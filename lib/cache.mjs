/**
 * Build-cache verdict.
 *
 * Simplified from cache-verdict (WJDdidi-1/cache-verdict, Apache-2.0).
 * The original detects the ecosystem, hashes inputs into a content key,
 * and keeps a ledger of stored caches. This version does the one thing
 * the question needs and nothing else: run the same build command twice,
 * once with the cache moved aside (cold) and once with it present
 * (warm), time both, and say whether the cache pays. The cache directory
 * is always restored to exactly the state it was in before the check,
 * even when a run fails.
 *
 * Safety rules, enforced before anything moves:
 *   - the cache directory must live inside the project root;
 *   - it must not be the project root, and must not contain the project;
 *   - it must not be inside dev-diagnosis's own work area (there is none —
 *     the stash lives in os.tmpdir(), never in the project).
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runCommand } from './run-command.mjs';

export const CACHE_DIR_CANDIDATES = [
  'node_modules/.cache',
  '.next/cache',
  '.cache',
  '.turbo',
  'target',
  '.gradle',
];

/** One timing sample is noise: hyperfine's whole point is that a single
 * run cannot tell a fast build from a slow one. `runs` caps at 10 so
 * nobody accidentally schedules an hour of builds. */
export const MAX_CACHE_RUNS = 10;

/** Median of the samples — robust to the one slow run a background
 * process causes, where a mean would move. Even counts average the two
 * middle samples. */
export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

/** First existing cache directory under root, or null. */
export function detectCacheDir(root) {
  const absolute = path.resolve(root);
  for (const candidate of CACHE_DIR_CANDIDATES) {
    const full = path.join(absolute, candidate);
    try {
      if (fs.statSync(full).isDirectory()) return full;
    } catch { /* not present — try the next candidate */ }
  }
  return null;
}

function assertCacheDirSafe(root, cacheDir) {
  const project = path.resolve(root);
  const resolved = path.resolve(cacheDir);
  if (resolved === project) throw new Error('cacheDir must not point at the project root');
  const rel = path.relative(project, resolved);
  if (rel === '' || rel.startsWith(`..${path.sep}`) || rel === '..' || path.isAbsolute(rel)) {
    throw new Error(`cacheDir ${resolved} is outside the project ${project}`);
  }
  const projectInside = path.relative(resolved, project);
  if (projectInside !== '' && !projectInside.startsWith(`..${path.sep}`) && projectInside !== '..' && !path.isAbsolute(projectInside)) {
    throw new Error(`cacheDir ${resolved} contains the project itself`);
  }
}

function movePath(from, to) {
  fs.renameSync(from, to);
}

function removeTree(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

/**
 * Run the build command cold (cache moved aside) and warm (cache present).
 * With runs: 1 (the default) this is one cold and one warm run, exactly
 * as before. With runs: N it is N cold runs and N warm runs, and the
 * verdict is judged on the medians, with the min–max spread reported —
 * the hyperfine method: a single timing sample is noise, and the
 * verdict used to flip between repeats on a jittery build. The cache
 * directory is restored to its original state in a finally block,
 * whatever happens.
 */
export function runCacheCheck(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const command = options.command;
  if (!Array.isArray(command) || command.length === 0) {
    throw new Error('cache check needs a build command after --, for example: dev-diagnosis cache -- node build.mjs');
  }
  const runs = options.runs == null ? 1 : options.runs;
  if (!Number.isInteger(runs) || runs < 1 || runs > MAX_CACHE_RUNS) {
    throw new Error(`runs must be an integer from 1 to ${MAX_CACHE_RUNS}, got ${runs}`);
  }
  let cacheDir = options.cacheDir ? path.resolve(root, options.cacheDir) : detectCacheDir(root);
  if (!cacheDir) {
    throw new Error(
      'no cache directory found in this project; pass --cache-dir <dir> '
      + `(looked for ${CACHE_DIR_CANDIDATES.join(', ')})`,
    );
  }
  assertCacheDirSafe(root, cacheDir);

  const stashRoot = path.join(
    path.dirname(cacheDir),
    `.dev-diagnosis-stash-${process.pid}-${randomUUID()}`,
  );
  // The stash lives next to the cache directory, on the same filesystem:
  // renaming across devices (for example into os.tmpdir()) fails with
  // EXDEV. It is removed in the finally block below.
  fs.mkdirSync(stashRoot);
  const originalStash = path.join(stashRoot, 'original');
  const producedStash = path.join(stashRoot, 'produced');
  const hadOriginal = fs.existsSync(cacheDir);
  let movedOriginal = false;
  let movedProduced = false;
  let originalRestored = false;

  const run = () => runCommand(command, { cwd: root, timeoutMs: options.timeoutMs });
  const coldRuns = [];
  const warmRuns = [];
  let coldStdout = '';
  let warmStdout = '';
  try {
    if (hadOriginal) { movePath(cacheDir, originalStash); movedOriginal = true; }
    for (let i = 0; i < runs; i += 1) {
      // A previous cold run produced a cache: clear it, or this run
      // would measure warm. The last produced cache is cleared below,
      // before the original is restored for the warm runs.
      if (fs.existsSync(cacheDir)) removeTree(cacheDir);
      const cold = run();
      if (!cold.ok) {
        throw new Error(`cold build failed${runs > 1 ? ` on run ${i + 1} of ${runs}` : ''} (exit ${cold.status ?? 'unknown'}): ${(cold.stderr || cold.error || '').trim().split('\n')[0] || 'no output'}`);
      }
      coldRuns.push(cold.ms);
      coldStdout = cold.stdout;
    }
    if (hadOriginal) {
      // Set the freshly produced cache aside; the warm runs measure the
      // cache as it was before this check.
      if (fs.existsSync(cacheDir)) { movePath(cacheDir, producedStash); movedProduced = true; }
      movePath(originalStash, cacheDir);
      originalRestored = true;
    }
    // With no original cache, the cold run's output stays in place: it is
    // the cache the warm runs should measure.
    for (let i = 0; i < runs; i += 1) {
      const warm = run();
      if (!warm.ok) {
        throw new Error(`warm build failed${runs > 1 ? ` on run ${i + 1} of ${runs}` : ''} (exit ${warm.status ?? 'unknown'}): ${(warm.stderr || warm.error || '').trim().split('\n')[0] || 'no output'}`);
      }
      warmRuns.push(warm.ms);
      warmStdout = warm.stdout;
    }
  } finally {
    // Restore the original cache exactly. If it was already put back for
    // the warm run it is sitting in cacheDir now and must be left alone;
    // only an error before that point leaves it in the stash.
    try {
      if (movedOriginal && !originalRestored) {
        if (fs.existsSync(cacheDir)) removeTree(cacheDir);
        if (fs.existsSync(originalStash)) movePath(originalStash, cacheDir);
      }
      if (movedProduced && fs.existsSync(producedStash)) removeTree(producedStash);
    } catch { /* best effort: never let cleanup hide the real result */ }
    try { removeTree(stashRoot); } catch { /* best effort */ }
  }

  const coldMs = median(coldRuns);
  const warmMs = median(warmRuns);
  const savedMs = coldMs - warmMs;
  const savedPct = coldMs > 0 ? Math.round((savedMs / coldMs) * 100) : 0;
  let verdict;
  let verdictDetail;
  if (savedMs >= 50 && savedPct >= 10) {
    verdict = 'cache pays';
    verdictDetail = `warm run is ${savedMs.toFixed(0)} ms (${savedPct}%) faster than cold`;
  } else if (savedMs <= -50 && savedPct <= -10) {
    verdict = 'cache costs';
    verdictDetail = `warm run is ${(-savedMs).toFixed(0)} ms (${-savedPct}%) slower than cold — the cache is not helping this build`;
  } else {
    verdict = 'inconclusive';
    verdictDetail = runs > 1
      ? 'cold and warm medians are within noise of each other; raise --runs to confirm'
      : 'cold and warm runs are within noise of each other; rerun to confirm';
  }
  if (runs > 1) {
    verdictDetail += ` (median of ${runs} runs each)`;
  }
  return {
    root, cacheDir, command, runs, coldRuns, warmRuns,
    coldMs, warmMs, savedMs, savedPct, verdict, verdictDetail,
    coldStdout, warmStdout,
  };
}
