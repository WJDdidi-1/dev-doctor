#!/usr/bin/env node
/**
 * dev-diagnosis — one offline CLI that diagnoses a repo the way four small
 * tools do: context noise for AI agents, missing CLI commands, build-cache
 * value, and flaky tests.
 *
 * Standard-library Node.js only, no network, no account. Works on Linux,
 * macOS and Windows: all paths go through node:path, JUnit input is
 * normalised from CRLF before parsing, and build commands run without a
 * shell (see lib/run-command.mjs for the one Windows-only retry).
 *
 * Exit codes: 0 = every check that ran passed; 1 = at least one check
 * found something to fix, or a check could not run; 2 = usage error.
 * With --fix the exit code follows a re-scan after the fix, so a fix
 * that leaves the repo clean exits 0. With --fix --dry-run nothing is
 * written, so the exit code follows the repo as it stands.
 *
 * Agent modes: --mcp serves the checks over MCP on stdio (see
 * lib/mcp.mjs); --skill-generate writes a Claude Agent Skills SKILL.md
 * that tells an agent to run the CLI when it starts work in a repo
 * (see lib/skill.mjs).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AIIGNORE_HEADER, estimateTokens, formatBytes } from '../lib/context.mjs';
import {
  UsageError, allJson, applyContextFixAndRescan, formatSummary,
  previewContextFix, rescanContext, runAll, runCacheCheck, runContextCheck,
  runFlakesCheck, runPathCheck, stripCacheStdout,
} from '../lib/checks.mjs';
import { runMcpServer } from '../lib/mcp.mjs';
import { runDoctor } from '../lib/doctor.mjs';
import { generateCompletion, knownCommands, knownOptions } from '../lib/completion.mjs';
import { ensureAgentsSection, generateSkill } from '../lib/skill.mjs';
import { applySetup, checkSetup, planSetup } from '../lib/setup.mjs';
import { formatFlakesTable } from '../lib/flakes.mjs';
import { formatMs, formatReportMarkdown, formatTokens, section, starPromptLine, verdictLine } from '../lib/report.mjs';

const VERSION = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

const USAGE = `dev-diagnosis: one diagnosis for your repo, your commands, your cache and your tests.

Usage:
  dev-diagnosis [all] [path] [--command <name>] [--flakes <dir>] [--fix] [--dry-run] [--changed[=<ref>]] [--report <file>] [-- <build-command...>]
  dev-diagnosis context [path] [--json] [--fix] [--dry-run] [--changed[=<ref>]]
  dev-diagnosis path <command> [--json]
  dev-diagnosis cache [--json] [--cache-dir <dir>] [--cwd <dir>] [--runs N] -- <build-command...>
  dev-diagnosis flakes <runs-dir> [--json] [--top N]
  dev-diagnosis --mcp [--sandbox <dir>]
  dev-diagnosis --skill-generate [--global | --project]
  dev-diagnosis setup [--dry-run] [--check]
  dev-diagnosis doctor [--json]
  dev-diagnosis completion <bash|zsh|fish>
  dev-diagnosis --help
  dev-diagnosis --version

Commands:
  all       Run every check that has what it needs and print one unified
            report. context always runs on [path] (default: current
            directory). A bare path is the same as all <path>.
            path runs when --command is given, flakes when
            --flakes is given, cache when a build command follows --.
            Checks without their input are listed as skipped, with the
            command that would run them.
  context   Find the files an AI coding agent should not read: build
            output, lockfiles, logs and oversized files. Prints a 0-100
            score and the .aiignore-style suggestions that would fix it.
  path      Diagnose why a CLI command is missing: one row per shell
            context (current, login, non-login, daemon-like), shadowed
            copies, toolchain installs, and a copy-paste fix.
  cache     Time one build command cold (cache moved aside) and warm
            (cache present) and say whether the cache pays. The cache
            directory is restored to its original state afterwards.
  flakes    Rank flaky tests from JUnit XML across CI runs, including
            passed-on-retry. Each subdirectory of <runs-dir> is one run;
            each *.xml file directly under it is a run of its own.
  --mcp     Serve the checks as an MCP server on stdio, so any
            MCP-compatible agent can call them as tools. See the README
            for the client config. --sandbox <dir> (alias --root)
            restricts every path the tools touch to that directory.
  --skill-generate
            Write a Claude Agent Skills SKILL.md for dev-diagnosis:
            ./.claude/skills/dev-diagnosis/SKILL.md by default
            (--project), or ~/.claude/skills/dev-diagnosis/SKILL.md
            with --global. Refuses to overwrite an existing file.
            Also appends a short section to ./AGENTS.md (--project
            only), so agents that read AGENTS.md at startup find it.
  setup     One-command install: detect the agents on this machine
            (Claude Code, Codex CLI, Cursor, VS Code) and write the
            MCP config that wires dev-diagnosis into each of them.
            Prints a preview of exactly what will be written before
            writing anything; a config that already mentions
            dev-diagnosis is left alone. --dry-run shows the preview
            without writing; --check reports which agents are wired.
  doctor    Check this installation is healthy: Node version,
            dev-diagnosis on PATH, the home directory setup and
            --skill-generate write into, installed skills, MCP wiring
            and .aiignore. Read-only — it changes nothing, so it works
            even when the rest of the tool is misbehaving. The method
            is Claude Code's 'claude doctor'. --json for machines.
  completion
            Print a shell completion script for bash, zsh or fish,
            generated from the same command list the CLI parses, so
            it can never suggest a flag the CLI rejects. Install it
            with e.g.:
            dev-diagnosis completion bash > ~/.bash_completion.d/dev-diagnosis

Options:
  --json          machine-readable output (context, path, cache, flakes, all)
  --fix           write the context check's .aiignore suggestions into
                  <path>/.aiignore (context and all only), then re-scan:
                  the verdict and the exit code follow the post-fix
                  score. Entries that are already there are left alone;
                  nothing else in the file is changed. With --dry-run,
                  show what would be written instead of writing it.
  --top N         show only the N highest-ranked flaky tests
  --runs N        with cache (and all): time the build N times cold
                  and N times warm (default 1, at most 10) and judge
                  the verdict on the medians, with the min–max spread
                  shown. One timing sample is noise — a jittery build
                  flips the verdict between repeats — so 3 or 5 runs
                  steadies it. The method is hyperfine's: several
                  timed runs and a median, not one sample.
  --report <file> with all: also write this run as a Markdown report
                  file, ready to paste to an agent or attach to a PR.
                  Works with --json and --fix; the report reflects
                  the post-fix re-scan when --fix is given.
  --changed[=<ref>]
                  with context (and all): scan only the files git
                  lists as changed vs <ref> (default HEAD) — tracked
                  files that differ plus untracked files git does not
                  ignore — so a repo with pre-existing noise can still
                  answer whether your change added any. The score, the
                  noise list and the totals are then the change's, not
                  the repo's. Needs a git repo; use --changed=main to
                  compare against another ref. The method is bat's: a
                  tool that reads files should know what changed.
  --sandbox <dir> restrict --mcp to paths under <dir> (--root is an alias)
  --global        with --skill-generate: write the skill to ~/.claude/skills
  --project       with --skill-generate: write the skill to ./.claude/skills
  --dry-run       with setup, or with --fix (context and all): show
                  the preview without writing anything. With --fix it
                  lists the .aiignore entries that would be added (and
                  the header a new file would get), and the exit code
                  follows the repo as it stands, since nothing changed.
  --check         with setup: report which agents are wired, without writing
  -h, --help      show this help
  -v, --version   print the version

Exit codes: 0 = every check that ran passed; 1 = a check found something
to fix or could not run; 2 = usage error. With --fix the exit code
follows a re-scan after the fix, so a fix that leaves the repo clean
exits 0. With --fix --dry-run nothing is written, so the exit code
follows the repo as it stands.
`;

// The completion spec is the single source of truth for what the
// parser accepts: the suggestion lists below are derived from it,
// so a flag added to the parser is automatically completable.
const KNOWN_COMMANDS = knownCommands();
const KNOWN_OPTIONS = knownOptions();

// Levenshtein distance — small, dependency-free, used only to suggest a
// correction when the user mistypes a command or an option. This is the
// method git, gh (via Cobra) and cargo all use: threshold 2 is Cobra's
// default SuggestionsMinimumDistance. A bare typo used to die with just
// "unknown command: al" and a pointer to --help; now the error names the
// command the user almost certainly meant, so the fix is a retype, not
// a re-read of the help.
function levenshtein(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    let corner = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const temp = prev[j];
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        corner + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      corner = temp;
    }
  }
  return prev[b.length];
}

// Returns '' when nothing is close enough, otherwise one line (or, for
// several matches, a "one of these" list) ready to print after the
// error. Exact matches never reach here — the parser consumes them —
// so distance 0 is excluded, and a bare '-' suggests nothing.
function didYouMean(input, candidates) {
  if (!input || !input.replace(/^-+/, '')) return '';
  const matches = candidates
    .map((candidate) => ({ candidate, distance: levenshtein(input, candidate) }))
    .filter(({ distance }) => distance >= 1 && distance <= 2)
    .sort((x, y) => x.distance - y.distance || (x.candidate < y.candidate ? -1 : 1));
  if (matches.length === 0) return '';
  if (matches.length === 1) return `Did you mean '${matches[0].candidate}'?`;
  return `Did you mean one of these?\n${matches.map((m) => `  ${m.candidate}`).join('\n')}`;
}

function parseArgs(argv) {
  const parsed = {
    command: null, positional: [], json: false, fix: false, help: false, version: false,
    commandName: null, flakesDir: null, cacheDir: null, cwd: null, top: null,
    report: null, runs: null, changed: null,
    buildCommand: null, error: null,
    mcp: false, sandbox: null, skillGenerate: false, skillGlobal: false, skillProject: false,
    dryRun: false, check: false,
  };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--') {
      parsed.buildCommand = argv.slice(i + 1);
      break;
    }
    if (arg === '--json' || arg === '-j') parsed.json = true;
    else if (arg === '--fix') parsed.fix = true;
    else if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg === '--version' || arg === '-v') parsed.version = true;
    else if (arg === '--mcp') parsed.mcp = true;
    else if (arg === '--dry-run') parsed.dryRun = true;
    else if (arg === '--check') parsed.check = true;
    else if (arg === '--skill-generate') parsed.skillGenerate = true;
    else if (arg === '--global') parsed.skillGlobal = true;
    else if (arg === '--project') parsed.skillProject = true;
    else if (arg === '--command') {
      parsed.commandName = argv[i + 1];
      if (parsed.commandName === undefined) parsed.error = '--command needs a value';
      i += 1;
    } else if (arg.startsWith('--command=')) parsed.commandName = arg.slice('--command='.length);
    else if (arg === '--flakes') {
      parsed.flakesDir = argv[i + 1];
      if (parsed.flakesDir === undefined) parsed.error = '--flakes needs a value';
      i += 1;
    } else if (arg.startsWith('--flakes=')) parsed.flakesDir = arg.slice('--flakes='.length);
    else if (arg === '--cache-dir') {
      parsed.cacheDir = argv[i + 1];
      if (parsed.cacheDir === undefined) parsed.error = '--cache-dir needs a value';
      i += 1;
    } else if (arg.startsWith('--cache-dir=')) parsed.cacheDir = arg.slice('--cache-dir='.length);
    else if (arg === '--cwd') {
      parsed.cwd = argv[i + 1];
      if (parsed.cwd === undefined) parsed.error = '--cwd needs a value';
      i += 1;
    } else if (arg.startsWith('--cwd=')) parsed.cwd = arg.slice('--cwd='.length);
    else if (arg === '--sandbox' || arg === '--root') {
      parsed.sandbox = argv[i + 1];
      if (parsed.sandbox === undefined) parsed.error = `${arg} needs a value`;
      i += 1;
    } else if (arg.startsWith('--sandbox=')) parsed.sandbox = arg.slice('--sandbox='.length);
    else if (arg.startsWith('--root=')) parsed.sandbox = arg.slice('--root='.length);
    else if (arg === '--top') {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value < 1) parsed.error = '--top needs a positive integer';
      else parsed.top = value;
      i += 1;
    } else if (arg.startsWith('--top=')) {
      const value = Number(arg.slice('--top='.length));
      if (!Number.isInteger(value) || value < 1) parsed.error = '--top needs a positive integer';
      else parsed.top = value;
    } else if (arg === '--runs') {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value < 1 || value > 10) parsed.error = '--runs needs an integer from 1 to 10';
      else parsed.runs = value;
      i += 1;
    } else if (arg.startsWith('--runs=')) {
      const value = Number(arg.slice('--runs='.length));
      if (!Number.isInteger(value) || value < 1 || value > 10) parsed.error = '--runs needs an integer from 1 to 10';
      else parsed.runs = value;
    } else if (arg === '--report') {
      parsed.report = argv[i + 1];
      if (parsed.report === undefined) parsed.error = '--report needs a value';
      i += 1;
    } else if (arg.startsWith('--report=')) {
      const value = arg.slice('--report='.length);
      if (!value) parsed.error = '--report needs a value';
      else parsed.report = value;
    } else if (arg === '--changed') {
      // Bare --changed means HEAD; a ref other than HEAD takes the
      // = form (--changed=main), so a positional path after the flag
      // is never swallowed as a ref.
      parsed.changed = 'HEAD';
    } else if (arg.startsWith('--changed=')) {
      const value = arg.slice('--changed='.length);
      if (!value) parsed.error = '--changed needs a value after =';
      else parsed.changed = value;
    } else if (arg.startsWith('-')) {
      // Suggest the option the user almost certainly meant
      // (--comand=node -> --command); the part after '=' is a value,
      // not part of the name.
      const suggestion = didYouMean(arg.split('=')[0], KNOWN_OPTIONS);
      parsed.error = `unknown option: ${arg}${suggestion ? `\n${suggestion}` : ''}`;
    } else if (parsed.command === null) parsed.command = arg;
    else parsed.positional.push(arg);
    i += 1;
  }
  return parsed;
}

function printContext(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Repo: ${result.root}`);
  console.log(`Files: ${result.files}  Size: ${formatBytes(result.bytes)}  Score: ${result.score}/100 — ${result.status}`);
  if (result.changed) {
    const noun = result.changed.files.length === 1 ? 'file' : 'files';
    console.log(`Scope: changed files vs ${result.changed.ref} (${result.changed.files.length} ${noun})`);
  }
  if (result.truncated) console.log('Note: scan stopped at the file limit; totals are a lower bound.');
  for (const item of result.breakdown) {
    console.log(`  ${item.label}: ${formatBytes(item.bytes)} (${item.share}%) — lost ${item.lost} of ${item.weight}`);
  }
  if (result.noise.length > 0) {
    console.log('Noise to keep away from an AI agent:');
    for (const item of result.noise.slice(0, 20)) {
      console.log(`  ${item.label} — ${item.reason} (${formatBytes(item.bytes)}, ≈ ${formatTokens(item.tokens)} tokens)`);
    }
    if (result.noise.length > 20) console.log(`  ... and ${result.noise.length - 20} more`);
    // Ranked by cost, so the first few items are where the waste is:
    // say how much of it they are, so the reader knows whether fixing
    // two or three entries is most of the job or barely a dent.
    if (result.noise.length >= 2 && result.estimatedTokens) {
      const n = Math.min(3, result.noise.length);
      // Sum the bytes first, then estimate once: summing the
      // per-item rounded token counts can exceed the total (each item
      // rounds up on its own), which once printed a share over 100%.
      // Estimating from the summed bytes is monotonic, so the share
      // can never pass 100%.
      const topBytes = result.noise.slice(0, n).reduce((sum, item) => sum + item.bytes, 0);
      const topTokens = estimateTokens(topBytes);
      const pct = Math.round((topTokens / result.estimatedTokens) * 1000) / 10;
      console.log(`Top ${n} noise items: ≈ ${formatTokens(topTokens)} tokens (${pct}% of this noise)`);
    }
    // Which directories the noise lives in (dust's rollup, applied to
    // the same list): the fix is usually one .aiignore pattern per
    // directory, so the reader needs to know whether one directory is
    // most of the job. Absent when the noise spans fewer than two
    // directories — then it would just repeat the file list.
    if (result.topDirectories?.length > 0) {
      console.log('Top directories by noise:');
      for (const dir of result.topDirectories) {
        console.log(`  ${dir.directory} — ≈ ${formatTokens(dir.tokens)} tokens (${dir.share}% of this noise)`);
      }
    }
    // What the noise costs in tokens, at ~4 bytes per token — an
    // estimate, labelled as one. Tokens are what the user pays for, so
    // the cost belongs next to the files, not in a footnote.
    if (result.estimatedTokens != null) {
      console.log(`Estimated tokens wasted on this noise: ≈ ${formatTokens(result.estimatedTokens)} tokens (estimate, ~4 bytes per token)`);
    }
  }
  if (result.review.length > 0) {
    console.log('Worth a look before sharing:');
    for (const item of result.review.slice(0, 10)) {
      console.log(`  ${item.label} — ${item.reason}`);
    }
  }
  if (result.reviewSuggestions?.length > 0) {
    console.log('Consider for .aiignore (advisory — --fix does not write these):');
    for (const suggestion of result.reviewSuggestions) console.log(`  ${suggestion}`);
  }
  if (result.suggestions.length > 0) {
    console.log('Fix: add these to .aiignore (or the agent\'s ignore list):');
    for (const suggestion of result.suggestions) console.log(`  ${suggestion}`);
  }
}

function printFixPreview(fix, suggestionCount) {
  // Ruff's --diff shape: the exact lines that would be written, as a
  // diff, so the reader can approve the fix before it lands. The
  // header lines are shown too when a new file would get them — they
  // are part of what --fix would write.
  if (fix.added.length > 0) {
    const noun = fix.added.length === 1 ? 'entry' : 'entries';
    const lead = fix.created
      ? `Would create .aiignore with ${fix.added.length} ${noun}`
      : `Would add ${fix.added.length} ${noun} to .aiignore`;
    console.log(`${lead} (dry run — nothing was written):`);
    if (fix.wouldAddHeader) {
      for (const line of AIIGNORE_HEADER) console.log(`  + ${line}`);
    }
    for (const entry of fix.added) console.log(`  + ${entry}`);
  } else if (suggestionCount === 0) {
    console.log('Nothing to add to .aiignore: no suggestions.');
  } else {
    console.log('Nothing would change: .aiignore already has all suggestions.');
  }
}

function printFixLine(fix, suggestionCount) {
  if (fix.added.length > 0) {
    const noun = fix.added.length === 1 ? 'entry' : 'entries';
    const lead = fix.created
      ? `Created .aiignore with ${fix.added.length} ${noun}`
      : `Added ${fix.added.length} ${noun} to .aiignore`;
    console.log(`${lead}: ${fix.added.join(', ')}`);
  } else if (suggestionCount === 0) {
    console.log('Nothing to add to .aiignore: no suggestions.');
  } else {
    console.log('Nothing added: .aiignore already has all suggestions.');
  }
}

function printPath(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  for (const row of result.contexts) {
    const status = row.resolved ? row.path : `MISS — ${row.reason}`;
    console.log(`${row.name.padEnd(12)} ${status}`);
  }
  if (result.copies.shadowed.length > 0) {
    console.log(`Shadowed by the winning copy: ${result.copies.shadowed.map((c) => c.path).join(', ')}`);
  }
  if (result.toolchainHits.length > 0) {
    console.log('Installed, but not on PATH:');
    for (const hit of result.toolchainHits) console.log(`  ${hit.path}`);
  }
  if (result.fix) console.log(`Fix: ${result.fix}`);
  const unreliable = result.contexts.filter((row) => !row.reliable);
  for (const row of unreliable) console.log(`Note: ${row.name} context fell back to the current PATH (${row.note}).`);
}

function printFlakes(result, top, json) {
  if (json) {
    // --top limits the listing, not the scan: the tests array holds only
    // the N highest-ranked tests, while totals still describe the whole
    // run set — the same split the text table already makes.
    const out = top == null ? result : { ...result, tests: result.tests.slice(0, top) };
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  console.log(formatFlakesTable(result, top));
}

function printCache(result, json) {
  if (json) {
    console.log(JSON.stringify(stripCacheStdout(result), null, 2));
    return;
  }
  console.log(`Cache dir: ${result.cacheDir}`);
  console.log(`Command: ${result.command.join(' ')}`);
  console.log(`Cold: ${formatMs(result.coldMs)}  Warm: ${formatMs(result.warmMs)}  Saved: ${formatMs(Math.max(0, result.savedMs))} (${result.savedPct}%)`);
  if (result.runs > 1) {
    // The medians above hide the spread; show it, or a tight verdict
    // on a noisy build looks more certain than it is.
    const spread = (runs) => `${formatMs(Math.min(...runs))}–${formatMs(Math.max(...runs))}`;
    console.log(`Runs: ${result.runs} cold (${spread(result.coldRuns)}) and ${result.runs} warm (${spread(result.warmRuns)}); times are medians`);
  }
  console.log(`Verdict: ${result.verdict} — ${result.verdictDetail}`);
}

function printSetupPreview(plan) {
  for (const row of plan.agents) {
    console.log(`${row.name} (${row.configPath})`);
    if (row.status === 'already-wired') {
      console.log('  already wired — dev-diagnosis is already in this config');
    } else if (row.status === 'unreadable') {
      console.log(`  skipped — ${row.note}`);
    } else {
      console.log(`  ${row.status} — will write:`);
      for (const line of row.preview.replace(/\n$/, '').split('\n')) console.log(`    ${line}`);
    }
  }
}

function printPathWarning(plan) {
  if (!plan.commandOnPath) {
    console.log('Note: `dev-diagnosis` is not on PATH — install it globally (`npm install -g dev-diagnosis-cli`) or your agents will not be able to run it.');
  }
}

function runSetup(args) {
  if (args.check) {
    const result = checkSetup();
    if (result.detected === 0) {
      console.log('No supported agent found (looked for Claude Code, Codex CLI, Cursor, VS Code).');
      return 1;
    }
    for (const row of result.rows) {
      const state = row.wired ? 'wired' : `not wired (${row.status})`;
      console.log(`${row.name}: ${state} — ${row.configPath}`);
    }
    return result.allWired ? 0 : 1;
  }
  const plan = planSetup();
  if (plan.agents.length === 0) {
    console.log('No supported agent found (looked for Claude Code, Codex CLI, Cursor, VS Code).');
    return 1;
  }
  if (args.dryRun) console.log('Dry run — nothing will be written.');
  printSetupPreview(plan);
  if (args.dryRun) {
    printPathWarning(plan);
    return 0;
  }
  const results = applySetup(plan);
  for (const result of results) console.log(`${result.name}: ${result.action} — ${result.detail}`);
  printPathWarning(plan);
  return results.some((result) => result.action === 'unreadable') ? 1 : 0;
}

function runDoctorCommand(args) {
  // Doctor takes no options except --json: --check and --dry-run are
  // already rejected above with the setup-only message, and the rest
  // belong to the checks, not to the checkup.
  if (args.fix || args.report || args.changed != null || args.commandName || args.flakesDir || args.cacheDir || args.cwd || args.top != null || args.runs != null || args.buildCommand || args.positional.length > 0) {
    console.error('Error: doctor takes no options except --json.');
    console.error('Run with --help to see the available options.');
    return 2;
  }
  const result = runDoctor();
  if (args.json) {
    console.log(JSON.stringify({ version: VERSION, ...result }, null, 2));
    return result.passed ? 0 : 1;
  }
  // Plain [ok]/[warn]/[FAIL] tags, no emoji: the output must read the
  // same on Windows consoles as on POSIX ones.
  for (const check of result.checks) {
    const tag = check.status === 'ok' ? 'ok' : check.status === 'warn' ? 'warn' : 'FAIL';
    console.log(`[${tag}] ${check.name} — ${check.detail}`);
    if (check.fix) console.log(`      Fix: ${check.fix}`);
  }
  const noun = result.failed === 1 ? 'check' : 'checks';
  console.log(result.passed
    ? `Doctor: healthy — ${result.checks.length} checks, ${result.warnings} warning(s)`
    : `Doctor: ${result.failed} failing ${noun} — see the fixes above`);
  return result.passed ? 0 : 1;
}

function runCompletion(positional) {
  const shell = positional[0];
  if (positional.length > 1) {
    console.error(`Error: unexpected argument: ${positional[1]}`);
    console.error('Run with --help to see the available options.');
    return 2;
  }
  if (!shell) {
    console.error('Error: completion needs a shell: bash, zsh or fish');
    console.error('Run with --help to see the available options.');
    return 2;
  }
  const script = generateCompletion(shell);
  if (script === null) {
    console.error(`Error: unknown shell: ${shell} (expected one of bash, zsh, fish)`);
    console.error('Run with --help to see the available options.');
    return 2;
  }
  console.log(script);
  return 0;
}

// Write the `all` run as a Markdown report file. Returns true on
// success; on failure the reason goes to stderr and the caller exits
// 1, so a missing report is never silent.
function writeReportFile(run, top, reportPath) {
  const target = path.resolve(reportPath);
  try {
    fs.writeFileSync(target, formatReportMarkdown(run, top), 'utf8');
  } catch (error) {
    console.error(`Error: could not write report to ${target}: ${error.message}`);
    return false;
  }
  return true;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.error) {
    console.error(`Error: ${args.error}`);
    console.error('Run with --help to see the available options.');
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (args.version) {
    console.log(VERSION);
    return 0;
  }
  // The four agent/install modes are exclusive: whichever the user
  // asked for, the other three must not run — --mcp would otherwise
  // swallow `setup --mcp` and sit on stdin waiting for messages.
  const modes = [args.mcp, args.skillGenerate, args.command === 'setup', args.command === 'doctor'].filter(Boolean).length;
  if (modes > 1) {
    console.error('Error: --mcp, --skill-generate, setup and doctor cannot be combined.');
    console.error('Run with --help to see the available options.');
    return 2;
  }
  if (args.mcp) {
    await runMcpServer({ sandbox: args.sandbox, version: VERSION });
    return 0;
  }
  if (args.skillGenerate) {
    if (args.skillGlobal && args.skillProject) {
      console.error('Error: choose one of --global or --project for --skill-generate.');
      console.error('Run with --help to see the available options.');
      return 2;
    }
    const scope = args.skillGlobal ? 'global' : 'project';
    // The AGENTS.md section goes in first, so a re-run that refuses
    // to overwrite an existing SKILL.md still leaves the repo with
    // the discovery entry point — it is append-only and idempotent.
    const agents = ensureAgentsSection(scope);
    if (agents.status === 'created') console.log(`Wrote ${agents.path}`);
    else if (agents.status === 'appended') console.log(`Appended a section to ${agents.path}`);
    else if (agents.status === 'skipped') console.log(`Note: ${agents.reason}`);
    const out = generateSkill(scope);
    if (!out.created) {
      console.error(`Error: ${out.reason} — refusing to overwrite it.`);
      return 1;
    }
    console.log(`Wrote ${out.path}`);
    return 0;
  }
  if (args.skillGlobal || args.skillProject) {
    console.error('Error: --global and --project only apply to --skill-generate.');
    console.error('Run with --help to see the available options.');
    return 2;
  }
  if (args.sandbox) {
    console.error('Error: --sandbox/--root only applies to --mcp.');
    console.error('Run with --help to see the available options.');
    return 2;
  }
  if (args.report && (args.mcp || args.skillGenerate)) {
    console.error('Error: --report only applies to all.');
    console.error('Run with --help to see the available options.');
    return 2;
  }
  // --dry-run previews a write; --check only reports state. Both are
  // setup-only except --dry-run, which also pairs with --fix on
  // context/all (preview the .aiignore fix without writing it). A bare
  // --dry-run with no command and no --fix is still a usage error.
  if (args.check && args.command !== 'setup') {
    console.error('Error: --check only applies to setup.');
    console.error('Run with --help to see the available options.');
    return 2;
  }
  if (args.dryRun && args.command !== 'setup' && !args.fix) {
    console.error('Error: --dry-run only applies to setup, or with --fix (context and all).');
    console.error('Run with --help to see the available options.');
    return 2;
  }
  if (args.dryRun && args.check) {
    console.error('Error: choose one of --dry-run or --check for setup.');
    console.error('Run with --help to see the available options.');
    return 2;
  }
  if (args.command === 'setup') {
    if (args.mcp || args.skillGenerate || args.json || args.fix || args.report || args.changed != null) {
      console.error('Error: setup cannot be combined with --mcp, --skill-generate, --json, --fix, --report or --changed.');
      console.error('Run with --help to see the available options.');
      return 2;
    }
    return runSetup(args);
  }
  if (args.command === 'doctor') {
    return runDoctorCommand(args);
  }

  const command = args.command || 'all';
  // `dev-diagnosis <path>` means `dev-diagnosis all <path>`: the usage line
  // promises `[all] [path]`, so a bare positional that is an existing
  // directory is a path, not an unknown command. Anything else that is not
  // a known command still errors below, so a typo stays a typo.
  let resolvedCommand = command;
  if (!['all', 'context', 'path', 'cache', 'flakes', 'setup', 'completion'].includes(command)) {
    let isDir = false;
    try { isDir = fs.statSync(path.resolve(command)).isDirectory(); } catch { isDir = false; }
    if (isDir) {
      args.positional.unshift(command);
      resolvedCommand = 'all';
    }
  }
  if (args.fix && resolvedCommand !== 'context' && resolvedCommand !== 'all') {
    console.error('Error: --fix only applies to context (and all).');
    console.error('Run with --help to see the available options.');
    return 2;
  }
  if (args.changed != null && resolvedCommand !== 'context' && resolvedCommand !== 'all') {
    console.error('Error: --changed only applies to context (and all).');
    console.error('Run with --help to see the available options.');
    return 2;
  }
  if (args.report && resolvedCommand !== 'all') {
    console.error('Error: --report only applies to all.');
    console.error('Run with --help to see the available options.');
    return 2;
  }
  if (resolvedCommand === 'completion') {
    return runCompletion(args.positional);
  }
  try {
    if (resolvedCommand === 'context') {
      const target = args.positional[0];
      const check = runContextCheck(target, args.changed != null ? { changedRef: args.changed } : {});
      if (args.fix) {
        if (args.dryRun) {
          // Preview only: nothing is written and nothing is re-scanned,
          // so the verdict and the exit code follow the repo as it
          // stands — the fix has not landed yet.
          if (args.json) {
            previewContextFix(check);
            console.log(JSON.stringify(check.result, null, 2));
            return check.passed ? 0 : 1;
          }
          printContext(check.result, false);
          printFixPreview(previewContextFix(check), check.result.suggestions.length);
          console.log('Dry run — nothing was written. Re-run without --dry-run to apply the fix.');
          console.log(verdictLine(check.passed, check.verdict));
          return check.passed ? 0 : 1;
        }
        // A fix command reports the repo as it stands after the fix:
        // re-scan and let the verdict and the exit code follow the
        // post-fix score, or a successful fix still exits 1. In --json
        // mode the fix runs before printing so the one printed object
        // is the post-fix result; in text mode the pre-fix report
        // prints first, so a failed write still leaves the diagnosis
        // on screen.
        if (args.json) {
          const fixed = applyContextFixAndRescan(check);
          console.log(JSON.stringify(fixed.result, null, 2));
          return fixed.passed ? 0 : 1;
        }
        printContext(check.result, false);
        const fixed = applyContextFixAndRescan(check);
        printFixLine(fixed.result.fix, check.result.suggestions.length);
        console.log(`Re-scanned after fix: Score: ${fixed.result.score}/100 — ${fixed.result.status}`);
        console.log(verdictLine(fixed.passed, fixed.verdict));
        return fixed.passed ? 0 : 1;
      }
      printContext(check.result, args.json);
      if (!args.json) console.log(verdictLine(check.passed, check.verdict));
      return check.passed ? 0 : 1;
    }
    if (resolvedCommand === 'path') {
      const name = args.positional[0];
      const check = runPathCheck(name);
      printPath(check.result, args.json);
      if (!args.json) console.log(verdictLine(check.passed, check.verdict));
      return check.passed ? 0 : 1;
    }
    if (resolvedCommand === 'flakes') {
      const dir = args.positional[0];
      const check = runFlakesCheck(dir);
      printFlakes(check.result, args.top, args.json);
      if (!args.json) console.log(verdictLine(check.passed, check.verdict));
      return check.passed ? 0 : 1;
    }
    if (resolvedCommand === 'cache') {
      const check = runCacheCheck({ buildCommand: args.buildCommand, cacheDir: args.cacheDir, cwd: args.cwd, runs: args.runs });
      printCache(check.result, args.json);
      if (!args.json) console.log(verdictLine(check.passed, check.verdict));
      return check.passed ? 0 : 1;
    }
    if (resolvedCommand === 'all') {
      const target = args.positional[0];
      const root = target ? path.resolve(target) : process.cwd();
      const run = runAll({
        root,
        commandName: args.commandName,
        flakesDir: args.flakesDir,
        buildCommand: args.buildCommand,
        cacheDir: args.cacheDir,
        runs: args.runs,
        changedRef: args.changed,
      });
      const contextCheck = run.checks.context;
      const pathCheck = run.checks.path || null;
      const flakesCheck = run.checks.flakes || null;
      const cacheCheck = run.checks.cache || null;

      if (args.json) {
        if (args.fix) {
          if (args.dryRun) previewContextFix(contextCheck);
          else {
            run.applyContextFix();
            rescanContext(run);
          }
        }
        if (args.report) {
          // stderr, not stdout: the JSON on stdout stays parseable,
          // and the confirmation still reaches the user.
          if (!writeReportFile(run, args.top, args.report)) return 1;
          console.error(`Wrote report to ${path.resolve(args.report)}`);
        }
        console.log(JSON.stringify(allJson(run, args.top), null, 2));
        return run.overall ? 0 : 1;
      }

      console.log(`dev-diagnosis — ${root}`);
      console.log(section('context'));
      printContext(contextCheck.result, false);
      let contextVerdict = contextCheck;
      if (args.fix) {
        if (args.dryRun) {
          printFixPreview(previewContextFix(contextCheck), contextCheck.result.suggestions.length);
          console.log('Dry run — nothing was written. Re-run without --dry-run to apply the fix.');
        } else {
          printFixLine(run.applyContextFix(), contextCheck.result.suggestions.length);
          const fixed = rescanContext(run);
          console.log(`Re-scanned after fix: Score: ${fixed.result.score}/100 — ${fixed.result.status}`);
          contextVerdict = fixed;
        }
      }
      console.log(verdictLine(contextVerdict.passed, contextVerdict.verdict));
      if (pathCheck) {
        console.log(section('path'));
        printPath(pathCheck.result, false);
        console.log(verdictLine(pathCheck.passed, pathCheck.verdict));
      }
      if (flakesCheck) {
        console.log(section('flakes'));
        if (flakesCheck.result) printFlakes(flakesCheck.result, args.top, false);
        console.log(verdictLine(flakesCheck.passed, flakesCheck.verdict));
      }
      if (cacheCheck) {
        console.log(section('cache'));
        if (cacheCheck.result) printCache(cacheCheck.result, false);
        console.log(verdictLine(cacheCheck.passed, cacheCheck.verdict));
      }
      if (run.skipped.length > 0) {
        console.log(section('skipped'));
        for (const line of run.skipped) console.log(`  ${line}`);
      }
      console.log('');
      console.log(run.overall ? 'Overall: PASS — nothing found to fix' : 'Overall: FAIL — see the checks above');
      console.log(formatSummary(run.summary));
      // One-line star ask, interactive terminals only: it never reaches
      // --json output or a pipe, so parsers and report files stay clean.
      const star = starPromptLine(process.stdout.isTTY);
      if (star) console.log(star);
      if (args.report) {
        if (!writeReportFile(run, args.top, args.report)) return 1;
        console.log(`Wrote report to ${path.resolve(args.report)}`);
      }
      return run.overall ? 0 : 1;
    }
    console.error(`Error: unknown command: ${command}`);
    const suggestion = didYouMean(command, KNOWN_COMMANDS);
    if (suggestion) console.error(suggestion);
    console.error('Run with --help to see the available options.');
    return 2;
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`Error: ${error.message}`);
      console.error('Run with --help to see the available options.');
      return 2;
    }
    console.error(`Error: ${error.message}`);
    return 1;
  }
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
