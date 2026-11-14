import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gitCommit, hasGit, makeGitRepo, tempDir, writeRepoFile } from '../scripts/support.mjs';
import { AIIGNORE_HEADER } from '../lib/context.mjs';
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
    // The annotations are what an MCP client uses to decide whether
    // to ask before calling: they describe what the tool *may* do.
    // A tool with an optional fix is not read-only, even when the
    // caller passes fix: false; the cache tool runs a build command
    // and its timings vary, so it is neither read-only nor
    // idempotent; the two pure reads are.
    assert.deepEqual(
      Object.fromEntries(list.result.tools.map((tool) => [tool.name, tool.annotations])),
      {
        diagnose_context: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        diagnose_path: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        diagnose_cache: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        diagnose_flakes: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        diagnose_all: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
    );
    // Descriptions carry what + when + keywords (the spec rule): an
    // agent decides whether to call a tool from its description, so
    // each one states when to use it and what it matches on.
    for (const tool of list.result.tools) {
      assert.match(tool.description, /Use when /);
      assert.match(tool.description, /Keywords: /);
    }
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

test('mcp: diagnose_cache with runs times the build repeatedly and reports the medians', async () => {
  const client = new McpClient(['--mcp', '--sandbox', freshExamples()]);
  try {
    client.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'diagnose_cache', arguments: { path: 'demo-repo', command: ['node', 'build.mjs'], runs: 3 } } });
    client.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'diagnose_cache', arguments: { path: 'demo-repo', command: ['node', 'build.mjs'], runs: 11 } } });
    const [repeated, invalid] = parse(await client.waitFor(2));
    const result = JSON.parse(repeated.result.content[0].text);
    assert.equal(result.runs, 3);
    assert.equal(result.coldRuns.length, 3);
    assert.equal(result.warmRuns.length, 3);
    assert.equal(result.verdict, 'cache pays');
    assert.equal(invalid.result.isError, true);
    assert.match(invalid.result.content[0].text, /runs must be an integer from 1 to 10/);
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

test('mcp: diagnose_context with fix + dryRun previews and writes nothing', async () => {
  // The CLI's --fix --dry-run has an MCP twin: an agent that wants to
  // see the fix before it lands gets the pre-fix 75/100 with the plan
  // marked dryRun, and no .aiignore appears on disk.
  const copy = freshExamples();
  const client = new McpClient(['--mcp', '--sandbox', copy]);
  try {
    client.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'diagnose_context', arguments: { path: 'demo-repo', fix: true, dryRun: true } } });
    const [preview] = parse(await client.waitFor(1));
    assert.equal(preview.result.isError, false);
    const result = JSON.parse(preview.result.content[0].text);
    assert.equal(result.score, 75);
    assert.equal(result.fix.dryRun, true);
    assert.deepEqual(result.fix.added, ['data/export.json']);
    assert.equal(fs.existsSync(path.join(copy, 'demo-repo', '.aiignore')), false);
    // The repo is untouched: a plain call still scores 75.
    client.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'diagnose_context', arguments: { path: 'demo-repo' } } });
    const [, again] = parse(await client.waitFor(2));
    assert.equal(JSON.parse(again.result.content[0].text).score, 75);
  } finally {
    await client.close();
  }
});

test('mcp: diagnose_all with fix + dryRun previews; dryRun without fix is an error', async () => {
  const copy = freshExamples();
  const client = new McpClient(['--mcp', '--sandbox', copy]);
  try {
    client.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'diagnose_all', arguments: { path: 'demo-repo', fix: true, dryRun: true } } });
    const [preview] = parse(await client.waitFor(1));
    assert.equal(preview.result.isError, false);
    const result = JSON.parse(preview.result.content[0].text);
    assert.equal(result.overall, 'FAIL');
    assert.equal(result.checks.context.score, 75);
    assert.equal(result.checks.context.fix.dryRun, true);
    assert.deepEqual(result.checks.context.fix.added, ['data/export.json']);
    assert.equal(fs.existsSync(path.join(copy, 'demo-repo', '.aiignore')), false);
    // dryRun without fix is a usage error, like --dry-run without --fix.
    client.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'diagnose_context', arguments: { path: 'demo-repo', dryRun: true } } });
    const [, errored] = parse(await client.waitFor(2));
    assert.equal(errored.result.isError, true);
    assert.match(errored.result.content[0].text, /dryRun needs fix/);
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
    assert.equal(fs.readFileSync(path.join(copy, 'demo-repo', '.aiignore'), 'utf8'), `${AIIGNORE_HEADER.join('\n')}\ndata/export.json\n`);
    // A second call without fix sees the fixed repo.
    client.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'diagnose_context', arguments: { path: 'demo-repo' } } });
    const [, again] = parse(await client.waitFor(2));
    assert.equal(JSON.parse(again.result.content[0].text).score, 94);
  } finally {
    await client.close();
  }
});

test('mcp: diagnose_context and diagnose_all take changedRef', async () => {
  const client = new McpClient(['--mcp', '--sandbox', freshExamples()]);
  try {
    client.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const [list] = parse(await client.waitFor(1));
    const byName = Object.fromEntries(list.result.tools.map((tool) => [tool.name, tool]));
    assert.equal(byName.diagnose_context.inputSchema.properties.changedRef.type, 'string');
    assert.equal(byName.diagnose_all.inputSchema.properties.changedRef.type, 'string');
    assert.equal(byName.diagnose_path.inputSchema.properties.changedRef, undefined);
  } finally {
    await client.close();
  }
});

test('mcp: diagnose_context with changedRef scopes to the change', async (t) => {
  if (!hasGit()) t.skip('git is not installed');
  const repo = makeGitRepo();
  writeRepoFile(repo, 'src/app.js', 'console.log("clean");\n');
  writeRepoFile(repo, 'old-debug.log', 'x'.repeat(1200000));
  gitCommit(repo, 'commit 1: clean app + committed log');
  writeRepoFile(repo, 'logs/new-debug.log', 'y'.repeat(1200000));
  const client = new McpClient(['--mcp', '--sandbox', repo]);
  try {
    // No path: the sandbox root is the repo.
    client.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'diagnose_context', arguments: { changedRef: 'HEAD' } } });
    const [scoped] = parse(await client.waitFor(1));
    assert.equal(scoped.result.isError, false, scoped.result.content[0].text);
    const result = JSON.parse(scoped.result.content[0].text);
    assert.equal(result.files, 1);
    assert.deepEqual(result.changed, { ref: 'HEAD', files: ['logs/new-debug.log'] });
    assert.equal(result.noise.length, 1);
  } finally {
    await client.close();
  }
});

test('mcp: diagnose_context with changedRef outside a git repo is an error result', async () => {
  const client = new McpClient(['--mcp', '--sandbox', freshExamples()]);
  try {
    client.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'diagnose_context', arguments: { changedRef: 'HEAD' } } });
    const [result] = parse(await client.waitFor(1));
    assert.equal(result.result.isError, true);
    assert.match(result.result.content[0].text, /not a git repository/);
  } finally {
    await client.close();
  }
});

test('mcp: prompts/list and prompts/get serve the diagnose_repo workflow', async () => {
  const client = new McpClient(['--mcp']);
  try {
    client.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
    client.send({ jsonrpc: '2.0', id: 2, method: 'prompts/list' });
    client.send({ jsonrpc: '2.0', id: 3, method: 'prompts/get', params: { name: 'diagnose_repo', arguments: { path: 'demo-repo' } } });
    client.send({ jsonrpc: '2.0', id: 4, method: 'prompts/get', params: { name: 'diagnose_repo' } });
    client.send({ jsonrpc: '2.0', id: 5, method: 'prompts/get', params: { name: 'nope' } });
    const [init, list, withPath, withoutPath, unknown] = parse(await client.waitFor(5));
    // initialize advertises the prompts capability, so a client that
    // surfaces prompts knows to ask for them.
    assert.deepEqual(init.result.capabilities, { tools: {}, prompts: {} });
    assert.deepEqual(list.result.prompts.map((prompt) => prompt.name), ['diagnose_repo']);
    assert.equal(list.result.prompts[0].arguments[0].name, 'path');
    assert.equal(list.result.prompts[0].arguments[0].required, false);
    assert.equal(withPath.result.messages[0].role, 'user');
    const text = withPath.result.messages[0].content.text;
    assert.match(text, /diagnose_all/);
    assert.match(text, /"demo-repo"/);
    assert.match(text, /do not write \.aiignore without the user agreeing/);
    assert.match(withoutPath.result.messages[0].content.text, /"\."/);
    assert.equal(unknown.error.code, -32602);
    assert.match(unknown.error.message, /unknown prompt: nope/);
  } finally {
    await client.close();
  }
});
