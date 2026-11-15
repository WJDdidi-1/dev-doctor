/**
 * Incremental scan cache (ESLint's `--cache` method, metadata strategy
 * only): remember what the context scan saw for each unchanged file,
 * so a re-scan of a large, mostly-unchanged tree skips re-reading
 * files whose size and mtime still match.
 *
 * The cache is a plain JSON file at the scan root
 * (`.dev-diagnosis-cache.json` by default), opt-in via `--cache`:
 * a user — or an agent — can read what the tool remembered. Entries
 * hold fingerprints only: per file, mtime + size, the classification
 * code, the token estimate, and secret findings as `[rule, line,
 * fingerprint]` triples. A fingerprint is a SHA-256 hash of the rule
 * and the matched value (lib/secrets.mjs), which cannot be reversed
 * into the value — the same safety argument the secrets baseline
 * makes for storing fingerprints. The cache never holds a value.
 *
 * Trust model, stated plainly: the cache is a local performance
 * artifact, not a security boundary — the same model as
 * `.eslintcache`. A hand-edited cache file could hide a finding,
 * exactly as a hand-edited `.eslintcache` can hide a lint error.
 * Mitigations, in order: the cache is opt-in and local; CI and the
 * pre-commit hook never use it by default (CI checks out fresh, so
 * there is no cache file, and the hook runs `--changed --staged`,
 * a tiny scope where the cache is irrelevant); the residual risk
 * (same size + same mtime + different content, e.g. mtime preserved
 * by a tool, or a 1-second-granularity filesystem) is the same risk
 * git's index and ESLint accept. Deleting the file forces a fresh
 * scan. A corrupt, unreadable or wrong-shaped cache never fails a
 * run: it warns once and the scan runs fresh.
 *
 * Deliberately not borrowed from ESLint: no `content` strategy —
 * hashing a file requires reading it, which is exactly the cost the
 * cache exists to avoid (for ESLint it pays because linting CPU
 * dominates; here the read is ~60% of the scan). No delete-on-a-run-
 * without-the-flag either: a stale cache just sits there, ignored,
 * until `--cache` runs again — fingerprint validation on every read
 * makes deletion pointless.
 *
 * Name note: the design doc called this module `lib/cache.mjs`, but
 * that file is already the build-cache verdict module (the `cache`
 * command), so this one is `lib/scan-cache.mjs`.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Format version written into every scan cache file. */
export const SCAN_CACHE_VERSION = 1;

/** Default cache file name at the scan root. */
export const DEFAULT_SCAN_CACHE_FILENAME = '.dev-diagnosis-cache.json';

/** Classification codes stored per file (see lib/context.mjs). */
export const SCAN_CACHE_CATEGORIES = ['none', 'build', 'large', 'lockfile', 'log', 'review'];

let cachedToolVersion = null;

/** The package version, for the cache header: a new tool version invalidates every cache, so a classification or rule change can never be replayed from an old file. */
export function getToolVersion() {
  if (cachedToolVersion == null) {
    cachedToolVersion = JSON.parse(
      fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ).version;
  }
  return cachedToolVersion;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Where the cache lives: the given location resolved under the scan root, or the default file at the root. */
export function resolveScanCachePath(root, location) {
  if (location == null || location === '') return path.join(path.resolve(root), DEFAULT_SCAN_CACHE_FILENAME);
  return path.resolve(root, location);
}

/**
 * The cache file's path relative to the scan root, forward slashes —
 * or null when it lives outside the root. The walk excludes exactly
 * this path, so the cache file is never counted, classified or
 * content-scanned.
 */
export function scanCacheRelativePath(root, cachePath) {
  const absolute = path.resolve(root);
  const resolved = path.resolve(cachePath);
  const rel = path.relative(absolute, resolved);
  if (rel === '' || rel.startsWith(`..${path.sep}`) || rel === '..' || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/**
 * Load a scan cache file. Returns `{ cache, warning }`: cache is null
 * when the file does not exist (the normal first run — no warning) or
 * when it cannot be used (warning set, scan runs fresh). A bad cache
 * never fails a run.
 */
export function loadScanCache(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { cache: null, warning: null };
    return { cache: null, warning: `cannot read scan cache '${filePath}': ${error.message}` };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return { cache: null, warning: `scan cache '${filePath}' is not valid JSON: ${error.message}` };
  }
  if (!isRecord(data) || data.cacheVersion !== SCAN_CACHE_VERSION || !isRecord(data.files)) {
    return { cache: null, warning: `scan cache '${filePath}' has the wrong shape — ignoring it and scanning fresh` };
  }
  return { cache: data, warning: null };
}

function sameGitignoreList(a, b) {
  const left = Array.isArray(a) ? a : [];
  const right = Array.isArray(b) ? b : [];
  if (left.length !== right.length) return false;
  const sortByPath = (list) => [...list].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  const sortedLeft = sortByPath(left);
  const sortedRight = sortByPath(right);
  for (let i = 0; i < sortedLeft.length; i += 1) {
    const [pathA, mtimeA, sizeA] = sortedLeft[i];
    const [pathB, mtimeB, sizeB] = sortedRight[i];
    if (pathA !== pathB || mtimeA !== mtimeB || sizeA !== sizeB) return false;
  }
  return true;
}

/**
 * Does the loaded cache describe the current run? Every header field
 * must match: cache version, tool version, scan root, file cap, every
 * `.aiignore` and every `.gitignore` the walk read (compared as
 * `[path, mtimeMs, size]` triples, order-insensitively). An old
 * cache file whose `aiignore` is still the pre-0.2.4 single
 * fingerprint object is not a list, so it never matches — one full
 * re-scan, and the rewrite is in the new shape. Any mismatch means
 * a full scan — the cache is rewritten afterwards.
 */
export function headerMatches(cache, expected) {
  if (!headerContentMatches(cache, expected)) return false;
  if (!sameGitignoreList(cache.aiignore, expected.aiignore)) return false;
  if (!sameGitignoreList(cache.gitignore, expected.gitignore)) return false;
  return true;
}

/**
 * The header fields that describe what the stored entries mean. A
 * mismatch here means the observations themselves may be stale (a
 * new tool version can change the classification or the secret
 * rules), so old entries must not be carried over — even on a scoped
 * scan that cannot re-observe them. Ignore-list fingerprints are
 * excluded on purpose: an `.aiignore` / `.gitignore` change affects
 * which files are scanned, not what a stored observation says about
 * a file's contents, so old entries survive an ignore change.
 */
export function headerContentMatches(cache, expected) {
  if (!cache) return false;
  if (cache.cacheVersion !== SCAN_CACHE_VERSION) return false;
  if (cache.toolVersion !== expected.toolVersion) return false;
  if (cache.root !== expected.root) return false;
  if (cache.maxFiles !== expected.maxFiles) return false;
  return true;
}

function isValidEntry(entry) {
  if (!isRecord(entry)) return false;
  if (typeof entry.m !== 'number' || typeof entry.s !== 'number') return false;
  if (!Array.isArray(entry.f)) return false;
  for (const finding of entry.f) {
    if (!Array.isArray(finding) || finding.length !== 3) return false;
    const [rule, line, fingerprint] = finding;
    if (typeof rule !== 'string' || typeof line !== 'number' || typeof fingerprint !== 'string') return false;
  }
  return true;
}

/**
 * The cached entry for one file, or null: no entry, a fingerprint
 * mismatch (the file changed), or a malformed entry. A hit means the
 * caller may reuse the stored findings without reading the file.
 */
export function lookupScanCache(cache, relative, stat) {
  if (!cache || !isRecord(cache.files)) return null;
  const entry = cache.files[relative];
  if (!isValidEntry(entry)) return null;
  if (entry.m !== stat.mtimeMs || entry.s !== stat.size) return null;
  return entry;
}

/**
 * Build the cache file's contents: header plus the per-file entries.
 * `files` is a Map (or plain object) of relative path to entry.
 * `aiignore` and `gitignore` entries are `[path, mtimeMs, size]`
 * triples, sorted by path so regenerating over an unchanged tree
 * produces no diff.
 */
export function buildScanCacheData({ root, maxFiles, aiignore, gitignore, files }) {
  const entries = files instanceof Map ? Object.fromEntries(files) : { ...files };
  const sortedAiignore = [...(aiignore ?? [])].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const sortedGitignore = [...(gitignore ?? [])].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return {
    cacheVersion: SCAN_CACHE_VERSION,
    toolVersion: getToolVersion(),
    root: path.resolve(root),
    maxFiles,
    aiignore: sortedAiignore,
    gitignore: sortedGitignore,
    writtenAt: new Date().toISOString(),
    files: entries,
  };
}

/**
 * Write the cache atomically: a temp file in the same directory,
 * then a rename, so a reader never sees a half-written cache.
 * Throws on failure — the caller warns and carries on without a
 * cache, because a cache that cannot be written must never fail a
 * scan. Refuses a path whose directory does not exist, instead of
 * creating it: a typo should error, not scatter a cache file.
 */
export function saveScanCache(filePath, data) {
  const dir = path.dirname(path.resolve(filePath));
  let stat;
  try {
    stat = fs.statSync(dir);
  } catch {
    throw new Error(`cannot write scan cache '${filePath}': directory does not exist: ${dir}`);
  }
  if (!stat.isDirectory()) throw new Error(`cannot write scan cache '${filePath}': not a directory: ${dir}`);
  const tmp = `${filePath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(data)}\n`, 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* best effort cleanup */ }
    throw new Error(`cannot write scan cache '${filePath}': ${error.message}`);
  }
}

/**
 * The one terminal / report line that discloses a cache was used:
 * `Cache: 52,991 files unchanged since 18:20 (metadata)`. Null when
 * nothing was reused — the `cached` field in the result already says
 * the cache was consulted, so a zero-hit run prints no line.
 */
export function formatScanCacheLine(cached) {
  if (!cached || !cached.files) return null;
  const when = new Date(cached.writtenAt);
  if (Number.isNaN(when.getTime())) return null;
  const hh = String(when.getHours()).padStart(2, '0');
  const mm = String(when.getMinutes()).padStart(2, '0');
  const noun = cached.files === 1 ? 'file' : 'files';
  return `Cache: ${cached.files.toLocaleString('en-US')} ${noun} unchanged since ${hh}:${mm} (metadata)`;
}
