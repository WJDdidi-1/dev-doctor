// GitHub Actions workflow-command annotations for the context check.
//
// The method is golangci-lint's `--out-format=github-actions` (and
// reviewdog's `-reporter=github-annotations`): one result, many
// reporters — deliver the finding where the user already looks. The
// dev-diagnosis Action runs `all` and fails the job when a check
// fails, but the reason — which files carry the noise — lives only
// in the step log. Annotations put the top noise files on the run's
// annotations panel (and on the PR's Files view when the file is in
// the PR) without opening the log. Like reviewdog's fallback on fork
// PRs, it needs no token, no file and no upload: any step's stdout
// is picked up by the runner.
//
// What is annotated: the top noise files only (file-level findings
// with a repo-relative path). Directory rollups (`dist/`) are
// skipped — an annotation needs a file, and a directory path would
// not attach to one. Secret findings are never annotated here: the
// finding's path + rule would broadcast "this file has a secret" on
// the run panel, and the pre-commit hook already fails on new
// secrets with a baseline. A failing score adds one run-level
// `::error::` (no file) saying why the job failed; the noise items
// are `::warning::` — they are worth fixing even when the check
// passes, so a 93/100 repo still annotates its noise. A clean scan
// emits nothing. GitHub drops annotations past 10 per level per
// step, silently, so the output is capped there instead of emitting
// lines that vanish. Returns '' when there is nothing to annotate.
//
// Escaping is the workflow-commands spec: data escapes %, CR, LF;
// property values additionally escape : and ,. The implementation
// is written from that spec, not copied from any linter.

import { formatBytes } from './context.mjs';
import { formatTokens } from './report.mjs';

// GitHub drops workflow-command annotations past 10 per level per
// step, silently — so cap the output there instead of emitting lines
// that vanish. The full report still lists every noise item.
const MAX_ANNOTATIONS_PER_LEVEL = 10;

// Workflow commands are single lines; a message longer than this is
// cut off by the runner anyway, so cap it first.
const MAX_MESSAGE_LENGTH = 1500;

// The context check passes at the bar the run was judged against
// (lib/checks.mjs, default 85): below it the job fails, so the run
// gets one error line naming the score and the bar.

export function escapeAnnotationData(text) {
  return String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

export function escapeAnnotationProperty(text) {
  return escapeAnnotationData(text).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

export function formatContextAnnotations(result, { maxItems = MAX_ANNOTATIONS_PER_LEVEL } = {}) {
  const lines = [];
  // The result carries its bar as `minScore`; a hand-built result
  // without one falls back to the default, so old callers keep the
  // old line.
  const threshold = result.minScore ?? 85;
  if (result.score < threshold) {
    lines.push(`::error title=${escapeAnnotationProperty('dev-diagnosis — context score below threshold')}::${escapeAnnotationData(`context score ${result.score}/100 is below the ${threshold} threshold — the noise below is why.`)}`);
  }
  const files = (result.noise ?? [])
    .filter((item) => item.path && !item.path.endsWith('/'))
    .slice(0, maxItems);
  files.forEach((item, index) => {
    const title = `dev-diagnosis — context noise #${index + 1} · ${item.reason}`;
    let message = `${item.label} — ${item.reason} (${formatBytes(item.bytes)}, ≈ ${formatTokens(item.tokens)} tokens). Add it to .aiignore to keep it out of agent context.`;
    if (message.length > MAX_MESSAGE_LENGTH) message = `${message.slice(0, MAX_MESSAGE_LENGTH - 1)}…`;
    lines.push(`::warning file=${escapeAnnotationProperty(item.path)},title=${escapeAnnotationProperty(title)}::${escapeAnnotationData(message)}`);
  });
  return lines.join('\n');
}
