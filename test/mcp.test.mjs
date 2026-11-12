import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { tempDir } from '../scripts/support.mjs';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const bin = path.join(root, 'bin', 'dev-diagnosis.js');
const examples = path.join(root, 'examples');
const demoRepo = path.join(examples, 'demo-repo');
const demoRuns = path.join(examples, 'runs');

/**
 * A minimal scripted MCP client: spawn the server, send newline-delimited
 * JSON-RPC requests, and collect the responses in order. Notifications
 * get no response, so the caller waits for exactly the number of
 * responses the requests should produce.
 */
class McpClient {
  constructor(args) {
    this.child = spawn(process.execPath, [bin, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.lines = [];
    this.waiters = [];
    let buffer = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        this.lines.push(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
      }
      this.flush();
    });
    this.child.stderr.setEncoding('utf8');
    this.stderr = '';
    this.child.stderr.on('data', (chunk) => { this.stderr += chunk; });
  }

  flush() {
    for (const waiter of this.waiters) {
      if (this.lines.length >= waiter.count) {
        waiter.resolve(this.lines.slice(0, waiter.count));
      }
    }
    this.waiters = this.waiters.filter((waiter) => this.lines.length < waiter.count);
  }

  waitFor(count, timeoutMs = 15000) {
    if (this.lines.length >= count) return Promise.resolve(this.lines.slice(0, count));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${count} MCP responses, got ${this.lines.length}: ${this.stderr}`)), timeoutMs);
      this.waiters.push({ count, resolve: (lines) => { clearTimeout(timer); resolve(lines); } });
    });
  }

  send(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  sendRaw(line) {
    this.child.stdin.write(`${line}\n`);
  }

  async close() {
    this.child.stdin.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => { this.child.kill(); resolve(); }, 5000);
      this.child.on('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}

function parse(lines) {
  return lines.map((line) => JSON.parse(line));
}

// Every test gets a private copy of examples/ as its sandbox. The
// cache check moves demo-repo/.cache aside and back, so two tests
// sharing the fixture (node --test runs test files concurrently)
// corrupt each other's cold/warm runs and flake — and a context scan
// running while .cache is moved would score a different repo.
function freshExamples() {
  const dir = tempDir('dev-diagnosis-mcp-');
  const copy = path.join(dir, 'examples');
  fs.cpSync(examples, copy, { recursive: true });
  return copy;
}

test('mcp: initialize, tools/list, tools/call and ping answer valid JSON-RPC', async () => {
  const client = new McpClient(['--mcp', '--sandbox', freshExamples()]);
  try {
    client.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
    client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    client.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    client.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'diagnose_context', arguments: { path: 'demo-repo' } } });
    client.send({ jsonrpc: '2.0', id: 4, method: 'ping' });
    const [init, list, context, ping] = parse(await client.waitFor(4));
    // The notification gets no response, so four requests yield four lines.
    assert.equal(init.id, 1);
    assert.equal(init.result.protocolVersion, '2024-11-05');
    assert.equal(init.result.serverInfo.name, 'dev-diagnosis');
    assert.equal(init.result.serverInfo.version, pkgVersion);
    assert.equal(list.id, 2);
    assert.deepEqual(
      list.result.tools.map((tool) => tool.name),
      ['diagnose_context', 'diagnose_path', 'diagnose_cache', 'diagnose_flakes', 'diagnose_all'],
    );
    assert.equal(context.id, 3);
    assert.equal(context.result.isError, false);
    const contextResult = JSON.parse(context.result.content[0].text);
    assert.equal(contextResult.score, 75);
    assert.ok(Number.isInteger(contextResult.estimatedTokens));
    assert.equal(ping.id, 4);
    assert.deepEqual(ping.result, {});
  } finally {
    await client.close();
  }
});

test('mcp: diagnose_all returns the same shape as all --json, with a summary', async () => {
  const client = new McpClient(['--mcp', '--sandbox', freshExamples()]);
  try {
    client.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'diagnose_all',
      arguments: { path: 'demo-repo', command: 'node', flakesDir: 'runs', buildCommand: ['node', 'build.mjs'] },
    } });
    const [all] = parse(await client.waitFor(1));
    assert.equal(all.result.isError, false);
    const out = JSON.parse(all.result.content[0].text);
    assert.equal(out.command, 'all');
    assert.equal(out.overall, 'FAIL');
    assert.equal(out.checks.context.score, 75);
    assert.equal(out.checks.path.contexts[0].resolved, true);
    assert.equal(out.checks.flakes.totals.flaky, 1);
    assert.equal(out.checks.cache.verdict, 'cache pays');
    assert.deepEqual(out.summary.checks, { total: 4, passed: 2, failed: 2, skipped: 0 });
    assert.ok(out.summary.contextNoiseBytes > 0);
    assert.ok(Number.isInteger(out.summary.cacheSavedPct));
  } finally {
    await client.close();
  }
});

test('mcp: diagnose_flakes and diagnose_cache work as tools', async () => {
  const client = new McpClient(['--mcp', '--sandbox', freshExamples()]);
  try {
    client.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'diagnose_flakes', arguments: { path: 'runs' } } });
    client.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'diagnose_cache', arguments: { path: 'demo-repo', command: ['node', 'build.mjs'] } } });
    const [flakes, cache] = parse(await client.waitFor(2));
    const flakesResult = JSON.parse(flakes.result.content[0].text);
    assert.equal(flakesResult.totals.flaky, 1);
    const cacheResult = JSON.parse(cache.result.content[0].text);
    assert.equal(cacheResult.verdict, 'cache pays');
    assert.ok(!('coldStdout' in cacheResult) && !('warmStdout' in cacheResult));
  } finally {
    await client.close();
  }
});

test('mcp: a path outside the sandbox is rejected as a tool error', async () => {
  const client = new McpClient(['--mcp', '--sandbox', examples]);
  try {
    client.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'diagnose_context', arguments: { path: '/etc' } } });
    client.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'diagnose_all', arguments: { path: demoRepo, flakesDir: '/etc' } } });
    const [outside, allOutside] = parse(await client.waitFor(2));
    assert.equal(outside.result.isError, true);
    assert.match(outside.result.content[0].text, /outside the sandbox/);
    assert.equal(allOutside.result.isError, true);
    assert.match(allOutside.result.content[0].text, /outside the sandbox/);
  } finally {
    await client.close();
  }
});

test('mcp: an unknown tool is a tool error, an unknown method is -32601', async () => {
  const client = new McpClient(['--mcp']);
  try {
    client.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'diagnose_nope', arguments: {} } });
    client.send({ jsonrpc: '2.0', id: 2, method: 'resources/list' });
    const [tool, method] = parse(await client.waitFor(2));
    assert.equal(tool.result.isError, true);
    assert.match(tool.result.content[0].text, /unknown tool/);
    assert.equal(method.error.code, -32601);
    assert.match(method.error.message, /Method not found/);
  } finally {
    await client.close();
  }
});

test('mcp: a malformed line gets a -32700 parse error and the server keeps going', async () => {
  const client = new McpClient(['--mcp']);
  try {
    client.sendRaw('{not json');
    client.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
    const [parseError, ping] = parse(await client.waitFor(2));
    assert.equal(parseError.error.code, -32700);
    assert.equal(parseError.id, null);
    assert.equal(ping.id, 1);
    assert.deepEqual(ping.result, {});
  } finally {
    await client.close();
  }
});

test('mcp: diagnose_context with fix answers with the post-fix scan', async () => {
  // An agent that asks for a fix needs to read whether the repo is
  // fixed now — not the pre-fix 75/100. The tool writes .aiignore into
  // the private examples copy and returns the re-scanned 94/100.
  const copy = freshExamples();
  const client = new McpClient(['--mcp', '--sandbox', copy]);
  try {
    client.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'diagnose_context', arguments: { path: 'demo-repo', fix: true } } });
    const [fixed] = parse(await client.waitFor(1));
    assert.equal(fixed.result.isError, false);
    const result = JSON.parse(fixed.result.content[0].text);
    assert.equal(result.score, 94);
    assert.deepEqual(result.fix.added, ['data/export.json']);
    assert.equal(fs.readFileSync(path.join(copy, 'demo-repo', '.aiignore'), 'utf8'), 'data/export.json\n');
    // A second call without fix sees the fixed repo.
    client.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'diagnose_context', arguments: { path: 'demo-repo' } } });
    const [, again] = parse(await client.waitFor(2));
    assert.equal(JSON.parse(again.result.content[0].text).score, 94);
  } finally {
    await client.close();
  }
});
