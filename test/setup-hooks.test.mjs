import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkHooks, hookScript, planHooks } from '../lib/setup.mjs';
import { git, hasGit, makeGitRepo, tempDir, writeRepoFile } from '../scripts/support.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'bin', 'dev-diagnosis.js');

function run(args, options = {}) {
  return spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', ...options });
}

// A fake git runner for the lib-level status logic: it answers the
// two git calls planHooks makes, while the hook files themselves are
// real files in a temp dir (so marker detection is exercised for
// real). `overrides` maps a command line to its canned result.
function fakeRun(repoRoot, overrides = {}) {
  return (argv) => {
    const key = argv.join(' ');
    if (overrides[key]) return overrides[key];
    if (key === 'git rev-parse --show-toplevel') {
      return { ok: true, status: 0, stdout: `${repoRoot}\n`, stderr: '' };
    }
    if (key === 'git config --get core.hooksPath') {
      // Unset: git exits 1 with empty stdout — not an error.
      return { ok: false, status: 1, stdout: '', stderr: '' };
    }
    throw new Error(`unexpected git call in test: ${key}`);
  };
}

test('setup --hooks: the hook scripts carry the exact README commands', () => {
  const preCommit = hookScript('pre-commit');
  assert.match(preCommit, /^#!\/bin\/sh\n/);
  assert.match(preCommit, /# Managed by dev-diagnosis/);
  assert.match(preCommit, /npx dev-diagnosis-cli context --changed --staged/);
  const commitMsg = hookScript('commit-msg');
  assert.match(commitMsg, /^#!\/bin\/sh\n/);
  assert.match(commitMsg, /# Managed by dev-diagnosis/);
  assert.match(commitMsg, /npx dev-diagnosis-cli secrets "\$1"/);
});

test('setup --hooks: planHooks reports not-a-repo when git fails', () => {
  const plan = planHooks({
    cwd: tempDir('dev-diagnosis-hooks-'),
    run: () => ({ ok: false, status: 128, stdout: '', stderr: 'fatal: not a git repository' }),
  });
  assert.equal(plan.status, 'not-a-repo');
  assert.equal(plan.repoRoot, null);
});

test('setup --hooks: planHooks reports create on a fresh repo', () => {
  const repo = tempDir('dev-diagnosis-hooks-');
  const plan = planHooks({ cwd: repo, run: fakeRun(repo) });
  assert.equal(plan.status, 'create');
  assert.equal(plan.repoRoot, repo);
  assert.deepEqual(plan.steps.write, ['pre-commit', 'commit-msg']);
  assert.equal(plan.steps.setConfig, true);
});

test('setup --hooks: planHooks refuses a foreign hooks path', () => {
  const repo = tempDir('dev-diagnosis-hooks-');
  const plan = planHooks({
    cwd: repo,
    run: fakeRun(repo, {
      'git config --get core.hooksPath': { ok: true, status: 0, stdout: '.other-hooks\n', stderr: '' },
    }),
  });
  assert.equal(plan.status, 'foreign-hooks-path');
  assert.match(plan.note, /\.other-hooks/);
});

test('setup --hooks: planHooks refuses a hook file it did not install', () => {
  const repo = tempDir('dev-diagnosis-hooks-');
  fs.mkdirSync(path.join(repo, '.githooks'));
  fs.writeFileSync(path.join(repo, '.githooks', 'pre-commit'), '#!/bin/sh\necho foreign\n');
  const plan = planHooks({ cwd: repo, run: fakeRun(repo) });
  assert.equal(plan.status, 'foreign-hook');
  assert.match(plan.note, /\.githooks\/pre-commit/);
  // The note is a display string with git-style forward slashes on
  // every platform — a backslash here would mean path.join leaked a
  // Windows separator into user-facing output.
  assert.doesNotMatch(plan.note, /\\/);
});

test('setup --hooks: planHooks completes a partial install (ours, path unset)', () => {
  const repo = tempDir('dev-diagnosis-hooks-');
  fs.mkdirSync(path.join(repo, '.githooks'));
  fs.writeFileSync(path.join(repo, '.githooks', 'pre-commit'), hookScript('pre-commit'));
  fs.writeFileSync(path.join(repo, '.githooks', 'commit-msg'), hookScript('commit-msg'));
  const plan = planHooks({ cwd: repo, run: fakeRun(repo) });
  assert.equal(plan.status, 'create');
  assert.deepEqual(plan.steps.write, []);
  assert.equal(plan.steps.setConfig, true);
});

test('setup --hooks: checkHooks reports installed only when both are in place', () => {
  const repo = tempDir('dev-diagnosis-hooks-');
  const notYet = checkHooks({
    cwd: repo,
    run: fakeRun(repo),
  });
  assert.equal(notYet.installed, false);
  assert.equal(notYet.status, 'create');
  const installed = checkHooks({
    cwd: repo,
    run: fakeRun(repo, {
      'git config --get core.hooksPath': { ok: true, status: 0, stdout: '.githooks\n', stderr: '' },
    }),
  });
  // Files are still missing, so not installed even with the path set.
  assert.equal(installed.installed, false);
  assert.equal(installed.status, 'create');
});

test('setup --hooks: --dry-run previews without writing, install writes 755 files and sets the path', (t) => {
  if (!hasGit()) t.skip('git is not installed');
  const repo = makeGitRepo();
  const dry = run(['setup', '--hooks', '--dry-run'], { cwd: repo });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /Dry run — nothing will be written/);
  assert.match(dry.stdout, /\.githooks\/pre-commit — will write:/);
  assert.match(dry.stdout, /npx dev-diagnosis-cli context --changed --staged/);
  assert.match(dry.stdout, /core\.hooksPath — will set to \.githooks/);
  assert.equal(fs.existsSync(path.join(repo, '.githooks', 'pre-commit')), false);
  assert.throws(() => git(repo, 'config', '--get', 'core.hooksPath'));

  const first = run(['setup', '--hooks'], { cwd: repo });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Git hooks: wrote \.githooks\/pre-commit, \.githooks\/commit-msg and set core\.hooksPath/);
  for (const name of ['pre-commit', 'commit-msg']) {
    const file = path.join(repo, '.githooks', name);
    assert.equal(fs.readFileSync(file, 'utf8'), hookScript(name));
    // Windows has no POSIX mode bits — chmod is a no-op there and the
    // mode reads back 0o666, so only pin 0755 where modes mean
    // something. Git for Windows runs the hooks regardless.
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(file).mode & 0o777, 0o755);
    }
  }
  assert.equal(git(repo, 'config', '--get', 'core.hooksPath').trim(), '.githooks');

  const second = run(['setup', '--hooks'], { cwd: repo });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /Git hooks already installed/);
});

test('setup --hooks: --check reports the install state', (t) => {
  if (!hasGit()) t.skip('git is not installed');
  const repo = makeGitRepo();
  const before = run(['setup', '--hooks', '--check'], { cwd: repo });
  assert.equal(before.status, 1);
  assert.match(before.stdout, /Git hooks: not installed/);
  const installed = run(['setup', '--hooks'], { cwd: repo });
  assert.equal(installed.status, 0, installed.stderr);
  const after = run(['setup', '--hooks', '--check'], { cwd: repo });
  assert.equal(after.status, 0, after.stderr);
  assert.match(after.stdout, /Git hooks: installed/);
});

test('setup --hooks: refuses a foreign hook file and a foreign hooks path, leaving both alone', (t) => {
  if (!hasGit()) t.skip('git is not installed');
  const foreignFile = makeGitRepo();
  fs.mkdirSync(path.join(foreignFile, '.githooks'));
  fs.writeFileSync(path.join(foreignFile, '.githooks', 'pre-commit'), '#!/bin/sh\necho foreign\n');
  const blocked = run(['setup', '--hooks'], { cwd: foreignFile });
  assert.equal(blocked.status, 1);
  assert.match(blocked.stdout, /\.githooks\/pre-commit already exists/);
  assert.equal(fs.readFileSync(path.join(foreignFile, '.githooks', 'pre-commit'), 'utf8'), '#!/bin/sh\necho foreign\n');

  const foreignPath = makeGitRepo();
  git(foreignPath, 'config', 'core.hooksPath', '.other-hooks');
  const refused = run(['setup', '--hooks'], { cwd: foreignPath });
  assert.equal(refused.status, 1);
  assert.match(refused.stdout, /core\.hooksPath is already set to '.other-hooks'/);
  assert.equal(git(foreignPath, 'config', '--get', 'core.hooksPath').trim(), '.other-hooks');
});

test('setup --hooks: --hooks is setup-only', () => {
  const result = run(['context', '--hooks']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--hooks only applies to setup/);
});

test('setup --hooks: the installed hooks work as real git hooks', (t) => {
  if (!hasGit()) t.skip('git is not installed');
  const repo = makeGitRepo();
  const installed = run(['setup', '--hooks'], { cwd: repo });
  assert.equal(installed.status, 0, installed.stderr);
  // The installed hooks call `npx dev-diagnosis-cli`, which would
  // download the published package; the suite runs the local bin in
  // its place (same code, same version once released).
  for (const name of ['pre-commit', 'commit-msg']) {
    const file = path.join(repo, '.githooks', name);
    const content = fs.readFileSync(file, 'utf8');
    assert.ok(content.includes('npx dev-diagnosis-cli'), 'installed hook must keep the documented npx command');
    // replaceAll: the command appears twice in the file (once in the
    // header comment, once as the command itself) — replacing only
    // the first would leave the hook calling npx, which resolves to
    // the published 0.2.2 that does not know --staged yet.
    fs.writeFileSync(file, content.replaceAll('npx dev-diagnosis-cli', `node ${JSON.stringify(bin)}`), { mode: 0o755 });
  }
  const commit = (message) => spawnSync('git', ['-C', repo, 'commit', '-m', message], { encoding: 'utf8' });
  writeRepoFile(repo, 'src/feature.js', '// new feature\n');
  git(repo, 'add', 'src/feature.js');
  const first = commit('initial clean commit');
  assert.equal(first.status, 0, first.stderr);
  writeRepoFile(repo, 'staged.json', 'y'.repeat(1200000));
  git(repo, 'add', 'staged.json');
  const blocked = commit('add big json');
  assert.equal(blocked.status, 1);
  assert.match(blocked.stdout + blocked.stderr, /75\/100/);
  assert.match(blocked.stdout + blocked.stderr, /staged\.json/);
  const fixed = run(['context', '--fix', '--changed', '--staged'], { cwd: repo });
  assert.equal(fixed.status, 0, fixed.stderr);
  git(repo, 'add', '.aiignore');
  const recommitted = commit('add big json with aiignore fix');
  assert.equal(recommitted.status, 0, recommitted.stderr);
  writeRepoFile(repo, 'clean.txt', 'clean change\n');
  git(repo, 'add', 'clean.txt');
  const secret = commit('rotate the key ghp_X7fK9mQ2vR8tY4wN6bJ3hD5sA1zC0xE8uV3p');
  assert.equal(secret.status, 1);
  assert.match(secret.stdout + secret.stderr, /github-token/);
  assert.doesNotMatch(secret.stdout + secret.stderr, /X7fK9mQ2vR8tY4wN6bJ3hD5sA1zC0xE8uV3p/);
  const clean = commit('clean message, no secrets');
  assert.equal(clean.status, 0, clean.stderr);
});
