import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tempDir } from '../scripts/support.mjs';
import { estimateTokens, formatBytes } from '../lib/context.mjs';
import { formatTokens } from '../lib/report.mjs';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgVersion = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;

// The demo fixture's listed noise is its one large file. Its byte count
// is the source of the token estimate and the summary's noise size —
// read it from the fixture instead of hardcoding a number, so the
// assertions hold on a Windows checkout too (CRLF conversion grows the
// file by one byte per line).
const demoNoiseFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'demo-repo', 'data', 'export.json');
const demoNoiseBytes = fs.statSync(demoNoiseFile).size;

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'dev-diagnosis.js');
const demoRepo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'demo-repo');
const demoRuns = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'runs');

function run(args, options = {}) {
  return spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', ...options });
}

// Tests that run a build against the demo repo get a private copy of
// it. The cache check moves the repo's .cache aside and back, so two
// of them running in parallel on the shared fixture (node --test runs
// test files concurrently) corrupt each other's cold/warm runs and
// flake. Read-only checks keep using the shared fixture.
function freshDemoRepo() {
  const dir = tempDir('dev-diagnosis-demo-');
  const copy = path.join(dir, 'demo-repo');
  fs.cpSync(demoRepo, copy, { recursive: true });
  return copy;
}

test('cli: --help lists all four checks', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0);
  for (const word of ['context', 'path', 'cache', 'flakes', 'all', '--fix']) {
    assert.ok(result.stdout.includes(word), `help should mention ${word}`);
  }
});

test('cli: --version prints the package version', () => {
  const result = run(['--version']);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), pkgVersion);
});

test('cli: an unknown command is a usage error', () => {
  const result = run(['frobnicate']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown command/);
});

test('cli: a bare path means all on that path', () => {
  const result = run([demoRepo]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, new RegExp(`dev-diagnosis — ${demoRepo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(result.stdout, /== context ==/);
  assert.match(result.stdout, /== skipped ==/);
  assert.match(result.stdout, /Overall: FAIL/);
});

test('cli: a bare path with options runs all with those options', () => {
  const result = run([demoRepo, '--command', 'node']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /== path ==/);
  assert.match(result.stdout, /node resolves to/);
});

test('cli: a bare path that is not a directory is still a usage error', () => {
  const result = run(['./definitely-not-a-directory-xyz']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown command/);
});

test('cli: context on the demo repo finds noise and exits 1', () => {
  const result = run(['context', demoRepo]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Score: 75\/100/);
  assert.match(result.stdout, /data\/export\.json/);
  // The demo's dist/, log and lockfile are each 0% of the total and
  // lose 0 points, so they are not listed as noise any more.
  assert.doesNotMatch(result.stdout, /dist\//);
  assert.doesNotMatch(result.stdout, /package-lock\.json/);
  assert.match(result.stdout, /FAIL/);
});

test('cli: context --json is valid JSON', () => {
  const result = run(['context', demoRepo, '--json']);
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.ok(parsed.score < 85);
  assert.ok(Array.isArray(parsed.noise));
});

test('cli: path finds node and misses a made-up command', () => {
  const found = run(['path', 'node']);
  assert.equal(found.status, 0);
  assert.match(found.stdout, /current\s+\S*node/);
  const missed = run(['path', 'definitely-not-a-command-xyz']);
  assert.equal(missed.status, 1);
  assert.match(missed.stdout, /MISS/);
});

test('cli: path verdict says "not found in any shell context" when it misses everywhere', () => {
  const result = run(['path', 'definitely-not-a-command-xyz']);
  assert.equal(result.status, 1);
  // The old verdict said "missing in the current shell", which understated
  // a miss in all four contexts — it sounded like the command might exist
  // somewhere else.
  assert.match(result.stdout, /definitely-not-a-command-xyz is not found in any shell context/);
  assert.doesNotMatch(result.stdout, /missing in the current shell/);
});

test('cli: path verdict names the context where a command resolves', () => {
  // A command that only the login shell can see: the classic "works in
  // the terminal, not in the IDE" case. The verdict should say where it
  // resolves instead of just saying the current shell misses it.
  const dir = tempDir('dev-diagnosis-path-login-');
  const binDir = path.join(dir, 'bin');
  const emptyDir = path.join(dir, 'empty');
  fs.mkdirSync(binDir);
  fs.mkdirSync(emptyDir);
  const tool = process.platform === 'win32' ? path.join(binDir, 'mytool.cmd') : path.join(binDir, 'mytool');
  fs.writeFileSync(tool, process.platform === 'win32' ? '@echo off\n' : '#!/bin/sh\necho hi\n');
  if (process.platform !== 'win32') fs.chmodSync(tool, 0o755);
  const env = {
    ...process.env,
    PATH: emptyDir,
    DEV_DOCTOR_LOGIN_PATH: binDir,
    DEV_DOCTOR_NON_LOGIN_PATH: emptyDir,
    DEV_DOCTOR_DAEMON_PATH: emptyDir,
  };
  const result = run(['path', 'mytool'], { env });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /current\s+MISS/);
  assert.match(result.stdout, /login\s+\S*mytool/);
  assert.match(result.stdout, /mytool is missing in the current shell, but resolves in login/);
  assert.match(result.stdout, /Fix: it resolves in another shell context/);
});

test('cli: flakes on the demo runs ranks the always-failing test first', () => {
  const result = run(['flakes', demoRuns]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /always-failing: 1/);
  assert.match(result.stdout, /rejectsExpiredToken/);
  assert.match(result.stdout, /appliesCoupon/);
});

test('cli: flakes --json --top limits the tests array but not the totals', () => {
  const result = run(['flakes', demoRuns, '--json', '--top', '1']);
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.tests.length, 1);
  assert.equal(parsed.totals.tests, 5);
  assert.equal(parsed.tests[0].id, 'com.example.LoginTest::rejectsExpiredToken');
});

test('cli: all --json --top limits the embedded flakes tests', () => {
  const result = run(['all', demoRepo, '--flakes', demoRuns, '--json', '--top', '1']);
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.checks.flakes.tests.length, 1);
  assert.equal(parsed.checks.flakes.totals.tests, 5);
});

test('cli: all --json keeps the reason when flakes cannot run', () => {
  const missing = path.join(demoRepo, 'no-such-runs');
  const result = run(['all', demoRepo, '--flakes', missing, '--json']);
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.overall, 'FAIL');
  assert.ok(parsed.checks.context, 'context still present');
  assert.match(parsed.checks.flakes.error, /runs directory not found/);
  assert.match(parsed.checks.flakes.error, /no-such-runs/);
});

test('cli: all --json keeps the reason when the cache build fails', () => {
  const dir = tempDir('dev-diagnosis-all-cache-');
  fs.mkdirSync(path.join(dir, '.cache'), { recursive: true });
  const result = run(['all', dir, '--json', '--', process.execPath, '-e', 'process.exit(3)']);
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.overall, 'FAIL');
  assert.match(parsed.checks.cache.error, /cold build failed \(exit 3\)/);
});

test('cli: flakes with only a broken XML file fails and names the file', () => {
  const dir = tempDir('dev-diagnosis-flakes-broken-');
  fs.mkdirSync(path.join(dir, 'run-01'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'run-01', 'broken.xml'), '<testsuites><testsuite><testcase classname="T" name="t"><failure/></testcase></testsuite>');
  const result = run(['flakes', dir]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /tests: 0/);
  assert.match(result.stdout, /Warning: 1 file could not be parsed/);
  assert.match(result.stdout, /broken\.xml/);
  assert.match(result.stdout, /FAIL/);
  assert.match(result.stdout, /1 file could not be parsed/);
});

test('cli: flakes with only an empty XML file fails and names the file', () => {
  const dir = tempDir('dev-diagnosis-flakes-empty-');
  fs.mkdirSync(path.join(dir, 'run-01'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'run-01', 'empty.xml'), '');
  const result = run(['flakes', dir]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /tests: 0/);
  assert.match(result.stdout, /Warning: 1 file could not be parsed/);
  assert.match(result.stdout, /empty\.xml/);
  assert.match(result.stdout, /no root element/);
  assert.match(result.stdout, /FAIL/);
  assert.match(result.stdout, /1 file could not be parsed/);
});

test('cli: flakes with an empty run directory fails and names the run', () => {
  const dir = tempDir('dev-diagnosis-flakes-empty-run-');
  fs.mkdirSync(path.join(dir, 'run-01'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'run-02-empty'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'run-01', 'results.xml'), `<?xml version="1.0"?><testsuites><testsuite><testcase classname="T" name="t"/></testsuite></testsuites>`);
  const result = run(['flakes', dir]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /runs: 1/);
  assert.match(result.stdout, /No flaky tests/);
  assert.match(result.stdout, /run-02-empty/);
  assert.match(result.stdout, /no JUnit XML files/);
  assert.match(result.stdout, /FAIL/);
  assert.match(result.stdout, /1 run directory had no JUnit XML files/);
});

test('cli: flakes --json reports the skipped run directory', () => {
  const dir = tempDir('dev-diagnosis-flakes-empty-run-json-');
  fs.mkdirSync(path.join(dir, 'run-01'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'run-02-empty'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'run-01', 'results.xml'), `<?xml version="1.0"?><testsuites><testsuite><testcase classname="T" name="t"/></testsuite></testsuites>`);
  const result = run(['flakes', dir, '--json']);
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.totals.runs, 1);
  assert.deepEqual(parsed.skippedRuns, [{ id: 'run-02-empty', reason: 'no JUnit XML files found' }]);
});

test('cli: flakes with a broken file next to a clean run still fails', () => {  const dir = tempDir('dev-diagnosis-flakes-mixed-');
  fs.mkdirSync(path.join(dir, 'run-01'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'run-02'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'run-01', 'results.xml'), `<?xml version="1.0"?><testsuites><testsuite><testcase classname="T" name="t"/></testsuite></testsuites>`);
  fs.writeFileSync(path.join(dir, 'run-02', 'broken.xml'), '<testsuites><testcase>');
  const result = run(['flakes', dir]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /No flaky tests/);
  assert.match(result.stdout, /Warning: 1 file could not be parsed/);
  assert.match(result.stdout, /FAIL/);
});

test('cli: cache on the demo repo pays', () => {
  const result = run(['cache', '--cwd', freshDemoRepo(), '--', 'node', 'build.mjs']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Verdict: cache pays/);
});

test('cli: cache --json leaves the build stdout out of the JSON', () => {
  const result = run(['cache', '--cwd', freshDemoRepo(), '--json', '--', 'node', 'build.mjs']);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.verdict, 'cache pays');
  assert.ok(Number.isFinite(parsed.coldMs) && Number.isFinite(parsed.warmMs));
  assert.ok(!('coldStdout' in parsed) && !('warmStdout' in parsed));
});

test('cli: all --json leaves the build stdout out of the cache check', () => {
  const result = run(['all', freshDemoRepo(), '--command', 'node', '--flakes', demoRuns, '--json', '--', 'node', 'build.mjs']);
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.checks.cache.verdict, 'cache pays');
  assert.ok(Number.isFinite(parsed.checks.cache.coldMs));
  assert.ok(!('coldStdout' in parsed.checks.cache) && !('warmStdout' in parsed.checks.cache));
});

test('cli: all on the demo repo runs all four checks and reports the skips honestly', () => {
  const result = run(['all', freshDemoRepo(), '--command', 'node', '--flakes', demoRuns, '--', 'node', 'build.mjs']);
  assert.equal(result.status, 1);
  for (const section of ['== context ==', '== path ==', '== flakes ==', '== cache ==']) {
    assert.ok(result.stdout.includes(section), `all should print ${section}`);
  }
  assert.match(result.stdout, /Overall: FAIL/);
});

test('cli: all without options runs context and lists the other three as skipped', () => {
  const result = run(['all', demoRepo]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /== skipped ==/);
  assert.match(result.stdout, /--command/);
  assert.match(result.stdout, /--flakes/);
});

test('cli: context --fix writes .aiignore and is idempotent', () => {
  const dir = tempDir('dev-diagnosis-fix-');
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'dist', 'app.js'), 'bundled\n');
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}\n');
  fs.writeFileSync(path.join(dir, 'src.js'), 'x\n');
  // The fix command reports the repo as it stands after the fix: it
  // re-scans and exits 0 when the fix leaves the repo clean, instead
  // of exiting 1 on the pre-fix verdict after a successful fix.
  const first = run(['context', dir, '--fix']);
  assert.equal(first.status, 0);
  assert.match(first.stdout, /Created \.aiignore with 2 entries/);
  assert.match(first.stdout, /Re-scanned after fix: Score: 100\/100/);
  assert.match(first.stdout, /PASS  context is clean/);
  const ignore = fs.readFileSync(path.join(dir, '.aiignore'), 'utf8');
  assert.ok(ignore.includes('dist/\n'), ignore);
  assert.ok(ignore.includes('package-lock.json\n'), ignore);
  // A second scan honours .aiignore: the noise is hidden, the repo is
  // clean, and there is nothing left to add.
  const second = run(['context', dir, '--fix']);
  assert.equal(second.status, 0);
  assert.match(second.stdout, /Score: 100\/100/);
  assert.match(second.stdout, /Nothing to add to \.aiignore: no suggestions/);
  assert.equal(fs.readFileSync(path.join(dir, '.aiignore'), 'utf8'), ignore);
});

test('cli: context --fix never writes review suggestions', () => {
  const dir = tempDir('dev-diagnosis-fix-review-');
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'dist', 'app.js'), 'bundled\n'.repeat(100));
  fs.writeFileSync(path.join(dir, 'secret.js'), 'const s = "AKIAIOSFODNN7EXAMPLE";\n');
  fs.mkdirSync(path.join(dir, 'test', 'fixtures', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'test', 'fixtures', 'lib', 'secret.js'), 'module.exports = {};\n');
  const first = run(['context', dir, '--fix']);
  assert.equal(first.status, 0); // the fix leaves the repo clean, so the post-fix verdict is PASS
  assert.match(first.stdout, /Created \.aiignore with 1 entry: dist\//);
  const ignore = fs.readFileSync(path.join(dir, '.aiignore'), 'utf8');
  assert.ok(ignore.includes('dist/\n'), ignore);
  assert.ok(!ignore.includes('secret.js'), ignore);
  // The review item is shown as advisory instead, and the fixture is
  // still listed on a re-scan — it was not silently hidden.
  assert.match(first.stdout, /Consider for \.aiignore \(advisory — --fix does not write these\):/);
  const second = run(['context', dir]);
  assert.equal(second.status, 0);
  assert.match(second.stdout, /test\/fixtures\/lib\/secret\.js — environment-like file/);
});

test('cli: context --json --fix reports the fix in the JSON', () => {
  const dir = tempDir('dev-diagnosis-fix-json-');
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'dist', 'app.js'), 'bundled\n');
  const result = run(['context', dir, '--json', '--fix']);
  assert.equal(result.status, 0); // the JSON reports the post-fix scan
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.score, 100);
  assert.deepEqual(parsed.fix.added, ['dist/']);
  assert.equal(parsed.fix.created, true);
});

test('cli: all --fix applies the context fix', () => {
  const dir = tempDir('dev-diagnosis-fix-all-');
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}\n');
  const result = run(['all', dir, '--fix']);
  assert.equal(result.status, 0); // the only failing check was fixed
  assert.match(result.stdout, /Created \.aiignore with 1 entry: package-lock\.json/);
  assert.match(result.stdout, /Re-scanned after fix: Score: 100\/100/);
  assert.match(result.stdout, /Overall: PASS/);
  assert.equal(fs.readFileSync(path.join(dir, '.aiignore'), 'utf8'), 'package-lock.json\n');
});

test('cli: all --fix still fails when another check fails', () => {
  // The fix must not mask a failure it did not fix: context comes back
  // clean (94/100 on the demo repo — the small files still count, but
  // pass), while the flaky test still fails the run.
  const repo = freshDemoRepo();
  const result = run(['all', repo, '--flakes', demoRuns, '--fix']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Re-scanned after fix: Score: 94\/100/);
  assert.match(result.stdout, /PASS  context is clean/);
  assert.match(result.stdout, /Overall: FAIL/);
  assert.equal(fs.readFileSync(path.join(repo, '.aiignore'), 'utf8'), 'data/export.json\n');
});

test('cli: --fix on a check without an .aiignore fix is a usage error', () => {
  const result = run(['path', 'node', '--fix']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--fix only applies to context/);
});

test('cli: all skips cache when the repo has no cache directory', () => {
  const dir = tempDir('dev-diagnosis-nocache-');
  fs.writeFileSync(path.join(dir, 'index.js'), 'console.log(1)\n');
  const result = run(['all', dir, '--', 'node', '-e', '1']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /== skipped ==/);
  assert.match(result.stdout, /no cache directory found/);
  assert.match(result.stdout, /Overall: PASS/);
});

test('cli: context --json reports the token estimate, null when clean', () => {
  const noisy = run(['context', demoRepo, '--json']);
  assert.equal(noisy.status, 1);
  const parsed = JSON.parse(noisy.stdout);
  // The demo's listed noise is the data dump: the estimate is its byte
  // count at ~4 bytes per token (see estimateTokens). The range below
  // is a sanity bound; the exact line is asserted in the next test.
  assert.ok(Number.isInteger(parsed.estimatedTokens));
  assert.ok(parsed.estimatedTokens > 400000 && parsed.estimatedTokens < 500000);
  const dir = tempDir('dev-diagnosis-tokens-clean-');
  fs.writeFileSync(path.join(dir, 'index.js'), 'console.log(1)\n');
  const clean = run(['context', dir, '--json']);
  assert.equal(clean.status, 0);
  assert.equal(JSON.parse(clean.stdout).estimatedTokens, null);
});

test('cli: context prints the token estimate line next to the noise', () => {
  const result = run(['context', demoRepo]);
  assert.equal(result.status, 1);
  const expected = formatTokens(estimateTokens(demoNoiseBytes));
  assert.match(result.stdout, new RegExp(`Estimated tokens wasted on this noise: ≈ ${expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} tokens \\(estimate, ~4 bytes per token\\)`));
});

test('cli: all prints a summary line with counts, noise and cache saving', () => {
  const result = run(['all', freshDemoRepo(), '--command', 'node', '--flakes', demoRuns, '--', 'node', 'build.mjs']);
  assert.equal(result.status, 1);
  const expectedSize = formatBytes(demoNoiseBytes);
  assert.match(result.stdout, new RegExp(`Summary: 4 checks — 2 passed, 2 failed, 0 skipped; context noise ${expectedSize.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}; cache saved \\d+%`));
});

test('cli: all --json includes the summary object', () => {
  const result = run(['all', freshDemoRepo(), '--command', 'node', '--flakes', demoRuns, '--json', '--', 'node', 'build.mjs']);
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(parsed.summary.checks, { total: 4, passed: 2, failed: 2, skipped: 0 });
  assert.ok(parsed.summary.contextNoiseBytes > 1000000);
  assert.ok(Number.isInteger(parsed.summary.cacheSavedPct));
});

test('cli: all with skips counts them in the summary', () => {
  const result = run(['all', demoRepo, '--json']);
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(parsed.summary.checks, { total: 4, passed: 0, failed: 1, skipped: 3 });
  assert.equal(parsed.summary.cacheSavedPct, null);
});

test('cli: --help lists --mcp, --sandbox and --skill-generate', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0);
  for (const word of ['--mcp', '--sandbox', '--root', '--skill-generate', '--global', '--project']) {
    assert.ok(result.stdout.includes(word), `help should mention ${word}`);
  }
});

test('cli: --sandbox without --mcp is a usage error', () => {
  const result = run(['--sandbox', demoRepo]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--sandbox\/--root only applies to --mcp/);
});

test('cli: --mcp and --skill-generate together is a usage error', () => {
  const result = run(['--mcp', '--skill-generate']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /cannot be combined/);
});
