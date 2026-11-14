/**
 * Shared test helpers.
 *
 * tempDir() is mkdtempSync with cleanup: the directory is removed
 * after the test that created it, so repeated suite runs cannot fill
 * /tmp (a 512 MB tmpfs on this machine — the suite used to leak ~100
 * MB per run and started failing once /tmp filled up). The `after`
 * hook runs even when the test fails, so a failing test still cleans
 * up after itself.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';

export function tempDir(prefix) {
  // Canonicalise the path: on macOS os.tmpdir() is under /var, a
  // symlink to /private/var, and a child process reports its working
  // directory by the real path — a test comparing a printed path with
  // the mkdtemp spelling would otherwise fail on the /var prefix.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Is git installed? --changed shells out to it, so its tests skip
 * when it is not there (the same pattern as the `script` binary skip
 * in cli.test.mjs) instead of failing on a missing binary.
 */
export function hasGit() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

/**
 * A real git repo in a temp dir, with local user config set so commits
 * work without a global git config. Tests write files into it and
 * commit with gitCommit().
 */
export function makeGitRepo() {
  const dir = tempDir('dev-diagnosis-git-');
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { encoding: 'utf8' });
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@test.test'], { encoding: 'utf8' });
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'test'], { encoding: 'utf8' });
  return dir;
}

export function gitCommit(repo, message) {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', message);
}

export function writeRepoFile(repo, relative, content) {
  const full = path.join(repo, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}
