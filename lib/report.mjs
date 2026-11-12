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

/** Short form for a token estimate: 420, 4.2k, 1.2M. */
export function formatTokens(tokens) {
  if (tokens == null) return '—';
  if (tokens < 1000) return String(tokens);
  if (tokens < 1000000) {
    const value = tokens / 1000;
    return `${value >= 100 ? Math.round(value) : value.toFixed(1).replace(/\.0$/, '')}k`;
  }
  const value = tokens / 1000000;
  return `${value >= 100 ? Math.round(value) : value.toFixed(1).replace(/\.0$/, '')}M`;
}
