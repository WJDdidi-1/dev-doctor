/**
 * The five checks, as functions both the CLI and the MCP server call.
 *
 * This is the one place the check logic lives: bin/dev-diagnosis.js
 * renders it for humans, lib/mcp.mjs serves it to agents, and neither
 * re-implements a verdict. Each runner returns the same shape —
 * `{ result, passed, verdict }` — and a check that could not run
 * returns `{ result: null, passed: false, verdict, error }` instead of
 * throwing, so the `all` report can say why it failed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { scanDirectory, applyAiignore, formatBytes, planAiignore } from './context.mjs';
import { listChangedFiles, refFileSizes } from './changed.mjs';
import { loadSecretsBaseline, splitBaselined } from './baseline.mjs';
import { loadScanCache, resolveScanCachePath } from './scan-cache.mjs';
import { scanFileForSecrets } from './secrets.mjs';
import {
  buildContexts, findCommandCopies, fixForDirectory, lookupCommand,
  searchToolchainBins,
} from './pathcheck.mjs';
import { runCacheCheck as runCacheCheckImpl } from './cache.mjs';
import { scanRuns } from './flakes.mjs';
import { scanBinaries } from './binaries.mjs';
import { formatMs } from './report.mjs';

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

// The default pass bar for the context check. Biome's method: the
// threshold is a number the user can set, not a constant baked into
// the verdict — a strict team passes at 95, an old repo starts at 70
// and raises the bar as it cleans up. The default stays 85: every
// existing gate, hook and doc that reads "below 85" keeps meaning
// what it meant.
export const DEFAULT_MIN_SCORE = 85;

// Validate a --min-score / MCP minScore value: a whole number from 0
// to 100, or null/undefined for the default. The CLI parser validates
// the same range on its own (like --runs), so this is the one
// validation the MCP tools and direct library callers hit — one
// message everywhere, so a bad value is a usage error (exit 2 /
// isError), never a silent default.
export function parseMinScore(value) {
  if (value == null) return DEFAULT_MIN_SCORE;
  const raw = typeof value === 'string' ? value : String(value);
  if (!/^\d+$/.test(raw)) throw new UsageError('--min-score needs a whole number from 0 to 100');
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
    throw new UsageError('--min-score needs a whole number from 0 to 100');
  }
  return parsed;
}

/**
 * The one ref that governs a new-only scan (golangci-lint's
 * --new-from-rev): `newFromRev` is `true` for a bare flag or a ref
 * string, `changedRef` is --changed's ref. The two must agree when
 * both name a ref — the changed set and the new-noise baseline are
 * the same comparison, so two different refs would be two different
 * questions. Returns the baseline ref, or null when neither flag is
 * set. A bare flag with no --changed means HEAD.
 */
export function resolveNewFromRevRef({ changedRef = null, newFromRev = null } = {}) {
  if (newFromRev == null) return null;
  // An empty string means HEAD on the MCP side, where an empty
  // changedRef means HEAD too — normalise both before comparing, so
  // changedRef '' with newFromRev 'HEAD' is agreement, not conflict.
  const changed = changedRef === '' ? 'HEAD' : changedRef;
  const explicit = typeof newFromRev === 'string' ? (newFromRev === '' ? 'HEAD' : newFromRev) : null;
  if (explicit != null && changed != null && explicit !== changed) {
    throw new UsageError(`--new-from-rev ${explicit} and --changed ${changed} name different refs: one ref governs both the changed set and the new-noise baseline.`);
  }
  return explicit ?? changed ?? 'HEAD';
}

// "login", "login and daemon-like", "login, non-login and daemon-like".
function joinNames(names) {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function runContextCheck(target, options = {}) {
  const root = target || process.cwd();
  // The pass bar (Biome's --max-diagnostics method, as a score):
  // validated up front, so a bad value fails before the scan runs.
  // The bar rides on the result, so --json, the report, the
  // annotations and the --fix re-scan all read the same number the
  // verdict was judged against — a consumer never has to know the
  // default 85 to interpret PASS/FAIL.
  const minScore = parseMinScore(options.minScore);
  // --changed scopes the scan to the files git lists as changed vs
  // the ref (HEAD by default). The check throws outside a git repo,
  // like a missing directory throws: the check could not run, and the
  // caller says so instead of silently scanning the whole repo.
  // --staged narrows it further to the staged set only (lint-staged's
  // method): the index vs the ref, no untracked files.
  // --new-from-rev (golangci-lint's method) implies --changed and
  // narrows it further still: only noise that is new since the ref
  // counts. The ref sizes come from one `git ls-tree` call, so the
  // baseline costs one git invocation however many files changed.
  const newFromRevRef = resolveNewFromRevRef({
    changedRef: options.changedRef ?? null,
    newFromRev: options.newFromRev ?? null,
  });
  const changed = options.changedRef != null
    ? listChangedFiles(root, options.changedRef, { staged: options.staged === true })
    : newFromRevRef != null
      ? listChangedFiles(root, newFromRevRef, { staged: options.staged === true })
      : null;
  const newFromRev = newFromRevRef != null
    ? { ref: newFromRevRef, sizes: refFileSizes(root, newFromRevRef) }
    : null;
  // A secrets baseline (detect-secrets' method) is loaded here, not
  // in the CLI, so the MCP tools get the same behaviour: findings it
  // covers are suppressed by the scan, and — once a baseline exists —
  // a finding it does not cover fails the check even though the score
  // passes. That is the answer to the open pre-commit question: with
  // no baseline a secret finding stays advisory (a repo with one known
  // false positive could never pass the hook otherwise); with one,
  // only a *new* secret fails. A missing baseline file is not an
  // error: the scan runs unsuppressed and the result says so, so the
  // caller can warn. A malformed one throws, like a missing directory
  // throws — a corrupt baseline must fail loudly, not silently
  // re-alert or silently suppress.
  let baseline = null;
  let baselineMissing = false;
  if (options.secretsBaselinePath != null) {
    baseline = loadSecretsBaseline(options.secretsBaselinePath);
    baselineMissing = baseline === null;
  }
  // The incremental scan cache (ESLint's --cache, metadata strategy)
  // is loaded here, not in the CLI, so the MCP tools get the same
  // behaviour. A missing file is the normal first run (no warning);
  // a corrupt one warns and the scan runs fresh — a bad cache never
  // fails a run. A location without --cache is a usage error, not a
  // silent default: the flag pair is one decision, not two.
  let scanCache = null;
  let cacheOptions = null;
  const cacheWarnings = [];
  if (options.cache === true) {
    const cachePath = resolveScanCachePath(root, options.cacheLocation ?? null);
    const loaded = loadScanCache(cachePath);
    if (loaded.warning) cacheWarnings.push(loaded.warning);
    scanCache = { path: cachePath, data: loaded.cache };
    cacheOptions = { cache: true, cacheLocation: options.cacheLocation ?? null };
  } else if (options.cacheLocation != null) {
    throw new UsageError('--cache-location needs --cache');
  }
  const result = scanDirectory(root, {
    ...(changed ? { changed } : {}),
    ...(newFromRev ? { newFromRev } : {}),
    secretsBaseline: baseline,
    ...(scanCache ? { scanCache, onScanCacheWarning: (message) => cacheWarnings.push(message) } : {}),
  });
  result.minScore = minScore;
  if (baselineMissing) {
    result.secretsBaseline = { path: options.secretsBaselinePath, loaded: false, suppressed: 0 };
  }
  // New secrets are the secret findings that survived suppression.
  // Without a loaded baseline there is no "known" set to compare
  // against, so findings stay advisory and the score alone decides.
  const newSecrets = result.review.filter((item) => item.kind === 'secret').length;
  const secretGate = baseline !== null && newSecrets > 0;
  const passed = result.score >= minScore && !secretGate;
  let verdict;
  if (passed) verdict = 'context is clean';
  else if (secretGate) verdict = `new secret${newSecrets === 1 ? '' : 's'} not in the baseline (score ${result.score}/100)`;
  // A custom bar names itself in the verdict: the score-band status
  // ("Looks clean") is about the absolute score, so without this a
  // 90/100 repo failing a --min-score 95 bar would print a clean
  // status next to a FAIL. The default bar keeps the old wording —
  // existing tests and docs quote it verbatim.
  else if (minScore !== DEFAULT_MIN_SCORE) verdict = `score ${result.score}/100 is below the --min-score ${minScore} bar`;
  else verdict = `${result.status.toLowerCase()} (score ${result.score}/100)`;
  // The cache warnings and options ride on the check, not the result:
  // the result is what --json prints, and it must stay identical
  // between a fresh and a cached run except for its `cached` field.
  // The re-scan helpers below read cacheOptions back, so a --fix
  // re-scan uses the cache too (and sees the .aiignore fingerprint
  // change, so it correctly runs fresh).
  return {
    result, passed, verdict,
    ...(cacheWarnings.length > 0 ? { cacheWarnings } : {}),
    ...(cacheOptions ? { cacheOptions } : {}),
  };
}

/** The baseline path a check result was run with, if any — so a re-scan after --fix keeps the same baseline instead of silently dropping it. */
function baselinePathOf(result) {
  return result?.secretsBaseline?.path ?? null;
}

/** The new-noise baseline ref a check result was run with, if any — so a re-scan after --fix keeps judging only new noise. */
function newFromRevRefOf(result) {
  return result?.changed?.newFromRev ?? null;
}

/** The pass bar a check result was judged against — so a re-scan after --fix keeps the same bar instead of silently falling back to 85. */
function minScoreOf(result) {
  return result?.minScore ?? null;
}

/**
 * Scan named files for secrets only — the `secrets` command and the
 * MCP `diagnose_secrets` tool. This is the context check's content
 * scan without the repo: no score, no noise list, no .aiignore. The
 * one input the context check can never reach is a commit message —
 * `.git/COMMIT_EDITMSG` is not a file in the tree, and it exists only
 * at commit time, after the message is written — so the message gets
 * its own command and its own pre-commit hook (commitlint's method:
 * the message arrives as a file path, `--edit $1`). The same command
 * also scans any file before sharing it: a pasted config, a dotfile,
 * a single file that does not need a whole-repo diagnosis.
 *
 * Unlike the context check, where a secret finding is advisory until
 * a baseline exists, here any finding that survives suppression
 * fails the check: scanning for secrets is the whole job, so a
 * finding cannot be advisory and still block a commit. A file that
 * cannot be read (missing, a directory) is an error entry and also
 * fails the check — a hook that silently passes an unreadable message
 * would be worse than no hook. Findings carry file, rule and line,
 * never the matched value.
 */
export function runSecretsCheck(files, options = {}) {
  if (!files || files.length === 0) {
    throw new UsageError('secrets needs at least one file, for example: dev-diagnosis secrets .git/COMMIT_EDITMSG');
  }
  // The baseline is loaded here, not in the CLI, so the MCP tool gets
  // the same suppression: a missing file is not an error (the scan
  // runs unsuppressed and the result says so), a malformed one throws.
  let baseline = null;
  let baselineMissing = false;
  if (options.secretsBaselinePath != null) {
    baseline = loadSecretsBaseline(options.secretsBaselinePath);
    baselineMissing = baseline === null;
  }
  const scanned = [];
  const findings = [];
  const errors = [];
  for (const file of files) {
    const absolute = path.resolve(file);
    let stat;
    try {
      stat = fs.statSync(absolute);
    } catch {
      errors.push({ file, reason: 'no such file' });
      continue;
    }
    if (!stat.isFile()) {
      errors.push({ file, reason: 'not a file' });
      continue;
    }
    // Displayed relative to the working directory, so a hook run from
    // the repo root prints `COMMIT_EDITMSG`, not an absolute path.
    const relative = path.relative(process.cwd(), absolute).split(path.sep).join('/') || file;
    scanned.push(relative);
    findings.push(...scanFileForSecrets(absolute, relative));
  }
  const { kept, suppressed } = splitBaselined(findings, baseline);
  const result = {
    files: scanned,
    findings: kept,
    errors,
    secretsBaseline: options.secretsBaselinePath != null
      ? { path: options.secretsBaselinePath, loaded: !baselineMissing, suppressed: suppressed.length }
      : null,
  };
  const passed = kept.length === 0 && errors.length === 0;
  const filesWithFindings = new Set(kept.map((finding) => finding.path)).size;
  const secretPart = kept.length > 0
    ? `${kept.length} possible secret${kept.length === 1 ? '' : 's'} in ${filesWithFindings} file${filesWithFindings === 1 ? '' : 's'} — rotate the flagged credential${kept.length === 1 ? '' : 's'}`
    : null;
  const errorPart = errors.length > 0
    ? `could not read ${errors.length} file${errors.length === 1 ? '' : 's'}: ${errors.map((error) => error.file).join(', ')}`
    : null;
  let verdict;
  if (passed) verdict = `no secrets found in ${scanned.length} file${scanned.length === 1 ? '' : 's'}`;
  else if (secretPart && errorPart) verdict = `${secretPart}; ${errorPart}`;
  else verdict = secretPart || errorPart;
  return { result, passed, verdict };
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
 * exactly what --fix would write. The plan also carries wouldChange:
 * true when the fix would add at least one entry — the exit code of a
 * dry run is 1 then, even when the score passes, because the dry run
 * answers "would the fix change anything?", not "does the repo pass?".
 * That is prettier --check's rule (exit 1 when a file would change,
 * which is what makes it usable as a CI gate), applied to the preview:
 * a repo can pass the 85 threshold while a fix is still pending, and
 * without the wouldChange exit the gate cannot tell clean from pending.
 */
export function previewContextFix(check) {
  const plan = planAiignore(check.result.root, check.result.suggestions);
  const { nextContent: _ignored, ...fix } = plan;
  fix.dryRun = true;
  fix.wouldChange = fix.added.length > 0;
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
  const staged = check.result.changed ? check.result.changed.staged === true : false;
  const secretsBaselinePath = baselinePathOf(check.result);
  const newFromRevRef = newFromRevRefOf(check.result);
  const cacheOptions = check.cacheOptions ?? null;
  const minScore = minScoreOf(check.result);
  const fixed = runContextCheck(check.result.root, {
    ...(changedRef != null ? { changedRef, staged } : {}),
    ...(newFromRevRef != null ? { newFromRev: newFromRevRef } : {}),
    ...(secretsBaselinePath != null ? { secretsBaselinePath } : {}),
    ...(cacheOptions ? { cache: true, cacheLocation: cacheOptions.cacheLocation ?? null } : {}),
    ...(minScore != null ? { minScore } : {}),
  });
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
  const staged = before?.result?.changed ? before.result.changed.staged === true : false;
  const secretsBaselinePath = baselinePathOf(before?.result);
  const newFromRevRef = newFromRevRefOf(before?.result);
  const cacheOptions = before?.cacheOptions ?? null;
  const minScore = minScoreOf(before?.result);
  const fixed = runContextCheck(run.root, {
    ...(changedRef != null ? { changedRef, staged } : {}),
    ...(newFromRevRef != null ? { newFromRev: newFromRevRef } : {}),
    ...(secretsBaselinePath != null ? { secretsBaselinePath } : {}),
    ...(cacheOptions ? { cache: true, cacheLocation: cacheOptions.cacheLocation ?? null } : {}),
    ...(minScore != null ? { minScore } : {}),
  });
  if (before?.result?.fix) fixed.result.fix = before.result.fix;
  run.checks.context = fixed;
  run.overall = Object.values(run.checks).every((check) => check.passed);
  run.summary = buildSummary(run.checks, run.skipped);
  return fixed;
}

export function runBinariesCheck(target, options = {}) {
  const top = options.top;
  if (top != null && (!Number.isInteger(top) || top < 1 || top > 20)) {
    throw new UsageError('--top needs a whole number from 1 to 20');
  }
  const result = scanBinaries(target || process.cwd(), { ...(top != null ? { top } : {}) });
  const count = result.binaries.length;
  let verdict;
  if (count === 0) verdict = 'no native binaries found';
  else if (result.totalBinaries > count) verdict = `${result.totalBinaries} native binaries found (largest ${count} shown)`;
  else verdict = `${count} native binar${count === 1 ? 'y' : 'ies'} checked — see the hardening table`;
  // Advisory by design: a binary with PIE disabled is a fact to know
  // about, not a failure of the repo — the check never fails the run.
  return { result, passed: true, verdict };
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

// The checks `all` can run, in the order they are reported. --only
// and --skip select from this list; the names are the same words the
// summary, --json and MCP use, so there is nothing new to learn.
export const ALL_CHECKS = ['context', 'binaries', 'path', 'flakes', 'cache'];

// Which checks `all` runs, from an --only list (opt-in: only these)
// or a --skip list (opt-out: everything but these) — one selection
// mechanism with both directions, the way super-linter's VALIDATE_
// toggles work: any toggle set true means only those run, any set
// false means all but those run, and mixing the two is an error.
// `only`/`skip` take arrays or comma-separated strings. Returns the
// selected names in canonical order plus the skip reason per
// unselected check, so the summary can stay honest about what did
// not run. Throws UsageError on an unknown name, on both lists at
// once, on an empty list, and when nothing would be left to run.
export function selectChecks({ only = null, skip = null } = {}) {
  const parse = (value, flag) => {
    const list = (Array.isArray(value) ? value : String(value).split(','))
      .map((name) => String(name).trim())
      .filter((name) => name !== '');
    const unknown = list.filter((name) => !ALL_CHECKS.includes(name));
    if (unknown.length > 0) {
      throw new UsageError(`unknown check in ${flag}: ${unknown.join(', ')} (valid checks: ${ALL_CHECKS.join(', ')})`);
    }
    return [...new Set(list)];
  };
  const onlyList = only != null ? parse(only, '--only') : null;
  const skipList = skip != null ? parse(skip, '--skip') : null;
  if (onlyList != null && skipList != null) {
    throw new UsageError('cannot combine --only and --skip: pick one way to select checks');
  }
  if (onlyList != null && onlyList.length === 0) {
    throw new UsageError('--only needs at least one check, for example: --only context,flakes');
  }
  if (skipList != null && skipList.length === 0) {
    throw new UsageError('--skip needs at least one check, for example: --skip cache');
  }
  const selected = onlyList != null
    ? ALL_CHECKS.filter((name) => onlyList.includes(name))
    : ALL_CHECKS.filter((name) => !(skipList ?? []).includes(name));
  if (selected.length === 0) {
    throw new UsageError('--skip leaves no check to run: at least one of context, binaries, path, flakes, cache must run');
  }
  const skipped = {};
  for (const name of ALL_CHECKS) {
    if (!selected.includes(name)) {
      skipped[name] = onlyList != null
        ? `${name} — not in --only ${onlyList.join(',')}`
        : `${name} — skipped by --skip ${skipList.join(',')}`;
    }
  }
  return { selected, skipped };
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
  const { selected, skipped: skipReasons } = selectChecks({ only: options.only, skip: options.skip });

  let contextCheck = null;
  let contextFix = null;
  const applyFix = () => {
    if (!contextCheck) throw new Error('context check did not run: it was skipped by --only/--skip');
    if (!contextFix) contextFix = applyContextFix(contextCheck);
    return contextFix;
  };

  if (selected.includes('context')) {
    contextCheck = runContextCheck(root, {
      ...(options.changedRef != null ? { changedRef: options.changedRef, staged: options.staged === true } : {}),
      ...(options.newFromRev != null ? { newFromRev: options.newFromRev } : {}),
      ...(options.secretsBaselinePath != null ? { secretsBaselinePath: options.secretsBaselinePath } : {}),
      ...(options.cache === true ? { cache: true, cacheLocation: options.cacheLocation ?? null } : {}),
      ...(options.minScore != null ? { minScore: options.minScore } : {}),
    });
    checks.context = contextCheck;
  } else skipped.push(skipReasons.context);

  // Binaries needs no input, so it never lands in the skipped list
  // for want of one: it runs whenever it is selected, and a repo
  // with no binaries reports that plainly.
  if (selected.includes('binaries')) {
    try {
      checks.binaries = runBinariesCheck(root);
    } catch (error) {
      checks.binaries = { result: null, passed: false, verdict: `could not run: ${error.message}`, error: error.message };
    }
  } else skipped.push(skipReasons.binaries);

  if (!selected.includes('path')) skipped.push(skipReasons.path);
  else if (options.commandName) checks.path = runPathCheck(options.commandName);
  else skipped.push('path — pass --command <name>, for example: dev-diagnosis all --command node');

  if (!selected.includes('flakes')) skipped.push(skipReasons.flakes);
  else if (options.flakesDir) {
    try {
      checks.flakes = runFlakesCheck(options.flakesDir);
    } catch (error) {
      checks.flakes = { result: null, passed: false, verdict: `could not run: ${error.message}`, error: error.message };
    }
  } else {
    skipped.push('flakes — pass --flakes <runs-dir>, for example: dev-diagnosis all --flakes examples/runs');
  }

  if (!selected.includes('cache')) skipped.push(skipReasons.cache);
  else if (options.buildCommand && options.buildCommand.length > 0) {
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
