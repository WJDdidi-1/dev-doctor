/**
 * Shared output format: one section per check, a one-line verdict, and a
 * copy-paste fix where one exists. Text goes to stdout; nothing here
 * writes to stderr, so `dev-diagnosis ... > report.txt` captures the report.
 */
import { formatFlakesTable } from './flakes.mjs';
import { estimateTokens, formatBytes } from './context.mjs';

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

/**
 * One-line ask for a star, printed at the end of an interactive `all`
 * report only. Machine output (--json) never sees it — a prompt in
 * JSON would break parsers — and piped output never sees it either,
 * so `dev-diagnosis all > report.txt` and CI logs stay clean.
 * Returns the line, or null when it should not print.
 */
export function starPromptLine(isTTY) {
  if (!isTTY) return null;
  return 'If this saved you time, star dev-diagnosis: https://github.com/WJDdidi-1/dev-doctor';
}

/**
 * The `all` run as one paste-ready Markdown report, for `--report
 * <file>`. Same numbers as the terminal report and the `--json`
 * output — score, noise list with token costs, suggestions, verdicts —
 * in prose an agent or a teammate can read without re-running the
 * tool, and small enough to paste into a chat or attach to a PR.
 * The caps match the terminal report (20 noise items, 10 review
 * items), with an "and N more" line, so the file stays paste-sized;
 * the full lists are in `--json`.
 */
export function formatReportMarkdown(run, top = null) {
  const lines = [];
  const context = run.checks.context;
  const pathCheck = run.checks.path || null;
  const flakesCheck = run.checks.flakes || null;
  const cacheCheck = run.checks.cache || null;

  lines.push('# dev-diagnosis report');
  lines.push('');
  lines.push(`Repo: ${run.root}`);
  lines.push(`Generated: ${new Date().toISOString()}`);
  const summary = run.summary;
  const summaryParts = [
    `${summary.checks.total} checks — ${summary.checks.passed} passed, ${summary.checks.failed} failed, ${summary.checks.skipped} skipped`,
  ];
  if (summary.contextNoiseBytes > 0) summaryParts.push(`context noise ${formatBytes(summary.contextNoiseBytes)}`);
  if (summary.cacheSavedPct != null) summaryParts.push(`cache saved ${summary.cacheSavedPct}%`);
  lines.push(`Overall: ${run.overall ? 'PASS' : 'FAIL'} — ${summaryParts.join('; ')}`);
  lines.push('');

  lines.push('## context');
  lines.push('');
  if (context.result) {
    const result = context.result;
    lines.push(`Score: ${result.score}/100 — ${result.status}`);
    lines.push(`Files: ${result.files}  Size: ${formatBytes(result.bytes)}`);
    if (result.changed) {
      const noun = result.changed.files.length === 1 ? 'file' : 'files';
      lines.push(`Scope: changed files vs ${result.changed.ref} (${result.changed.files.length} ${noun})`);
    }
    if (result.truncated) lines.push('Note: scan stopped at the file limit; totals are a lower bound.');
    for (const item of result.breakdown) {
      lines.push(`- ${item.label}: ${formatBytes(item.bytes)} (${item.share}%) — lost ${item.lost} of ${item.weight}`);
    }
    if (result.noise.length > 0) {
      lines.push('');
      lines.push('### Noise to keep away from an AI agent');
      lines.push('');
      lines.push('| File | Why | Size | Tokens |');
      lines.push('| --- | --- | --- | --- |');
      for (const item of result.noise.slice(0, 20)) {
        lines.push(`| ${item.label} | ${item.reason} | ${formatBytes(item.bytes)} | ≈ ${formatTokens(item.tokens)} |`);
      }
      if (result.noise.length > 20) lines.push(`… and ${result.noise.length - 20} more`);
      if (result.noise.length >= 2 && result.estimatedTokens) {
        const n = Math.min(3, result.noise.length);
        // Sum the bytes first, then estimate once: summing the
        // per-item rounded token counts can exceed the total (each
        // item rounds up on its own), which once printed a share over
        // 100%. Estimating from the summed bytes is monotonic, so the
        // share can never pass 100%.
        const topBytes = result.noise.slice(0, n).reduce((sum, item) => sum + item.bytes, 0);
        const topTokens = estimateTokens(topBytes);
        const pct = Math.round((topTokens / result.estimatedTokens) * 1000) / 10;
        lines.push('');
        lines.push(`Top ${n} noise items: ≈ ${formatTokens(topTokens)} tokens (${pct}% of this noise)`);
      }
      // Which directories the noise lives in (dust's rollup, applied
      // to the same list): the fix is usually one .aiignore pattern
      // per directory. Absent when the noise spans fewer than two
      // directories — then it would just repeat the file list.
      if (result.topDirectories?.length > 0) {
        lines.push('');
        lines.push('Top directories by noise:');
        lines.push('');
        for (const dir of result.topDirectories) {
          lines.push(`- ${dir.directory} — ≈ ${formatTokens(dir.tokens)} tokens (${dir.share}% of this noise)`);
        }
      }
      if (result.estimatedTokens != null) {
        lines.push(`Estimated tokens wasted on this noise: ≈ ${formatTokens(result.estimatedTokens)} tokens (estimate, ~4 bytes per token)`);
      }
    }
    if (result.review.length > 0) {
      lines.push('');
      lines.push('### Worth a look before sharing');
      lines.push('');
      for (const item of result.review.slice(0, 10)) lines.push(`- ${item.label} — ${item.reason}`);
      if (result.review.length > 10) lines.push(`… and ${result.review.length - 10} more`);
    }
    if (result.reviewSuggestions?.length > 0) {
      lines.push('');
      lines.push('Consider for .aiignore (advisory — --fix does not write these):');
      lines.push('');
      for (const suggestion of result.reviewSuggestions) lines.push(`- ${suggestion}`);
    }
    if (result.suggestions.length > 0) {
      lines.push('');
      lines.push('### Fix: add these to .aiignore');
      lines.push('');
      lines.push('```');
      for (const suggestion of result.suggestions) lines.push(suggestion);
      lines.push('```');
    }
  } else {
    lines.push(`Could not run: ${context.error || context.verdict}`);
  }
  lines.push('');
  lines.push(`Verdict: ${context.passed ? 'PASS' : 'FAIL'} — ${context.verdict}`);

  if (pathCheck) {
    lines.push('');
    lines.push('## path');
    lines.push('');
    if (pathCheck.result) {
      for (const row of pathCheck.result.contexts) {
        lines.push(`- ${row.name}: ${row.resolved ? row.path : `MISS — ${row.reason}`}`);
      }
      if (pathCheck.result.copies.shadowed.length > 0) {
        lines.push(`Shadowed by the winning copy: ${pathCheck.result.copies.shadowed.map((c) => c.path).join(', ')}`);
      }
      if (pathCheck.result.toolchainHits.length > 0) {
        lines.push('Installed, but not on PATH:');
        for (const hit of pathCheck.result.toolchainHits) lines.push(`- ${hit.path}`);
      }
      if (pathCheck.result.fix) lines.push(`Fix: ${pathCheck.result.fix}`);
      for (const row of pathCheck.result.contexts.filter((row) => !row.reliable)) {
        lines.push(`Note: ${row.name} context fell back to the current PATH (${row.note}).`);
      }
    } else {
      lines.push(`Could not run: ${pathCheck.error || pathCheck.verdict}`);
    }
    lines.push('');
    lines.push(`Verdict: ${pathCheck.passed ? 'PASS' : 'FAIL'} — ${pathCheck.verdict}`);
  }

  if (flakesCheck) {
    lines.push('');
    lines.push('## flakes');
    lines.push('');
    if (flakesCheck.result) {
      lines.push('```');
      lines.push(formatFlakesTable(flakesCheck.result, top));
      lines.push('```');
    } else {
      lines.push(`Could not run: ${flakesCheck.error || flakesCheck.verdict}`);
    }
    lines.push('');
    lines.push(`Verdict: ${flakesCheck.passed ? 'PASS' : 'FAIL'} — ${flakesCheck.verdict}`);
  }

  if (cacheCheck) {
    lines.push('');
    lines.push('## cache');
    lines.push('');
    if (cacheCheck.result) {
      const result = cacheCheck.result;
      lines.push(`Cache dir: ${result.cacheDir}`);
      lines.push(`Command: ${result.command.join(' ')}`);
      lines.push(`Cold: ${formatMs(result.coldMs)}  Warm: ${formatMs(result.warmMs)}  Saved: ${formatMs(Math.max(0, result.savedMs))} (${result.savedPct}%)`);
      if (result.runs > 1) {
        const spread = (runs) => `${formatMs(Math.min(...runs))}–${formatMs(Math.max(...runs))}`;
        lines.push(`Runs: ${result.runs} cold (${spread(result.coldRuns)}) and ${result.runs} warm (${spread(result.warmRuns)}); times are medians`);
      }
    } else {
      lines.push(`Could not run: ${cacheCheck.error || cacheCheck.verdict}`);
    }
    lines.push('');
    lines.push(`Verdict: ${cacheCheck.passed ? 'PASS' : 'FAIL'} — ${cacheCheck.verdict}`);
  }

  if (run.skipped.length > 0) {
    lines.push('');
    lines.push('## skipped');
    lines.push('');
    for (const line of run.skipped) lines.push(`- ${line}`);
  }

  lines.push('');
  lines.push('---');
  lines.push('Generated by dev-diagnosis — https://github.com/WJDdidi-1/dev-doctor');
  return `${lines.join('\n')}\n`;
}
