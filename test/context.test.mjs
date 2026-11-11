import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyAiignore, classifyPath, matchesAiignore, scanDirectory } from '../lib/context.mjs';

function makeRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-diagnosis-context-'));
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
  // A large file's fix is its exact path: no glob can single it out, and
  // without a suggestion --fix could never make its repo come back clean.
  assert.equal(classifyPath('data/big.bin', 2 * 1024 * 1024).suggestion, 'data/big.bin');
  assert.equal(classifyPath('big.bin', 2 * 1024 * 1024).suggestion, 'big.bin');
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

test('classifyPath: a nested build directory is labelled by its full path', () => {
  // A bare dist/ label would be ambiguous when two parts of the tree each
  // have one, and the suggestion it produces would not match the nested
  // directory at all. A top-level directory keeps the short label.
  const nested = classifyPath('packages/foo/dist/app.js');
  assert.equal(nested.noise.label, 'packages/foo/dist/');
  assert.equal(nested.suggestion, 'packages/foo/dist/');
  assert.equal(classifyPath('dist/app.js').noise.label, 'dist/');
  assert.equal(classifyPath('dist/app.js').suggestion, 'dist/');
});

test('scanDirectory: files under one build directory roll up into one row', () => {
  const root = makeRepo({
    'src/index.js': 'x\n',
    'dist/a.js': 'bundled\n'.repeat(100),
    'dist/b.js': 'bundled\n'.repeat(100),
    'dist/c.js': 'bundled\n'.repeat(100),
  });
  const result = scanDirectory(root);
  const build = result.noise.filter((item) => item.reason === 'generated build output');
  assert.equal(build.length, 1);
  assert.equal(build[0].label, 'dist/');
  assert.equal(build[0].bytes, 'bundled\n'.repeat(100).length * 3);
});

test('scanDirectory: --fix round-trips on nested build output', () => {
  // Regression: --fix used to write a bare dist/ entry, which only
  // matches top-level build output, so re-scanning a repo whose dist/
  // lives under packages/foo still failed after the fix.
  const root = makeRepo({
    'src/index.js': 'x\n',
    'packages/foo/dist/app.js': 'bundled\n',
  });
  const first = scanDirectory(root);
  assert.ok(first.suggestions.includes('packages/foo/dist/'));
  const fix = applyAiignore(root, first.suggestions);
  assert.deepEqual(fix.added, ['packages/foo/dist/']);
  const second = scanDirectory(root);
  assert.equal(second.score, 100);
  assert.equal(second.noise.length, 0);
  assert.deepEqual(second.suggestions, []);
});

test('scanDirectory: --fix round-trips on a large file', () => {
  // Regression: large files used to carry no suggestion, so --fix wrote
  // everything else and the next scan still failed on the same file —
  // the documented "fix then re-scan comes back clean" promise did not
  // hold for any repo with one oversized file, including this project's
  // own demo fixture.
  const root = makeRepo({
    'src/index.js': 'x\n',
    'data/export.json': 'x'.repeat(2 * 1024 * 1024),
  });
  const first = scanDirectory(root);
  assert.ok(first.suggestions.includes('data/export.json'));
  const fix = applyAiignore(root, first.suggestions);
  assert.deepEqual(fix.added, ['data/export.json']);
  const second = scanDirectory(root);
  assert.equal(second.score, 100);
  assert.equal(second.noise.length, 0);
  assert.deepEqual(second.suggestions, []);
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
  assert.ok(result.suggestions.includes('data/export.json'));
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
  assert.throws(() => scanDirectory(path.join(os.tmpdir(), 'dev-diagnosis-does-not-exist')), /directory not found/);
});

test('applyAiignore: creates .aiignore with the suggestions', () => {
  const root = makeRepo({ 'src/index.js': 'x\n' });
  const fix = applyAiignore(root, ['dist/', 'package-lock.json']);
  assert.equal(fix.created, true);
  assert.deepEqual(fix.added, ['dist/', 'package-lock.json']);
  assert.equal(fs.readFileSync(path.join(root, '.aiignore'), 'utf8'), 'dist/\npackage-lock.json\n');
});

test('applyAiignore: appends only the missing entries and keeps the rest', () => {
  const root = makeRepo({ 'src/index.js': 'x\n', '.aiignore': '# mine\npackage-lock.json\n' });
  const fix = applyAiignore(root, ['dist/', 'package-lock.json', '*.log']);
  assert.equal(fix.created, false);
  assert.deepEqual(fix.added, ['*.log', 'dist/']);
  assert.deepEqual(fix.alreadyPresent, ['package-lock.json']);
  assert.equal(
    fs.readFileSync(path.join(root, '.aiignore'), 'utf8'),
    '# mine\npackage-lock.json\n*.log\ndist/\n',
  );
  // A second run adds nothing: applying the fix is idempotent.
  const again = applyAiignore(root, ['dist/', 'package-lock.json', '*.log']);
  assert.deepEqual(again.added, []);
  assert.equal(fs.readFileSync(path.join(root, '.aiignore'), 'utf8'), '# mine\npackage-lock.json\n*.log\ndist/\n');
});

test('applyAiignore: no suggestions means no file is created', () => {
  const root = makeRepo({ 'src/index.js': 'x\n' });
  const fix = applyAiignore(root, []);
  assert.deepEqual(fix.added, []);
  assert.equal(fix.created, false);
  assert.equal(fs.existsSync(path.join(root, '.aiignore')), false);
});

test('matchesAiignore: directory patterns, globs and basenames', () => {
  assert.equal(matchesAiignore('dist/app.js', ['dist/']), true);
  assert.equal(matchesAiignore('src/dist/app.js', ['dist/']), false);
  assert.equal(matchesAiignore('logs/dev.log', ['*.log']), true);
  assert.equal(matchesAiignore('docs/package-lock.json', ['package-lock.json']), true);
  assert.equal(matchesAiignore('.env', ['.env*']), true);
  assert.equal(matchesAiignore('.env.local', ['.env*']), true);
  assert.equal(matchesAiignore('src/index.js', ['dist/', '*.log']), false);
  assert.equal(matchesAiignore('src/index.js', ['# comment', '', '!dist/']), false);
});

test('scanDirectory: files listed in .aiignore are excluded from the scan', () => {
  const root = makeRepo({
    'src/index.js': 'x\n',
    'dist/app.bundle.js': 'bundled\n'.repeat(500),
    'package-lock.json': '{}\n',
    '.aiignore': '# already handled\n' + 'dist/\n' + 'package-lock.json\n',
  });
  const result = scanDirectory(root);
  assert.equal(result.score, 100);
  assert.equal(result.noise.length, 0);
  assert.equal(result.files, 2); // src/index.js and .aiignore itself
  assert.deepEqual(result.suggestions, []);
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
