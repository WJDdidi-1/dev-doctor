/**
 * The four checks, as functions both the CLI and the MCP server call.
 *
 * This is the one place the check logic lives: bin/dev-diagnosis.js
 * renders it for humans, lib/mcp.mjs serves it to agents, and neither
 * re-implements a verdict. Each runner returns the same shape —
 * `{ result, passed, verdict }` — and a check that could not run
 * returns `{ result: null, passed: false, verdict, error }` instead of
 * throwing, so the `all` report can say why it failed.
 */
import { scanDirectory, applyAiignore, formatBytes, planAiignore } from './context.mjs';
import { listChangedFiles } from './changed.mjs';
import {
  buildContexts, findCommandCopies, fixForDirectory, lookupCommand,
  searchToolchainBins,
} from './pathcheck.mjs';
import { runCacheCheck as runCacheCheckImpl } from './cache.mjs';
import { scanRuns } from './flakes.mjs';
import { formatMs } from './report.mjs';

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

// "login", "login and daemon-like", "login, non-login and daemon-like".
function joinNames(names) {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function runContextCheck(target, options = {}) {
  const root = target || process.cwd();
  // --changed scopes the scan to the files git lists as changed vs
  // the ref (HEAD by default). The check throws outside a git repo,
  // like a missing directory throws: the check could not run, and the
  // caller says so instead of silently scanning the whole repo.
  const changed = options.changedRef != null
    ? listChangedFiles(root, options.changedRef)
    : null;
  const result = scanDirectory(root, changed ? { changed } : {});
  const passed = result.score >= 85;
  return { result, passed, verdict: passed ? 'context is clean' : `${result.status.toLowerCase()} (score ${result.score}/100)` };
}

/**
 * Apply the context check's .aiignore suggestions and record the
 * outcome on the check result, so --json output carries it too.
 */
export function applyContextFix(check) {
  const fix = applyAiignore(check.result.root, check.result.suggestions);
  check.result.fix = fix;
  return fix;
}

/**
 * The --dry-run twin of applyContextFix: compute the .aiignore plan
 * without writing anything, and record it on the check result (marked
 * dryRun: true) so --json output carries the preview too. The plan is
 * the same computation applyAiignore runs, so the preview shows
 * exactly what --fix would write.
 */
export function previewContextFix(check) {
  const plan = planAiignore(check.result.root, check.result.suggestions);
  const { nextContent: _ignored, ...fix } = plan;
  fix.dryRun = true;
  check.result.fix = fix;
  return fix;
}

/**
 * Apply a context check's .aiignore fix, then re-scan so the returned
 * check describes the repo as it stands after the fix. The fix outcome
 * is carried onto the re-scanned result, so --json and MCP output still
 * say what was written. Without the re-scan, `context --fix` on a noisy
 * repo would report the pre-fix verdict — exit 1 and FAIL — even though
 * the fix landed and a re-run scores clean. The exit code of a fix
 * command should say whether the repo is fixed now, the way
 * eslint --fix does: it exits 0 when everything it could fix is fixed.
 */
export function applyContextFixAndRescan(check) {
  const fix = applyContextFix(check);
  // A scoped check re-scans scoped: the fix only wrote .aiignore, so
  // the changed set is re-listed fresh and the post-fix result still
  // describes the change, not the repo.
  const changedRef = check.result.changed ? check.result.changed.ref : null;
  const fixed = runContextCheck(check.result.root, changedRef != null ? { changedRef } : {});
  fixed.result.fix = fix;
  return fixed;
}

/**
 * Re-scan the context check of an `all` run after --fix, and refresh
 * the run's overall verdict and summary to match. The pre-fix report
 * stays printed above; what changes is the verdict the run reports.
 * The fix outcome recorded by applyContextFix is carried over, so the
 * post-fix result still says what was written.
 */
export function rescanContext(run) {
  const before = run.checks.context;
  const changedRef = before?.result?.changed ? before.result.changed.ref : null;
  const fixed = runContextCheck(run.root, changedRef != null ? { changedRef } : {});
  if (before?.result?.fix) fixed.result.fix = before.result.fix;
  run.checks.context = fixed;
  run.overall = Object.values(run.checks).every((check) => check.passed);
  run.summary = buildSummary(run.checks, run.skipped);
  return fixed;
}

export function runPathCheck(commandName) {
  if (!commandName) throw new UsageError('path needs a command, for example: dev-diagnosis path node');
  const contexts = buildContexts();
  const rows = contexts.map((ctx) => {
    const found = lookupCommand(commandName, ctx.pathValue);
    return { ...ctx, resolved: found.resolved, path: found.path, reason: found.reason || null };
  });
  const copies = findCommandCopies(commandName, process.env.PATH || '');
  const toolchainHits = rows[0].resolved ? [] : searchToolchainBins(commandName);
  let fix = null;
  if (!rows[0].resolved && toolchainHits.length > 0) fix = fixForDirectory(toolchainHits[0].directory);
  else if (!rows[0].resolved && rows.some((row) => row.resolved)) {
    fix = 'it resolves in another shell context — check which startup file sets your PATH';
  }
  const passed = rows[0].resolved;
  // The verdict must agree with the four-context table above it: "missing
  // in the current shell" was wrong on both sides — when the command
  // missed everywhere it sounded like it might exist elsewhere, and when
  // it resolved in another context it never said where. Name the contexts
  // it resolves in, or say plainly that no context has it.
  const foundIn = rows.filter((row) => row.resolved).map((row) => row.name);
  let verdict;
  if (passed) verdict = `${commandName} resolves to ${rows[0].path}`;
  else if (foundIn.length > 0) verdict = `${commandName} is missing in the current shell, but resolves in ${joinNames(foundIn)}`;
  else verdict = `${commandName} is not found in any shell context`;
  return {
    result: { command: commandName, contexts: rows, copies, toolchainHits, fix },
    passed,
    verdict,
  };
}

export function runFlakesCheck(dir) {
  if (!dir) throw new UsageError('flakes needs a runs directory, for example: dev-diagnosis flakes examples/runs');
  const result = scanRuns(dir);
  const unparsable = result.warnings.length;
  const skippedRuns = result.skippedRuns ? result.skippedRuns.length : 0;
  // A file that could not be parsed, or a run directory that produced no
  // reports, means the verdict is based on incomplete data: "no flaky
  // tests" on a half-read run set is not a pass, so the check fails and
  // the verdict says what was unreadable. The warnings themselves are
  // printed with the table.
  const passed = result.totals.flaky === 0 && result.totals.alwaysFailing === 0 && unparsable === 0 && skippedRuns === 0;
  const base = result.totals.flaky === 0 && result.totals.alwaysFailing === 0
    ? `no flaky tests across ${result.totals.runs} runs`
    : `${result.totals.flaky} flaky, ${result.totals.alwaysFailing} always-failing across ${result.totals.runs} runs`;
  const problems = [];
  if (unparsable > 0) problems.push(`${unparsable} file${unparsable === 1 ? '' : 's'} could not be parsed`);
  if (skippedRuns > 0) problems.push(`${skippedRuns} run director${skippedRuns === 1 ? 'y' : 'ies'} had no JUnit XML files`);
  return {
    result,
    passed,
    verdict: problems.length > 0 ? `${base}; ${problems.join('; ')}` : base,
  };
}

export function runCacheCheck(options) {
  if (!options.buildCommand || options.buildCommand.length === 0) {
    throw new UsageError('cache needs a build command after --, for example: dev-diagnosis cache -- node build.mjs');
  }
  const result = runCacheCheckImpl({
    root: options.cwd || process.cwd(),
    cacheDir: options.cacheDir,
    command: options.buildCommand,
    runs: options.runs,
  });
  const passed = result.verdict !== 'cache costs';
  return {
    result,
    passed,
    verdict: `${result.verdict}: cold ${formatMs(result.coldMs)}, warm ${formatMs(result.warmMs)} (${result.verdictDetail})`,
  };
}

// The raw cache result carries the build's full stdout from both runs;
// JSON output drops it, so a chatty build does not bloat the machine-
// readable output. Used by the standalone cache output and by the
// `all --json` builder below, so both shapes stay identical.
export function stripCacheStdout(result) {
  const { coldStdout, warmStdout, ...rest } = result;
  return rest;
}

/**
 * One-line summary of an `all` run: how many checks passed, failed or
 * were skipped, how much context noise was found, and what the cache
 * saved when it ran. `contextNoiseBytes` is the listed noise — the
 * same bytes the token estimate is based on.
 */
export function buildSummary(checks, skipped) {
  const ran = Object.values(checks);
  const passed = ran.filter((check) => check.passed).length;
  const noiseBytes = checks.context && checks.context.result
    ? checks.context.result.noise.reduce((sum, item) => sum + item.bytes, 0)
    : 0;
  const cacheResult = checks.cache && checks.cache.result ? checks.cache.result : null;
  return {
    checks: { total: ran.length + skipped.length, passed, failed: ran.length - passed, skipped: skipped.length },
    contextNoiseBytes: noiseBytes,
    cacheSavedPct: cacheResult ? cacheResult.savedPct : null,
  };
}

export function formatSummary(summary) {
  const parts = [
    `${summary.checks.total} checks — ${summary.checks.passed} passed, ${summary.checks.failed} failed, ${summary.checks.skipped} skipped`,
  ];
  if (summary.contextNoiseBytes > 0) parts.push(`context noise ${formatBytes(summary.contextNoiseBytes)}`);
  if (summary.cacheSavedPct != null) parts.push(`cache saved ${summary.cacheSavedPct}%`);
  return `Summary: ${parts.join('; ')}`;
}

/**
 * Run every check that has what it needs, the way `all` does. The
 * context fix is not applied here: the caller decides when, so the
 * human report can print the diagnosis before writing .aiignore, and
 * the JSON report can include the fix outcome. Call the returned
 * `applyContextFix()` (memoized) when the fix should happen.
 */
export function runAll(options = {}) {
  const root = options.root;
  const checks = {};
  const skipped = [];

  const contextCheck = runContextCheck(root, options.changedRef != null ? { changedRef: options.changedRef } : {});
  checks.context = contextCheck;
  let contextFix = null;
  const applyFix = () => {
    if (!contextFix) contextFix = applyContextFix(contextCheck);
    return contextFix;
  };

  if (options.commandName) checks.path = runPathCheck(options.commandName);
  else skipped.push('path — pass --command <name>, for example: dev-diagnosis all --command node');

  if (options.flakesDir) {
    try {
      checks.flakes = runFlakesCheck(options.flakesDir);
    } catch (error) {
      checks.flakes = { result: null, passed: false, verdict: `could not run: ${error.message}`, error: error.message };
    }
  } else {
    skipped.push('flakes — pass --flakes <runs-dir>, for example: dev-diagnosis all --flakes examples/runs');
  }

  if (options.buildCommand && options.buildCommand.length > 0) {
    try {
      checks.cache = runCacheCheck({ buildCommand: options.buildCommand, cacheDir: options.cacheDir, cwd: root, runs: options.runs });
    } catch (error) {
      if (String(error.message).includes('no cache directory found')) {
        // Nothing to measure is not a failure: report it as skipped so
        // `all` on a repo without a build cache does not end in FAIL.
        skipped.push('cache — no cache directory found in this project; pass --cache-dir <dir> to measure one');
      } else {
        checks.cache = { result: null, passed: false, verdict: `could not run: ${error.message}`, error: error.message };
      }
    }
  } else {
    skipped.push('cache — add -- <build-command>, for example: dev-diagnosis all -- node build.mjs');
  }

  const overall = Object.values(checks).every((check) => check.passed);
  return {
    root, checks, skipped, overall,
    summary: buildSummary(checks, skipped),
    applyContextFix: applyFix,
  };
}

/**
 * The `all --json` shape: each check's result (flakes limited by
 * --top, cache without the build stdout), failed checks carrying their
 * reason instead of null, plus the summary.
 */
export function allJson(run, top = null) {
  return {
    command: 'all',
    root: run.root,
    checks: Object.fromEntries(Object.entries(run.checks).map(([key, check]) => {
      let result = check.result;
      // Same --top split as the standalone flakes output: the embedded
      // tests array is limited, totals stay whole-scan.
      if (key === 'flakes' && result && top != null) {
        result = { ...result, tests: result.tests.slice(0, top) };
      }
      // Same stdout strip as standalone `cache --json`: the raw result
      // carries the build's full stdout from both runs.
      if (key === 'cache' && result) result = stripCacheStdout(result);
      // A check that could not run has no result: keep its reason in
      // the JSON instead of emitting null, or a script consumer sees
      // overall FAIL with no way to tell why.
      if (result == null) result = { error: check.error || check.verdict };
      return [key, result];
    })),
    skipped: run.skipped,
    overall: run.overall ? 'PASS' : 'FAIL',
    summary: run.summary,
  };
}
