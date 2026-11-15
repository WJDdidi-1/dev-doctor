import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tempDir } from '../scripts/support.mjs';
import { scanDirectory } from '../lib/context.mjs';
import { scanFileForSecrets, scanTextForSecrets, shannonEntropy } from '../lib/secrets.mjs';

// Corpus lines are built from fragments, never written as one literal:
// this file itself is scanned by the tool's own dogfood run, so a
// complete fake credential on one line would be a finding in our own
// repo. The fragments never co-occur on a physical line.
const awsKey = 'AKIA' + 'Q7X2K9M4P6R8T3Y5';
const githubToken = 'ghp_' + 'k7Qw9x2Zm4Np8Rt5Yv' + '6Bs3Dc7Fg9Hj2K4Lp8';
const privateKeyHeader = '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----';
const slackToken = 'xoxb-' + '847291635204-938471625304-9fK2mQ7xR4tY8wZ1aB3c';
const jwtToken = 'eyJhbGciOiJIUzI1NiI' + 'sInR5cCI6IkpXVCJ9' + '.' + 'eyJzdWIiOiIxMjM0NTY3ODkwIn0' + '.' + 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
const genericKeyLine = ['api', 'key'].join('_') + ' = "' + '9f8e7d6c' + '5b4a3928' + '1706f5e4' + 'd3c2b1a0' + '"';
const otherKeyLine = ['api', 'key'].join('_') + ' = "' + '1a2b3c4d' + '5e6f7a8b' + '9c0d1e2f' + '3a4b5c6d' + '"';

function makeRepo(files) {
  const root = tempDir('dev-diagnosis-secrets-');
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

test('secrets: entropy gate admits a real-looking key and rejects noise', () => {
  // A hand-built 32-hex key with every digit exactly twice scores
  // exactly 4.0 — but a real random one measures 3.3–3.9, so the
  // generic rule's bar is 3.0, not just under 4.0 (see the random-key
  // test below: the old 3.9 bar missed all 20 of its keys).
  assert.equal(shannonEntropy('9f8e7d6c5b4a39281706f5e4d3c2b1a0'), 4);
  assert.ok(shannonEntropy('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') < 1);
  assert.ok(shannonEntropy('test123') < 3.0);
});

// Deterministic PRNG (mulberry32) so the regression corpus is stable:
// the keys are generated at runtime, never written as literals, so
// this file stays clean under the tool's own dogfood scan.
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('secrets: twenty random 32-hex keys are all found, any casing (3.9 bar missed them)', () => {
  const rand = mulberry32(20261115);
  const keys = [];
  for (let i = 0; i < 20; i += 1) {
    let key = '';
    for (let j = 0; j < 32; j += 1) key += Math.floor(rand() * 16).toString(16);
    keys.push(key);
  }
  // Every one of these measures under 3.9 (min 3.42, max 3.77): the
  // old threshold would have reported none of them.
  assert.ok(keys.every((key) => shannonEntropy(key) < 3.9));
  // Real assignments are uppercase (`API_KEY=`) or camelCase
  // (`apiKey =`) far more often than lowercase snake_case — the rule
  // is case-insensitive, and the corpus cycles all three casings so
  // a missing `i` flag fails this test (it did: 0/20 uppercase).
  const forms = [(key) => `API_KEY=${key}`, (key) => `api_key = "${key}"`, (key) => `apiKey = "${key}"`];
  const text = keys.map((key, i) => forms[i % 3](key)).join('\n');
  const findings = scanTextForSecrets(text, 'config.js');
  assert.equal(findings.length, 20);
  assert.ok(findings.every((f) => f.rule === 'generic-api-key'));
});

test('secrets: all five true positives are found, with rule and line', () => {
  const text = [
    `AWS_KEY=${awsKey}`,
    `TOKEN=${githubToken}`,
    privateKeyHeader,
    `SLACK=${slackToken}`,
    genericKeyLine,
  ].join('\n');
  const findings = scanTextForSecrets(text, 'config.js');
  assert.deepEqual(findings.map((f) => f.rule), [
    'aws-access-key',
    'github-token',
    'private-key',
    'slack-token',
    'generic-api-key',
  ]);
  assert.deepEqual(findings.map((f) => f.line), [1, 2, 3, 4, 5]);
  for (const finding of findings) {
    assert.equal(finding.verified, false);
    assert.match(finding.reason, /unverified/);
  }
  // The matched value is never in the finding: a report of a leak must
  // not itself leak the secret.
  const dumped = JSON.stringify(findings);
  assert.ok(!dumped.includes(awsKey.slice(4)), dumped);
  assert.ok(!dumped.includes(githubToken.slice(4)), dumped);
  assert.ok(!dumped.includes('9f8e7d6c5b4a3928'), dumped);
});

test('secrets: the fourteen false-positive traps stay silent', () => {
  const traps = [
    // The AWS documentation's own example key.
    'AKIA' + 'IOSFODNN7EXAMPLE',
    // An all-zero token: the right shape, no variety, no entropy.
    'ghp_' + '0'.repeat(36),
    // Bare hashes and ids with no credential assignment around them.
    '9f8e7d6c5b4a39281706f5e4d3c2b1a0e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2',
    '123e4567-e89b-12d3-a456-426614174000',
    jwtToken,
    'aGVsbG8gd29ybGQgdGhpcyBpcyBhIGxvbmcgYmFzZTY0IGJsb2Igd2l0aCBubyBrZXl3b3Jk',
    'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2',
    // A short, low-entropy password.
    'password = "test123"',
    // A GitHub Actions expression is a reference to a secret, not one.
    'GH_TOKEN="${{ inputs.token || github.token }}"',
    // An environment reference names where a secret lives; it is not
    // a credential value. (Dogfood caught this on ci-triage's doctor.)
    'token = process.env.GH_TOKEN',
    'apiKey = import.meta.env.VITE_API_KEY',
    // A plain sentence that happens to contain the word "secret".
    ' // remember to rotate the secret after the incident',
    // A dotted property chain assigned to a secret-named variable is
    // code, not a credential: `result.review.filter` is 21 characters
    // of high-entropy-looking text. (Dogfood caught this on this very
    // file after the entropy bar dropped to 3.0.)
    'const secrets = result.review.filter((item) => item.rule === \'aws-access-key\');',
    'apiKey = configuration.settings.primary',
  ];
  for (const line of traps) {
    assert.deepEqual(scanTextForSecrets(line, 'x.js'), [], line);
  }
});

test('secrets: a JWT assigned to a token variable is still found', () => {
  // The value class has no dot, so the rule reads only the JWT's
  // first segment — 36 characters, entropy ~4.9 — which is enough.
  // (The bare JWT stays silent without an assignment; see the traps.)
  const findings = scanTextForSecrets(`token = "${jwtToken}"`, 'auth.js');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'generic-api-key');
});

test('secrets: template files and lockfiles are never content-scanned', () => {
  const root = makeRepo({
    '.env.example': `AWS_KEY=${awsKey}\n`,
    'package-lock.json': `    "integrity": "sha512-9f8e7d6c5b4a39281706f5e4d3c2b1a0e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8=="\n`,
  });
  assert.deepEqual(scanFileForSecrets(path.join(root, '.env.example'), '.env.example'), []);
  assert.deepEqual(scanFileForSecrets(path.join(root, 'package-lock.json'), 'package-lock.json'), []);
});

test('secrets: scanDirectory reports a finding as advisory review, score untouched', () => {
  const root = makeRepo({
    '.env': `AWS_KEY=${awsKey}\n`,
    'src/index.js': 'x\n',
  });
  const result = scanDirectory(root);
  assert.equal(result.score, 100);
  const secrets = result.review.filter((item) => item.rule === 'aws-access-key');
  assert.equal(secrets.length, 1);
  assert.equal(secrets[0].path, '.env');
  assert.equal(secrets[0].line, 1);
  assert.equal(secrets[0].verified, false);
  // Advisory only: the exact path is suggested for a manual look, but
  // --fix must never write it — the score was already 100, so there is
  // nothing for a fix to fix.
  assert.ok(result.reviewSuggestions.includes('.env'));
  assert.deepEqual(result.suggestions, []);
  assert.ok(!JSON.stringify(result).includes(awsKey.slice(4)));
});

test('secrets: findings carry a stable fingerprint that never holds the value', () => {
  const first = scanTextForSecrets(genericKeyLine, 'config.js');
  const again = scanTextForSecrets(genericKeyLine, 'config.js');
  assert.equal(first.length, 1);
  assert.equal(first[0].kind, 'secret');
  assert.match(first[0].fingerprint, /^[0-9a-f]{64}$/);
  // Same value, same rule — the same fingerprint on every scan, so a
  // baseline can recognise the finding again.
  assert.equal(first[0].fingerprint, again[0].fingerprint);
  // A different value is a different fingerprint.
  const other = scanTextForSecrets(otherKeyLine, 'config.js');
  assert.equal(other.length, 1);
  assert.notEqual(first[0].fingerprint, other[0].fingerprint);
  // A hash of the value is not the value: the dump still leaks nothing.
  const dumped = JSON.stringify(first);
  assert.ok(!dumped.includes('9f8e7d6c5b4a3928'), dumped);
});

test('secrets: a minified single-line file does not stall the scan', () => {
  // One megabyte on one line, no keyword anywhere: the generic rule
  // used to start with a greedy variable-name prefix, which made the
  // engine backtrack over the whole unbroken word-run — a 500 KB line
  // hung the scan for over two minutes (2026-11-15). The pattern now
  // starts at the keyword, so the same line costs about a
  // millisecond; the bound is generous, the old code missed it by
  // two orders of magnitude.
  const start = Date.now();
  const findings = scanTextForSecrets('x'.repeat(1024 * 1024), 'bundle.min.js');
  assert.deepEqual(findings, []);
  assert.ok(Date.now() - start < 1000, `took ${Date.now() - start} ms`);
});

test('secrets: one finding per line, the most specific rule winning', () => {
  // A GitHub token on an assignment line also matches the generic
  // keyword rule; only the provider rule reports it.
  const findings = scanTextForSecrets(`GITHUB_TOKEN=${githubToken}`, 'ci.yml');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'github-token');
});
