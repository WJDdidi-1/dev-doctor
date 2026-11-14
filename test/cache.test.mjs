import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { tempDir } from '../scripts/support.mjs';
import { detectCacheDir, MAX_CACHE_RUNS, median, runCacheCheck } from '../lib/cache.mjs';

const BUILD_SCRIPT = `
import fs from 'node:fs';
import path from 'node:path';
const cacheDir = path.join(process.cwd(), '.cache');
const out = path.join(cacheDir, 'out.txt');
if (fs.existsSync(out)) {
  console.log('cache hit');
} else {
  // Simulate real work that a cache would skip. 400 ms, so the
  // cold-vs-warm gap dwarfs Node startup time and stays decisive
  // even on a loaded CI machine.
  const until = Date.now() + 400;
  while (Date.now() < until) { /* busy wait, deterministic */ }
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(out, 'built\\n');
  console.log('cache miss');
}
`;

function makeProject() {
  const root = tempDir('dev-diagnosis-cache-');
  fs.mkdirSync(path.join(root, '.cache'), { recursive: true });
  fs.writeFileSync(path.join(root, '.cache', 'out.txt'), 'built\n');
  fs.writeFileSync(path.join(root, 'build.mjs'), BUILD_SCRIPT);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'demo', type: 'module' }));
  return root;
}

test('runCacheCheck: a cache that skips 150 ms of work pays, and the cache is restored', () => {
  const root = makeProject();
  const before = fs.readFileSync(path.join(root, '.cache', 'out.txt'), 'utf8');
  const result = runCacheCheck({ root, command: ['node', 'build.mjs'] });
  assert.equal(result.verdict, 'cache pays');
  assert.ok(result.coldMs >= 100, `cold run should take the simulated work time, got ${result.coldMs} ms`);
  assert.ok(result.warmMs < result.coldMs, `warm (${result.warmMs} ms) should beat cold (${result.coldMs} ms)`);
  // The original cache file is back, byte for byte.
  assert.equal(fs.readFileSync(path.join(root, '.cache', 'out.txt'), 'utf8'), before);
  assert.ok(fs.existsSync(path.join(root, '.cache', 'out.txt')));
});

test('runCacheCheck: the cache is restored even when the build fails', () => {
  const root = makeProject();
  fs.writeFileSync(path.join(root, 'build.mjs'), 'process.exit(3);\n');
  assert.throws(
    () => runCacheCheck({ root, command: ['node', 'build.mjs'] }),
    /cold build failed/,
  );
  assert.equal(fs.readFileSync(path.join(root, '.cache', 'out.txt'), 'utf8'), 'built\n');
});

test('runCacheCheck: refuses a cache dir that is the project root', () => {
  const root = makeProject();
  assert.throws(
    () => runCacheCheck({ root, cacheDir: root, command: ['node', 'build.mjs'] }),
    /must not point at the project root/,
  );
});

test('runCacheCheck: refuses a cache dir outside the project', () => {
  const root = makeProject();
  assert.throws(
    () => runCacheCheck({ root, cacheDir: path.join(os.tmpdir(), 'elsewhere'), command: ['node', 'build.mjs'] }),
    /outside the project/,
  );
});

test('runCacheCheck: needs a build command', () => {
  const root = makeProject();
  assert.throws(() => runCacheCheck({ root, command: [] }), /needs a build command/);
});

test('median: odd, even and single samples', () => {
  assert.equal(median([300, 100, 200]), 200);
  assert.equal(median([100, 300]), 200);
  assert.equal(median([150]), 150);
  assert.equal(median([500, 100, 400, 200]), 300);
});

test('runCacheCheck: runs: 3 times cold and warm, verdict on the medians, cache restored', () => {
  const root = makeProject();
  const before = fs.readFileSync(path.join(root, '.cache', 'out.txt'), 'utf8');
  const result = runCacheCheck({ root, command: ['node', 'build.mjs'], runs: 3 });
  assert.equal(result.runs, 3);
  assert.equal(result.coldRuns.length, 3);
  assert.equal(result.warmRuns.length, 3);
  assert.equal(result.coldMs, median(result.coldRuns));
  assert.equal(result.warmMs, median(result.warmRuns));
  assert.equal(result.verdict, 'cache pays');
  assert.match(result.verdictDetail, /median of 3 runs each/);
  assert.equal(fs.readFileSync(path.join(root, '.cache', 'out.txt'), 'utf8'), before);
  // No stash left behind.
  assert.ok(!fs.readdirSync(root).some((name) => name.startsWith('.dev-diagnosis-stash-')));
});

test('runCacheCheck: runs: 1 is the default and keeps the old shape', () => {
  const root = makeProject();
  const result = runCacheCheck({ root, command: ['node', 'build.mjs'] });
  assert.equal(result.runs, 1);
  assert.equal(result.coldRuns.length, 1);
  assert.equal(result.coldMs, result.coldRuns[0]);
  assert.equal(result.verdict, 'cache pays');
});

test('runCacheCheck: runs outside 1..10 is refused', () => {
  const root = makeProject();
  for (const bad of [0, MAX_CACHE_RUNS + 1, 2.5, '3']) {
    assert.throws(
      () => runCacheCheck({ root, command: ['node', 'build.mjs'], runs: bad }),
      /runs must be an integer from 1 to 10/,
    );
  }
});

test('runCacheCheck: the cache is restored when a later cold run fails, and the error names the run', () => {
  const root = makeProject();
  // Fails on the second invocation: the counter lives in the project
  // root, outside .cache, so it survives the stash-and-restore dance.
  fs.writeFileSync(path.join(root, 'build.mjs'), `
import fs from 'node:fs';
import path from 'node:path';
const counter = path.join(process.cwd(), 'count.txt');
const n = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0) + 1;
fs.writeFileSync(counter, String(n));
if (n === 2) process.exit(3);
`);
  assert.throws(
    () => runCacheCheck({ root, command: ['node', 'build.mjs'], runs: 3 }),
    /cold build failed on run 2 of 3 \(exit 3\)/,
  );
  assert.equal(fs.readFileSync(path.join(root, '.cache', 'out.txt'), 'utf8'), 'built\n');
});

test('detectCacheDir: finds .cache, and returns null when there is none', () => {
  const root = makeProject();
  assert.equal(detectCacheDir(root), path.join(root, '.cache'));
  const empty = tempDir('dev-diagnosis-cache-');
  assert.equal(detectCacheDir(empty), null);
});
