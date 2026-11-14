import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { git, gitCommit, hasGit, makeGitRepo, tempDir, writeRepoFile } from '../scripts/support.mjs';
import { DEFAULT_CHANGED_REF, listChangedFiles } from '../lib/changed.mjs';

const BIG = 'x'.repeat(1200000);

// A repo with pre-existing noise: a committed 1.2 MB log plus a clean
// file, then a second commit touching the clean file. The changed set
// vs HEAD is only what is uncommitted afterwards; vs HEAD~1 it also
// includes the second commit's change.
function fixture(t) {
  if (!hasGit()) t.skip('git is not installed');
  const repo = makeGitRepo();
  writeRepoFile(repo, 'src/app.js', 'console.log("clean");\n');
  writeRepoFile(repo, 'old-debug.log', BIG);
  gitCommit(repo, 'commit 1: clean app + committed log');
  fs.appendFileSync(path.join(repo, 'src/app.js'), 'console.log("more");\n');
  gitCommit(repo, 'commit 2: extend app');
  return repo;
}

test('changed: vs HEAD lists staged, unstaged and untracked — but not committed noise', (t) => {
  const repo = fixture(t);
  writeRepoFile(repo, 'logs/new-debug.log', BIG);
  writeRepoFile(repo, 'src/feature.js', '// new feature\n');
  fs.appendFileSync(path.join(repo, 'src/app.js'), '// uncommitted tweak\n');
  git(repo, 'add', 'src/feature.js'); // staged
  const changed = listChangedFiles(repo);
  assert.equal(changed.ref, DEFAULT_CHANGED_REF);
  assert.deepEqual(changed.files, ['logs/new-debug.log', 'src/app.js', 'src/feature.js']);
  assert.ok(!changed.files.includes('old-debug.log'), 'the committed log is not a change');
});

test('changed: an explicit ref includes the commits after it', (t) => {
  const repo = fixture(t);
  writeRepoFile(repo, 'logs/new-debug.log', BIG);
  const changed = listChangedFiles(repo, 'HEAD~1');
  assert.equal(changed.ref, 'HEAD~1');
  assert.deepEqual(changed.files, ['logs/new-debug.log', 'src/app.js']);
});

test('changed: untracked files git ignores are not changes', (t) => {
  const repo = fixture(t);
  writeRepoFile(repo, '.gitignore', '*.tmp\n');
  gitCommit(repo, 'ignore tmp files');
  writeRepoFile(repo, 'a.tmp', BIG);
  writeRepoFile(repo, 'b.log', BIG);
  const changed = listChangedFiles(repo);
  assert.deepEqual(changed.files, ['b.log']);
});

test('changed: an empty ref means HEAD, and a subdirectory gets relative paths', (t) => {
  const repo = fixture(t);
  writeRepoFile(repo, 'src/feature.js', '// new feature\n');
  assert.equal(listChangedFiles(repo, '').ref, 'HEAD');
  assert.deepEqual(listChangedFiles(repo, '').files, ['src/feature.js']);
  assert.deepEqual(listChangedFiles(path.join(repo, 'src')).files, ['feature.js']);
});

test('changed: not a git repo, and an unknown ref, throw a plain error', (t) => {
  if (!hasGit()) t.skip('git is not installed');
  const plain = tempDir('dev-diagnosis-not-git-');
  assert.throws(
    () => listChangedFiles(plain),
    (error) => error.message.startsWith('not a git repository:'),
  );
  const repo = fixture(t);
  assert.throws(
    () => listChangedFiles(repo, 'no-such-ref'),
    (error) => /cannot list changes vs no-such-ref: fatal: ambiguous argument/.test(error.message),
  );
});
