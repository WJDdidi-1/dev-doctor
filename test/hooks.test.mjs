import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { git, hasGit, makeGitRepo, writeRepoFile } from '../scripts/support.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'bin', 'dev-diagnosis.js');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

// The hook commands, in both forms: the pre-commit framework ships
// them in .pre-commit-hooks.yaml (pinned there), and the husky path
// documents them in the README (pinned here). Husky is only
// core.hooksPath + shell scripts — git's own hook mechanism — so
// these tests install the documented commands as real git hooks in a
// temp repo and commit through them: a clean first commit passes, a
// staged noisy file blocks with the verdict, the documented fix clears
// it, and a secret in the message blocks without ever printing the
// value. The suite runs the local bin in place of `npx
// dev-diagnosis-cli` (no registry download in tests); the exact
// documented lines, npx prefix included, are pinned by the README
// test below.

function huskySection() {
  const start = readme.indexOf('### Husky');
  assert.notEqual(start, -1, 'README has no ### Husky section');
  const end = readme.indexOf('\n## ', start + 1);
  return end === -1 ? readme.slice(start) : readme.slice(start, end);
}

test('hooks: the README husky snippet carries the two exact hook commands', () => {
  const section = huskySection();
  assert.match(section, /npx dev-diagnosis-cli context --changed --staged/);
  assert.match(section, /npx dev-diagnosis-cli secrets "\$1"/);
  // The pre-commit hook command, not the plain --changed one: the
  // snippet must judge the staged set, the same as the manifest.
  assert.doesNotMatch(section, /context --changed`/);
});

function installHooks(repo) {
  const hooksDir = path.join(repo, '.hooks');
  fs.mkdirSync(hooksDir);
  // The documented commands, with the local bin standing in for the
  // npx-installed CLI (same code, same version once released).
  fs.writeFileSync(
    path.join(hooksDir, 'pre-commit'),
    `#!/bin/sh\nnode ${JSON.stringify(bin)} context --changed --staged\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(hooksDir, 'commit-msg'),
    `#!/bin/sh\nnode ${JSON.stringify(bin)} secrets "$1"\n`,
    { mode: 0o755 },
  );
  git(repo, 'config', 'core.hooksPath', hooksDir);
}

function commit(repo, message) {
  return spawnSync('git', ['-C', repo, 'commit', '-m', message], { encoding: 'utf8' });
}

test('hooks: the documented commands work as real git hooks', (t) => {
  if (!hasGit()) t.skip('git is not installed');
  const repo = makeGitRepo(); // no commits yet — HEAD is unborn
  installHooks(repo);
  writeRepoFile(repo, 'src/feature.js', '// new feature\n');
  git(repo, 'add', 'src/feature.js');
  // A clean first commit passes — the hook runs on the commit that
  // creates HEAD, so unborn HEAD must be a verdict, not an error.
  const first = commit(repo, 'initial clean commit');
  assert.equal(first.status, 0, first.stderr);
  assert.doesNotMatch(first.stdout + first.stderr, /cannot list changes/);
  // A staged noisy file blocks the commit with the verdict.
  writeRepoFile(repo, 'staged.json', 'y'.repeat(1200000));
  git(repo, 'add', 'staged.json');
  const blocked = commit(repo, 'add big json');
  assert.equal(blocked.status, 1);
  assert.match(blocked.stdout + blocked.stderr, /75\/100/);
  assert.match(blocked.stdout + blocked.stderr, /staged\.json/);
  // The documented fix clears it and the re-commit passes.
  const fixed = spawnSync(process.execPath, [bin, 'context', '--fix', '--changed', '--staged'], {
    cwd: repo,
    encoding: 'utf8',
  });
  assert.equal(fixed.status, 0, fixed.stderr);
  assert.match(fixed.stdout, /Re-scanned after fix: Score: 100\/100/);
  git(repo, 'add', '.aiignore');
  const recommitted = commit(repo, 'add big json with aiignore fix');
  assert.equal(recommitted.status, 0, recommitted.stderr);
  // A secret in the message blocks; the value is never printed.
  writeRepoFile(repo, 'clean.txt', 'clean change\n');
  git(repo, 'add', 'clean.txt');
  const secret = commit(repo, 'rotate the key ghp_X7fK9mQ2vR8tY4wN6bJ3hD5sA1zC0xE8uV3p');
  assert.equal(secret.status, 1);
  assert.match(secret.stdout + secret.stderr, /github-token/);
  assert.doesNotMatch(secret.stdout + secret.stderr, /X7fK9mQ2vR8tY4wN6bJ3hD5sA1zC0xE8uV3p/);
  const clean = commit(repo, 'clean message, no secrets');
  assert.equal(clean.status, 0, clean.stderr);
});
