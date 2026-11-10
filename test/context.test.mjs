import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { classifyPath, scanDirectory } from '../lib/context.mjs';

function makeRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-doctor-context-'));
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

test('classifyPath: build output, lockfiles, logs and large files are noise', () => {
  assert.equal(classifyPath('dist/app.js').noise.reason, 'generated build output');
  assert.equal(classifyPath('build/index.js').noise.reason, 'generated build output');
  assert.equal(classifyPath('coverage/lcov.info').noise.reason, 'test coverage output');
  assert.equal(classifyPath('package-lock.json').noise.reason, 'lockfile');
  assert.equal(classifyPath('logs/dev.log').noise.reason, 'local log file');
  assert.equal(classifyPath('data/big.bin', 2 * 1024 * 1024).noise.reason, 'large file');
});

test('classifyPath: templates and secret-like files are review, not noise', () => {
  assert.equal(classifyPath('.env.example').review.reason, 'environment template (usually safe to share)');
  assert.equal(classifyPath('.env').review.reason, 'environment-like file');
  assert.equal(classifyPath('src/index.js').noise, undefined);
  assert.equal(classifyPath('src/index.js').review, undefined);
});

test('classifyPath: Windows-style paths classify the same as POSIX paths', () => {
  // A backslash-joined path must not slip past the noise-dir rule.
  assert.equal(classifyPath('dist\\app.js').noise.reason, 'generated build output');
});

test('scanDirectory: a clean repo scores 100', () => {
  const root = makeRepo({ 'src/index.js': 'console.log("hi");\n', 'README.md': '# hi\n' });
  const result = scanDirectory(root);
  assert.equal(result.score, 100);
  assert.equal(result.noise.length, 0);
  assert.equal(result.passed, undefined); // scan result carries no verdict; the CLI decides
});

test('scanDirectory: a noisy repo scores below clean and suggests fixes', () => {
  const root = makeRepo({
    'src/index.js': 'x\n',
    'dist/app.bundle.js': 'bundled\n'.repeat(500),
    'package-lock.json': '{}\n',
    'logs/dev.log': 'log\n',
    'data/export.json': 'x'.repeat(2 * 1024 * 1024),
  });
  const result = scanDirectory(root);
  // The large file alone costs its full 25 points, so the score is at most
  // 75; the other noise categories push it lower.
  assert.ok(result.score < 85, `expected a noisy score, got ${result.score}`);
  assert.ok(result.noise.length >= 4);
  assert.ok(result.suggestions.includes('dist/'));
  assert.ok(result.suggestions.includes('package-lock.json'));
  assert.ok(result.suggestions.includes('*.log'));
});

test('scanDirectory: a repo that is entirely build output scores 60, the floor', () => {
  // Each category can lose at most its weight, and the weights are shares
  // of one total — so 60 is the lowest this score can go. The test pins
  // that floor rather than assuming a lower score is possible.
  const root = makeRepo({ 'dist/app.bundle.js': 'bundled\n'.repeat(10000), 'src/index.js': 'x\n' });
  const result = scanDirectory(root);
  assert.equal(result.score, 60);
});

test('scanDirectory: a missing directory is an error, not a clean score', () => {
  assert.throws(() => scanDirectory(path.join(os.tmpdir(), 'dev-doctor-does-not-exist')), /directory not found/);
});

test('scanDirectory: .git and node_modules are skipped', () => {
  const root = makeRepo({
    'src/index.js': 'x\n',
    '.git/objects/big.bin': 'x'.repeat(2 * 1024 * 1024),
    'node_modules/pkg/dist/out.js': 'x'.repeat(2 * 1024 * 1024),
  });
  const result = scanDirectory(root);
  assert.equal(result.score, 100);
  assert.equal(result.files, 1);
});
