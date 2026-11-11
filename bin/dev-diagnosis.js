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
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanDirectory, formatBytes } from '../lib/context.mjs';
import {
  buildContexts, findCommandCopies, fixForDirectory, lookupCommand,
  searchToolchainBins,
} from '../lib/pathcheck.mjs';
import { detectCacheDir, runCacheCheck } from '../lib/cache.mjs';
import { formatFlakesTable, scanRuns } from '../lib/flakes.mjs';
import { formatMs, section, verdictLine } from '../lib/report.mjs';

const VERSION = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

const USAGE = `dev-diagnosis: one diagnosis for your repo, your commands, your cache and your tests.

Usage:
  dev-diagnosis [all] [path] [--command <name>] [--flakes <dir>] [-- <build-command...>]
  dev-diagnosis context [path] [--json]
  dev-diagnosis path <command> [--json]
  dev-diagnosis cache [--cache-dir <dir>] [--cwd <dir>] -- <build-command...>
  dev-diagnosis flakes <runs-dir> [--json] [--top N]
  dev-diagnosis --help
  dev-diagnosis --version

Commands:
  all       Run every check that has what it needs and print one unified
            report. context always runs on [path] (default: current
            directory). path runs when --command is given, flakes when
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

Options:
  --json          machine-readable output (context, path, flakes, all)
  --top N         show only the N highest-ranked flaky tests
  -h, --help      show this help
  -v, --version   print the version

Exit codes: 0 = every check that ran passed; 1 = a check found something
to fix or could not run; 2 = usage error.
`;

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

function parseArgs(argv) {
  const parsed = {
    command: null, positional: [], json: false, help: false, version: false,
    commandName: null, flakesDir: null, cacheDir: null, cwd: null, top: null,
    buildCommand: null, error: null,
  };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--') {
      parsed.buildCommand = argv.slice(i + 1);
      break;
    }
    if (arg === '--json' || arg === '-j') parsed.json = true;
    else if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg === '--version' || arg === '-v') parsed.version = true;
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
    else if (arg === '--top') {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value < 1) parsed.error = '--top needs a positive integer';
      else parsed.top = value;
      i += 1;
    } else if (arg.startsWith('--top=')) {
      const value = Number(arg.slice('--top='.length));
      if (!Number.isInteger(value) || value < 1) parsed.error = '--top needs a positive integer';
      else parsed.top = value;
    } else if (arg.startsWith('-')) {
      parsed.error = `unknown option: ${arg}`;
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
  if (result.truncated) console.log('Note: scan stopped at the file limit; totals are a lower bound.');
  for (const item of result.breakdown) {
    console.log(`  ${item.label}: ${formatBytes(item.bytes)} (${item.share}%) — lost ${item.lost} of ${item.weight}`);
  }
  if (result.noise.length > 0) {
    console.log('Noise to keep away from an AI agent:');
    for (const item of result.noise.slice(0, 20)) {
      console.log(`  ${item.label} — ${item.reason} (${formatBytes(item.bytes)})`);
    }
    if (result.noise.length > 20) console.log(`  ... and ${result.noise.length - 20} more`);
  }
  if (result.review.length > 0) {
    console.log('Worth a look before sharing:');
    for (const item of result.review.slice(0, 10)) {
      console.log(`  ${item.label} — ${item.reason}`);
    }
  }
  if (result.suggestions.length > 0) {
    console.log('Fix: add these to .aiignore (or the agent\'s ignore list):');
    for (const suggestion of result.suggestions) console.log(`  ${suggestion}`);
  }
}

function runContext(target) {
  const result = scanDirectory(target || process.cwd());
  const passed = result.score >= 85;
  return { result, passed, verdict: passed ? 'context is clean' : `${result.status.toLowerCase()} (score ${result.score}/100)` };
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

function runPath(commandName) {
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
  return {
    result: { command: commandName, contexts: rows, copies, toolchainHits, fix },
    passed,
    verdict: passed ? `${commandName} resolves to ${rows[0].path}` : `${commandName} is missing in the current shell`,
  };
}

function printFlakes(result, top, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(formatFlakesTable(result, top));
}

function runFlakes(dir) {
  if (!dir) throw new UsageError('flakes needs a runs directory, for example: dev-diagnosis flakes examples/runs');
  const result = scanRuns(dir);
  const passed = result.totals.flaky === 0 && result.totals.alwaysFailing === 0;
  return {
    result,
    passed,
    verdict: passed
      ? `no flaky tests across ${result.totals.runs} runs`
      : `${result.totals.flaky} flaky, ${result.totals.alwaysFailing} always-failing across ${result.totals.runs} runs`,
  };
}

function runCache(options) {
  if (!options.buildCommand || options.buildCommand.length === 0) {
    throw new UsageError('cache needs a build command after --, for example: dev-diagnosis cache -- node build.mjs');
  }
  const result = runCacheCheck({
    root: options.cwd || process.cwd(),
    cacheDir: options.cacheDir,
    command: options.buildCommand,
  });
  const passed = result.verdict !== 'cache costs';
  return {
    result,
    passed,
    verdict: `${result.verdict}: cold ${formatMs(result.coldMs)}, warm ${formatMs(result.warmMs)} (${result.verdictDetail})`,
  };
}

function printCache(result, json) {
  if (json) {
    const { coldStdout, warmStdout, ...rest } = result;
    console.log(JSON.stringify(rest, null, 2));
    return;
  }
  console.log(`Cache dir: ${result.cacheDir}`);
  console.log(`Command: ${result.command.join(' ')}`);
  console.log(`Cold: ${formatMs(result.coldMs)}  Warm: ${formatMs(result.warmMs)}  Saved: ${formatMs(Math.max(0, result.savedMs))} (${result.savedPct}%)`);
  console.log(`Verdict: ${result.verdict} — ${result.verdictDetail}`);
}

function main(argv) {
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

  const command = args.command || 'all';
  try {
    if (command === 'context') {
      const target = args.positional[0];
      const check = runContext(target);
      printContext(check.result, args.json);
      if (!args.json) console.log(verdictLine(check.passed, check.verdict));
      return check.passed ? 0 : 1;
    }
    if (command === 'path') {
      const name = args.positional[0];
      const check = runPath(name);
      printPath(check.result, args.json);
      if (!args.json) console.log(verdictLine(check.passed, check.verdict));
      return check.passed ? 0 : 1;
    }
    if (command === 'flakes') {
      const dir = args.positional[0];
      const check = runFlakes(dir);
      printFlakes(check.result, args.top, args.json);
      if (!args.json) console.log(verdictLine(check.passed, check.verdict));
      return check.passed ? 0 : 1;
    }
    if (command === 'cache') {
      const check = runCache({ buildCommand: args.buildCommand, cacheDir: args.cacheDir, cwd: args.cwd });
      printCache(check.result, args.json);
      if (!args.json) console.log(verdictLine(check.passed, check.verdict));
      return check.passed ? 0 : 1;
    }
    if (command === 'all') {
      const target = args.positional[0];
      const root = target ? path.resolve(target) : process.cwd();
      const checks = {};
      const skipped = [];

      const contextCheck = runContext(root);
      checks.context = contextCheck;
      const pathCheck = args.commandName ? runPath(args.commandName) : null;
      if (pathCheck) checks.path = pathCheck;
      else skipped.push('path — pass --command <name>, for example: dev-diagnosis all --command node');
      let flakesCheck = null;
      if (args.flakesDir) {
        try {
          flakesCheck = runFlakes(args.flakesDir);
          checks.flakes = flakesCheck;
        } catch (error) {
          checks.flakes = { result: null, passed: false, verdict: `could not run: ${error.message}`, error: error.message };
          flakesCheck = checks.flakes;
        }
      } else {
        skipped.push('flakes — pass --flakes <runs-dir>, for example: dev-diagnosis all --flakes examples/runs');
      }
      let cacheCheck = null;
      if (args.buildCommand && args.buildCommand.length > 0) {
        try {
          cacheCheck = runCache({ buildCommand: args.buildCommand, cacheDir: args.cacheDir, cwd: root });
          checks.cache = cacheCheck;
        } catch (error) {
          if (String(error.message).includes('no cache directory found')) {
            // Nothing to measure is not a failure: report it as skipped so
            // `all` on a repo without a build cache does not end in FAIL.
            skipped.push('cache — no cache directory found in this project; pass --cache-dir <dir> to measure one');
          } else {
            checks.cache = { result: null, passed: false, verdict: `could not run: ${error.message}`, error: error.message };
            cacheCheck = checks.cache;
          }
        }
      } else {
        skipped.push('cache — add -- <build-command>, for example: dev-diagnosis all -- node build.mjs');
      }

      const overall = Object.values(checks).every((check) => check.passed);
      if (args.json) {
        const out = {
          command: 'all', root,
          checks: Object.fromEntries(Object.entries(checks).map(([key, check]) => [key, check.result])),
          skipped, overall: overall ? 'PASS' : 'FAIL',
        };
        console.log(JSON.stringify(out, null, 2));
        return overall ? 0 : 1;
      }

      console.log(`dev-diagnosis — ${root}`);
      console.log(section('context'));
      printContext(contextCheck.result, false);
      console.log(verdictLine(contextCheck.passed, contextCheck.verdict));
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
      if (skipped.length > 0) {
        console.log(section('skipped'));
        for (const line of skipped) console.log(`  ${line}`);
      }
      console.log('');
      console.log(overall ? 'Overall: PASS — nothing found to fix' : 'Overall: FAIL — see the checks above');
      return overall ? 0 : 1;
    }
    console.error(`Error: unknown command: ${command}`);
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

process.exitCode = main(process.argv.slice(2));
