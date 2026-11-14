/**
 * Which files changed in git — bat's method: a tool that reads files
 * should know what changed, not just what exists.
 *
 * bat shows git-modified lines in the gutter of the file it prints;
 * the transferable idea is git-aware scoping: the user usually cares
 * about *their* change, not the whole repo. `context --changed`
 * limits the noise scan to the files that changed, so a repo with
 * pre-existing noise (a committed 1.7 MB log, a legacy dist/) can
 * still answer "did my change add noise?" — and a CI check on
 * `all --changed origin/main` fails only on new noise, the way
 * reviewdog reports only on changed lines.
 *
 * The set is: tracked files that differ from <ref> (staged or
 * unstaged — `git diff <ref>` covers both) plus untracked files that
 * git does not ignore (`git ls-files --others --exclude-standard`).
 * Untracked files are part of the change: a new log file the user has
 * not committed yet is exactly the noise a pre-commit check should
 * catch. Deleted files are listed by git but do not exist on disk,
 * so the scan drops them naturally.
 *
 * Local only, no network: both git commands read the local repo.
 * Paths come back NUL-separated (`-z`) and relative to the scanned
 * root (`--relative` for diff, cwd-relative for ls-files), so a scan
 * of a subdirectory of a repo still gets paths it can match.
 */
import path from 'node:path';
import { runCommand } from './run-command.mjs';

export const DEFAULT_CHANGED_REF = 'HEAD';

function splitNul(text) {
  return String(text || '').split('\0').map((line) => line.trim()).filter(Boolean);
}

/**
 * List the files changed in git under `root`, vs `ref` (default HEAD).
 * Returns `{ ref, files }` — repo-relative forward-slash paths,
 * sorted, deduplicated. Throws a plain Error when git is missing, the
 * directory is not a repo, or the ref does not exist.
 */
export function listChangedFiles(root, ref = DEFAULT_CHANGED_REF) {
  const absolute = path.resolve(root);
  const wanted = ref == null || ref === '' ? DEFAULT_CHANGED_REF : String(ref);
  const repo = runCommand(['git', '-C', absolute, 'rev-parse', '--show-toplevel']);
  if (!repo.ok) {
    if (repo.error && /ENOENT/i.test(repo.error)) {
      throw new Error('git is not installed or not on PATH — --changed needs git');
    }
    throw new Error(`not a git repository: ${root} — --changed needs a git repo`);
  }
  const diff = runCommand(['git', '-C', absolute, 'diff', '-z', '--name-only', '--relative', wanted]);
  if (!diff.ok) {
    // git's stderr is a multi-line usage hint; the first line is the
    // reason, the rest is noise in our output.
    const detail = String(diff.stderr || '').trim().split('\n')[0];
    throw new Error(`cannot list changes vs ${wanted}: ${detail || 'git diff failed'}`);
  }
  const untracked = runCommand(['git', '-C', absolute, 'ls-files', '-z', '--others', '--exclude-standard']);
  if (!untracked.ok) {
    const detail = String(untracked.stderr || '').trim();
    throw new Error(`cannot list untracked files: ${detail || 'git ls-files failed'}`);
  }
  const files = new Set([...splitNul(diff.stdout), ...splitNul(untracked.stdout)]);
  return { ref: wanted, files: [...files].sort() };
}
