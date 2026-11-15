import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { git, gitCommit, hasGit, makeGitRepo, tempDir, writeRepoFile } from '../scripts/support.mjs';
import { AIIGNORE_HEADER } from '../lib/context.mjs';
import { writeSecretsBaseline } from '../lib/baseline.mjs';
import { scanTextForSecrets } from '../lib/secrets.mjs';
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
      ['diagnose_context', 'diagnose_binaries', 'diagnose_path', 'diagnose_cache', 'diagnose_flakes', 'diagnose_all', 'diagnose_secrets'],
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
        diagnose_binaries: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        diagnose_path: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        diagnose_cache: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        diagnose_flakes: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        diagnose_all: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        diagnose_secrets: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
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
    assert.equal(out.checks.binaries.totalBinaries, 0);
    assert.deepEqual(out.summary.checks, { total: 5, passed: 3, failed: 2, skipped: 0 });
    assert.ok(out.summary.contextNoiseBytes > 0);
    assert.ok(Number.isInteger(out.summary.cacheSavedPct));
  } finally {
    await client.close();
  }
});

test('mcp: diagnose_binaries works as a tool and validates top', async () => {
  const client = new McpClient(['--mcp', '--sandbox', freshExamples()]);
  try {
    client.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'diagnose_binaries', arguments: { path: 'demo-repo' } } });
    client.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'diagnose_binaries', arguments: { path: 'demo-repo', top: 21 } } });
    const [found, invalid] = parse(await client.waitFor(2));
    assert.equal(found.result.isError, false);
    const result = JSON.parse(found.result.content[0].text);
    assert.equal(result.totalBinaries, 0);
    assert.deepEqual(result.binaries, []);
    assert.equal(invalid.result.isError, true);
    assert.match(invalid.result.content[0].text, /--top needs a whole number from 1 to 20/);
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
    assert.equal(result.fix.wouldChange, true);
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
    assert.equal(result.checks.context.fix.wouldChange, true);
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

test('mcp: tools declare outputSchema and results carry structuredContent', async () => {
  const client = new McpClient(['--mcp', '--sandbox', freshExamples()]);
  try {
    client.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    client.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'diagnose_context', arguments: { path: 'demo-repo' } } });
    client.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'diagnose_binaries', arguments: { path: 'demo-repo' } } });
    client.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'diagnose_path', arguments: {} } });
    const [list, context, binaries, pathError] = parse(await client.waitFor(4));
    // Every tool declares the structured-output shape: a loose object
    // schema on purpose — the payloads are dynamic nested objects with
    // optional fields, and the Inspector validates structuredContent
    // against it, so a detailed schema would warn on any property it
    // does not list.
    for (const tool of list.result.tools) {
      assert.deepEqual(tool.outputSchema, { type: 'object' });
    }
    // A success result carries the same object typed as it does as
    // text: the content text is unchanged, and structuredContent is
    // exactly the object the text serializes.
    for (const call of [context, binaries]) {
      assert.equal(call.result.isError, false);
      assert.deepEqual(call.result.structuredContent, JSON.parse(call.result.content[0].text));
    }
    // An error result carries no structuredContent: there is no
    // payload to type.
    assert.equal(pathError.result.isError, true);
    assert.equal('structuredContent' in pathError.result, false);
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
    assert.equal(byName.diagnose_context.inputSchema.properties.staged.type, 'boolean');
    assert.equal(byName.diagnose_all.inputSchema.properties.staged.type, 'boolean');
    assert.equal(byName.diagnose_context.inputSchema.properties.newFromRev.type, 'string');
    assert.equal(byName.diagnose_all.inputSchema.properties.newFromRev.type, 'string');
    assert.equal(byName.diagnose_context.inputSchema.properties.secretsBaseline.type, 'string');
    assert.equal(byName.diagnose_all.inputSchema.properties.secretsBaseline.type, 'string');
    assert.equal(byName.diagnose_context.inputSchema.properties.cache.type, 'boolean');
    assert.equal(byName.diagnose_all.inputSchema.properties.cache.type, 'boolean');
    assert.equal(byName.diagnose_context.inputSchema.properties.minScore.type, 'number');
    assert.equal(byName.diagnose_all.inputSchema.properties.minScore.type, 'number');
    assert.equal(byName.diagnose_path.inputSchema.properties.cache, undefined);
    assert.equal(byName.diagnose_secrets.inputSchema.properties.cache, undefined);
    assert.equal(byName.diagnose_path.inputSchema.properties.changedRef, undefined);
    assert.equal(byName.diagnose_path.inputSchema.properties.staged, undefined);
    assert.equal(byName.diagnose_path.inputSchema.properties.newFromRev, undefined);
    assert.equal(byName.diagnose_path.inputSchema.properties.secretsBaseline, undefined);
    assert.equal(byName.diagnose_path.inputSchema.properties.minScore, undefined);
    assert.equal(byName.diagnose_secrets.inputSchema.properties.minScore, undefined);
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
    assert.deepEqual(result.changed, { ref: 'HEAD', files: ['logs/new-debug.log'], staged: false, newFromRev: null });
    assert.equal(result.noise.length, 1);
  } finally {
    await client.close();
  }
});

test('mcp: diagnose_context with changedRef + staged scopes to the staged set', async (t) => {
  if (!hasGit()) t.skip('git is not installed');
  const repo = makeGitRepo();
  writeRepoFile(repo, 'src/app.js', 'console.log("clean");\n');
  writeRepoFile(repo, 'old-debug.log', 'x'.repeat(1200000));
  gitCommit(repo, 'commit 1: clean app + committed log');
  writeRepoFile(repo, 'src/feature.js', '// new feature\n');
  git(repo, 'add', 'src/feature.js'); // staged, clean
  writeRepoFile(repo, 'unstaged.json', 'y'.repeat(1200000)); // unstaged noise
  const client = new McpClient(['--mcp', '--sandbox', repo]);
  try {
    client.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'diagnose_context', arguments: { changedRef: 'HEAD', staged: true } } });
    const [staged] = parse(await client.waitFor(1));
    assert.equal(staged.result.isError, false, staged.result.content[0].text);
    const result = JSON.parse(staged.result.content[0].text);
    assert.equal(result.files, 1);
    assert.deepEqual(result.changed, { ref: 'HEAD', files: ['src/feature.js'], staged: true, newFromRev: null });
    assert.equal(result.score, 100);
    assert.deepEqual(result.noise, []);
    // staged without changedRef is a usage error, like the CLI's
    // --staged without --changed.
    client.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'diagnose_context', arguments: { staged: true } } });
    const [, errored] = parse(await client.waitFor(2));
    assert.equal(errored.result.isError, true);
    assert.match(errored.result.content[0].text, /staged needs changedRef/);
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

test('mcp: diagnose_context with newFromRev passes a lockfile bump changedRef fails', async (t) => {
  if (!hasGit()) t.skip('git is not installed');
  const repo = makeGitRepo();
  writeRepoFile(repo, 'src/index.js', 'console.log("clean");\n');
  writeRepoFile(repo, 'package-lock.json', '{\n  "version": "1.0.1"\n}\n'.padEnd(2000000, ' '));
  gitCommit(repo, 'commit 1: clean src + committed lockfile');
  const lockfile = path.join(repo, 'package-lock.json');
  fs.writeFileSync(lockfile, fs.readFileSync(lockfile, 'utf8').replace('"1.0.1"', '"1.0.2"'));
  const client = new McpClient(['--mcp', '--sandbox', repo]);
  try {
    client.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'diagnose_context', arguments: { changedRef: 'HEAD' } } });
    const [changed] = parse(await client.waitFor(1));
    assert.equal(changed.result.isError, false, changed.result.content[0].text);
    assert.equal(JSON.parse(changed.result.content[0].text).score, 80);
    // newFromRev alone implies changedRef: the same bump passes, and
    // an empty string means HEAD like an empty changedRef does.
    client.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'diagnose_context', arguments: { newFromRev: '' } } });
    const [, fresh] = parse(await client.waitFor(2));
    assert.equal(fresh.result.isError, false, fresh.result.content[0].text);
    const result = JSON.parse(fresh.result.content[0].text);
    assert.equal(result.score, 100);
    assert.deepEqual(result.changed, { ref: 'HEAD', files: ['package-lock.json'], staged: false, newFromRev: 'HEAD' });
    assert.deepEqual(result.noise, []);
  } finally {
    await client.close();
  }
});

test('mcp: diagnose_context with newFromRev and a different changedRef is an error result', async (t) => {
  if (!hasGit()) t.skip('git is not installed');
  const repo = makeGitRepo();
  writeRepoFile(repo, 'src/app.js', 'console.log("clean");\n');
  gitCommit(repo, 'commit 1: clean app');
  const client = new McpClient(['--mcp', '--sandbox', repo]);
  try {
    client.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'diagnose_context', arguments: { changedRef: 'HEAD~1', newFromRev: 'HEAD' } } });
    const [result] = parse(await client.waitFor(1));
    assert.equal(result.result.isError, true);
    assert.match(result.result.content[0].text, /--new-from-rev HEAD and --changed HEAD~1 name different refs/);
  } finally {
    await client.close();
  }
});

test('mcp: diagnose_context with secretsBaseline suppresses known findings', async () => {
  const sandbox = tempDir('dev-diagnosis-mcp-baseline-');
  const repo = path.join(sandbox, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  // Fragment-built, like every other corpus line: this file is
  // dogfood-scanned, so a complete fake credential must never sit
  // on one physical line of it.
  const keyLine = ['api', 'key'].join('_') + ' = "' + '9f8e7d6c' + '5b4a3928' + '1706f5e4' + 'd3c2b1a0' + '"';
  fs.writeFileSync(path.join(repo, 'config.js'), `${keyLine}\n`);
  fs.writeFileSync(path.join(repo, 'index.js'), 'x\n');
  const findings = scanTextForSecrets(keyLine, 'config.js');
  writeSecretsBaseline(path.join(repo, 'baseline.json'), findings);
  const client = new McpClient(['--mcp', '--sandbox', sandbox]);
  try {
    client.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'diagnose_context', arguments: { path: 'repo' } } });
    client.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'diagnose_context', arguments: { path: 'repo', secretsBaseline: 'baseline.json' } } });
    const [open, suppressed] = parse(await client.waitFor(2));
    assert.equal(open.result.isError, false, open.result.content[0].text);
    const openResult = JSON.parse(open.result.content[0].text);
    assert.equal(openResult.review.filter((item) => item.kind === 'secret').length, 1);
    assert.equal(openResult.secretsBaseline, null);
    assert.equal(suppressed.result.isError, false, suppressed.result.content[0].text);
    const suppressedResult = JSON.parse(suppressed.result.content[0].text);
    assert.equal(suppressedResult.review.filter((item) => item.kind === 'secret').length, 0);
    assert.deepEqual(suppressedResult.secretsBaseline, { path: path.join(repo, 'baseline.json'), loaded: true, suppressed: 1 });
  } finally {
    await client.close();
  }
});

test('mcp: diagnose_context with cache reuses the scan on the second call', async () => {
  const sandbox = tempDir('dev-diagnosis-mcp-cache-');
  const repo = path.join(sandbox, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'index.js'), 'console.log(1);\n');
  fs.writeFileSync(path.join(repo, 'data.json'), 'x'.repeat(100000));
  const client = new McpClient(['--mcp', '--sandbox', sandbox]);
  try {
    client.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'diagnose_context', arguments: { path: 'repo', cache: true } } });
    client.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'diagnose_context', arguments: { path: 'repo', cache: true } } });
    const [first, second] = parse(await client.waitFor(2));
    assert.equal(first.result.isError, false, first.result.content[0].text);
    const firstResult = JSON.parse(first.result.content[0].text);
    assert.equal(firstResult.cached, null);
    assert.equal(second.result.isError, false, second.result.content[0].text);
    const secondResult = JSON.parse(second.result.content[0].text);
    assert.equal(secondResult.cached.files, 2);
    assert.equal(secondResult.cached.strategy, 'metadata');
    delete firstResult.cached;
    delete secondResult.cached;
    assert.deepEqual(secondResult, firstResult);
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

test('mcp: diagnose_secrets scans named files and never returns the value', async () => {
  const sandbox = tempDir('dev-diagnosis-mcp-secrets-');
  // Fragment-built, like every other corpus line: this file is
  // dogfood-scanned, so a complete fake credential must never sit
  // on one physical line of it.
  const keyLine = ['api', 'key'].join('_') + ' = "' + '9f8e7d6c' + '5b4a3928' + '1706f5e4' + 'd3c2b1a0' + '"';
  const keyValue = '9f8e7d6c' + '5b4a3928' + '1706f5e4' + 'd3c2b1a0';
  fs.writeFileSync(path.join(sandbox, 'config.js'), `${keyLine}\n`);
  fs.writeFileSync(path.join(sandbox, 'index.js'), 'x\n');
  const client = new McpClient(['--mcp', '--sandbox', sandbox]);
  try {
    client.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'diagnose_secrets', arguments: { paths: ['config.js'] } } });
    client.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'diagnose_secrets', arguments: { paths: ['index.js'] } } });
    const [tainted, clean] = parse(await client.waitFor(2));
    assert.equal(tainted.result.isError, false, tainted.result.content[0].text);
    const taintedResult = JSON.parse(tainted.result.content[0].text);
    assert.equal(taintedResult.findings.length, 1);
    assert.equal(taintedResult.findings[0].rule, 'generic-api-key');
    assert.equal(taintedResult.findings[0].line, 1);
    assert.ok(!tainted.result.content[0].text.includes(keyValue), 'the tool result must never contain the matched value');
    assert.equal(clean.result.isError, false, clean.result.content[0].text);
    assert.deepEqual(JSON.parse(clean.result.content[0].text).findings, []);
  } finally {
    await client.close();
  }
});

test('mcp: diagnose_secrets rejects paths outside the sandbox and an empty paths array', async () => {
  const sandbox = tempDir('dev-diagnosis-mcp-secrets-');
  fs.writeFileSync(path.join(sandbox, 'index.js'), 'x\n');
  const client = new McpClient(['--mcp', '--sandbox', sandbox]);
  try {
    client.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'diagnose_secrets', arguments: { paths: ['../outside.txt'] } } });
    client.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'diagnose_secrets', arguments: { paths: [] } } });
    const [escaped, empty] = parse(await client.waitFor(2));
    assert.equal(escaped.result.isError, true);
    assert.match(escaped.result.content[0].text, /outside the sandbox/);
    assert.equal(empty.result.isError, true);
    assert.match(empty.result.content[0].text, /needs a paths array/);
  } finally {
    await client.close();
  }
});

test('mcp: diagnose_secrets with writeSecretsBaseline records instead of judging', async () => {
  const sandbox = tempDir('dev-diagnosis-mcp-secrets-');
  const keyLine = ['api', 'key'].join('_') + ' = "' + '9f8e7d6c' + '5b4a3928' + '1706f5e4' + 'd3c2b1a0' + '"';
  fs.writeFileSync(path.join(sandbox, 'config.js'), `${keyLine}\n`);
  const client = new McpClient(['--mcp', '--sandbox', sandbox]);
  try {
    client.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'diagnose_secrets', arguments: { paths: ['config.js'], writeSecretsBaseline: 'baseline.json' } } });
    const [recorded] = parse(await client.waitFor(1));
    assert.equal(recorded.result.isError, false, recorded.result.content[0].text);
    const recordedResult = JSON.parse(recorded.result.content[0].text);
    assert.equal(recordedResult.secretsBaselineWritten.count, 1);
    assert.ok(fs.existsSync(path.join(sandbox, 'baseline.json')));
    const data = JSON.parse(fs.readFileSync(path.join(sandbox, 'baseline.json'), 'utf8'));
    assert.equal(data.findings.length, 1);
    assert.equal(data.findings[0].rule, 'generic-api-key');
    // The recorded finding stops alerting on the next call.
    client.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'diagnose_secrets', arguments: { paths: ['config.js'], secretsBaseline: 'baseline.json' } } });
    const [, suppressed] = parse(await client.waitFor(2));
    assert.equal(suppressed.result.isError, false, suppressed.result.content[0].text);
    const suppressedResult = JSON.parse(suppressed.result.content[0].text);
    assert.deepEqual(suppressedResult.findings, []);
    assert.equal(suppressedResult.secretsBaseline.suppressed, 1);
    // Both baseline flags together are a usage error.
    client.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'diagnose_secrets', arguments: { paths: ['config.js'], secretsBaseline: 'baseline.json', writeSecretsBaseline: 'other.json' } } });
    const [, , both] = parse(await client.waitFor(3));
    assert.equal(both.result.isError, true);
    assert.match(both.result.content[0].text, /cannot be combined/);
  } finally {
    await client.close();
  }
});

test('mcp: diagnose_all takes only/skip', async () => {
  const client = new McpClient(['--mcp', '--sandbox', freshExamples()]);
  try {
    client.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const [list] = parse(await client.waitFor(1));
    const byName = Object.fromEntries(list.result.tools.map((tool) => [tool.name, tool]));
    assert.equal(byName.diagnose_all.inputSchema.properties.only.type, 'array');
    assert.equal(byName.diagnose_all.inputSchema.properties.skip.type, 'array');
    assert.equal(byName.diagnose_context.inputSchema.properties.only, undefined);
    assert.equal(byName.diagnose_context.inputSchema.properties.skip, undefined);
    // Skipping cache means the build command never runs: the run
    // reports it skipped and the summary drops the cache line.
    client.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'diagnose_all', arguments: { path: '.', command: 'node', buildCommand: ['node', 'build.mjs'], skip: ['cache'] } } });
    const [, skipped] = parse(await client.waitFor(2));
    assert.equal(skipped.result.isError, false, skipped.result.content[0].text);
    const out = JSON.parse(skipped.result.content[0].text);
    assert.equal(out.checks.cache, undefined);
    assert.ok(out.skipped.includes('cache — skipped by --skip cache'));
    assert.equal(out.summary.cacheSavedPct, null);
    // An unknown name is a usage error, like the CLI's exit 2.
    client.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'diagnose_all', arguments: { only: ['bogus'] } } });
    const [, , bad] = parse(await client.waitFor(3));
    assert.equal(bad.result.isError, true);
    assert.match(bad.result.content[0].text, /unknown check in --only: bogus/);
    // only + skip together are a usage error.
    client.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'diagnose_all', arguments: { only: ['context'], skip: ['cache'] } } });
    const [, , , both] = parse(await client.waitFor(4));
    assert.equal(both.result.isError, true);
    assert.match(both.result.content[0].text, /cannot combine --only and --skip/);
    // fix needs the context check to run.
    client.send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'diagnose_all', arguments: { fix: true, skip: ['context'] } } });
    const [, , , , nofix] = parse(await client.waitFor(5));
    assert.equal(nofix.result.isError, true);
    assert.match(nofix.result.content[0].text, /fix needs the context check/);
  } finally {
    await client.close();
  }
});

test('mcp: diagnose_context and diagnose_all take minScore, and a bad one is an error', async () => {
  const client = new McpClient(['--mcp', '--sandbox', freshExamples()]);
  try {
    // The demo repo scores 75: it passes at minScore 70 and fails at
    // 80 — the tool answers with the result either way (isError is
    // only for usage errors), and the result carries the bar.
    client.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'diagnose_context', arguments: { path: 'demo-repo', minScore: 70 } } });
    client.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'diagnose_all', arguments: { path: 'demo-repo', minScore: 80 } } });
    client.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'diagnose_context', arguments: { path: 'demo-repo', minScore: 101 } } });
    const [low, high, invalid] = parse(await client.waitFor(3));
    assert.equal(low.result.isError, false);
    const lowResult = JSON.parse(low.result.content[0].text);
    assert.equal(lowResult.score, 75);
    assert.equal(lowResult.minScore, 70);
    assert.equal(high.result.isError, false);
    const highResult = JSON.parse(high.result.content[0].text);
    assert.equal(highResult.checks.context.score, 75);
    assert.equal(highResult.checks.context.minScore, 80);
    assert.equal(highResult.overall, 'FAIL');
    assert.equal(invalid.result.isError, true);
    assert.match(invalid.result.content[0].text, /--min-score needs a whole number from 0 to 100/);
  } finally {
    await client.close();
  }
});
