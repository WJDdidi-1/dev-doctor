import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { git, gitCommit, hasGit, makeGitRepo, tempDir, writeRepoFile } from '../scripts/support.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const bin = path.join(root, 'bin', 'dev-diagnosis.js');
const manifestText = readFileSync(path.join(root, '.pre-commit-hooks.yaml'), 'utf8');

// dev-diagnosis as a pre-commit hook (the method is pre-commit's
// hook-manifest format): this repo ships .pre-commit-hooks.yaml so
// users add it to their .pre-commit-config.yaml and the hook runs
// `dev-diagnosis context --changed --staged` on every commit — the
// round-15 --changed check, narrowed by round 26 to the staged set,
// enforced at the moment noise would be committed. A second hook,
// `dev-diagnosis-commit-msg`, runs on the commit-msg stage and scans
// the message file itself (`dev-diagnosis secrets`): the message is
// not a file in the tree, so the context hook can never see a key
// pasted into it. pre-commit's contract is the exit code: 0 passes
// the commit, non-zero fails it. The hooks never write anything; on
// failure they print the noise (or the secret's file, rule and line —
// never the value) and the fix, and the user runs
// `dev-diagnosis context --fix --changed --staged` and re-commits.
// These tests pin the manifest fields and run the exact hook
// commands against real git fixtures, so a drifted entry, a stale
// version pin, or a changed exit-code contract fails CI instead of
// shipping a hook that silently passes or blocks every commit.

// Minimal parser for this flat manifest: one list item, scalar
// fields, inline lists. It is not a YAML parser — if the file ever
// grows structure, this test should grow with it.
function parseManifest(text) {
  const hooks = [];
  let current = null;
  // Strip CR first: a CRLF checkout would otherwise leave a trailing
  // \r on every line, and the line-anchored regexes below would match
  // nothing (the 2026-11-15 Windows CI failures — zero hooks parsed).
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const item = line.match(/^- id: (.+)$/);
    if (item) {
      current = { id: item[1].trim() };
      hooks.push(current);
      continue;
    }
    const field = line.match(/^  ([a-z_]+): (.*)$/);
    if (field && current) {
      const [, key, raw] = field;
      if (raw.startsWith('[')) {
        current[key] = raw.slice(1, -1).split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
      } else {
        current[key] = raw.trim().replace(/^'|'$/g, '');
      }
    }
  }
  return hooks;
}

const hooks = parseManifest(manifestText);

test('pre-commit: manifest declares two hooks with the pre-commit contract fields', () => {
  assert.equal(hooks.length, 2);
  const hook = hooks[0];
  assert.equal(hook.id, 'dev-diagnosis');
  assert.ok(hook.name.length > 0, 'hook name must not be empty');
  assert.ok(hook.description.length > 0, 'hook description must not be empty');
  assert.equal(hook.entry, 'dev-diagnosis');
  assert.equal(hook.language, 'node');
  // The hook takes no filenames: it scores the staged set via
  // --changed --staged, so pre-commit must not append staged paths.
  assert.equal(hook.pass_filenames, 'false');
  assert.deepEqual(hook.args, ['context', '--changed', '--staged']);
  // The commit-msg hook is the opposite: it judges exactly one file —
  // the message file pre-commit passes it — so it takes filenames,
  // runs on the commit-msg stage only, and takes no other args.
  const commitMsg = hooks[1];
  assert.equal(commitMsg.id, 'dev-diagnosis-commit-msg');
  assert.ok(commitMsg.name.length > 0, 'hook name must not be empty');
  assert.ok(commitMsg.description.length > 0, 'hook description must not be empty');
  assert.equal(commitMsg.entry, 'dev-diagnosis');
  assert.equal(commitMsg.language, 'node');
  assert.equal(commitMsg.pass_filenames, 'true');
  assert.deepEqual(commitMsg.args, ['secrets']);
  assert.deepEqual(commitMsg.stages, ['commit-msg']);
});

test('pre-commit: pinned CLI version and documented rev match the package version', () => {
  for (const hook of hooks) {
    assert.deepEqual(hook.additional_dependencies, [`dev-diagnosis-cli@${pkg.version}`]);
  }
  assert.ok(
    manifestText.includes(`rev: v${pkg.version}`),
    'the README snippet in the manifest header must name the release that carries this file',
  );
  // The README's install snippet names the same rev: a user copying
  // it must land on a tag that actually contains the manifest.
  const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
  const section = readme.split('## Pre-commit hook')[1].split('\n## ')[0];
  assert.ok(
    section.includes(`rev: v${pkg.version}`),
    'the README pre-commit snippet must name the release that carries the manifest',
  );
});

const BIG = 'x'.repeat(1200000);

function runHookCommand(repo, args) {
  return spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', cwd: repo });
}

test('pre-commit: a noisy staged change fails the hook command, and the documented fix clears it', (t) => {
  if (!hasGit()) t.skip('git is not installed');
  const repo = makeGitRepo();
  writeRepoFile(repo, 'README.md', '# demo\n');
  gitCommit(repo, 'initial commit');
  writeRepoFile(repo, 'data_export.json', BIG);
  git(repo, 'add', 'data_export.json');

  const failed = runHookCommand(repo, [...hooks[0].args]);
  assert.equal(failed.status, 1, 'the hook must fail the commit on a noisy change');
  assert.match(failed.stdout, /75\/100/, 'the change scores 75/100 (one large file, 25 points lost)');
  assert.match(failed.stdout, /data_export\.json/, 'the failure names the noisy file');
  assert.match(failed.stdout, /Fix: add these to \.aiignore/, 'the failure prints the fix');
  assert.match(failed.stdout, /FAIL/);

  const fixed = runHookCommand(repo, ['context', '--fix', '--changed', '--staged']);
  assert.equal(fixed.status, 0, 'the documented fix must exit 0');
  assert.match(fixed.stdout, /100\/100/, 'the post-fix re-scan scores clean');

  const rerun = runHookCommand(repo, [...hooks[0].args]);
  assert.equal(rerun.status, 0, 'the hook command passes once the fix is in');
  assert.match(rerun.stdout, /PASS/);
});

test('pre-commit: unstaged noise does not fail the hook command', (t) => {
  if (!hasGit()) t.skip('git is not installed');
  const repo = makeGitRepo();
  writeRepoFile(repo, 'README.md', '# demo\n');
  gitCommit(repo, 'initial commit');
  writeRepoFile(repo, 'notes.txt', 'hello\n');
  git(repo, 'add', 'notes.txt');
  // A 1.2 MB file sits in the working tree, unstaged: it is not part
  // of this commit, so the hook — which judges the staged set — must
  // pass. The old working-tree scope failed this exact case.
  writeRepoFile(repo, 'scratch.json', BIG);

  const hook = runHookCommand(repo, [...hooks[0].args]);
  assert.equal(hook.status, 0, 'the hook must not block a commit on unstaged noise');
  assert.match(hook.stdout, /Scope: staged files vs HEAD \(1 file\)/);
  assert.match(hook.stdout, /PASS/);

  const workingTree = runHookCommand(repo, ['context', '--changed']);
  assert.equal(workingTree.status, 1, 'the working-tree scope still fails on the same noise');
  assert.match(workingTree.stdout, /75\/100/);
});

test('pre-commit: a clean change passes the hook command', (t) => {
  if (!hasGit()) t.skip('git is not installed');
  const repo = makeGitRepo();
  writeRepoFile(repo, 'README.md', '# demo\n');
  gitCommit(repo, 'initial commit');
  writeRepoFile(repo, 'notes.txt', 'hello\n');
  git(repo, 'add', 'notes.txt');

  const clean = runHookCommand(repo, [...hooks[0].args]);
  assert.equal(clean.status, 0, 'the hook must not block a clean change');
  assert.match(clean.stdout, /100\/100/);
  assert.match(clean.stdout, /PASS/);
});

// The commit-msg hook's input is a message file, not a repo: the
// key line is built from fragments, never written as one literal,
// so this file itself stays clean under the tool's own dogfood run.
const msgKeyLine = ['api', 'key'].join('_') + ' = "' + '9f8e7d6c' + '5b4a3928' + '1706f5e4' + 'd3c2b1a0' + '"';
const msgKeyValue = '9f8e7d6c' + '5b4a3928' + '1706f5e4' + 'd3c2b1a0';

test('pre-commit: a secret in the commit message fails the commit-msg hook command', () => {
  const dir = tempDir('dev-diagnosis-precommit-msg-');
  const message = path.join(dir, 'COMMIT_EDITMSG');
  writeFileSync(message, `fix: rotate the key\n\n${msgKeyLine}\n`);

  // The hook command as pre-commit runs it: its args, plus the
  // message file pre-commit passes (pass_filenames: true).
  const failed = runHookCommand(dir, [...hooks[1].args, message]);
  assert.equal(failed.status, 1, 'the hook must fail the commit on a secret in the message');
  assert.match(failed.stdout, /COMMIT_EDITMSG:3 \(generic-api-key\)/);
  assert.match(failed.stdout, /FAIL/);
  assert.doesNotMatch(failed.stdout, new RegExp(msgKeyValue), 'the value must never reach the terminal');
});

test('pre-commit: a clean commit message passes the commit-msg hook command', () => {
  const dir = tempDir('dev-diagnosis-precommit-msg-');
  const message = path.join(dir, 'COMMIT_EDITMSG');
  writeFileSync(message, 'fix: rotate the key\n');

  const clean = runHookCommand(dir, [...hooks[1].args, message]);
  assert.equal(clean.status, 0, 'the hook must not block a clean message');
  assert.match(clean.stdout, /no secrets found in 1 file/);
  assert.match(clean.stdout, /PASS/);
});
