import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tempDir } from '../scripts/support.mjs';
import { scanDirectory } from '../lib/context.mjs';
import { runContextCheck } from '../lib/checks.mjs';
import { writeSecretsBaseline } from '../lib/baseline.mjs';
import { scanTextForSecrets } from '../lib/secrets.mjs';
import {
  DEFAULT_SCAN_CACHE_FILENAME,
  SCAN_CACHE_VERSION,
  buildScanCacheData,
  formatScanCacheLine,
  getToolVersion,
  headerContentMatches,
  headerMatches,
  loadScanCache,
  lookupScanCache,
  resolveScanCachePath,
  saveScanCache,
  scanCacheRelativePath,
} from '../lib/scan-cache.mjs';

// Corpus lines are built from fragments, never written as one literal:
// this file itself is scanned by the tool's own dogfood run, so a
// complete fake credential on one line would be a finding in our own
// repo. The fragments never co-occur on a physical line.
const keyLine = (hex) => ['api', 'key'].join('_') + ' = "' + hex + '"';
const keyA = keyLine('9f8e7d6c' + '5b4a3928' + '1706f5e4' + 'd3c2b1a0');
const keyB = keyLine('1a2b3c4d' + '5e6f7a8b' + '9c0d1e2f' + '3a4b5c6d');

function makeRepo(files) {
  const root = tempDir('dev-diagnosis-scan-cache-');
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

function cachePathFor(root) {
  return path.join(root, DEFAULT_SCAN_CACHE_FILENAME);
}

function loadFor(root) {
  const { cache, warning } = loadScanCache(cachePathFor(root));
  assert.equal(warning, null);
  assert.ok(cache);
  return cache;
}

function scanWithCache(root, extra = {}) {
  const cachePath = cachePathFor(root);
  const loaded = loadScanCache(cachePath);
  return scanDirectory(root, {
    scanCache: { path: cachePath, data: loaded.cache },
    ...extra,
  });
}

const headerFor = (root, { aiignore = [], gitignore = [] } = {}) => ({
  toolVersion: getToolVersion(),
  root,
  maxFiles: 100000,
  aiignore,
  gitignore,
});

test('scan-cache: resolveScanCachePath defaults to the root file and resolves a custom location', () => {
  const root = tempDir('dev-diagnosis-scan-cache-');
  assert.equal(resolveScanCachePath(root, null), path.join(root, DEFAULT_SCAN_CACHE_FILENAME));
  assert.equal(resolveScanCachePath(root, 'sub/cache.json'), path.join(root, 'sub', 'cache.json'));
  // An absolute location resolves against the filesystem root, not
  // under the scan root — and on Windows the drive comes from the
  // root, not the process cwd (the 2026-11-15 CI failure: the runner
  // checks out on D: while the temp root lives on C:, so
  // path.resolve('/tmp', ...) gives D:\tmp\... but the function
  // returns C:\tmp\...). path.parse(root).root names the right drive
  // on every platform; on POSIX it is just '/'.
  assert.equal(resolveScanCachePath(root, '/tmp/abs-cache.json'), path.join(path.parse(root).root, 'tmp', 'abs-cache.json'));
});

test('scan-cache: save then load round-trips, and the file never holds a secret value', () => {
  const dir = tempDir('dev-diagnosis-scan-cache-');
  const file = path.join(dir, 'cache.json');
  const findings = scanTextForSecrets(keyA, 'config.js');
  assert.equal(findings.length, 1);
  const data = buildScanCacheData({
    root: dir,
    maxFiles: 100000,
    aiignore: null,
    gitignore: [],
    files: new Map([['config.js', {
      m: 1730000000000.1, s: 40, c: 'review', t: 10,
      f: findings.map((finding) => [finding.rule, finding.line, finding.fingerprint]),
    }]]),
  });
  assert.equal(data.cacheVersion, SCAN_CACHE_VERSION);
  assert.equal(data.toolVersion, getToolVersion());
  saveScanCache(file, data);
  const { cache, warning } = loadScanCache(file);
  assert.equal(warning, null);
  assert.deepEqual(cache, data);
  // The file holds hashes, rules and addresses — never the value.
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(!text.includes('9f8e7d6c5b4a3928'), text);
  // Atomic write: no temp file left behind.
  assert.deepEqual(fs.readdirSync(dir), ['cache.json']);
});

test('scan-cache: load of a missing file is null with no warning; corrupt or wrong-shaped files warn', () => {
  const dir = tempDir('dev-diagnosis-scan-cache-');
  const missing = loadScanCache(path.join(dir, 'nope.json'));
  assert.equal(missing.cache, null);
  assert.equal(missing.warning, null);
  const corrupt = path.join(dir, 'corrupt.json');
  fs.writeFileSync(corrupt, 'not json{{{');
  const corruptLoad = loadScanCache(corrupt);
  assert.equal(corruptLoad.cache, null);
  assert.match(corruptLoad.warning, /not valid JSON/);
  const wrongVersion = path.join(dir, 'version.json');
  fs.writeFileSync(wrongVersion, JSON.stringify({ cacheVersion: 99, files: {} }));
  assert.equal(loadScanCache(wrongVersion).cache, null);
  assert.match(loadScanCache(wrongVersion).warning, /wrong shape/);
  const noFiles = path.join(dir, 'nofiles.json');
  fs.writeFileSync(noFiles, JSON.stringify({ cacheVersion: SCAN_CACHE_VERSION }));
  assert.equal(loadScanCache(noFiles).cache, null);
});

test('scan-cache: save refuses a directory that does not exist', () => {
  const dir = tempDir('dev-diagnosis-scan-cache-');
  assert.throws(
    () => saveScanCache(path.join(dir, 'no-such-dir', 'cache.json'), { cacheVersion: SCAN_CACHE_VERSION, files: {} }),
    /directory does not exist/,
  );
});

test('scan-cache: headerMatches needs every field; headerContentMatches ignores the ignore lists', () => {
  const root = '/repo';
  const expected = headerFor(root, {
    aiignore: [['.aiignore', 100, 10]],
    gitignore: [['.gitignore', 200, 20]],
  });
  const cache = {
    cacheVersion: SCAN_CACHE_VERSION,
    toolVersion: getToolVersion(),
    root,
    maxFiles: 100000,
    aiignore: [['.aiignore', 100, 10]],
    gitignore: [['.gitignore', 200, 20]],
    files: {},
  };
  assert.equal(headerMatches(cache, expected), true);
  assert.equal(headerContentMatches(cache, expected), true);
  assert.equal(headerMatches({ ...cache, toolVersion: '0.0.0' }, expected), false);
  assert.equal(headerMatches({ ...cache, root: '/other' }, expected), false);
  assert.equal(headerMatches({ ...cache, maxFiles: 99 }, expected), false);
  assert.equal(headerMatches({ ...cache, aiignore: null }, expected), false);
  assert.equal(headerMatches({ ...cache, aiignore: [['.aiignore', 101, 10]] }, expected), false);
  // An old cache file whose aiignore is still the pre-0.2.4 single
  // fingerprint object is not a list, so it never matches — one full
  // re-scan, and the rewrite is in the new shape.
  assert.equal(headerMatches({ ...cache, aiignore: { mtimeMs: 100, size: 10 } }, expected), false);
  assert.equal(headerMatches({ ...cache, gitignore: [] }, expected), false);
  assert.equal(headerMatches({ ...cache, gitignore: [['.gitignore', 200, 21]] }, expected), false);
  assert.equal(headerMatches({ ...cache, gitignore: [['sub/.gitignore', 200, 20]] }, expected), false);
  // The gitignore list compares order-insensitively.
  assert.equal(headerMatches({ ...cache, gitignore: [['b/.gitignore', 1, 1], ['.gitignore', 200, 20]] }, {
    ...expected,
    gitignore: [['.gitignore', 200, 20], ['b/.gitignore', 1, 1]],
  }), true);
  // The aiignore list compares order-insensitively too.
  assert.equal(headerMatches({ ...cache, aiignore: [['pkg/.aiignore', 1, 1], ['.aiignore', 100, 10]] }, {
    ...expected,
    aiignore: [['.aiignore', 100, 10], ['pkg/.aiignore', 1, 1]],
  }), true);
  // An ignore-list change alone does not make the stored observations
  // stale: content still matches, so old entries may be carried over
  // on a scoped scan — only the full header fails.
  assert.equal(headerContentMatches({ ...cache, aiignore: null }, expected), true);
  assert.equal(headerContentMatches({ ...cache, gitignore: [] }, expected), true);
  assert.equal(headerContentMatches({ ...cache, toolVersion: '0.0.0' }, expected), false);
  assert.equal(headerContentMatches(null, expected), false);
});

test('scan-cache: lookup hits only on an exact fingerprint match', () => {
  const cache = {
    files: {
      'a.js': { m: 100, s: 40, c: 'none', t: 10, f: [] },
      'bad.js': { m: 100, s: 40, c: 'none', t: 10, f: [['generic-api-key', 1]] },
      'short.js': { m: 100, s: 40, c: 'none', t: 10, f: [['generic-api-key', 1, 'abc']] },
    },
  };
  assert.deepEqual(lookupScanCache(cache, 'a.js', { mtimeMs: 100, size: 40 }), cache.files['a.js']);
  assert.equal(lookupScanCache(cache, 'a.js', { mtimeMs: 101, size: 40 }), null);
  assert.equal(lookupScanCache(cache, 'a.js', { mtimeMs: 100, size: 41 }), null);
  assert.equal(lookupScanCache(cache, 'missing.js', { mtimeMs: 100, size: 40 }), null);
  assert.equal(lookupScanCache(null, 'a.js', { mtimeMs: 100, size: 40 }), null);
  // A malformed entry is a miss, never a crash — and a finding triple
  // without its fingerprint is malformed.
  assert.equal(lookupScanCache(cache, 'bad.js', { mtimeMs: 100, size: 40 }), null);
  assert.deepEqual(lookupScanCache(cache, 'short.js', { mtimeMs: 100, size: 40 }), cache.files['short.js']);
});

test('scan-cache: formatScanCacheLine is null when nothing was reused', () => {
  assert.equal(formatScanCacheLine(null), null);
  assert.equal(formatScanCacheLine({ files: 0, bytes: 0, strategy: 'metadata', writtenAt: new Date().toISOString() }), null);
  assert.equal(formatScanCacheLine({ files: 1, bytes: 10, strategy: 'metadata', writtenAt: 'bad-date' }), null);
  const line = formatScanCacheLine({ files: 52991, bytes: 123456, strategy: 'metadata', writtenAt: '2026-11-15T18:20:00.000Z' });
  assert.match(line, /Cache: 52,991 files unchanged since \d\d:\d\d \(metadata\)/);
  const one = formatScanCacheLine({ files: 1, bytes: 10, strategy: 'metadata', writtenAt: '2026-11-15T18:20:00.000Z' });
  assert.match(one, /Cache: 1 file unchanged since/);
});

test('scan-cache: scanCacheRelativePath is null outside the root', () => {
  const root = tempDir('dev-diagnosis-scan-cache-');
  assert.equal(scanCacheRelativePath(root, path.join(root, '.dev-diagnosis-cache.json')), '.dev-diagnosis-cache.json');
  assert.equal(scanCacheRelativePath(root, path.join(root, 'sub', 'cache.json')), 'sub/cache.json');
  assert.equal(scanCacheRelativePath(root, '/tmp/outside.json'), null);
  assert.equal(scanCacheRelativePath(root, root), null);
});

test('scan-cache: fresh and cached scans agree except for the cached field', () => {
  const root = makeRepo({
    'src/index.js': 'console.log("hi");\n',
    'data/export.json': 'x'.repeat(1500000),
    'logs/dev.log': 'y'.repeat(50000),
    'config.js': `${keyA}\n`,
  });
  const fresh = scanDirectory(root, {});
  assert.equal(fresh.cached, null);
  const first = scanWithCache(root);
  assert.equal(first.cached, null); // first run: no cache file yet
  assert.ok(fs.existsSync(cachePathFor(root)));
  const second = scanWithCache(root);
  assert.equal(second.cached.files, 4);
  assert.equal(second.cached.strategy, 'metadata');
  assert.ok(typeof second.cached.writtenAt === 'string');
  // The cache file itself is never counted: the second scan sees the
  // same file count as the first, which ran before the file existed.
  assert.equal(second.files, fresh.files);
  assert.equal(second.files, first.files);
  const { cached: _c1, ...firstRest } = first;
  const { cached: _c2, ...secondRest } = second;
  assert.deepEqual(secondRest, firstRest);
  // The cached run still reports the secret finding, with its rule
  // and line — nothing the cache remembered was lost.
  const secrets = second.review.filter((item) => item.kind === 'secret');
  assert.equal(secrets.length, 1);
  assert.equal(secrets[0].rule, 'generic-api-key');
  assert.equal(secrets[0].line, 1);
});

test('scan-cache: a touched file re-scans and its new finding appears', () => {
  const root = makeRepo({
    'a.js': 'console.log(1);\n',
    'config.js': `${keyA}\n`,
  });
  scanWithCache(root);
  const second = scanWithCache(root);
  assert.equal(second.cached.files, 2);
  // Rewrite config.js with a different secret and force a new mtime:
  // the entry must miss, the new finding must appear, and the old one
  // must be gone.
  fs.writeFileSync(path.join(root, 'config.js'), `${keyB}\n`);
  fs.utimesSync(path.join(root, 'config.js'), new Date('2020-01-01'), new Date('2020-01-01'));
  const third = scanWithCache(root);
  assert.equal(third.cached.files, 1);
  const secrets = third.review.filter((item) => item.kind === 'secret');
  assert.equal(secrets.length, 1);
  assert.equal(secrets[0].rule, 'generic-api-key');
  assert.equal(secrets[0].line, 1);
  const cache = loadFor(root);
  assert.ok(cache.files['config.js']);
  assert.equal(cache.files['config.js'].f.length, 1);
  // The cached finding is the new secret's fingerprint, not the old one.
  const freshFindings = scanTextForSecrets(keyB, 'config.js');
  assert.equal(cache.files['config.js'].f[0][2], freshFindings[0].fingerprint);
  const oldFindings = scanTextForSecrets(keyA, 'config.js');
  assert.notEqual(cache.files['config.js'].f[0][2], oldFindings[0].fingerprint);
});

test('scan-cache: a fully-cached run leaves the cache file untouched; a change rewrites it', () => {
  const root = makeRepo({ 'a.js': 'console.log(1);\n', 'b.js': 'console.log(2);\n' });
  scanWithCache(root);
  const cacheFile = cachePathFor(root);
  const old = new Date('2020-01-01');
  fs.utimesSync(cacheFile, old, old);
  const before = fs.readFileSync(cacheFile, 'utf8');
  const second = scanWithCache(root);
  assert.equal(second.cached.files, 2);
  // Nothing changed: no rewrite, so both the bytes and the mtime
  // are exactly what the first run left.
  assert.equal(fs.readFileSync(cacheFile, 'utf8'), before);
  assert.equal(fs.statSync(cacheFile).mtimeMs, old.getTime());
  // Touch one file: the next run must rewrite, with a fresh entry.
  fs.writeFileSync(path.join(root, 'a.js'), 'console.log(11);\n');
  fs.utimesSync(path.join(root, 'a.js'), new Date('2020-06-01'), new Date('2020-06-01'));
  const third = scanWithCache(root);
  assert.equal(third.cached.files, 1);
  assert.notEqual(fs.statSync(cacheFile).mtimeMs, old.getTime());
  assert.equal(loadFor(root).files['a.js'].s, fs.statSync(path.join(root, 'a.js')).size);
  // A deleted file also rewrites: the entry must be gone afterwards.
  fs.unlinkSync(path.join(root, 'b.js'));
  const fourth = scanWithCache(root);
  assert.equal(fourth.cached.files, 1);
  assert.deepEqual(Object.keys(loadFor(root).files), ['a.js']);
});

test('scan-cache: a deleted file drops from the cache on a full-scope scan', () => {
  const root = makeRepo({
    'a.js': 'console.log(1);\n',
    'b.js': 'console.log(2);\n',
    'c.js': 'console.log(3);\n',
  });
  scanWithCache(root);
  fs.unlinkSync(path.join(root, 'b.js'));
  const second = scanWithCache(root);
  assert.equal(second.cached.files, 2);
  const cache = loadFor(root);
  assert.deepEqual(Object.keys(cache.files).sort(), ['a.js', 'c.js']);
});

test('scan-cache: an .aiignore change forces a full re-scan, then the cache is fast again', () => {
  const root = makeRepo({ 'a.js': 'console.log(1);\n', 'notes.txt': 'hello\n' });
  scanWithCache(root);
  const second = scanWithCache(root);
  assert.equal(second.cached.files, 2);
  fs.writeFileSync(path.join(root, '.aiignore'), 'unrelated-dir/\n');
  const third = scanWithCache(root);
  assert.equal(third.cached, null); // header mismatch: full scan
  const fourth = scanWithCache(root);
  assert.equal(fourth.cached.files, 2);
});

test('scan-cache: a nested .gitignore change forces a full re-scan', () => {
  const root = makeRepo({
    'a.js': 'console.log(1);\n',
    'sub/b.js': 'console.log(2);\n',
    'sub/.gitignore': 'ignored.txt\n',
  });
  scanWithCache(root);
  const second = scanWithCache(root);
  // a.js, sub/b.js and the sub/.gitignore file itself are all scanned.
  assert.equal(second.cached.files, 3);
  fs.writeFileSync(path.join(root, 'sub', '.gitignore'), 'ignored.txt\nother.txt\n');
  const third = scanWithCache(root);
  assert.equal(third.cached, null);
});

test('scan-cache: a nested .aiignore change forces a full re-scan', () => {
  const root = makeRepo({
    'a.js': 'console.log(1);\n',
    'sub/b.js': 'console.log(2);\n',
    'sub/.aiignore': 'ignored.txt\n',
  });
  scanWithCache(root);
  const second = scanWithCache(root);
  // a.js, sub/b.js and the sub/.aiignore file itself are all scanned.
  assert.equal(second.cached.files, 3);
  fs.writeFileSync(path.join(root, 'sub', '.aiignore'), 'ignored.txt\nother.txt\n');
  const third = scanWithCache(root);
  assert.equal(third.cached, null);
  const fourth = scanWithCache(root);
  assert.equal(fourth.cached.files, 3);
});

test('scan-cache: a corrupt cache warns and the scan runs fresh, then rewrites the cache', () => {
  const root = makeRepo({ 'a.js': 'console.log(1);\n' });
  fs.writeFileSync(cachePathFor(root), 'not json{{{');
  const check = runContextCheck(root, {
    cache: true,
    cacheLocation: null,
  });
  assert.equal(check.result.cached, null);
  assert.equal(check.cacheWarnings.length, 1);
  assert.match(check.cacheWarnings[0], /not valid JSON/);
  // The corrupt file was replaced by a valid cache.
  const { cache, warning } = loadScanCache(cachePathFor(root));
  assert.equal(warning, null);
  assert.ok(cache.files['a.js']);
});

test('scan-cache: a scoped scan upserts but never drops entries outside its scope', () => {
  const root = makeRepo({
    'a.js': 'console.log(1);\n',
    'b.js': 'console.log(2);\n',
  });
  scanWithCache(root);
  fs.unlinkSync(path.join(root, 'a.js'));
  fs.writeFileSync(path.join(root, 'b.js'), 'console.log(22);\n');
  fs.utimesSync(path.join(root, 'b.js'), new Date('2020-01-01'), new Date('2020-01-01'));
  const scoped = scanDirectory(root, {
    changed: { ref: 'HEAD', files: ['b.js'], staged: false },
    scanCache: { path: cachePathFor(root), data: loadFor(root) },
  });
  assert.equal(scoped.cached.files, 0); // b.js changed: no hits in scope
  assert.equal(scoped.files, 1);
  const cache = loadFor(root);
  // a.js is gone from disk but was outside the scope: its entry stays.
  assert.ok(cache.files['a.js']);
  assert.ok(cache.files['b.js']);
  assert.equal(cache.files['b.js'].s, fs.statSync(path.join(root, 'b.js')).size);
});

test('scan-cache: a custom --cache-location is honoured, inside and outside the root', () => {
  const root = makeRepo({ 'a.js': 'console.log(1);\n' });
  fs.mkdirSync(path.join(root, 'sub'));
  const first = runContextCheck(root, { cache: true, cacheLocation: 'sub/cache.json' });
  assert.equal(first.result.cached, null);
  assert.ok(fs.existsSync(path.join(root, 'sub', 'cache.json')));
  assert.ok(!fs.existsSync(cachePathFor(root)));
  const second = runContextCheck(root, { cache: true, cacheLocation: 'sub/cache.json' });
  assert.equal(second.result.cached.files, 1);
  const outside = runContextCheck(root, { cache: true, cacheLocation: '../outside-cache.json' });
  assert.equal(outside.result.cached, null);
  assert.ok(fs.existsSync(path.join(root, '..', 'outside-cache.json')));
  fs.unlinkSync(path.join(root, '..', 'outside-cache.json'));
});

test('scan-cache: a cache that cannot be written warns instead of failing the scan', () => {
  const root = makeRepo({ 'a.js': 'console.log(1);\n' });
  const check = runContextCheck(root, { cache: true, cacheLocation: 'no-such-dir/cache.json' });
  assert.equal(check.result.score, 100);
  assert.equal(check.result.cached, null);
  assert.equal(check.cacheWarnings.length, 1);
  assert.match(check.cacheWarnings[0], /cannot write scan cache/);
});

test('scan-cache: without --cache the result carries cached: null', () => {
  const root = makeRepo({ 'a.js': 'console.log(1);\n' });
  const check = runContextCheck(root, {});
  assert.equal(check.result.cached, null);
  assert.equal(check.cacheOptions, undefined);
  assert.equal(check.cacheWarnings, undefined);
});

test('scan-cache: a baselined finding stays suppressed on a cached run, and a new secret still fails', () => {
  const root = makeRepo({ 'config.js': `${keyA}\n`, 'a.js': 'console.log(1);\n' });
  const baselinePath = path.join(root, '.dev-diagnosis-secrets-baseline.json');
  const findings = scanTextForSecrets(keyA, 'config.js');
  writeSecretsBaseline(baselinePath, findings, { generator: 'test 0.0.0' });
  const opts = { cache: true, secretsBaselinePath: baselinePath };
  const first = runContextCheck(root, opts);
  assert.equal(first.result.secretsBaseline.suppressed, 1);
  assert.equal(first.passed, true);
  const second = runContextCheck(root, opts);
  // config.js, a.js and the baseline file itself are all scanned.
  assert.equal(second.result.cached.files, 3);
  assert.equal(second.result.secretsBaseline.suppressed, 1);
  assert.equal(second.passed, true);
  assert.equal(second.result.review.filter((item) => item.kind === 'secret').length, 0);
  // A new secret in a touched file is not in the baseline: it fails
  // the check even on a cached run — the cache never hides a new
  // finding behind an old fingerprint.
  fs.writeFileSync(path.join(root, 'config.js'), `${keyA}\n${keyB}\n`);
  fs.utimesSync(path.join(root, 'config.js'), new Date('2020-01-01'), new Date('2020-01-01'));
  const third = runContextCheck(root, opts);
  assert.equal(third.result.cached.files, 2);
  assert.equal(third.result.secretsBaseline.suppressed, 1);
  assert.equal(third.passed, false);
  assert.match(third.verdict, /new secret/);
});

test('scan-cache: cached re-scan is much faster than fresh on a 3,000-file tree', () => {
  const root = tempDir('dev-diagnosis-scan-cache-');
  const content = 'x'.repeat(20000);
  for (let i = 0; i < 3000; i += 1) {
    const dir = path.join(root, `pkg${Math.floor(i / 100)}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `file${i}.js`), `// ${i}\n${content}\n`);
  }
  const time = (fn) => {
    const start = process.hrtime.bigint();
    fn();
    return Number(process.hrtime.bigint() - start) / 1e6;
  };
  const freshMs = time(() => scanDirectory(root, {}));
  scanWithCache(root); // writes the cache
  const cachedMs = time(() => scanWithCache(root));
  const second = scanWithCache(root);
  assert.equal(second.cached.files, 3000);
  assert.ok(cachedMs < freshMs * 0.25, `cached ${cachedMs.toFixed(0)} ms is not < 25% of fresh ${freshMs.toFixed(0)} ms`);
});
