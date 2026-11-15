import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../scripts/support.mjs';
import { ALL_CHECKS, applyContextFixAndRescan, parseMinScore, rescanContext, resolveNewFromRevRef, runAll, runContextCheck, selectChecks, UsageError } from '../lib/checks.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const demoRepo = path.join(root, 'examples', 'demo-repo');
const demoRuns = path.join(root, 'examples', 'runs');

test('selectChecks: no selection runs all five in canonical order', () => {
  const { selected, skipped } = selectChecks();
  assert.deepEqual(selected, ['context', 'binaries', 'path', 'flakes', 'cache']);
  assert.deepEqual(skipped, {});
  assert.deepEqual(ALL_CHECKS, ['context', 'binaries', 'path', 'flakes', 'cache']);
});

test('selectChecks: --only runs just those, in canonical order, and names the rest', () => {
  const { selected, skipped } = selectChecks({ only: ['cache', 'context'] });
  assert.deepEqual(selected, ['context', 'cache']);
  assert.equal(skipped.binaries, 'binaries — not in --only cache,context');
  assert.equal(skipped.path, 'path — not in --only cache,context');
  assert.equal(skipped.flakes, 'flakes — not in --only cache,context');
  assert.equal(skipped.context, undefined);
  assert.equal(skipped.cache, undefined);
});

test('selectChecks: --skip runs everything but those', () => {
  const { selected, skipped } = selectChecks({ skip: ['cache'] });
  assert.deepEqual(selected, ['context', 'binaries', 'path', 'flakes']);
  assert.equal(skipped.cache, 'cache — skipped by --skip cache');
});

test('selectChecks: comma-separated strings with spaces, and duplicates', () => {
  assert.deepEqual(selectChecks({ only: 'context, flakes' }).selected, ['context', 'flakes']);
  assert.deepEqual(selectChecks({ skip: 'cache,cache' }).selected, ['context', 'binaries', 'path', 'flakes']);
});

test('selectChecks: unknown names, both flags, empty lists and skipping everything are usage errors', () => {
  assert.throws(
    () => selectChecks({ only: ['bogus'] }),
    (error) => error instanceof UsageError && /unknown check in --only: bogus \(valid checks: context, binaries, path, flakes, cache\)/.test(error.message),
  );
  assert.throws(() => selectChecks({ skip: ['cache', 'nope'] }), /unknown check in --skip: nope/);
  assert.throws(() => selectChecks({ only: ['context'], skip: ['cache'] }), /cannot combine --only and --skip/);
  assert.throws(() => selectChecks({ only: [] }), /--only needs at least one check/);
  assert.throws(() => selectChecks({ only: '' }), /--only needs at least one check/);
  assert.throws(() => selectChecks({ skip: [] }), /--skip needs at least one check/);
  assert.throws(() => selectChecks({ skip: ['context', 'binaries', 'path', 'flakes', 'cache'] }), /--skip leaves no check to run/);
});

test('runAll: --only context runs only context and lists the rest as skipped', () => {
  const run = runAll({ root: demoRepo, only: ['context'] });
  assert.deepEqual(Object.keys(run.checks), ['context']);
  assert.deepEqual(run.skipped, [
    'binaries — not in --only context',
    'path — not in --only context',
    'flakes — not in --only context',
    'cache — not in --only context',
  ]);
  assert.deepEqual(run.summary.checks, { total: 5, passed: 0, failed: 1, skipped: 4 });
  assert.equal(run.overall, false);
});

test('runAll: --skip cache never runs the build and the summary drops the cache line', () => {
  const run = runAll({
    root: demoRepo, commandName: 'node', flakesDir: demoRuns,
    buildCommand: ['node', 'build.mjs'], skip: ['cache'],
  });
  assert.equal(run.checks.cache, undefined);
  assert.equal(run.checks.context.result.score, 75);
  assert.ok(run.skipped.includes('cache — skipped by --skip cache'));
  assert.equal(run.summary.cacheSavedPct, null);
});

test('resolveNewFromRevRef: a bare flag means HEAD, a ref means that ref, and none means null', () => {
  assert.equal(resolveNewFromRevRef({ newFromRev: true }), 'HEAD');
  assert.equal(resolveNewFromRevRef({ newFromRev: 'HEAD~1' }), 'HEAD~1');
  assert.equal(resolveNewFromRevRef({}), null);
  assert.equal(resolveNewFromRevRef({ changedRef: 'main' }), null);
});

test('resolveNewFromRevRef: a bare flag takes --changed\'s ref, and matching refs agree', () => {
  assert.equal(resolveNewFromRevRef({ changedRef: 'main', newFromRev: true }), 'main');
  assert.equal(resolveNewFromRevRef({ changedRef: 'main', newFromRev: 'main' }), 'main');
  // An empty string means HEAD on the MCP side, where an empty
  // changedRef means HEAD too — so this is agreement, not conflict.
  assert.equal(resolveNewFromRevRef({ changedRef: '', newFromRev: 'HEAD' }), 'HEAD');
  assert.equal(resolveNewFromRevRef({ newFromRev: '' }), 'HEAD');
});

test('resolveNewFromRevRef: two different refs are a usage error', () => {
  assert.throws(
    () => resolveNewFromRevRef({ changedRef: 'main', newFromRev: 'HEAD~1' }),
    (error) => error instanceof UsageError
      && /--new-from-rev HEAD~1 and --changed main name different refs/.test(error.message),
  );
});

test('parseMinScore: missing means the 85 default, whole numbers 0-100 pass, anything else is a usage error', () => {
  assert.equal(parseMinScore(undefined), 85);
  assert.equal(parseMinScore(null), 85);
  assert.equal(parseMinScore(0), 0);
  assert.equal(parseMinScore(85), 85);
  assert.equal(parseMinScore(100), 100);
  assert.equal(parseMinScore('70'), 70);
  for (const bad of [101, -1, 85.5, 'abc', '', '85.5', true, {}, []]) {
    assert.throws(
      () => parseMinScore(bad),
      (error) => error instanceof UsageError && /--min-score needs a whole number from 0 to 100/.test(error.message),
    );
  }
});

test('runContextCheck: the demo repo (75) fails at the default 85, passes at 70, and the verdict names a custom bar', () => {
  const def = runContextCheck(demoRepo);
  assert.equal(def.result.score, 75);
  assert.equal(def.result.minScore, 85);
  assert.equal(def.passed, false);
  assert.equal(def.verdict, 'some context noise found (score 75/100)');
  const low = runContextCheck(demoRepo, { minScore: 70 });
  assert.equal(low.result.minScore, 70);
  assert.equal(low.passed, true);
  assert.equal(low.verdict, 'context is clean');
  const high = runContextCheck(demoRepo, { minScore: 80 });
  assert.equal(high.passed, false);
  assert.equal(high.verdict, 'score 75/100 is below the --min-score 80 bar');
  assert.throws(
    () => runContextCheck(demoRepo, { minScore: 101 }),
    (error) => error instanceof UsageError && /--min-score needs a whole number from 0 to 100/.test(error.message),
  );
});

test('runAll: --min-score threads into the context check and the overall verdict follows it', () => {
  const low = runAll({ root: demoRepo, only: ['context'], minScore: 70 });
  assert.equal(low.checks.context.result.minScore, 70);
  assert.equal(low.checks.context.passed, true);
  assert.equal(low.overall, true);
  const high = runAll({ root: demoRepo, only: ['context'], minScore: 80 });
  assert.equal(high.checks.context.passed, false);
  assert.equal(high.overall, false);
});

test('runContextCheck: a --fix re-scan keeps the custom bar instead of falling back to 85', () => {
  // A private copy: the fix writes .aiignore into it.
  const dir = tempDir('dev-diagnosis-min-score-');
  const copy = path.join(dir, 'demo-repo');
  fs.cpSync(demoRepo, copy, { recursive: true });
  const check = runContextCheck(copy, { minScore: 90 });
  assert.equal(check.result.score, 75);
  const fixed = applyContextFixAndRescan(check);
  // The fix lifts the demo repo to 94, which passes at 90 — but the
  // pin is the bar itself: without the carry-through the re-scan
  // would report minScore 85.
  assert.equal(fixed.result.minScore, 90);
  assert.equal(fixed.result.score, 94);
  assert.equal(fixed.passed, true);
  assert.equal(fixed.verdict, 'context is clean');
});

test('rescanContext: the all-path re-scan keeps the custom bar too', () => {
  const dir = tempDir('dev-diagnosis-min-score-');
  const copy = path.join(dir, 'demo-repo');
  fs.cpSync(demoRepo, copy, { recursive: true });
  const run = runAll({ root: copy, only: ['context'], minScore: 90 });
  run.applyContextFix();
  const fixed = rescanContext(run);
  assert.equal(fixed.result.minScore, 90);
  assert.equal(fixed.result.score, 94);
  assert.equal(fixed.passed, true);
  assert.equal(run.overall, true);
});
