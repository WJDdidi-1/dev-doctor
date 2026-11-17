import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { git, gitCommit, hasGit, makeGitRepo, tempDir, writeRepoFile } from '../scripts/support.mjs';
import { DEFAULT_CHANGED_REF, listChangedFiles, refFileSizes } from '../lib/changed.mjs';

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

test('changed: staged lists only the index vs HEAD — unstaged and untracked excluded', (t) => {
  const repo = fixture(t);
  writeRepoFile(repo, 'logs/new-debug.log', BIG);
  writeRepoFile(repo, 'src/feature.js', '// new feature\n');
  fs.appendFileSync(path.join(repo, 'src/app.js'), '// uncommitted tweak\n');
  git(repo, 'add', 'src/feature.js'); // staged
  const staged = listChangedFiles(repo, 'HEAD', { staged: true });
  assert.equal(staged.ref, 'HEAD');
  assert.equal(staged.staged, true);
  assert.deepEqual(staged.files, ['src/feature.js']);
  // The same tree unscoped still sees all three: the staged set is a
  // strict subset of the working-tree set.
  const changed = listChangedFiles(repo);
  assert.equal(changed.staged, false);
  assert.deepEqual(changed.files, ['logs/new-debug.log', 'src/app.js', 'src/feature.js']);
});

test('changed: a staged noisy file is in the staged set, an unstaged one is not', (t) => {
  const repo = fixture(t);
  writeRepoFile(repo, 'staged.json', BIG);
  writeRepoFile(repo, 'unstaged.json', BIG);
  git(repo, 'add', 'staged.json');
  const staged = listChangedFiles(repo, 'HEAD', { staged: true });
  assert.deepEqual(staged.files, ['staged.json']);
});

test('changed: staged with an explicit ref includes the commits after it', (t) => {
  const repo = fixture(t);
  writeRepoFile(repo, 'src/feature.js', '// new feature\n');
  git(repo, 'add', 'src/feature.js'); // staged
  // vs HEAD~1 the staged set is the second commit's change (already
  // in the index, since the index matches HEAD) plus the staged file.
  const staged = listChangedFiles(repo, 'HEAD~1', { staged: true });
  assert.equal(staged.ref, 'HEAD~1');
  assert.deepEqual(staged.files, ['src/app.js', 'src/feature.js']);
});

test('refFileSizes: sizes of committed files, and a file the ref never had is absent', (t) => {
  const repo = fixture(t);
  const sizes = refFileSizes(repo);
  assert.equal(sizes.get('old-debug.log'), BIG.length);
  assert.equal(
    sizes.get('src/app.js'),
    'console.log("clean");\n'.length + 'console.log("more");\n'.length,
  );
  assert.equal(sizes.has('no-such-file.js'), false);
  assert.equal(sizes.has('logs/new-debug.log'), false);
});

test('refFileSizes: an empty ref means HEAD, and a subdirectory gets relative paths', (t) => {
  const repo = fixture(t);
  const head = refFileSizes(repo);
  const empty = refFileSizes(repo, '');
  assert.equal(empty.get('src/app.js'), head.get('src/app.js'));
  assert.equal(empty.get('old-debug.log'), head.get('old-debug.log'));
  const sub = refFileSizes(path.join(repo, 'src'));
  assert.equal(sub.get('app.js'), head.get('src/app.js'));
  assert.equal(sub.has('src/app.js'), false);
});

test('refFileSizes: an older ref sees the older tree', (t) => {
  const repo = fixture(t);
  const sizes = refFileSizes(repo, 'HEAD~1');
  // Commit 1's app.js, before commit 2 extended it.
  assert.equal(sizes.get('src/app.js'), 'console.log("clean");\n'.length);
  assert.equal(sizes.get('old-debug.log'), BIG.length);
});

test('refFileSizes: not a git repo, and an unknown ref, throw a plain error', (t) => {
  if (!hasGit()) t.skip('git is not installed');
  const plain = tempDir('dev-diagnosis-not-git-');
  assert.throws(
    () => refFileSizes(plain),
    (error) => error.message.startsWith('not a git repository:'),
  );
  const repo = fixture(t);
  assert.throws(
    () => refFileSizes(repo, 'no-such-ref'),
    // ls-tree's wording, unlike diff's "ambiguous argument".
    (error) => /cannot list files at no-such-ref: fatal: Not a valid object name no-such-ref/.test(error.message),
  );
});

test('changed: unborn HEAD reads as the empty tree — the first commit is a change, not an error', (t) => {
  if (!hasGit()) t.skip('git is not installed');
  const repo = makeGitRepo(); // no commits yet — HEAD is unborn
  writeRepoFile(repo, 'src/feature.js', '// new feature\n');
  git(repo, 'add', 'src/feature.js'); // staged
  writeRepoFile(repo, 'notes.json', 'y'.repeat(1200000)); // untracked noise
  // The working-tree scope sees both; the staged scope only the file
  // that will be committed — and neither errors on the missing HEAD.
  const changed = listChangedFiles(repo);
  assert.equal(changed.ref, 'HEAD');
  assert.deepEqual(changed.files, ['notes.json', 'src/feature.js']);
  const staged = listChangedFiles(repo, 'HEAD', { staged: true });
  assert.equal(staged.ref, 'HEAD');
  assert.equal(staged.staged, true);
  assert.deepEqual(staged.files, ['src/feature.js']);
});

test('changed: an explicit unknown ref still throws on an unborn HEAD', (t) => {
  if (!hasGit()) t.skip('git is not installed');
  const repo = makeGitRepo();
  writeRepoFile(repo, 'src/feature.js', '// new feature\n');
  assert.throws(
    () => listChangedFiles(repo, 'no-such-ref'),
    (error) => /cannot list changes vs no-such-ref: fatal: ambiguous argument/.test(error.message),
  );
});

test('refFileSizes: unborn HEAD is an empty tree — every file is new', (t) => {
  if (!hasGit()) t.skip('git is not installed');
  const repo = makeGitRepo();
  writeRepoFile(repo, 'src/feature.js', '// new feature\n');
  git(repo, 'add', 'src/feature.js');
  const sizes = refFileSizes(repo);
  assert.equal(sizes.size, 0);
  assert.equal(sizes.has('src/feature.js'), false);
  assert.throws(
    () => refFileSizes(repo, 'no-such-ref'),
    (error) => /cannot list files at no-such-ref: fatal: Not a valid object name no-such-ref/.test(error.message),
  );
});
