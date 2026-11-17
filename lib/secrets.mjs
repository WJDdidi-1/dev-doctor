/**
 * Content-level secret scan (gitleaks' method: rules are data, findings
 * carry a rule id and a line; TruffleHog's method: every finding says
 * whether it was verified — ours never are, by design).
 *
 * The filename check in lib/context.mjs only sees names: a file called
 * `config.js` with a live key inside it passes silently. This module
 * reads file *contents* and looks for credential shapes. It is advisory
 * only: findings are `review` items, they cost no score points, and
 * `--fix` never writes them. A committed live key is an irreversible
 * leak (git history keeps it forever, it must be rotated), so the
 * finding says what to do — rotate it — rather than pretending a
 * pattern match proves the key is still live.
 *
 * Never prints a matched value: a finding carries the file, the rule
 * and the line number, nothing else. Nothing is sent anywhere — the
 * scan is offline, which is also why verification is impossible here:
 * verifying a key means sending it to the issuing service. Every
 * finding is therefore `verified: false`, an unverified pattern match,
 * and the reason says so.
 *
 * A finding also carries a `fingerprint`: the SHA-256 of the rule id
 * and the matched value, so a triaged finding can be recognised again
 * without ever storing or printing the value itself (the baseline in
 * lib/baseline.mjs matches on fingerprints only). A fingerprint is
 * stable when the same secret moves to another file or line — that is
 * the point: the triage decision follows the secret, not its address.
 * The private-key rule has no value to hash (its header line is the
 * same for every key), so its fingerprint hashes the file path
 * instead: a key in a new file is a new finding, which is the safe
 * direction for a credential whose value cannot be told apart.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';

import { LOCKFILES, isTemplateFile } from './filekinds.mjs';

/** Files larger than this are not content-scanned. */
export const MAX_SECRET_SCAN_BYTES = 1024 * 1024;

/**
 * Shannon entropy of a string, in bits per character. A 32-hex-char
 * key can only reach 4.0 if all 16 symbols appear exactly twice — a
 * real random one measures 3.3–3.9 (median ≈3.6 over 200 samples), so
 * a bar near 4.0 misses nearly every real hex key; the generic rule's
 * bar therefore sits at 3.0 (detect-secrets uses the same 3.0 as its
 * hex limit). A repeated-character fake (`ghp_000…`) scores near 0.
 */
export function shannonEntropy(value) {
  if (!value) return 0;
  const counts = new Map();
  for (const ch of value) counts.set(ch, (counts.get(ch) || 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

// The AWS documentation's own example key. It is the canonical fake
// in every AWS doc page, so matching it would flag documentation.
const KNOWN_EXAMPLE_VALUES = new Set(['AKIAIOSFODNN7EXAMPLE']);

// Placeholder words inside a candidate value: the value is a stand-in
// the author meant to be replaced, not a credential.
const PLACEHOLDER_WORDS = ['example', 'placeholder', 'changeme', 'xxx', 'sample', 'dummy'];

function isPlaceholder(value) {
  const lower = value.toLowerCase();
  return PLACEHOLDER_WORDS.some((word) => lower.includes(word));
}

// An environment reference is not a credential: `token =
// process.env.GH_TOKEN` and `apiKey = import.meta.env.VITE_API_KEY`
// name where a secret lives, they do not contain one. Dogfooding
// caught this on ci-triage's own lib/doctor.mjs — the same class of
// false positive as the `${{ }}` expression, a reference, not a value.
function isEnvReference(value) {
  return value.startsWith('process.env.') || value.startsWith('import.meta.env.');
}

function hasVariety(value) {
  return new Set(value).size >= 8;
}

/**
 * One rule: `pattern` finds candidates, `valueOf` extracts the part
 * whose entropy decides whether the candidate is real enough to
 * report, `minEntropy` is that bar. Provider-shaped rules are checked
 * before the generic keyword rule, and only the first rule that
 * matches a line reports it — one finding per line, the most specific
 * rule winning.
 */
const RULES = [
  {
    id: 'aws-access-key',
    label: 'AWS access key',
    pattern: /AKIA[0-9A-Z]{16}/g,
    valueOf: (match) => match[0],
    minEntropy: 3.0,
  },
  {
    id: 'github-token',
    label: 'GitHub token',
    pattern: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}/g,
    valueOf: (match) => match[0].split('_').slice(1).join('_'),
    minEntropy: 3.5,
  },
  {
    id: 'private-key',
    label: 'private key',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA |ED25519 )?PRIVATE KEY-----/g,
    valueOf: () => '',
    minEntropy: 0,
  },
  {
    id: 'slack-token',
    label: 'Slack token',
    pattern: /xox[baprs]-[0-9A-Za-z-]{10,}/g,
    valueOf: (match) => match[0].slice(4),
    minEntropy: 3.0,
  },
  {
    id: 'generic-api-key',
    label: 'possible API key or secret',
    // An assignment whose key names a credential and whose value is a
    // long high-entropy string: `api_key = "9f8e…"`. Bare hex, UUIDs,
    // JWTs and lockfile hashes have no such assignment, so they never
    // match — the keyword is what keeps the rule from flagging every
    // hash in the repo. The value class has no dot: a dot marks a
    // property chain (`secrets = result.review.filter`) or a path,
    // not a credential — and a JWT is still caught, because its first
    // segment alone is long and high-entropy. Case-insensitive:
    // real assignments are usually `API_KEY=` or `apiKey =`, not
    // lowercase snake_case — without the `i` flag the rule missed
    // every uppercase assignment (0/20 random keys, found 2026-11-15).
    // The pattern starts AT the keyword, with no variable-name prefix
    // before it: a leading `[A-Za-z0-9_.-]*` forced the engine to
    // backtrack over every unbroken word-run on the line, so one
    // 800-char line cost 4 ms and a 500 KB minified line hung the
    // scan for over two minutes (measured 2026-11-15). Starting at
    // the keyword lets the engine prefilter on the literal, so a
    // 1 MB line costs under 1 ms — and detection is unchanged,
    // because the old match always started at the keyword anyway:
    // `my_api_key` and `config.apiKey` still match, with the same
    // captured value.
    pattern: /(?:api[_-]?key|secret|token|password|passwd|pwd)[A-Za-z0-9_.-]*\s*[:=]\s*(["']?)([A-Za-z0-9_\-/+=]{20,})["']?/gi,
    valueOf: (match) => match[2],
    minEntropy: 3.0,
  },
];

export const SECRET_RULES = RULES.map(({ id, label }) => ({ id, label }));

// Code files: languages where a bare identifier on the right of an
// assignment is a variable reference, not a literal value. Shell and
// env-style files are deliberately absent — a bare value IS a
// credential there (`TOKEN=abc…` in `.env`, `export TOKEN=abc…` in
// `.sh`) — as are JSON, YAML, docs and extensionless files, where
// the exclusion would be a guess. A file type missing here only
// keeps the old behaviour (still flags), which is the safe direction.
const CODE_EXTENSIONS = new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts',
  'py', 'pyi', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'groovy',
  'c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'hh', 'cs', 'php', 'swift',
  'lua', 'pl', 'pm', 'hs', 'ml', 'mli', 'fs', 'fsx', 'dart', 'elm',
  'ex', 'exs', 'erl', 'clj', 'cljs', 'jl', 'nim', 'zig', 'd', 'r', 'vb', 'pas',
]);

function isCodeFile(relativePath) {
  const basename = String(relativePath).split('/').pop();
  const dot = basename.lastIndexOf('.');
  return dot > 0 && CODE_EXTENSIONS.has(basename.slice(dot + 1).toLowerCase());
}

// A bare identifier is a variable name, not a credential — but a long
// all-hex value is not a name: no real variable is 20 hex characters,
// while a hardcoded key is exactly that shape (`API_KEY=9f8e…` in
// code is a key without quotes). The exclusion therefore needs at
// least one character outside the hex set.
function isBareIdentifier(value) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) && /[^0-9a-fA-F]/.test(value);
}

function matchRules(line, relativePath) {
  // A GitHub Actions expression is a reference to a secret, not a
  // secret itself: `GH_TOKEN="${{ inputs.token }}"` looks like a
  // high-entropy token value to the generic rule, but there is no
  // credential on the line at all.
  if (line.includes('${{')) return null;
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    const match = rule.pattern.exec(line);
    if (!match) continue;
    const value = rule.valueOf(match);
    // A function call is a reference, not a credential: `token =
    // getTypeAnnotationFirstToken(path)` captures the 27-character
    // function name as the "value", and its entropy clears the bar.
    // (Dogfood caught this on prettier's type-annotation printer.)
    // Only the generic rule assigns values this way — the provider
    // rules match literal key shapes, which a call cannot produce.
    if (rule.id === 'generic-api-key' && line.slice(rule.pattern.lastIndex).trimStart().startsWith('(')) continue;
    // A bare identifier assigned to a secret-named variable in a code
    // file is a variable, not a credential: `token =
    // previouslyFetchedTokenValue` names a value fetched elsewhere —
    // a real credential in code is a string literal. Only the generic
    // rule assigns values this way, and only when the value is
    // unquoted: `token = "previouslyFetchedTokenValue"` is a string
    // literal and still flags. In an env file a bare value IS a
    // credential, so the exclusion is code files only (see
    // CODE_EXTENSIONS above).
    if (
      rule.id === 'generic-api-key' &&
      !match[1] &&
      isCodeFile(relativePath) &&
      isBareIdentifier(value)
    ) continue;
    if (KNOWN_EXAMPLE_VALUES.has(value)) continue;
    if (value && isPlaceholder(value)) continue;
    if (value && isEnvReference(value)) continue;
    if (value && !hasVariety(value)) continue;
    if (value && shannonEntropy(value) < rule.minEntropy) continue;
    return { rule, value };
  }
  return null;
}

/**
 * Group secret findings by fingerprint: the same credential in many
 * files is one finding, not one per file. Dogfooding on Biome found
 * 2,050 findings that were 41 distinct secrets — the same test token
 * snapshotted 433 times — and a review list that long is unreadable:
 * a real key hides in the flood, and the terminal prints only the
 * first 10 without saying how many more there are. The first
 * occurrence is kept (its file and line), with `occurrences`
 * counting every place the secret appears, and the reason says so —
 * the rotation scope is the count, not the first file. Only findings
 * with a fingerprint are grouped; other review items pass through
 * untouched, in order. The fingerprint is what the baseline matches
 * on, so one triage decision still suppresses every occurrence.
 */
export function deduplicateSecretFindings(items) {
  const firstByFingerprint = new Map();
  const out = [];
  for (const item of items) {
    if (item.kind !== 'secret' || !item.fingerprint) {
      out.push(item);
      continue;
    }
    const existing = firstByFingerprint.get(item.fingerprint);
    if (existing) {
      existing.occurrences += 1;
      continue;
    }
    const grouped = { ...item, occurrences: 1 };
    firstByFingerprint.set(item.fingerprint, grouped);
    out.push(grouped);
  }
  for (const grouped of firstByFingerprint.values()) {
    if (grouped.occurrences > 1) {
      const more = grouped.occurrences - 1;
      grouped.reason = `${grouped.reason}; also in ${more} more place${more === 1 ? '' : 's'}`;
    }
  }
  return out;
}

/**
 * The fingerprint of one finding: SHA-256 over the rule id and the
 * matched value, so the same secret is recognised again wherever it
 * moves. A hash of a high-entropy value cannot be reversed into the
 * value, which is what makes it safe to store in a baseline file and
 * to print in --json output. When there is no value to hash (the
 * private-key rule), the file path stands in — see the module header.
 */
export function secretFingerprint(ruleId, value, relativePath) {
  const material = value ? `${ruleId}\0${value}` : `${ruleId}\0${relativePath}`;
  return createHash('sha256').update(material, 'utf8').digest('hex');
}

/**
 * Literal markers, lowercased: ripgrep's method — a regex engine is
 * only run where a literal candidate exists. Every rule's pattern
 * requires one of these literals: `AKIA`, the `gh?_` / `github_pat_`
 * prefixes, `-----BEGIN `, `xox`, or one of the generic rule's
 * keywords (case-insensitive). A file containing none of them cannot
 * match any rule, so the line split and the per-line regexes are
 * skipped outright. The check is a necessary condition, never a
 * filter on meaning — a file that passes it is still judged line by
 * line, so detection is unchanged; only files that cannot match are
 * skipped. Measured on nodejs/node: 3,225 of 54,807 files pass the
 * prefilter; the rest skip the line split and the five per-line
 * regexes (the secret scan's regex work, ~6 s of a ~46 s scan on
 * this VM — the rest is the per-file open cost, which no content
 * check can avoid; repeat scans use --cache for that).
 */
const SECRET_MARKERS = [
  'akia', 'ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_',
  '-----begin ', 'xox',
  'apikey', 'api_key', 'api-key', 'secret', 'token', 'password', 'passwd', 'pwd',
];

/**
 * Scan text (one string, lines split on \n) for secrets. Pure, so the
 * corpus tests exercise it without touching the filesystem. Returns
 * findings shaped like the context check's review items — file, rule,
 * line, never the matched value.
 */
export function scanTextForSecrets(text, relativePath) {
  const findings = [];
  const lower = String(text).toLowerCase();
  if (!SECRET_MARKERS.some((marker) => lower.includes(marker))) return findings;
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const matched = matchRules(lines[i], relativePath);
    if (!matched) continue;
    const { rule, value } = matched;
    findings.push({
      kind: 'secret',
      label: relativePath,
      reason: `possible secret: ${rule.label} (line ${i + 1}, unverified)`,
      path: relativePath,
      rule: rule.id,
      line: i + 1,
      verified: false,
      fingerprint: secretFingerprint(rule.id, value, relativePath),
    });
  }
  return findings;
}

function isBinary(buffer) {
  // A NUL byte in the first 8 KB is the binary test every scanner
  // uses; reading the whole file just to decide would waste the
  // scan's time budget on minified bundles.
  return buffer.subarray(0, 8192).includes(0);
}

/**
 * Scan one file's contents. Returns [] without reading when the file
 * cannot hold a reportable secret: over the size cap, a lockfile
 * (its integrity hashes are bare strings, never assignments), or a
 * template/example file (its values are placeholders by design).
 * Binary files and unreadable files also return [].
 */
export function scanFileForSecrets(absolutePath, relativePath) {
  const basename = relativePath.split('/').pop();
  if (LOCKFILES.has(basename)) return [];
  if (isTemplateFile(basename)) return [];
  let stat;
  try {
    stat = fs.statSync(absolutePath);
  } catch {
    return [];
  }
  if (!stat.isFile() || stat.size > MAX_SECRET_SCAN_BYTES) return [];
  let buffer;
  try {
    buffer = fs.readFileSync(absolutePath);
  } catch {
    return [];
  }
  if (isBinary(buffer)) return [];
  return scanTextForSecrets(buffer.toString('utf8'), relativePath);
}
