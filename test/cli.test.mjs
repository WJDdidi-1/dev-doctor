import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'dev-doctor.js');
const demoRepo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'demo-repo');
const demoRuns = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'runs');

function run(args, options = {}) {
  return spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', ...options });
}

test('cli: --help lists all four checks', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0);
  for (const word of ['context', 'path', 'cache', 'flakes', 'all']) {
    assert.ok(result.stdout.includes(word), `help should mention ${word}`);
  }
});

test('cli: --version prints 0.1.0', () => {
  const result = run(['--version']);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), '0.1.0');
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
