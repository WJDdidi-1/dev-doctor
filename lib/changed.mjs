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
 * With `{ staged: true }` (lint-staged's method — run against the
 * files staged in Git) the set is the index vs <ref> only
 * (`git diff --cached <ref>`): a file the user has `git add`ed is
 * in, an unstaged modification or an untracked file is out. That is
 * the set a pre-commit hook should judge — it is exactly what will
 * be committed — so an unrelated noisy file sitting unstaged in the
 * working tree no longer blocks a commit that does not include it.
 * The plain `--changed` set is still the right default for a human
 * asking "did my change add noise?", where untracked files count.
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
 * The size of every file in the tree at `ref`, as a Map from the
 * scan-root-relative path (the same form listChangedFiles returns)
 * to its byte size. `git ls-tree -r -l` run from the scan root lists
 * exactly that subtree with paths relative to it — no relativizing
 * needed — and one call covers the whole tree, so a 500-file change
 * costs one git invocation, not one per file. Files absent at the
 * ref are simply not in the map: a new file has no baseline size.
 * Throws a plain Error when git is missing, the directory is not a
 * repo, or the ref does not exist — the same shapes as
 * listChangedFiles, so the caller can report them the same way.
 */
export function refFileSizes(root, ref) {
  const absolute = path.resolve(root);
  const wanted = ref == null || ref === '' ? DEFAULT_CHANGED_REF : String(ref);
  const repo = runCommand(['git', '-C', absolute, 'rev-parse', '--show-toplevel']);
  if (!repo.ok) {
    if (repo.error && /ENOENT/i.test(repo.error)) {
      throw new Error('git is not installed or not on PATH — --new-from-rev needs git');
    }
    throw new Error(`not a git repository: ${root} — --new-from-rev needs a git repo`);
  }
  const tree = runCommand(['git', '-C', absolute, 'ls-tree', '-r', '-l', '-z', wanted]);
  if (!tree.ok) {
    const detail = String(tree.stderr || '').trim().split('\n')[0];
    throw new Error(`cannot list files at ${wanted}: ${detail || 'git ls-tree failed'}`);
  }
  const sizes = new Map();
  for (const entry of splitNul(tree.stdout)) {
    // "<mode> SP <type> SP <sha> SP <size> TAB <path>" — the size is
    // '-' for trees, which -r never emits; only blobs carry a size.
    // git right-pads the size to the widest entry, so the field is
    // not at a fixed index: take the last whitespace-separated token
    // before the tab (a small file's size would otherwise read as
    // Number('') === 0).
    const tab = entry.indexOf('\t');
    if (tab === -1) continue;
    const size = Number(entry.slice(0, tab).trim().split(/\s+/).pop());
    if (!Number.isFinite(size)) continue;
    sizes.set(entry.slice(tab + 1), size);
  }
  return sizes;
}
/**
 * List the files changed in git under `root`, vs `ref` (default HEAD).
 * With `options.staged`, only the files staged in the index vs `ref`
 * (`git diff --cached`); otherwise the working tree vs `ref` plus
 * untracked files git does not ignore. Returns `{ ref, files, staged }`
 * — repo-relative forward-slash paths, sorted, deduplicated. Throws a
 * plain Error when git is missing, the directory is not a repo, or the
 * ref does not exist.
 */
export function listChangedFiles(root, ref = DEFAULT_CHANGED_REF, options = {}) {
  const absolute = path.resolve(root);
  const wanted = ref == null || ref === '' ? DEFAULT_CHANGED_REF : String(ref);
  const staged = options.staged === true;
  const repo = runCommand(['git', '-C', absolute, 'rev-parse', '--show-toplevel']);
  if (!repo.ok) {
    if (repo.error && /ENOENT/i.test(repo.error)) {
      throw new Error('git is not installed or not on PATH — --changed needs git');
    }
    throw new Error(`not a git repository: ${root} — --changed needs a git repo`);
  }
  const diffArgs = staged
    ? ['git', '-C', absolute, 'diff', '--cached', '-z', '--name-only', '--relative', wanted]
    : ['git', '-C', absolute, 'diff', '-z', '--name-only', '--relative', wanted];
  const diff = runCommand(diffArgs);
  if (!diff.ok) {
    // git's stderr is a multi-line usage hint; the first line is the
    // reason, the rest is noise in our output.
    const detail = String(diff.stderr || '').trim().split('\n')[0];
    throw new Error(`cannot list changes vs ${wanted}: ${detail || 'git diff failed'}`);
  }
  // Untracked files are not staged, so the staged set never lists
  // them — a file is judged once it is `git add`ed, which is when it
  // becomes part of the commit.
  const untracked = staged
    ? { ok: true, stdout: '' }
    : runCommand(['git', '-C', absolute, 'ls-files', '-z', '--others', '--exclude-standard']);
  if (!untracked.ok) {
    const detail = String(untracked.stderr || '').trim();
    throw new Error(`cannot list untracked files: ${detail || 'git ls-files failed'}`);
  }
  const files = new Set([...splitNul(diff.stdout), ...splitNul(untracked.stdout)]);
  return { ref: wanted, files: [...files].sort(), staged };
}
