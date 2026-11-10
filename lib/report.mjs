/**
 * Shared output format: one section per check, a one-line verdict, and a
 * copy-paste fix where one exists. Text goes to stdout; nothing here
 * writes to stderr, so `dev-diagnosis ... > report.txt` captures the report.
 */

export function section(title) {
  return `\n== ${title} ==`;
}

export function verdictLine(ok, text) {
  return `${ok ? 'PASS' : 'FAIL'}  ${text}`;
}

export function formatMs(ms) {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}
