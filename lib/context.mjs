/**
 * Context-noise check.
 *
 * Adapted from ai-context-doctor (WJDdidi-1/ai-context-doctor, Apache-2.0):
 * the same classification rules and the same category-weighted score — build
 * output costs at most 40 points, large files 25, lockfiles 20, logs 15 —
 * so one pathological file cannot speak for the whole repository. The
 * five-dimension score, .aiignore levels and policy handling from the
 * original are deliberately left out: this is the small, single-purpose
 * version that answers "what should an AI agent not be handed".
 */
import fs from 'node:fs';
import path from 'node:path';

import { scanFileForSecrets, MAX_SECRET_SCAN_BYTES, SECRET_RULES } from './secrets.mjs';
import { splitBaselined } from './baseline.mjs';
import {
  buildScanCacheData, getToolVersion, headerContentMatches, headerMatches,
  lookupScanCache, saveScanCache, scanCacheRelativePath,
} from './scan-cache.mjs';

const SECRET_LIKE = /(^\.env(\..+)?$)|(\.env$)|(^credentials(\..+)?$)|(^secrets?(\..+)?$)|(\.pem$)|(\.key$)/i;
const TEMPLATE = /\.(example|sample|template|dist)$/i;

export const IGNORED_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'vendor']);

export const NOISE_DIRS = new Map([
  ['dist', 'generated build output'],
  ['build', 'generated build output'],
  ['coverage', 'test coverage output'],
  ['.next', 'framework output'],
  ['.turbo', 'framework cache'],
]);

export const LOCKFILES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']);

export const LARGE_FILE_THRESHOLD_BYTES = 1024 * 1024;

/**
 * Default cap on the files a scan counts. The walk traverses the
 * whole tree either way (it has to, to honour .gitignore), so the cap
 * costs nothing in time — it only bounds the counted set. 100,000
 * covers the largest repos measured (nodejs/node is ~53,000 files
 * once .git and ignored directories are out); anything bigger still
 * reports truncated: true instead of silently under-counting. The
 * previous default of 10,000 made the biggest repos' token numbers
 * lower bounds — Node's estimate was ~24.8M at the cap and ~47.5M
 * without it — so the cap was the measurement, not the repo.
 */
export const DEFAULT_MAX_FILES = 100000;

export const CATEGORY_WEIGHTS = [
  { id: 'build', label: 'build output', weight: 40 },
  { id: 'large', label: 'large files', weight: 25 },
  { id: 'lockfile', label: 'lockfiles', weight: 20 },
  { id: 'log', label: 'logs', weight: 15 },
];

export function isSecretLikeFile(basename) {
  return SECRET_LIKE.test(basename);
}

export function isTemplateFile(basename) {
  return TEMPLATE.test(basename);
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = units[0];
  for (let i = 1; i < units.length && value >= 1024; i += 1) {
    value /= 1024;
    unit = units[i];
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

/**
 * Rough token cost of the listed noise: about 4 bytes per token, the
 * rule of thumb most tokenizers land near. It is an estimate, not a
 * count — the label in the output says so. Returns null when there is
 * no listed noise, so a clean repo does not claim a saving of zero.
 */
export function estimateTokens(bytes) {
  if (!bytes || bytes <= 0) return null;
  return Math.round(bytes / 4);
}

/**
 * Roll up the listed noise by top-level directory (dust's method:
 * show where the waste lives, not just a flat file list). The fix
 * decision is usually directory-level — one .aiignore pattern per
 * directory — but the noise list is per file, so five 20k-token logs
 * in logs/ read as five small rows and the reader has to add them up
 * to see that logs/ is 90% of the noise. Each group sums its bytes
 * first and estimates tokens once, the same rounding discipline as
 * the Top N line, so a share can never pass 100%. Root-level files
 * group under `(root)`. Returns [] when the noise spans fewer than
 * two groups: a single-directory rollup would just repeat the file
 * list. `item.path` is the repo-relative path; `label` is the
 * fallback for results built without one.
 */
export function topNoiseDirectories(noise, totalTokens, limit = 3) {
  if (!totalTokens || !noise || noise.length === 0) return [];
  const groups = new Map();
  for (const item of noise) {
    const relative = item.path ?? item.label ?? '';
    const slash = relative.indexOf('/');
    const directory = slash === -1 ? '(root)' : `${relative.slice(0, slash)}/`;
    const group = groups.get(directory) || { directory, bytes: 0 };
    group.bytes += item.bytes;
    groups.set(directory, group);
  }
  if (groups.size < 2) return [];
  return [...groups.values()]
    .map((group) => {
      const tokens = estimateTokens(group.bytes);
      return { ...group, tokens, share: Math.round((tokens / totalTokens) * 1000) / 10 };
    })
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, limit);
}

function noiseCategory(reason) {
  if (reason === 'lockfile') return 'lockfile';
  if (reason === 'local log file') return 'log';
  if (reason === 'generated build output' || reason === 'test coverage output'
    || reason === 'framework output' || reason === 'framework cache') return 'build';
  return 'large';
}

export function scoreNoise(noise, totalBytes) {
  const bytesByCategory = new Map();
  for (const item of noise) {
    const id = noiseCategory(item.reason);
    bytesByCategory.set(id, (bytesByCategory.get(id) || 0) + item.bytes);
  }
  const breakdown = CATEGORY_WEIGHTS.map(({ id, label, weight }) => {
    const bytes = bytesByCategory.get(id) || 0;
    const share = totalBytes > 0 ? bytes / totalBytes : 0;
    const lost = Math.min(weight, weight * share);
    return { id, label, weight, bytes, share: Math.round(share * 1000) / 10, lost: Math.round(lost * 10) / 10 };
  });
  const lost = Math.round(breakdown.reduce((sum, item) => sum + item.lost, 0) * 10) / 10;
  return { score: Math.max(0, Math.min(100, Math.round(100 - lost))), lost, breakdown };
}

export function statusFor(score) {
  if (score >= 85) return 'Looks clean for an AI coding agent';
  if (score >= 60) return 'Some context noise found';
  return 'Too much noise for an AI coding agent';
}

/**
 * Classify one path without touching the filesystem. The relative path is
 * normalised to forward slashes first, so a Windows path and a POSIX path
 * classify the same way.
 */
export function classifyPath(relativePath, size = 0) {
  const normalized = String(relativePath).split(path.sep).join('/').split('\\').join('/');
  const parts = normalized.split('/');
  const basename = parts[parts.length - 1];

  // A noise directory is reported by its full path from the repo root
  // (packages/foo/dist/), not just its name: two build directories in
  // different parts of the tree would otherwise print the same label,
  // and the .aiignore entry --fix writes has to match the whole path —
  // a bare dist/ only ignores top-level build output.
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (NOISE_DIRS.has(parts[i])) {
      const dir = `${parts.slice(0, i + 1).join('/')}/`;
      return { noise: { label: dir, reason: NOISE_DIRS.get(parts[i]) }, suggestion: dir };
    }
  }
  if (LOCKFILES.has(basename)) {
    return { noise: { label: normalized, reason: 'lockfile' }, suggestion: basename };
  }
  if (basename.endsWith('.log')) {
    return { noise: { label: normalized, reason: 'local log file' }, suggestion: '*.log' };
  }
  if (size > LARGE_FILE_THRESHOLD_BYTES) {
    // A large file has no pattern that fixes it — a glob would be wrong —
    // so the fix is its exact path from the repo root. Without that, a
    // repo with one oversized file could never come back clean: --fix
    // would write everything else and the next scan would still fail on
    // the same file, which is exactly what the --fix round-trip promises
    // not to do.
    return { noise: { label: normalized, reason: 'large file' }, suggestion: normalized };
  }
  if (isTemplateFile(basename)) {
    return { review: { label: normalized, reason: 'environment template (usually safe to share)' }, suggestion: null };
  }
  if (isSecretLikeFile(basename)) {
    return {
      review: { label: normalized, reason: 'environment-like file' },
      suggestion: basename.startsWith('.env') ? '.env*' : basename,
    };
  }
  if (/deploy/i.test(normalized)) {
    return { review: { label: normalized, reason: 'deployment script' }, suggestion: null };
  }
  return { suggestion: null };
}

function patternToRegExp(pattern) {
  let out = '';
  for (const ch of pattern) {
    if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/**
 * Does a .aiignore pattern match this repo-relative path? Patterns are
 * the small subset the tool itself writes: `dir/` matches everything
 * under that directory, a pattern with a slash matches the whole path,
 * anything else matches the basename as a glob (`*` and `?` only).
 * Comment, blank and negation (`!`) lines never match: negation is not
 * supported, and silently treating one as an ignore would hide files
 * the user explicitly wanted back.
 */
export function matchesAiignore(relativePath, patterns) {
  const normalized = String(relativePath).split(path.sep).join('/').split('\\').join('/');
  const basename = normalized.split('/').pop();
  for (const raw of patterns) {
    const pattern = String(raw).trim();
    if (!pattern || pattern.startsWith('#') || pattern.startsWith('!')) continue;
    if (pattern.endsWith('/')) {
      const dir = pattern.slice(0, -1);
      if (normalized === dir || normalized.startsWith(`${dir}/`)) return true;
      continue;
    }
    if (pattern.includes('/')) {
      if (patternToRegExp(pattern).test(normalized)) return true;
    } else if (patternToRegExp(pattern).test(basename)) {
      return true;
    }
  }
  return false;
}

function readAiignore(root) {
  try {
    return fs.readFileSync(path.join(root, '.aiignore'), 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && !line.startsWith('!'));
  } catch {
    return [];
  }
}

/**
 * Read the `.aiignore` in one directory as a stack level, mirroring
 * readGitignore: `{ base, patterns }`, or null when the file has no
 * usable patterns. Patterns are scoped to the file's own directory —
 * git's per-directory .gitignore rule (gitignore(5)): a pattern in
 * `pkg/.aiignore` matches paths under `pkg/`, never the repo root.
 */
function readAiignoreLevel(dir, base) {
  const patterns = readAiignore(dir);
  return patterns.length > 0 ? { base, patterns } : null;
}

/** The fingerprint of a `.aiignore` file (mtime + size), or null when there is none — mirrors gitignoreFingerprint: the scan cache header records every `.aiignore` the walk reads. */
function aiignoreFingerprint(dir) {
  try {
    const stat = fs.statSync(path.join(dir, '.aiignore'));
    return stat.isFile() ? { mtimeMs: stat.mtimeMs, size: stat.size } : null;
  } catch {
    return null;
  }
}

/**
 * Is this repo-relative path ignored by the `.aiignore` stack? Each
 * level is `{ base, patterns }`, where `base` is the `.aiignore`'s
 * directory relative to the repo root (`''` for the root). A level
 * only applies under its own directory, and a pattern is matched
 * against the path relative to that directory with matchesAiignore —
 * so `big.log` in `pkg/.aiignore` ignores `pkg/big.log` and nothing
 * else. Unlike .gitignore there is no negation in .aiignore (a `!`
 * line never matches), so the levels are a union: any match ignores.
 */
export function isAiignored(relativePath, stack) {
  const normalized = String(relativePath).split(path.sep).join('/').split('\\').join('/');
  for (const { base, patterns } of stack) {
    let rel;
    if (base === '') rel = normalized;
    else if (normalized === base) continue; // a rule cannot ignore its own directory
    else if (normalized.startsWith(`${base}/`)) rel = normalized.slice(base.length + 1);
    else continue;
    if (matchesAiignore(rel, patterns)) return true;
  }
  return false;
}

function escapeRegExpChar(ch) {
  return ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/**
 * Convert one .gitignore glob into a RegExp (anchored at both ends).
 * `*` and `?` never cross a `/`; `**` does — `**/` at the start matches
 * zero or more directories, a trailing `/**` matches everything under a
 * directory, and a bare `**` matches anything. `[...]` is a character
 * class, with git's `!` negation spelled `^` for the RegExp.
 */
function gitignorePatternToRegExp(pattern) {
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 3;
        } else {
          out += '.*';
          i += 2;
        }
      } else {
        out += '[^/]*';
        i += 1;
      }
    } else if (ch === '?') {
      out += '[^/]';
      i += 1;
    } else if (ch === '[') {
      let j = i + 1;
      let negated = false;
      if (pattern[j] === '!') {
        negated = true;
        j += 1;
      }
      if (pattern[j] === ']') j += 1; // a leading ] is literal
      while (j < pattern.length && pattern[j] !== ']') j += 1;
      if (j >= pattern.length) {
        out += '\\[';
        i += 1;
      } else {
        const inner = pattern.slice(i + 1 + (negated ? 1 : 0), j).replace(/\\/g, '\\\\');
        out += `[${negated ? '^' : ''}${inner}]`;
        i = j + 1;
      }
    } else {
      out += escapeRegExpChar(ch);
      i += 1;
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * Parse .gitignore content into rules. Supports the common subset of
 * git's pattern language: blank lines and `#` comments are skipped, a
 * leading `!` negates (last matching pattern wins), a trailing `/`
 * matches directories only, a leading `/` — or a `/` anywhere else in
 * the pattern — anchors it to the .gitignore's own directory, otherwise
 * the pattern matches a basename at any depth. `\\#` and `\\!` at the
 * start of a line are literal. Trailing spaces are stripped, as git
 * does. `.git/info/exclude` and the global gitignore are not read —
 * only `.gitignore` files in the scanned tree.
 */
export function parseGitignore(text) {
  const rules = [];
  for (let raw of String(text).split(/\r?\n/)) {
    raw = raw.replace(/ +$/, '');
    if (!raw) continue;
    if (raw.startsWith('\\#') || raw.startsWith('\\!')) raw = raw.slice(1);
    else if (raw.startsWith('#')) continue;
    let negate = false;
    if (raw.startsWith('!')) {
      negate = true;
      raw = raw.slice(1);
      if (!raw) continue;
    }
    let dirOnly = false;
    if (raw.endsWith('/')) {
      dirOnly = true;
      raw = raw.slice(0, -1);
      if (!raw) continue;
    }
    let anchored = false;
    if (raw.startsWith('/')) {
      anchored = true;
      raw = raw.slice(1);
      if (!raw) continue;
    } else if (raw.includes('/')) {
      anchored = true;
    }
    rules.push({ negate, dirOnly, anchored, regex: gitignorePatternToRegExp(raw) });
  }
  return rules;
}

/**
 * Is this repo-relative path ignored by the .gitignore stack? Each level
 * is `{ base, rules }`, where `base` is the .gitignore's directory
 * relative to the repo root (`''` for the root). Deeper levels are
 * checked after shallower ones, and the last matching pattern decides —
 * so a `!` negation re-includes a file, but only when no parent
 * directory was pruned first (the walk never descends into an ignored
 * directory, which is also git's rule: a file cannot be re-included
 * under an excluded parent).
 */
export function isGitignored(relativePath, isDir, stack) {
  const normalized = String(relativePath).split(path.sep).join('/').split('\\').join('/');
  let ignored = false;
  for (const { base, rules } of stack) {
    let rel;
    if (base === '') rel = normalized;
    else if (normalized === base) continue; // a rule cannot ignore its own directory
    else if (normalized.startsWith(`${base}/`)) rel = normalized.slice(base.length + 1);
    else continue;
    for (const rule of rules) {
      if (rule.dirOnly && !isDir) continue;
      const candidate = rule.anchored ? rel : rel.split('/').pop();
      if (rule.regex.test(candidate)) ignored = !rule.negate;
    }
  }
  return ignored;
}

function readGitignore(dir, base) {
  try {
    const rules = parseGitignore(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'));
    return rules.length > 0 ? { base, rules } : null;
  } catch {
    return null;
  }
}

/** The fingerprint of a `.gitignore` file (mtime + size), or null when there is none: the scan cache header records every `.gitignore` the walk reads, so a rule change forces a full re-scan. */
function gitignoreFingerprint(dir) {
  try {
    const stat = fs.statSync(path.join(dir, '.gitignore'));
    return stat.isFile() ? { mtimeMs: stat.mtimeMs, size: stat.size } : null;
  } catch {
    return null;
  }
}

// Rule labels for rebuilding secret findings from scan-cache entries:
// the cache stores `[rule, line, fingerprint]` triples, never values,
// and the finding's reason is rebuilt from the rule id — the same
// text scanTextForSecrets writes, so a cached finding reads exactly
// like a fresh one.
const RULE_LABELS = new Map(SECRET_RULES.map((rule) => [rule.id, rule.label]));

/**
 * Rebuild secret findings from a cache entry. Returns null when the
 * entry cannot be trusted (unknown rule id, wrong shapes) — the
 * caller then treats the file as a cache miss and scans it fresh.
 */
function findingsFromCacheEntry(entry, relative) {
  const findings = [];
  for (const item of entry.f) {
    const [rule, line, fingerprint] = item;
    const label = RULE_LABELS.get(rule);
    if (!label || typeof line !== 'number' || typeof fingerprint !== 'string') return null;
    findings.push({
      kind: 'secret',
      label: relative,
      reason: `possible secret: ${label} (line ${line}, unverified)`,
      path: relative,
      rule,
      line,
      verified: false,
      fingerprint,
    });
  }
  return findings;
}

/** The scan-cache entry for one freshly scanned file: fingerprint, classification code and token estimate (both derivable, stored so the file is inspectable), and the secret findings as `[rule, line, fingerprint]` triples — never values. */
function scanCacheEntry(classifyResult, file, secretFindings) {
  let category = 'none';
  if (classifyResult.noise) category = noiseCategory(classifyResult.noise.reason);
  else if (classifyResult.review) category = 'review';
  return {
    m: file.mtimeMs,
    s: file.size,
    c: category,
    t: estimateTokens(file.size) ?? 0,
    f: secretFindings.map((finding) => [finding.rule, finding.line, finding.fingerprint]),
  };
}

function walk(root, dir, out, state) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // A directory that cannot be listed is not empty — it is unknown:
    // its files are not in the totals, the score, or the noise list,
    // so the scan says so instead of silently scoring a partial tree.
    state.unreadable += 1;
    return;
  }
  // Sort entries so two runs over the same tree report in the same order on
  // every platform; directory listing order is not guaranteed.
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    // Always report forward slashes, so output (and tests) are identical
    // on Windows, macOS and Linux.
    const rel = path.relative(root, full).split(path.sep).join('/');
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      if (isAiignored(rel, state.aiignore)) continue;
      if (isGitignored(rel, true, state.gitignore)) continue;
      // The .gitignore in this directory is read (or attempted) now,
      // so its fingerprint is recorded now: the cache header must see
      // exactly the .gitignore files the walk saw, including one with
      // no rules — it can gain rules later.
      const giFingerprint = gitignoreFingerprint(full);
      if (giFingerprint) state.gitignoreFingerprints.push({ path: `${rel}/.gitignore`, ...giFingerprint });
      const level = readGitignore(full, rel);
      if (level) state.gitignore.push(level);
      // The .aiignore in this directory is read the same way: its
      // fingerprint is recorded, and its patterns join the stack for
      // everything below it — a package's own ignore file, scoped to
      // that package, not the repo root.
      const aiFingerprint = aiignoreFingerprint(full);
      if (aiFingerprint) state.aiignoreFingerprints.push({ path: `${rel}/.aiignore`, ...aiFingerprint });
      const aiLevel = readAiignoreLevel(full, rel);
      if (aiLevel) state.aiignore.push(aiLevel);
      walk(root, full, out, state);
      if (aiLevel) state.aiignore.pop();
      if (level) state.gitignore.pop();
      continue;
    }
    if (entry.isSymbolicLink()) {
      // The scan never follows a link into a directory (that would
      // risk cycles), and a dangling link has no target to read: both
      // are unknowns, not files. A link to a real file is read as
      // that file — the agent is handed the target's contents either
      // way, so it is counted under the link's path.
      let targetStat;
      try {
        targetStat = fs.statSync(full);
      } catch {
        state.unreadable += 1;
        continue;
      }
      if (!targetStat.isFile()) {
        state.unreadable += 1;
        continue;
      }
    } else if (!entry.isFile()) {
      continue;
    }
    // The repo-root .aiignore is this tool's own output file, not repo
    // content an agent would be handed: counting its bytes in the
    // total would let the tool's own header move its own score (a fresh
    // header flipped the demo fixture 94 → 95). Nested .aiignore files
    // are user-written config, not tool output, so they are counted
    // like any other small file — only the root one is ours. The scan
    // cache file is excluded the same way: it is the tool's own record,
    // not repo content, and its bytes must never enter the totals.
    if (rel === '.aiignore') continue;
    if (state.cacheRel != null && rel === state.cacheRel) continue;
    if (isAiignored(rel, state.aiignore)) continue;
    if (isGitignored(rel, false, state.gitignore)) continue;
    if (state.files >= state.maxFiles) {
      // The cap bounds the counted set, not the walk — but a file
      // past the cap is still a file the scan did not see: count it
      // (and its bytes, when they can be read) so the report can say
      // how much of the repo the score is based on, instead of the
      // totals silently being a lower bound with no size attached.
      state.truncated = true;
      state.skippedFiles += 1;
      try {
        state.skippedBytes += fs.statSync(full).size;
      } catch {
        // The file vanished (or cannot be read) — it still counts as
        // skipped, just with unknown size.
      }
      continue;
    }
    let size = 0;
    let mtimeMs = 0;
    try {
      // The stat is taken once and kept: the mtime is the scan cache's
      // fingerprint for this file, so the entry must carry exactly
      // what this walk saw.
      const stat = fs.statSync(full);
      size = stat.size;
      mtimeMs = stat.mtimeMs;
    } catch {
      // Same rule as an unreadable directory: a file that cannot be
      // statted is unknown, not absent.
      state.unreadable += 1;
      continue;
    }
    state.files += 1;
    state.bytes += size;
    out.push({ relativePath: rel, size, mtimeMs });
  }
}

/**
 * Scan a directory and describe how much of it is context noise.
 * Synchronous and dependency-free, like the original. `maxFiles` caps the
 * walk; a capped walk reports `truncated: true` instead of silently
 * under-counting. Files listed in an `.aiignore` are excluded from
 * the scan entirely — they are what the agent will not be handed,
 * so they are not noise any more — which is also what makes
 * `context --fix` followed by `context` come back clean. An
 * `.aiignore` in a subdirectory applies to that directory (git's
 * per-directory rule: a pattern in `pkg/.aiignore` matches paths
 * under `pkg/`), so a package can ignore its own generated files
 * without touching the repo-root file; `--fix` still writes only
 * the root one. Files and
 * directories listed in `.gitignore` (at the root or nested) are
 * excluded the same way: they are already invisible to most agents, so
 * flagging them would be noise about noise.
 * `options.changed` (`{ ref, files, staged }` from lib/changed.mjs)
 * limits the scan to those files: the score, the noise list and the
 * totals are then the change's, not the repo's.
 * `options.scanCache` (`{ path, data }` from lib/scan-cache.mjs)
 * enables the incremental scan cache: unchanged files (same size +
 * mtime as their entry) are not re-read, their stored secret
 * findings are reused, and the cache is written back after the scan.
 * `data` is the loaded cache (null when there is none or it could
 * not be read); a header mismatch means a full scan. Save failures
 * go to `options.onScanCacheWarning`, never to an exception — a cache
 * that cannot be written must not fail a scan.
 * `options.newFromRev` (`{ ref, sizes }` — sizes from
 * lib/changed.mjs `refFileSizes`, keyed by the same relative paths
 * as the changed set) reports only noise that is new since `ref`:
 * a changed file absent at the ref is entirely new, a file already
 * noisy there in the same category counts only its growth, and a
 * file whose noise did not grow drops out. Review items and secret
 * findings are not filtered — they are advisory, and a secret is a
 * leak whenever it was added.
 */
export function scanDirectory(root, options = {}) {
  const absolute = path.resolve(root);
  let stat;
  try {
    stat = fs.statSync(absolute);
  } catch {
    throw new Error(`directory not found: ${root}`);
  }
  if (!stat.isDirectory()) throw new Error(`not a directory: ${root}`);
  const maxFiles = options.maxFiles == null ? DEFAULT_MAX_FILES : options.maxFiles;
  // The scan cache header fingerprints every .aiignore and .gitignore
  // the walk reads (root seeded here, nested ones collected by the
  // walk), so a rule change at any level forces a full re-scan. The
  // fingerprints are stats, not reads — they cost nothing on top of
  // the walk.
  const aiignore = [];
  const aiignoreFingerprints = [];
  const rootAiLevel = readAiignoreLevel(absolute, '');
  if (rootAiLevel) aiignore.push(rootAiLevel);
  const rootAiFingerprint = aiignoreFingerprint(absolute);
  if (rootAiFingerprint) aiignoreFingerprints.push({ path: '.aiignore', ...rootAiFingerprint });
  const gitignoreFingerprints = [];
  const rootGiFingerprint = gitignoreFingerprint(absolute);
  if (rootGiFingerprint) gitignoreFingerprints.push({ path: '.gitignore', ...rootGiFingerprint });
  const gitignore = [];
  const rootLevel = readGitignore(absolute, '');
  if (rootLevel) gitignore.push(rootLevel);
  const scanCache = options.scanCache ?? null;
  const state = {
    files: 0, bytes: 0, maxFiles, truncated: false, aiignore, gitignore,
    skippedFiles: 0, skippedBytes: 0, unreadable: 0,
    // The cache file itself is excluded from the walk (null when it
    // lives outside the scan root). The .aiignore and .gitignore
    // fingerprints collected by the walk, root first.
    cacheRel: scanCache != null ? scanCacheRelativePath(absolute, scanCache.path) : null,
    aiignoreFingerprints, gitignoreFingerprints,
  };
  const files = [];
  walk(absolute, absolute, files, state);
  // The walk's own counts, before a --changed scope recomputes the
  // totals over the kept files: the coverage percentage describes
  // the walk, not the change, so it is captured here.
  const walkedFiles = state.files;
  const walkedSkippedFiles = state.skippedFiles;

  // Changed-files scope (bat's git-aware method, --changed): only the
  // files git lists as changed are classified — the walk still ran, so
  // .aiignore and .gitignore are honoured the same way, and files the
  // walk never saw (gitignored, deleted) drop out. The totals are
  // recomputed over the kept files, so the score is the score of the
  // change, not of the repo: a legacy log the change did not touch
  // must not move the verdict on the change.
  const changed = options.changed || null;
  const kept = changed
    ? files.filter((file) => changed.files.includes(file.relativePath))
    : files;
  if (changed) {
    state.files = kept.length;
    state.bytes = kept.reduce((sum, file) => sum + file.size, 0);
  }
  // golangci-lint's --new-from-rev, at file level: when the scan is
  // new-only, a changed file's noise counts only to the extent it is
  // new since the ref. A file absent at the ref is entirely new; a
  // file already noisy there in the same category counts only its
  // growth (current size minus ref size, never below zero), so
  // touching a 2 MB lockfile to bump one version adds no noise while
  // growing it by 100 KB reports exactly those 100 KB. A file whose
  // noise category changed — a file crossing the 1 MB large-file line
  // — counts in full, because its old category is not this
  // category's noise. The classification is pure in (path, size),
  // so the ref version is classified from its size alone, with no
  // content read. A renamed file's new path is absent at the ref, so
  // it counts as new — the old path is not traced. Review items and
  // secret findings are not filtered: they are advisory, and a
  // secret is a leak whenever it was added.
  const newFromRev = options.newFromRev ?? null;

  const allNoise = [];
  // One row per build-output directory, not one row per file inside it:
  // a dist/ with hundreds of files would otherwise flood the noise list
  // (and the score uses the summed bytes either way).
  const dirNoise = new Map();
  const review = [];
  const reviewSuggestions = new Set();
  let secretsSuppressed = 0;
  let unscannedSecrets = 0;
  let unscannedSecretsBytes = 0;
  // The scan cache (ESLint's --cache, metadata strategy): the header
  // is validated against what the walk just saw — a mismatch means a
  // full scan, and the cache is rewritten afterwards. A cache hit
  // skips the content read and the secrets scan for that file; the
  // classification is re-derived (classifyPath is pure in the path
  // and size, both already known, so replaying it costs microseconds
  // and cannot drift from a fresh scan). Only the secret findings
  // come from the cache — they are the one thing the content read
  // produces that cannot be recomputed without reading.
  const gitignoreForHeader = state.gitignoreFingerprints.map((fp) => [fp.path, fp.mtimeMs, fp.size]);
  const aiignoreForHeader = state.aiignoreFingerprints.map((fp) => [fp.path, fp.mtimeMs, fp.size]);
  const cacheUsable = scanCache != null && scanCache.data != null && headerMatches(scanCache.data, {
    toolVersion: getToolVersion(),
    root: absolute,
    maxFiles,
    aiignore: aiignoreForHeader,
    gitignore: gitignoreForHeader,
  });
  // A cache rewrite is only needed when the stored observations would
  // change: a file was re-scanned, an entry dropped, or the header is
  // no longer current. A fully-cached run rewrites nothing — the file
  // stays byte-identical, and its mtime stays the day it was written.
  let cacheDirty = scanCache != null && !cacheUsable;
  const newEntries = new Map();
  let cachedFiles = 0;
  let cachedBytes = 0;
  for (const file of kept) {
    const result = classifyPath(file.relativePath, file.size);
    const relative = file.relativePath.split(path.sep).join('/');
    // New-only noise: the item's bytes are the new bytes, not the
    // file's size — the score, the token estimate and the fix list
    // all read the item, so the delta flows through everywhere.
    let noiseBytes = file.size;
    if (result.noise && newFromRev) {
      const refSize = newFromRev.sizes.get(relative);
      if (refSize != null) {
        const refResult = classifyPath(relative, refSize);
        if (refResult.noise && noiseCategory(refResult.noise.reason) === noiseCategory(result.noise.reason)) {
          noiseBytes = Math.max(0, file.size - refSize);
        }
      }
    }
    if (result.noise && noiseBytes > 0) {
      const item = {
        ...result.noise,
        bytes: noiseBytes,
        path: relative,
        suggestion: result.suggestion || null,
      };
      if (item.label.endsWith('/')) {
        const existing = dirNoise.get(item.label);
        if (existing) existing.bytes += item.bytes;
        else {
          const aggregated = { label: item.label, reason: item.reason, bytes: item.bytes, path: item.label, suggestion: result.suggestion || null };
          dirNoise.set(item.label, aggregated);
          allNoise.push(aggregated);
        }
      } else {
        allNoise.push(item);
      }
    } else if (result.review) {
      review.push({ ...result.review, bytes: file.size, path: file.relativePath.split(path.sep).join('/') });
      if (result.suggestion) reviewSuggestions.add(result.suggestion);
    }
    // Content-level secret scan (gitleaks' rules-are-data method): a
    // file the name check passes can still carry a live key inside it.
    // Findings are advisory review items like the filename ones — they
    // cost no score points, never print the matched value, and --fix
    // never writes them. The suggestion is the file's exact path: the
    // file itself is what must not reach the agent. Findings the
    // secrets baseline already covers (detect-secrets' method: a
    // triaged finding is recognised by its fingerprint) are dropped
    // here, with their suggestions, and counted — the report says
    // how many were suppressed, so a baseline never silences
    // anything invisibly.
    // Files over the secret-scan cap are never content-scanned, so a
    // credential inside one is a blind spot, not a clean bill: count
    // them here, whatever their type — the cap is what skipped the
    // scan, and the detail says only that: not scanned, not "unsafe".
    if (file.size > MAX_SECRET_SCAN_BYTES) {
      unscannedSecrets += 1;
      unscannedSecretsBytes += file.size;
    }
    // With a usable cache, an unchanged file (same size + mtime as
    // its entry) is not re-read: its stored findings are reused, and
    // the fresh entry is the stored one. Anything else is scanned
    // normally and recorded, so the cache is rewritten with fresh
    // observations after the scan.
    let secretFindings;
    let cacheHit = false;
    if (cacheUsable) {
      const entry = lookupScanCache(scanCache.data, relative, { mtimeMs: file.mtimeMs, size: file.size });
      const reconstructed = entry ? findingsFromCacheEntry(entry, relative) : null;
      if (reconstructed != null) {
        cacheHit = true;
        cachedFiles += 1;
        cachedBytes += file.size;
        secretFindings = reconstructed;
        newEntries.set(relative, entry);
      }
    }
    if (!cacheHit) {
      secretFindings = scanFileForSecrets(path.join(absolute, file.relativePath), relative);
      if (scanCache != null) {
        cacheDirty = true;
        newEntries.set(relative, scanCacheEntry(result, file, secretFindings));
      }
    }
    const { kept: newSecrets, suppressed } = splitBaselined(secretFindings, options.secretsBaseline ?? null);
    secretsSuppressed += suppressed.length;
    for (const finding of newSecrets) {
      review.push({ ...finding, bytes: file.size, suggestion: relative });
      reviewSuggestions.add(relative);
    }
  }

  // Write the cache back after a successful scan: the new entries
  // overwrite the old ones for the files this scan saw. Files the
  // scan did not see are dropped — but only on a full-scope scan
  // that actually saw the whole tree. A --changed-scoped scan (or a
  // scan that hit the file cap) upserts only: entries outside the
  // scope stay, unless the header mismatch is about content (a new
  // tool version, a different root or cap), in which case the stored
  // observations may be stale and nothing is carried over. A cache
  // that cannot be written warns and is forgotten — it must never
  // fail a scan.
  let cached = null;
  if (scanCache != null) {
    const carryOver = (changed != null || state.truncated)
      && headerContentMatches(scanCache.data, {
        toolVersion: getToolVersion(), root: absolute, maxFiles,
        aiignore: aiignoreForHeader, gitignore: gitignoreForHeader,
      });
    const merged = { ...(carryOver ? scanCache.data.files : {}) };
    for (const [relative, entry] of newEntries) merged[relative] = entry;
    // A full-scope scan drops entries for files that are gone; a
    // dropped entry is a change, so the cache is rewritten.
    if (changed == null && !state.truncated && scanCache.data != null) {
      for (const relative of Object.keys(scanCache.data.files)) {
        if (!merged[relative]) cacheDirty = true;
      }
    }
    if (cacheDirty) {
      const data = buildScanCacheData({
        root: absolute, maxFiles, aiignore: aiignoreForHeader,
        gitignore: gitignoreForHeader, files: merged,
      });
      try {
        saveScanCache(scanCache.path, data);
      } catch (error) {
        if (typeof options.onScanCacheWarning === 'function') options.onScanCacheWarning(error.message);
      }
    }
    // A cache hit is a fingerprint-verified earlier observation, not
    // a blind spot, so cached files are never `unknowns` — but the
    // result must disclose the cache: how many files were reused,
    // their bytes, and when the cache was written.
    if (cacheUsable) {
      cached = {
        files: cachedFiles,
        bytes: cachedBytes,
        strategy: 'metadata',
        writtenAt: scanCache.data.writtenAt ?? null,
      };
    }
  }

  const scored = scoreNoise(allNoise, state.bytes);
  // Only noise in a category that actually lost points is reported. A
  // 95 B lockfile in a 1.7 MB repo loses 0 points, so listing it as
  // "noise to keep away" — with a fix suggestion — would contradict the
  // PASS verdict on a 100/100 scan. The score itself still uses every
  // noise byte; the filter only decides what is worth fixing.
  const costly = new Set(scored.breakdown.filter((item) => item.lost > 0).map((item) => item.id));
  // Ranked by cost, biggest first (Repomix's token-count tree, Aider's
  // repomap): the reader should meet the most expensive noise first, and
  // the top-N share line in the CLI needs a ranked list. Each item
  // carries its own token estimate so the text report and --json agree.
  const noise = allNoise
    .filter((item) => costly.has(noiseCategory(item.reason)))
    .map(({ suggestion, ...item }) => ({ ...item, tokens: estimateTokens(item.bytes) }))
    .sort((a, b) => b.bytes - a.bytes);
  const suggestions = new Set();
  for (const item of allNoise) {
    if (item.suggestion && costly.has(noiseCategory(item.reason))) suggestions.add(item.suggestion);
  }
  // Review suggestions are advisory only and are never part of
  // `suggestions`, so --fix never writes them: a review item costs no
  // score points, so writing its entry would fix nothing — and a
  // basename pattern like `secret.js` would hide every same-named file
  // in the repo, including harmless test fixtures. They are reported
  // separately so the user can add them to .aiignore by hand.
  const noiseBytes = noise.reduce((sum, item) => sum + item.bytes, 0);
  // What the listed noise costs in tokens, at ~4 bytes per token
  // (estimate, not a count); null when there is no listed noise.
  const estimatedTokens = estimateTokens(noiseBytes);
  /**
   * What this scan does not know (REA's Evidence/Unknown model,
   * borrowed as a report field, not a dependency): every entry is a
   * measured blind spot, with counts — never a guess, and never
   * silently absent. The score is computed from what was seen; the
   * unknowns say what was not seen, so a 100/100 on a half-scanned
   * repo cannot be read as a clean bill for the whole repo. Empty
   * when the scan saw everything: a clean scan reports no unknowns.
   */
  const unknowns = [];
  if (state.truncated) {
    unknowns.push({
      kind: 'truncated',
      detail: `scan stopped at the ${maxFiles.toLocaleString('en-US')}-file limit: ${walkedSkippedFiles} file${walkedSkippedFiles === 1 ? '' : 's'} (${formatBytes(state.skippedBytes)}) not counted — the score and totals are a lower bound`,
      files: walkedSkippedFiles,
      bytes: state.skippedBytes,
    });
  }
  if (state.unreadable > 0) {
    unknowns.push({
      kind: 'unreadable',
      detail: `${state.unreadable} file${state.unreadable === 1 ? '' : 's'} or director${state.unreadable === 1 ? 'y' : 'ies'} could not be read, so their contents are unknown`,
      files: state.unreadable,
    });
  }
  if (unscannedSecrets > 0) {
    unknowns.push({
      kind: 'unscanned-for-secrets',
      detail: `${unscannedSecrets} file${unscannedSecrets === 1 ? '' : 's'} over 1 MB (${formatBytes(unscannedSecretsBytes)}) ${unscannedSecrets === 1 ? 'was' : 'were'} not content-scanned for secrets — a credential inside one would not be found`,
      files: unscannedSecrets,
      bytes: unscannedSecretsBytes,
    });
  }
  // Share of the repo's files the score is based on: the counted
  // files over the counted plus the cap-skipped ones. 100 when
  // nothing was skipped; unreadable paths are not in the denominator
  // — the walk cannot know how many files hide inside a directory
  // it could not list.
  const visibleFilesPct = walkedSkippedFiles === 0
    ? 100
    : Math.round((walkedFiles / (walkedFiles + walkedSkippedFiles)) * 1000) / 10;
  return {
    root: absolute,
    files: state.files,
    bytes: state.bytes,
    truncated: state.truncated,
    unknowns,
    visibleFilesPct,
    // The scope, when the scan was limited to changed files: the ref,
    // the file list, and whether only staged files were scanned, so
    // --json, --report and MCP can say exactly what was scanned. Null
    // for a whole-repo scan. `newFromRev` names the ref the noise was
    // judged new against (null for a plain --changed scan): the same
    // ref as `ref` — one ref governs both the changed set and the
    // new-noise baseline.
    changed: changed ? { ref: changed.ref, files: [...changed.files], staged: changed.staged === true, newFromRev: newFromRev ? newFromRev.ref : null } : null,
    // The secrets baseline, when one was loaded: which file it came
    // from and how many triaged findings it suppressed. Null when no
    // baseline was requested, so --json output is unchanged for scans
    // without one. A requested-but-missing baseline is recorded by
    // the caller (runContextCheck) as loaded: false.
    secretsBaseline: options.secretsBaseline
      ? { path: options.secretsBaseline.path, loaded: true, suppressed: secretsSuppressed }
      : null,
    // The scan cache, when one was used: how many files were reused
    // from it (fingerprint-verified earlier observations, not blind
    // spots), their bytes, and when the cache was written. Null when
    // no cache was loaded or it did not match this run — the scan
    // then ran fresh, and a fresh run's JSON is identical to a cached
    // run's except for this field.
    cached,
    noise,
    review,
    suggestions: [...suggestions].sort(),
    // Advisory only: --fix never writes these (see above).
    reviewSuggestions: [...reviewSuggestions].sort(),
    score: scored.score,
    lost: scored.lost,
    breakdown: scored.breakdown,
    status: statusFor(scored.score),
    estimatedTokens,
    // Which top-level directories the noise lives in, biggest first —
    // the directory-level view of the same list, so the reader sees
    // whether fixing one directory is most of the job. Empty when the
    // noise spans fewer than two directories.
    topDirectories: topNoiseDirectories(noise, estimatedTokens),
  };
}

/**
 * Header written at the top of a newly created .aiignore (Repomix's
 * self-describing output file, applied to our generated file): anyone
 * opening the file later can see what wrote it and how to regenerate
 * it. Comment lines, so they are never treated as patterns.
 */
export const AIIGNORE_HEADER = [
  '# .aiignore — written by `dev-diagnosis context --fix` (https://github.com/WJDdidi-1/dev-doctor)',
  '# Re-run `dev-diagnosis context --fix` to update it; the entries below are safe to edit or remove.',
];

/**
 * Work out exactly what applyAiignore would do, without writing
 * anything. This is the single source of truth for both the real fix
 * and its --dry-run preview (Ruff's --diff rule: the preview shows
 * exactly what --fix would do, because both run the same computation),
 * so a preview can never drift from the fix it describes. `created`
 * is true only when the file does not exist yet and something would be
 * added; `wouldAddHeader` says whether the new file (or an empty one)
 * would get the provenance header; `nextContent` is the exact bytes
 * the file would hold afterwards, or null when nothing would change.
 */
export function planAiignore(root, suggestions) {
  const target = path.join(path.resolve(root), '.aiignore');
  const wanted = [...new Set(suggestions)].sort();
  if (wanted.length === 0) {
    return { path: target, added: [], alreadyPresent: [], created: false, wouldAddHeader: false, nextContent: null };
  }
  let content = '';
  let missing = false;
  try {
    content = fs.readFileSync(target, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`cannot read .aiignore: ${error.message}`);
    missing = true;
  }
  const present = new Set(
    content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
  );
  const added = wanted.filter((entry) => !present.has(entry));
  const alreadyPresent = wanted.filter((entry) => present.has(entry));
  if (added.length === 0) {
    return { path: target, added, alreadyPresent, created: false, wouldAddHeader: false, nextContent: null };
  }
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  // A fresh file (or one with no real content yet) gets the header so
  // its provenance is visible; an existing file is append-only and is
  // never rewritten to add one.
  const addHeader = missing || content.trim() === '';
  let next = content;
  if (addHeader) {
    next = AIIGNORE_HEADER.map((line) => line + newline).join('');
  } else if (next.length > 0 && !next.endsWith('\n')) {
    next += newline;
  }
  next += added.map((entry) => entry + newline).join('');
  return { path: target, added, alreadyPresent, created: missing, wouldAddHeader: addHeader, nextContent: next };
}

/**
 * Write the scan's .aiignore suggestions into `<root>/.aiignore`.
 * Only appends entries that are not already there (compared after
 * trimming); existing content is never removed or reordered, and no file
 * is created when there is nothing to add. Returns what happened so the
 * CLI can report it: `{ path, added, alreadyPresent, created }`.
 */
export function applyAiignore(root, suggestions) {
  const plan = planAiignore(root, suggestions);
  if (plan.nextContent == null) {
    return { path: plan.path, added: [], alreadyPresent: plan.alreadyPresent, created: false };
  }
  try {
    fs.writeFileSync(plan.path, plan.nextContent);
  } catch (error) {
    throw new Error(`cannot write .aiignore: ${error.message}`);
  }
  return { path: plan.path, added: plan.added, alreadyPresent: plan.alreadyPresent, created: plan.created };
}
