import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgVersion = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'dev-diagnosis.js');
const demoRepo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'demo-repo');
const demoRuns = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'runs');

function run(args, options = {}) {
  return spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', ...options });
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

test('cli: context on the demo repo finds noise and exits 1', () => {
  const result = run(['context', demoRepo]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Score: \d+\/100/);
  assert.match(result.stdout, /dist\//);
  assert.match(result.stdout, /package-lock\.json/);
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

test('cli: flakes on the demo runs ranks the always-failing test first', () => {
  const result = run(['flakes', demoRuns]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /always-failing: 1/);
  assert.match(result.stdout, /rejectsExpiredToken/);
  assert.match(result.stdout, /appliesCoupon/);
});

test('cli: flakes with only a broken XML file fails and names the file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-diagnosis-flakes-broken-'));
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

test('cli: flakes with a broken file next to a clean run still fails', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-diagnosis-flakes-mixed-'));
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
  const result = run(['cache', '--cwd', demoRepo, '--', 'node', 'build.mjs']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Verdict: cache pays/);
});

test('cli: all on the demo repo runs all four checks and reports the skips honestly', () => {
  const result = run(['all', demoRepo, '--command', 'node', '--flakes', demoRuns, '--', 'node', 'build.mjs']);
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-diagnosis-fix-'));
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'dist', 'app.js'), 'bundled\n');
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}\n');
  fs.writeFileSync(path.join(dir, 'src.js'), 'x\n');
  const first = run(['context', dir, '--fix']);
  assert.equal(first.status, 1); // the noise is still there; the fix only hides it from the agent
  assert.match(first.stdout, /Created \.aiignore with 2 entries/);
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

test('cli: context --json --fix reports the fix in the JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-diagnosis-fix-json-'));
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'dist', 'app.js'), 'bundled\n');
  const result = run(['context', dir, '--json', '--fix']);
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(parsed.fix.added, ['dist/']);
  assert.equal(parsed.fix.created, true);
});

test('cli: all --fix applies the context fix', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-diagnosis-fix-all-'));
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}\n');
  const result = run(['all', dir, '--fix']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Created \.aiignore with 1 entry: package-lock\.json/);
  assert.equal(fs.readFileSync(path.join(dir, '.aiignore'), 'utf8'), 'package-lock.json\n');
});

test('cli: --fix on a check without an .aiignore fix is a usage error', () => {
  const result = run(['path', 'node', '--fix']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--fix only applies to context/);
});

test('cli: all skips cache when the repo has no cache directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-diagnosis-nocache-'));
  fs.writeFileSync(path.join(dir, 'index.js'), 'console.log(1)\n');
  const result = run(['all', dir, '--', 'node', '-e', '1']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /== skipped ==/);
  assert.match(result.stdout, /no cache directory found/);
  assert.match(result.stdout, /Overall: PASS/);
});
