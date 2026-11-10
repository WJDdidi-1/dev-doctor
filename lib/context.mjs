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

  for (const part of parts.slice(0, -1)) {
    if (NOISE_DIRS.has(part)) {
      return { noise: { label: `${part}/`, reason: NOISE_DIRS.get(part) }, suggestion: `${part}/` };
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
      walk(root, full, out, state);
      continue;
    }
    if (!entry.isFile()) continue;
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
 * under-counting.
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
  const state = { files: 0, bytes: 0, maxFiles, truncated: false };
  const files = [];
  walk(absolute, absolute, files, state);

  const noise = [];
  const review = [];
  const suggestions = new Set();
  for (const file of files) {
    const result = classifyPath(file.relativePath, file.size);
    if (result.noise) {
      noise.push({ ...result.noise, bytes: file.size, path: file.relativePath.split(path.sep).join('/') });
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
