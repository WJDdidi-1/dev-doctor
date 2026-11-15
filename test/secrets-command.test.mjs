import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { UsageError, runSecretsCheck } from '../lib/checks.mjs';
import { writeSecretsBaseline } from '../lib/baseline.mjs';
import { tempDir } from '../scripts/support.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'bin', 'dev-diagnosis.js');

function run(args, options = {}) {
  return spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', ...options });
}

// Corpus lines are built from fragments, never written as one literal:
// this file itself is scanned by the tool's own dogfood run, so a
// complete fake credential on one line would be a finding in our own
// repo. The fragments never co-occur on a physical line.
const keyLine = ['api', 'key'].join('_') + ' = "' + '9f8e7d6c' + '5b4a3928' + '1706f5e4' + 'd3c2b1a0' + '"';
const keyValue = '9f8e7d6c' + '5b4a3928' + '1706f5e4' + 'd3c2b1a0';
const otherKeyLine = ['api', 'key'].join('_') + ' = "' + '1a2b3c4d' + '5e6f7a8b' + '9c0d1e2f' + '3a4b5c6d' + '"';

function makeSecretDir() {
  const dir = tempDir('dev-diagnosis-secrets-command-');
  fs.writeFileSync(path.join(dir, 'config.js'), `${keyLine}\n`);
  fs.writeFileSync(path.join(dir, 'index.js'), 'x\n');
  return dir;
}

test('secrets: runSecretsCheck passes a clean file', () => {
  const dir = makeSecretDir();
  const check = runSecretsCheck([path.join(dir, 'index.js')]);
  assert.equal(check.passed, true);
  assert.match(check.verdict, /no secrets found in 1 file/);
  assert.deepEqual(check.result.findings, []);
  assert.deepEqual(check.result.errors, []);
  assert.equal(check.result.secretsBaseline, null);
  assert.equal(check.result.files.length, 1);
});

test('secrets: runSecretsCheck finds a secret and never carries the value', () => {
  const dir = makeSecretDir();
  const check = runSecretsCheck([path.join(dir, 'config.js')]);
  assert.equal(check.passed, false);
  assert.match(check.verdict, /1 possible secret in 1 file/);
  assert.match(check.verdict, /rotate the flagged credential/);
  assert.equal(check.result.findings.length, 1);
  const finding = check.result.findings[0];
  assert.equal(finding.rule, 'generic-api-key');
  assert.equal(finding.line, 1);
  assert.ok(finding.path.endsWith('config.js'), `finding path was ${finding.path}`);
  assert.ok(!('value' in finding), 'a finding must never carry the matched value');
  assert.ok(!JSON.stringify(check.result).includes(keyValue), 'the result JSON must never contain the matched value');
});

test('secrets: runSecretsCheck reports a missing file and a directory as errors', () => {
  const dir = makeSecretDir();
  const check = runSecretsCheck([path.join(dir, 'no-such.txt'), dir]);
  assert.equal(check.passed, false);
  assert.equal(check.result.errors.length, 2);
  assert.deepEqual(check.result.errors.map((error) => error.reason), ['no such file', 'not a file']);
  assert.match(check.verdict, /could not read 2 files/);
  assert.match(check.verdict, /no-such\.txt/);
});

test('secrets: runSecretsCheck with no files throws a usage error', () => {
  assert.throws(() => runSecretsCheck([]), (error) => error instanceof UsageError && /needs at least one file/.test(error.message));
  assert.throws(() => runSecretsCheck(null), UsageError);
});

test('secrets: runSecretsCheck suppresses baselined findings', () => {
  const dir = makeSecretDir();
  const first = runSecretsCheck([path.join(dir, 'config.js')]);
  const baselinePath = path.join(dir, 'baseline.json');
  writeSecretsBaseline(baselinePath, first.result.findings);
  const check = runSecretsCheck([path.join(dir, 'config.js')], { secretsBaselinePath: baselinePath });
  assert.equal(check.passed, true);
  assert.deepEqual(check.result.findings, []);
  assert.deepEqual(check.result.secretsBaseline, { path: baselinePath, loaded: true, suppressed: 1 });
  // A secret the baseline does not cover still fails.
  fs.writeFileSync(path.join(dir, 'other.js'), `${otherKeyLine}\n`);
  const second = runSecretsCheck([path.join(dir, 'config.js'), path.join(dir, 'other.js')], { secretsBaselinePath: baselinePath });
  assert.equal(second.passed, false);
  assert.equal(second.result.findings.length, 1);
  assert.equal(second.result.secretsBaseline.suppressed, 1);
});

test('secrets: runSecretsCheck with a missing baseline scans unsuppressed and says so', () => {
  const dir = makeSecretDir();
  const check = runSecretsCheck([path.join(dir, 'config.js')], { secretsBaselinePath: path.join(dir, 'no-such.json') });
  assert.equal(check.passed, false);
  assert.equal(check.result.findings.length, 1);
  assert.deepEqual(check.result.secretsBaseline, { path: path.join(dir, 'no-such.json'), loaded: false, suppressed: 0 });
});

test('cli: secrets on a clean file exits 0', () => {
  const dir = makeSecretDir();
  const result = run(['secrets', 'index.js'], { cwd: dir });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Scanned 1 file for secrets/);
  assert.match(result.stdout, /PASS/);
  assert.match(result.stdout, /no secrets found in 1 file/);
});

test('cli: secrets on a tainted file exits 1 and never prints the value', () => {
  const dir = makeSecretDir();
  const result = run(['secrets', 'config.js'], { cwd: dir });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /config\.js:1 \(generic-api-key\)/);
  assert.match(result.stdout, /possible secret/);
  assert.match(result.stdout, /FAIL/);
  assert.doesNotMatch(result.stdout, new RegExp(keyValue), 'the value must never reach the terminal');
});

test('cli: secrets with no file is a usage error', () => {
  const result = run(['secrets']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /needs at least one file/);
});

test('cli: secrets --json reports the finding as JSON', () => {
  const dir = makeSecretDir();
  const result = run(['secrets', 'config.js', '--json'], { cwd: dir });
  assert.equal(result.status, 1, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.findings.length, 1);
  assert.equal(parsed.findings[0].rule, 'generic-api-key');
  assert.equal(parsed.findings[0].line, 1);
  assert.ok(!JSON.stringify(parsed).includes(keyValue), 'the JSON output must never contain the matched value');
});

test('cli: secrets --write-secrets-baseline records findings and exits 0', () => {
  const dir = makeSecretDir();
  const result = run(['secrets', 'config.js', '--write-secrets-baseline', 'baseline.json'], { cwd: dir });
  assert.equal(result.status, 0, result.stderr);
  const file = path.join(dir, 'baseline.json');
  assert.ok(fs.existsSync(file));
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(data.version, 1);
  assert.equal(data.findings.length, 1);
  assert.equal(data.findings[0].rule, 'generic-api-key');
  assert.match(result.stdout, /recorded: config\.js:1 \(generic-api-key\)/);
  assert.match(result.stdout, /Baseline written to baseline\.json \(1 finding\)/);
  // The recorded finding stops alerting on the next run.
  const suppressed = run(['secrets', 'config.js', '--secrets-baseline', 'baseline.json'], { cwd: dir });
  assert.equal(suppressed.status, 0, suppressed.stderr);
  assert.match(suppressed.stdout, /1 secret finding suppressed by baseline baseline\.json/);
  assert.doesNotMatch(suppressed.stdout, /possible secret/);
});

test('cli: secrets --write-secrets-baseline refuses an unreadable file', () => {
  const dir = makeSecretDir();
  const result = run(['secrets', 'no-such.txt', '--write-secrets-baseline', 'baseline.json'], { cwd: dir });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot write a baseline over unreadable files/);
  assert.ok(!fs.existsSync(path.join(dir, 'baseline.json')), 'no baseline may be written from a partial scan');
});

test('cli: secrets --secrets-baseline and --write-secrets-baseline cannot be combined', () => {
  const dir = makeSecretDir();
  const result = run(['secrets', 'config.js', '--secrets-baseline', 'a.json', '--write-secrets-baseline', 'b.json'], { cwd: dir });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /cannot be combined/);
});

test('cli: secrets refuses --fix and --changed', () => {
  const dir = makeSecretDir();
  const fixed = run(['secrets', 'config.js', '--fix'], { cwd: dir });
  assert.equal(fixed.status, 2);
  assert.match(fixed.stderr, /--fix only applies to context/);
  const changed = run(['secrets', 'config.js', '--changed'], { cwd: dir });
  assert.equal(changed.status, 2);
  assert.match(changed.stderr, /--changed only applies to context/);
});

test('cli: secrets on a missing file exits 1 and names it', () => {
  const dir = makeSecretDir();
  const result = run(['secrets', 'no-such.txt'], { cwd: dir });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /could not read no-such\.txt — no such file/);
  assert.match(result.stdout, /FAIL/);
});

// The commit-msg hook's exact input: pre-commit passes the message
// file to `dev-diagnosis secrets`, so this is the contract the hook
// depends on — a tainted message fails, a clean one passes.
test('cli: secrets scans a commit message file', () => {
  const dir = makeSecretDir();
  const message = path.join(dir, 'COMMIT_EDITMSG');
  fs.writeFileSync(message, `fix: rotate the key\n\n${keyLine}\n`);
  const tainted = run(['secrets', 'COMMIT_EDITMSG'], { cwd: dir });
  assert.equal(tainted.status, 1, tainted.stderr);
  assert.match(tainted.stdout, /COMMIT_EDITMSG:3 \(generic-api-key\)/);
  assert.doesNotMatch(tainted.stdout, new RegExp(keyValue));

  fs.writeFileSync(message, 'fix: rotate the key\n');
  const clean = run(['secrets', 'COMMIT_EDITMSG'], { cwd: dir });
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /no secrets found in 1 file/);
});
