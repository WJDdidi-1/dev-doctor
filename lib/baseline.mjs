/**
 * The secrets baseline (detect-secrets' method): a file that records
 * the secret findings a human has already triaged, so they stop
 * re-alerting on every run — and so the pre-commit hook can fail a
 * commit only when it adds a *new* secret, instead of failing forever
 * on a repo that already has a known false positive.
 *
 * The file holds hashed fingerprints, never values: each entry is the
 * SHA-256 fingerprint from lib/secrets.mjs (rule id + matched value),
 * plus the rule, path and line where it was first seen. The path and
 * line are audit hints for the human reading the file — matching uses
 * the fingerprint alone, so a triaged secret stays suppressed when it
 * moves to another file or line. Entries are sorted by fingerprint, so
 * regenerating the file over an unchanged repo produces no diff.
 *
 * What this is not: git-secrets' `.gitallowed` pattern file, where a
 * false positive is silenced by a hand-written regex. A regex can
 * over-match and silently allow a real secret that happens to look
 * like the pattern; a fingerprint matches exactly one triaged value.
 * The baseline is also not a substitute for rotating a real secret —
 * a baselined finding is a finding someone decided to live with, and
 * the write command prints every finding it records so that decision
 * is made with the list on screen, not blind.
 *
 * The baseline file itself is safe to commit: it contains hashes of
 * high-entropy values, which cannot be reversed into the values.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Format version written into every baseline file. */
export const BASELINE_VERSION = 1;

/** The conventional name for a baseline file at a repo root. */
export const BASELINE_FILENAME = '.dev-diagnosis-secrets-baseline.json';

export class BaselineError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BaselineError';
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Load a baseline file. Returns null when the file does not exist —
 * the caller treats that as "no baseline", not an error. Throws
 * BaselineError when the file exists but cannot be used: unreadable,
 * not JSON, wrong shape, or a version this tool does not understand.
 * A corrupt baseline must fail loudly: silently ignoring it would
 * re-alert on every triaged finding, and silently accepting a
 * half-parsed one could suppress findings it was never meant to.
 */
export function loadSecretsBaseline(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new BaselineError(`cannot read secrets baseline '${filePath}': ${error.message}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new BaselineError(`secrets baseline '${filePath}' is not valid JSON: ${error.message}`);
  }
  if (!isRecord(data)) throw new BaselineError(`secrets baseline '${filePath}' must be a JSON object`);
  if (data.version !== BASELINE_VERSION) {
    throw new BaselineError(`secrets baseline '${filePath}' has version ${JSON.stringify(data.version)}, expected ${BASELINE_VERSION}`);
  }
  if (!Array.isArray(data.findings)) {
    throw new BaselineError(`secrets baseline '${filePath}' must have a 'findings' array`);
  }
  const entries = new Map();
  for (const entry of data.findings) {
    if (!isRecord(entry) || typeof entry.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(entry.fingerprint)) {
      throw new BaselineError(`secrets baseline '${filePath}' has a finding without a valid fingerprint`);
    }
    if (typeof entry.rule !== 'string' || entry.rule.length === 0) {
      throw new BaselineError(`secrets baseline '${filePath}' has a finding without a rule`);
    }
    entries.set(entry.fingerprint, {
      rule: entry.rule,
      path: typeof entry.path === 'string' ? entry.path : null,
      line: typeof entry.line === 'number' ? entry.line : null,
    });
  }
  return {
    path: filePath,
    version: data.version,
    generatedAt: typeof data.generatedAt === 'string' ? data.generatedAt : null,
    generator: typeof data.generator === 'string' ? data.generator : null,
    entries,
  };
}

/**
 * Write a baseline file from the secret findings of one scan. Only
 * findings with a fingerprint are recorded (every secret finding has
 * one); the recorded path and line are where the finding was seen, for
 * audit. Returns `{ path, count }`. Refuses to write into a directory
 * that does not exist, instead of creating it — a typo in the path
 * should error, not scatter a baseline into a new directory.
 */
export function writeSecretsBaseline(filePath, findings, { generator = null } = {}) {
  const dir = path.dirname(path.resolve(filePath));
  let stat;
  try {
    stat = fs.statSync(dir);
  } catch {
    throw new BaselineError(`cannot write secrets baseline '${filePath}': directory does not exist: ${dir}`);
  }
  if (!stat.isDirectory()) throw new BaselineError(`cannot write secrets baseline '${filePath}': not a directory: ${dir}`);
  const recorded = findings
    .filter((finding) => typeof finding.fingerprint === 'string')
    .map((finding) => ({
      fingerprint: finding.fingerprint,
      rule: finding.rule,
      path: finding.path ?? null,
      line: typeof finding.line === 'number' ? finding.line : null,
    }))
    .sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0));
  const data = {
    version: BASELINE_VERSION,
    generatedAt: new Date().toISOString(),
    ...(generator ? { generator } : {}),
    findings: recorded,
  };
  try {
    fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  } catch (error) {
    throw new BaselineError(`cannot write secrets baseline '${filePath}': ${error.message}`);
  }
  return { path: filePath, count: recorded.length };
}

/** True when this finding's fingerprint is recorded in the baseline. */
export function isBaselined(finding, baseline) {
  if (!baseline) return false;
  return baseline.entries.has(finding.fingerprint);
}

/**
 * Split a scan's secret findings into the ones the baseline already
 * covers and the ones it does not. The kept ones are the new secrets;
 * the suppressed ones are the triaged ones. With no baseline every
 * finding is kept.
 */
export function splitBaselined(findings, baseline) {
  const kept = [];
  const suppressed = [];
  for (const finding of findings) {
    (isBaselined(finding, baseline) ? suppressed : kept).push(finding);
  }
  return { kept, suppressed };
}
