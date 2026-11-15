import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tempDir } from '../scripts/support.mjs';
import { scanDirectory } from '../lib/context.mjs';
import { runContextCheck } from '../lib/checks.mjs';
import { scanTextForSecrets } from '../lib/secrets.mjs';
import {
  BASELINE_FILENAME,
  BASELINE_VERSION,
  BaselineError,
  isBaselined,
  loadSecretsBaseline,
  splitBaselined,
  writeSecretsBaseline,
} from '../lib/baseline.mjs';

// Corpus lines are built from fragments, never written as one literal:
// this file itself is scanned by the tool's own dogfood run, so a
// complete fake credential on one line would be a finding in our own
// repo. The fragments never co-occur on a physical line.
const genericKeyLine = ['api', 'key'].join('_') + ' = "' + '9f8e7d6c' + '5b4a3928' + '1706f5e4' + 'd3c2b1a0' + '"';
const otherKeyLine = ['api', 'key'].join('_') + ' = "' + '1a2b3c4d' + '5e6f7a8b' + '9c0d1e2f' + '3a4b5c6d' + '"';
const privateKeyHeader = '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----';

function makeRepo(files) {
  const root = tempDir('dev-diagnosis-baseline-');
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

test('baseline: write then load round-trips, entries sorted by fingerprint', () => {
  const dir = tempDir('dev-diagnosis-baseline-');
  const file = path.join(dir, BASELINE_FILENAME);
  const findings = scanTextForSecrets([genericKeyLine, otherKeyLine].join('\n'), 'config.js');
  assert.equal(findings.length, 2);
  const written = writeSecretsBaseline(file, findings, { generator: 'test 0.0.0' });
  assert.equal(written.count, 2);
  assert.equal(written.path, file);
  const loaded = loadSecretsBaseline(file);
  assert.equal(loaded.version, BASELINE_VERSION);
  assert.equal(loaded.generator, 'test 0.0.0');
  assert.equal(loaded.entries.size, 2);
  const fingerprints = [...loaded.entries.keys()];
  assert.deepEqual(fingerprints, [...fingerprints].sort());
  for (const finding of findings) {
    assert.ok(loaded.entries.has(finding.fingerprint));
    assert.equal(loaded.entries.get(finding.fingerprint).rule, 'generic-api-key');
    assert.equal(loaded.entries.get(finding.fingerprint).path, 'config.js');
    assert.equal(loaded.entries.get(finding.fingerprint).line, finding.line);
  }
  // The file never holds a value: only hashes, rules and addresses.
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(!text.includes('9f8e7d6c5b4a3928'), text);
  assert.ok(!text.includes('1a2b3c4d5e6f7a8b'), text);
});

test('baseline: a missing file loads as null; malformed files throw', () => {
  const dir = tempDir('dev-diagnosis-baseline-');
  assert.equal(loadSecretsBaseline(path.join(dir, 'nope.json')), null);
  const bad = {
    'not-json.json': '{oops',
    'wrong-version.json': JSON.stringify({ version: 99, findings: [] }),
    'no-findings.json': JSON.stringify({ version: 1 }),
    'bad-fingerprint.json': JSON.stringify({ version: 1, findings: [{ fingerprint: 'xyz', rule: 'generic-api-key' }] }),
    'no-rule.json': JSON.stringify({ version: 1, findings: [{ fingerprint: 'a'.repeat(64) }] }),
    'not-object.json': JSON.stringify([1, 2]),
  };
  for (const [name, content] of Object.entries(bad)) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, content);
    assert.throws(() => loadSecretsBaseline(file), BaselineError, name);
  }
});

test('baseline: writing into a missing directory throws instead of creating it', () => {
  const dir = tempDir('dev-diagnosis-baseline-');
  const findings = scanTextForSecrets(genericKeyLine, 'config.js');
  assert.throws(
    () => writeSecretsBaseline(path.join(dir, 'no-such-dir', 'baseline.json'), findings),
    BaselineError,
  );
});

test('baseline: splitBaselined keeps new findings and suppresses known ones', () => {
  const findings = scanTextForSecrets([genericKeyLine, otherKeyLine].join('\n'), 'config.js');
  const dir = tempDir('dev-diagnosis-baseline-');
  const file = path.join(dir, BASELINE_FILENAME);
  writeSecretsBaseline(file, findings.slice(0, 1));
  const loaded = loadSecretsBaseline(file);
  const { kept, suppressed } = splitBaselined(findings, loaded);
  assert.equal(kept.length, 1);
  assert.equal(suppressed.length, 1);
  assert.equal(kept[0].fingerprint, findings[1].fingerprint);
  assert.equal(suppressed[0].fingerprint, findings[0].fingerprint);
  // With no baseline every finding is kept.
  assert.deepEqual(splitBaselined(findings, null), { kept: findings, suppressed: [] });
  assert.equal(isBaselined(findings[0], null), false);
  assert.equal(isBaselined(findings[0], loaded), true);
  assert.equal(isBaselined(findings[1], loaded), false);
});

test('baseline: a fingerprint follows the secret when it moves files', () => {
  const here = scanTextForSecrets(genericKeyLine, 'config.js');
  const moved = scanTextForSecrets(genericKeyLine, 'lib/moved.js');
  assert.equal(here.length, 1);
  assert.equal(moved.length, 1);
  // Same value, same rule — the same fingerprint, wherever it lives.
  assert.equal(here[0].fingerprint, moved[0].fingerprint);
  const dir = tempDir('dev-diagnosis-baseline-');
  const file = path.join(dir, BASELINE_FILENAME);
  writeSecretsBaseline(file, here);
  const loaded = loadSecretsBaseline(file);
  assert.equal(isBaselined(moved[0], loaded), true);
});

test('baseline: a private key in a new file is a new finding', () => {
  // The private-key rule has no value to hash (its header line is the
  // same for every key), so its fingerprint hashes the file path: a
  // key in a new file must re-alert, which is the safe direction.
  const a = scanTextForSecrets(privateKeyHeader, 'id_rsa');
  const b = scanTextForSecrets(privateKeyHeader, 'other/id_rsa');
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.notEqual(a[0].fingerprint, b[0].fingerprint);
});

test('baseline: scanDirectory suppresses baselined findings and reports them', () => {
  const root = makeRepo({ 'config.js': `${genericKeyLine}\n`, 'src/index.js': 'x\n' });
  const first = scanDirectory(root);
  const secrets = first.review.filter((item) => item.kind === 'secret');
  assert.equal(secrets.length, 1);
  assert.equal(first.secretsBaseline, null);
  const file = path.join(root, BASELINE_FILENAME);
  writeSecretsBaseline(file, secrets);
  const second = scanDirectory(root, { secretsBaseline: loadSecretsBaseline(file) });
  assert.equal(second.review.filter((item) => item.kind === 'secret').length, 0);
  assert.deepEqual(second.secretsBaseline, { path: file, loaded: true, suppressed: 1 });
  assert.ok(!second.reviewSuggestions.includes('config.js'));
  assert.equal(second.score, 100);
});

test('baseline: runContextCheck fails only on new secrets when a baseline exists', () => {
  const root = makeRepo({ 'config.js': `${genericKeyLine}\n` });
  // No baseline: the finding stays advisory and the check passes.
  const open = runContextCheck(root);
  assert.equal(open.passed, true);
  assert.equal(open.verdict, 'context is clean');
  assert.equal(open.result.review.filter((item) => item.kind === 'secret').length, 1);
  // Baseline the finding: the check still passes, now with nothing
  // to report and one suppressed.
  const file = path.join(root, BASELINE_FILENAME);
  writeSecretsBaseline(file, open.result.review.filter((item) => item.kind === 'secret'));
  const known = runContextCheck(root, { secretsBaselinePath: file });
  assert.equal(known.passed, true);
  assert.equal(known.verdict, 'context is clean');
  assert.equal(known.result.secretsBaseline.suppressed, 1);
  assert.equal(known.result.review.filter((item) => item.kind === 'secret').length, 0);
  // Add a new secret: the same baseline now fails the check — but the
  // score did not move, because the gate is separate from the noise
  // score (a secret is not context noise, and the score says so).
  fs.writeFileSync(path.join(root, 'other.js'), `${otherKeyLine}\n`);
  const added = runContextCheck(root, { secretsBaselinePath: file });
  assert.equal(added.passed, false);
  assert.match(added.verdict, /new secret not in the baseline/);
  assert.equal(added.result.score, 100);
  assert.equal(added.result.review.filter((item) => item.kind === 'secret').length, 1);
});

test('baseline: a missing baseline file scans unsuppressed and says so', () => {
  const root = makeRepo({ 'config.js': `${genericKeyLine}\n` });
  const missing = path.join(root, 'no-such-baseline.json');
  const check = runContextCheck(root, { secretsBaselinePath: missing });
  assert.equal(check.passed, true);
  assert.equal(check.result.review.filter((item) => item.kind === 'secret').length, 1);
  assert.deepEqual(check.result.secretsBaseline, { path: missing, loaded: false, suppressed: 0 });
});
