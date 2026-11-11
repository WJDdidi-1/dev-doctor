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
    return { noise: { label: normalized, reason: 'large file' }, suggestion: null };
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

function walk(root, dir, out, state) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
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
      if (state.ignore.length > 0 && matchesAiignore(rel, state.ignore)) continue;
      walk(root, full, out, state);
      continue;
    }
    if (!entry.isFile()) continue;
    if (state.ignore.length > 0 && matchesAiignore(rel, state.ignore)) continue;
    if (state.files >= state.maxFiles) {
      state.truncated = true;
      continue;
    }
    let size = 0;
    try {
      size = fs.statSync(full).size;
    } catch {
      continue;
    }
    state.files += 1;
    state.bytes += size;
    out.push({ relativePath: rel, size });
  }
}

/**
 * Scan a directory and describe how much of it is context noise.
 * Synchronous and dependency-free, like the original. `maxFiles` caps the
 * walk; a capped walk reports `truncated: true` instead of silently
 * under-counting. Files listed in the repo's `.aiignore` are excluded
 * from the scan entirely — they are what the agent will not be handed,
 * so they are not noise any more — which is also what makes
 * `context --fix` followed by `context` come back clean.
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
  const maxFiles = options.maxFiles == null ? 10000 : options.maxFiles;
  const ignore = readAiignore(absolute);
  const state = { files: 0, bytes: 0, maxFiles, truncated: false, ignore };
  const files = [];
  walk(absolute, absolute, files, state);

  const noise = [];
  // One row per build-output directory, not one row per file inside it:
  // a dist/ with hundreds of files would otherwise flood the noise list
  // (and the score uses the summed bytes either way).
  const dirNoise = new Map();
  const review = [];
  const suggestions = new Set();
  for (const file of files) {
    const result = classifyPath(file.relativePath, file.size);
    if (result.noise) {
      const item = { ...result.noise, bytes: file.size, path: file.relativePath.split(path.sep).join('/') };
      if (item.label.endsWith('/')) {
        const existing = dirNoise.get(item.label);
        if (existing) existing.bytes += file.size;
        else {
          const aggregated = { label: item.label, reason: item.reason, bytes: file.size, path: item.label };
          dirNoise.set(item.label, aggregated);
          noise.push(aggregated);
        }
      } else {
        noise.push(item);
      }
      if (result.suggestion) suggestions.add(result.suggestion);
    } else if (result.review) {
      review.push({ ...result.review, bytes: file.size, path: file.relativePath.split(path.sep).join('/') });
      if (result.suggestion) suggestions.add(result.suggestion);
    }
  }

  const scored = scoreNoise(noise, state.bytes);
  return {
    root: absolute,
    files: state.files,
    bytes: state.bytes,
    truncated: state.truncated,
    noise,
    review,
    suggestions: [...suggestions].sort(),
    score: scored.score,
    lost: scored.lost,
    breakdown: scored.breakdown,
    status: statusFor(scored.score),
  };
}

/**
 * Write the scan's .aiignore suggestions into `<root>/.aiignore`.
 * Only appends entries that are not already there (compared after
 * trimming); existing content is never removed or reordered, and no file
 * is created when there is nothing to add. Returns what happened so the
 * CLI can report it: `{ path, added, alreadyPresent, created }`.
 */
export function applyAiignore(root, suggestions) {
  const target = path.join(path.resolve(root), '.aiignore');
  const wanted = [...new Set(suggestions)].sort();
  if (wanted.length === 0) {
    return { path: target, added: [], alreadyPresent: [], created: false };
  }
  let content = '';
  let created = false;
  try {
    content = fs.readFileSync(target, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`cannot read .aiignore: ${error.message}`);
    created = true;
  }
  const present = new Set(
    content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
  );
  const added = wanted.filter((entry) => !present.has(entry));
  if (added.length === 0) {
    return { path: target, added: [], alreadyPresent: wanted, created: false };
  }
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  let next = content;
  if (next.length > 0 && !next.endsWith('\n')) next += newline;
  next += added.map((entry) => entry + newline).join('');
  try {
    fs.writeFileSync(target, next);
  } catch (error) {
    throw new Error(`cannot write .aiignore: ${error.message}`);
  }
  return { path: target, added, alreadyPresent: wanted.filter((entry) => present.has(entry)), created };
}
