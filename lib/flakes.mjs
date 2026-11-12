/**
 * Flaky-test ranking from JUnit XML.
 *
 * Adapted from flake-ledger (WJDdidi-1/flake-ledger, Apache-2.0): the same
 * outcome model — failure/error, flakyFailure/flakyError/rerunFailure
 * tags, retry attributes, repeated testcase entries collapsing into one
 * record — and the same 95% Wilson lower bound for ranking. Reduced to
 * what this CLI needs: no sharding rules, no GitHub annotations, no
 * quarantine file. Run layout is simple and documented in the help:
 * each subdirectory of <runs-dir> is one run, and each *.xml file
 * directly under <runs-dir> is one run of its own.
 */
import fs from 'node:fs';
import path from 'node:path';
import { elementChildren, getAttribute, isElement, localName, parseXml, textContent } from './xml.mjs';

const FAILURE_TAGS = new Set(['failure', 'error']);
const FLAKY_TAGS = new Set(['flakyfailure', 'flakyerror']);
const RERUN_TAGS = new Set(['rerunfailure', 'rerunerror']);
const SKIP_TAGS = new Set(['skipped', 'disabled']);

const RETRY_ATTRIBUTE_NAMES = [
  'retry', 'retries', 'rerun', 'reruns', 'retryCount', 'rerunCount', 'retry_count', 'rerun_count',
];

function lower(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function retryEvidence(node) {
  for (const name of RETRY_ATTRIBUTE_NAMES) {
    const raw = getAttribute(node, name);
    if (raw === undefined || raw === '') continue;
    const trimmed = String(raw).trim();
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      if (numeric > 0) return true;
      continue;
    }
    if (/^(true|yes|y)$/i.test(trimmed)) return true;
  }
  return false;
}

function collectTestcases(node, out) {
  if (!node || !Array.isArray(node.children)) return;
  for (const child of node.children) {
    if (!isElement(child)) continue;
    if (localName(child.name).toLowerCase() === 'testcase') out.push(child);
    else collectTestcases(child, out);
  }
}

function attemptFrom(node) {
  const children = elementChildren(node);
  let status = 'passed';
  let message = null;
  let retried = retryEvidence(node);
  let file = getAttribute(node, 'file') || null;
  const lineRaw = getAttribute(node, 'line');
  const line = lineRaw !== undefined && /^\d+$/.test(String(lineRaw).trim()) ? Number(lineRaw) : null;

  for (const child of children) {
    const tag = lower(localName(child.name));
    if (FLAKY_TAGS.has(tag) || RERUN_TAGS.has(tag)) {
      status = 'passed-on-retry';
      retried = true;
      message = getAttribute(child, 'message') || message;
    } else if (FAILURE_TAGS.has(tag)) {
      if (status !== 'passed-on-retry') status = tag === 'error' ? 'error' : 'failed';
      message = getAttribute(child, 'message') || message;
    } else if (SKIP_TAGS.has(tag)) {
      status = 'skipped';
      message = getAttribute(child, 'message') || message;
    }
    if (!file) {
      const childFile = getAttribute(child, 'file');
      if (childFile) file = childFile;
    }
  }
  if (status === 'passed' && retried) status = 'passed-on-retry';
  return { status, message, retried, file, line };
}

export function parseJunitText(text, sourceName = '<xml>') {
  const doc = parseXml(text, { sourceName });
  const cases = [];
  collectTestcases(doc, cases);
  return cases.map((node) => {
    const classname = getAttribute(node, 'classname') || '';
    const name = getAttribute(node, 'name') || '';
    return {
      id: `${classname}::${name}`,
      classname,
      name,
      ...attemptFrom(node),
    };
  });
}

export function parseJunitFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  return parseJunitText(text, filePath);
}

/** 95% Wilson score interval, lower bound — the ranking flake-ledger uses. */
export function wilsonLowerBound(unstable, total) {
  if (total <= 0) return 0;
  const z = 1.96;
  const p = unstable / total;
  const denom = 1 + (z * z) / total;
  const centre = p + (z * z) / (2 * total);
  const spread = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return Math.max(0, (centre - spread) / denom);
}

function listXmlFiles(dir) {
  const out = [];
  const walk = (current) => {
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.xml')) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/**
 * Scan a runs directory. Each immediate subdirectory is one run (all XML
 * files inside it, recursively, belong to that run); each *.xml file
 * directly under the directory is a run of its own. Runs are ordered by
 * name so the timeline is stable on every platform.
 */
export function scanRuns(root, options = {}) {
  const absolute = path.resolve(root);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) {
    throw new Error(`runs directory not found: ${root}`);
  }
  const newWindow = options.newWindow == null ? 2 : options.newWindow;
  const entries = fs.readdirSync(absolute, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const runGroups = [];
  const skippedRuns = [];
  for (const entry of entries) {
    const full = path.join(absolute, entry.name);
    if (entry.isDirectory()) {
      const files = listXmlFiles(full);
      if (files.length > 0) runGroups.push({ id: entry.name, files });
      else {
        // A run directory with no XML is a run that produced no reports —
        // a broken CI upload, not a run with zero tests. Dropping it
        // silently would report "runs: 1" while a second run existed, so
        // it is recorded and the check fails on it, like an unparsable
        // file: the verdict must not rest on half-read data.
        skippedRuns.push({ id: entry.name, reason: 'no JUnit XML files found' });
      }
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.xml')) {
      runGroups.push({ id: entry.name.replace(/\.xml$/i, ''), files: [full] });
    }
  }
  if (runGroups.length === 0) throw new Error(`no JUnit XML files found under ${root}`);

  const runs = [];
  const warnings = [];
  for (const group of runGroups) {
    const tests = new Map();
    for (const file of group.files) {
      let parsed;
      try {
        parsed = parseJunitFile(file);
      } catch (error) {
        // parseJunitFile already puts the file path in an XML error's
        // message; only prepend it for errors that do not carry it, so
        // the warning never reads "file: file:line:col: ...".
        warnings.push(error.message.startsWith(file) ? error.message : `${file}: ${error.message}`);
        continue;
      }
      for (const test of parsed) {
        const existing = tests.get(test.id);
        if (!existing) {
          tests.set(test.id, { ...test, attempts: [test] });
        } else {
          existing.attempts.push(test);
          // A test that failed once and passed once in the same run passed
          // on retry — that is the flake signal, not two separate results.
          const statuses = new Set(existing.attempts.map((a) => a.status));
          const bad = [...statuses].some((s) => s === 'failed' || s === 'error');
          const good = statuses.has('passed') || statuses.has('passed-on-retry');
          if (bad && good) existing.status = 'passed-on-retry';
          else if (bad) existing.status = statuses.has('error') ? 'error' : 'failed';
          else if (statuses.has('skipped')) existing.status = 'skipped';
          if (!existing.message && test.message) existing.message = test.message;
          if (!existing.file && test.file) existing.file = test.file;
        }
      }
    }
    runs.push({ id: group.id, files: group.files, tests: [...tests.values()] });
  }

  const ledger = new Map();
  for (const run of runs) {
    for (const test of run.tests) {
      let record = ledger.get(test.id);
      if (!record) {
        record = {
          id: test.id, classname: test.classname, name: test.name,
          file: test.file || null, timeline: [],
          unstableRuns: 0, eligibleRuns: 0, failedRuns: 0, passedOnRetryRuns: 0, skippedRuns: 0,
        };
        ledger.set(test.id, record);
      }
      const outcome = test.status === 'passed-on-retry' ? 'passed-on-retry'
        : test.status === 'failed' || test.status === 'error' ? 'failed'
          : test.status === 'skipped' ? 'skipped' : 'passed';
      record.timeline.push({ runId: run.id, outcome, status: test.status, message: test.message || null });
      if (outcome === 'passed-on-retry') { record.passedOnRetryRuns += 1; record.unstableRuns += 1; record.eligibleRuns += 1; }
      else if (outcome === 'failed') { record.failedRuns += 1; record.unstableRuns += 1; record.eligibleRuns += 1; }
      else if (outcome === 'skipped') { record.skippedRuns += 1; }
      else { record.eligibleRuns += 1; }
      if (!record.file && test.file) record.file = test.file;
    }
  }

  const tests = [...ledger.values()];
  for (const test of tests) {
    test.unstableRate = test.eligibleRuns > 0 ? test.unstableRuns / test.eligibleRuns : 0;
    test.score = wilsonLowerBound(test.unstableRuns, test.eligibleRuns);
    const lastUnstable = test.timeline.map((entry, i) => ({ entry, i }))
      .filter(({ entry }) => entry.outcome === 'failed' || entry.outcome === 'passed-on-retry');
    const newestIndex = lastUnstable.length > 0 ? lastUnstable[lastUnstable.length - 1].i : -1;
    const isNew = newestIndex !== -1 && newestIndex >= test.timeline.length - newWindow
      && test.timeline.slice(0, newestIndex).every((e) => e.outcome === 'passed');
    test.trend = isNew ? 'new' : (test.unstableRuns > 0 ? 'chronic' : 'stable');
    if (test.failedRuns === test.eligibleRuns && test.eligibleRuns > 0) test.classification = 'always-failing';
    else if (test.unstableRuns > 0 && test.passedOnRetryRuns > 0) test.classification = 'passed-on-retry';
    else if (test.unstableRuns > 0) test.classification = 'flaky';
    else test.classification = 'stable';
  }
  tests.sort((a, b) => (b.score - a.score) || (b.unstableRuns - a.unstableRuns) || (a.id < b.id ? -1 : 1));

  return {
    runsDir: absolute,
    runs: runs.map((run) => ({ id: run.id, files: run.files, testCount: run.tests.length })),
    tests,
    warnings,
    skippedRuns,
    totals: {
      runs: runs.length,
      tests: tests.length,
      flaky: tests.filter((t) => t.classification === 'flaky' || t.classification === 'passed-on-retry').length,
      alwaysFailing: tests.filter((t) => t.classification === 'always-failing').length,
    },
  };
}

export function formatFlakesTable(result, top = null) {
  const rows = top == null ? result.tests : result.tests.slice(0, top);
  const unstable = rows.filter((t) => t.unstableRuns > 0);
  const lines = [];
  lines.push(`runs: ${result.totals.runs}  tests: ${result.totals.tests}  flaky: ${result.totals.flaky}  always-failing: ${result.totals.alwaysFailing}`);
  if (unstable.length === 0) {
    lines.push('No flaky tests: every test passed in every run it appeared in.');
  } else {
    const header = `${'test'.padEnd(46)} ${'unstable'.padStart(8)} ${'runs'.padStart(5)} ${'trend'.padStart(8)}  classification`;
    lines.push(header);
    for (const test of unstable) {
      const label = test.id.length > 46 ? `${test.id.slice(0, 43)}...` : test.id;
      lines.push(`${label.padEnd(46)} ${`${test.unstableRuns}/${test.eligibleRuns}`.padStart(8)} ${String(test.eligibleRuns).padStart(5)} ${test.trend.padStart(8)}  ${test.classification}`);
    }
  }
  // A file that could not be parsed is not "no flaky tests": say so on
  // screen, with the file and the reason, instead of passing silently.
  if (result.warnings && result.warnings.length > 0) {
    const noun = result.warnings.length === 1 ? 'file' : 'files';
    lines.push(`Warning: ${result.warnings.length} ${noun} could not be parsed — results are incomplete:`);
    for (const warning of result.warnings) lines.push(`  ${warning}`);
  }
  // A run directory that produced no reports is not "no flaky tests":
  // say which runs were skipped, so a missing CI upload is visible.
  if (result.skippedRuns && result.skippedRuns.length > 0) {
    const noun = result.skippedRuns.length === 1 ? 'run directory' : 'run directories';
    const verb = result.skippedRuns.length === 1 ? 'was' : 'were';
    lines.push(`Note: ${result.skippedRuns.length} ${noun} had no JUnit XML files and ${verb} skipped:`);
    for (const run of result.skippedRuns) lines.push(`  ${run.id} — ${run.reason}`);
  }
  return lines.join('\n');
}
