/**
 * MCP server mode: `dev-diagnosis --mcp`.
 *
 * A stdio MCP server in the standard library only — the same code the
 * CLI runs, served over JSON-RPC 2.0, one message per line. Agents
 * connect with the usual config:
 *
 *   { "mcpServers": { "dev-diagnosis": { "command": "dev-diagnosis", "args": ["--mcp"] } } }
 *
 * Protocol: `initialize` (2024-11-05), `notifications/initialized`,
 * `tools/list`, `tools/call`, `prompts/list`, `prompts/get`, `ping`.
 * Each tool returns the same JSON the CLI's --json output produces, so
 * an agent that already knows the CLI output knows the tool output
 * too — and the same object is also returned as `structuredContent`,
 * the MCP structured-output channel, declared per tool by a loose
 * `outputSchema: { type: 'object' }` (the payloads are dynamic nested
 * objects with optional fields; a detailed schema would drift, and the
 * Inspector validates structuredContent against it with AJV, so it
 * would warn on any property the schema does not list). The declared
 * protocol version stays 2024-11-05: these fields are additive and
 * older clients ignore them, the same precedent as the annotations,
 * which are also a 2025-03-26 addition. The one prompt,
 * `diagnose_repo`, is the same workflow as a
 * message template: an MCP client that lets the user pick a prompt can
 * start the diagnosis without the user typing a request.
 *
 * Sandbox: `--sandbox <dir>` (alias `--root`) restricts every path the
 * tools touch to that directory. A path outside it is rejected with a
 * plain error before anything runs. The `path` tool takes only a
 * command name, so it has nothing to sandbox and is always allowed.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  UsageError, allJson, applyContextFixAndRescan, previewContextFix,
  rescanContext, runAll,
  runBinariesCheck, runCacheCheck, runContextCheck, runFlakesCheck, runPathCheck, runSecretsCheck,
  selectChecks, stripCacheStdout,
} from './checks.mjs';
import { writeSecretsBaseline } from './baseline.mjs';

export const MCP_PROTOCOL_VERSION = '2024-11-05';

const TOOLS = [
  {
    name: 'diagnose_context',
    outputSchema: { type: 'object' },
    description: 'Find the files an AI coding agent should not read in a repo: build output, lockfiles, logs and oversized files. Use when starting work in a repo, when the session feels slow, or before pasting a codebase to an agent. Returns a 0-100 score, the noise found, the token estimate, and the .aiignore suggestions that would fix it. Keywords: context window, token waste, noise, .aiignore.',
    // Annotations describe what the tool *may* do, so they are the
    // worst case: with fix: true this tool writes <path>/.aiignore
    // (destructive), and without it it only reads. The fix is
    // idempotent — a second fix with the same suggestions adds
    // nothing, because entries already present are skipped.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Repo to scan (default: the sandbox root, or the current directory without one).' },
        fix: { type: 'boolean', description: 'Write the .aiignore suggestions into <path>/.aiignore.' },
        dryRun: { type: 'boolean', description: 'With fix: only preview the .aiignore entries that would be written, without writing anything.' },
        changedRef: { type: 'string', description: 'Only scan the files git lists as changed vs this ref (empty means HEAD): the score and noise list are then the change\'s, not the repo\'s. Needs a git repo.' },
        staged: { type: 'boolean', description: 'With changedRef: only scan the files staged in the index vs the ref (git diff --cached), so an unstaged file never blocks the verdict. Untracked files are judged once they are staged.' },
        newFromRev: { type: 'string', description: 'Report only noise that is new since this ref (empty means HEAD): implies changedRef, so a file already noisy at the ref counts only its growth. Must match changedRef when both name a ref. Review items and secret findings are still reported for every changed file. Needs a git repo.' },
        minScore: { type: 'number', description: 'Pass at this context score instead of 85: a whole number from 0 to 100. A strict team passes at 95; an old repo starts at 70 and raises the bar as it cleans up. The verdict, the exit behaviour and the result\'s minScore field all follow the bar.' },
        cache: { type: 'boolean', description: 'Reuse the scan cache for unchanged files (.dev-diagnosis-cache.json at the repo root): a second scan of an unchanged tree skips re-reading files whose size and mtime still match. Opt-in; the result carries a cached field saying how many files were reused. A changed .aiignore or .gitignore, a new tool version or a corrupt cache means a full re-scan.' },
        secretsBaseline: { type: 'string', description: 'Secrets baseline file (relative to the repo): findings it already covers are suppressed, and a secret finding it does not cover fails the check even when the score passes. A missing file warns and scans unsuppressed.' },
      },
    },
  },
  {
    name: 'diagnose_binaries',
    outputSchema: { type: 'object' },
    description: 'Check up the largest native binaries in a repo (ELF, PE, Mach-O): one hardening table each — PIE, NX, RELRO, stripped, stack protector, fortify, CET/BTI-PAC, RPATH, RUNPATH — plus whole-file entropy. Use when a repo vendors native binaries, or before shipping one — it reports what the headers say and never assesses exploitability, and it always passes. Keywords: native binary, hardening, PIE, stripped, ELF, PE, Mach-O, vendored binary.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Repo to scan (default: the sandbox root, or the current directory without one).' },
        top: { type: 'integer', description: 'Show only the N largest binaries (default 5, max 20).' },
      },
    },
  },
  {
    name: 'diagnose_path',
    outputSchema: { type: 'object' },
    description: 'Diagnose why a CLI command is missing: one row per shell context (current, login, non-login, daemon-like), shadowed copies, toolchain installs, and a copy-paste fix. Use when a command works in one terminal but not another, or when an agent reports "command not found". Keywords: command not found, PATH, shell, missing binary.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command to look up, for example "node".' },
      },
      required: ['command'],
    },
  },
  {
    name: 'diagnose_cache',
    outputSchema: { type: 'object' },
    description: 'Time one build command cold (cache moved aside) and warm (cache present) and say whether the cache pays. Use when a build feels slow and you suspect the cache is not helping, or before deleting a cache directory. The cache directory is restored afterwards. Keywords: cache, build time, slow build, benchmark.',
    // Runs an arbitrary build command, which writes its normal build
    // output, and the timings differ run to run — so not read-only,
    // not idempotent, even though the cache itself is restored.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Project directory to run the build in (default: the sandbox root, or the current directory without one).' },
        command: { type: 'array', items: { type: 'string' }, description: 'Build command as an argv array, for example ["node", "build.mjs"].' },
        cacheDir: { type: 'string', description: 'Cache directory to measure (default: auto-detected under the project).' },
        runs: { type: 'integer', description: 'How many cold and warm runs to time (default 1, at most 10); the verdict uses the medians, so 3 or 5 steadies it on a jittery build.' },
      },
      required: ['command'],
    },
  },
  {
    name: 'diagnose_flakes',
    outputSchema: { type: 'object' },
    description: 'Rank flaky tests from JUnit XML across CI runs, including passed-on-retry. Use when CI goes red intermittently, or when deciding which test to fix first. Each subdirectory of the runs directory is one run; each *.xml file directly under it is a run of its own. Keywords: flaky tests, JUnit, CI failures, test retries.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Runs directory to scan.' },
        top: { type: 'integer', description: 'Show only the N highest-ranked flaky tests.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'diagnose_all',
    outputSchema: { type: 'object' },
    description: 'Run every check that has what it needs and print one unified report: context runs (unless only/skip excludes it), path runs with a command name, flakes with a runs directory, cache with a build command. Use when starting work in an unfamiliar repo, or when you want the full health picture in one shot. Checks without their input are listed as skipped. Keywords: repo health, full diagnosis, onboarding, all checks.',
    // The superset of the other tools: it can write .aiignore (fix)
    // and run a build command (cache), and the cache timings vary —
    // so not read-only and not idempotent as a whole.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Repo to diagnose (default: the sandbox root, or the current directory without one).' },
        command: { type: 'string', description: 'Command name for the path check, for example "node".' },
        flakesDir: { type: 'string', description: 'JUnit runs directory for the flakes check.' },
        buildCommand: { type: 'array', items: { type: 'string' }, description: 'Build command as an argv array for the cache check.' },
        cacheDir: { type: 'string', description: 'Cache directory to measure (default: auto-detected).' },
        runs: { type: 'integer', description: 'How many cold and warm runs to time for the cache check (default 1, at most 10); the verdict uses the medians.' },
        fix: { type: 'boolean', description: 'Write the context check .aiignore suggestions.' },
        dryRun: { type: 'boolean', description: 'With fix: only preview the .aiignore entries that would be written, without writing anything.' },
        changedRef: { type: 'string', description: 'Only scan the context check over the files git lists as changed vs this ref (empty means HEAD). Needs a git repo.' },
        staged: { type: 'boolean', description: 'With changedRef: only scan the files staged in the index vs the ref (git diff --cached).' },
        newFromRev: { type: 'string', description: 'For the context check: report only noise that is new since this ref (empty means HEAD); implies changedRef, so a file already noisy at the ref counts only its growth. Must match changedRef when both name a ref. Needs a git repo.' },
        minScore: { type: 'number', description: 'For the context check: pass at this score instead of 85 — a whole number from 0 to 100. A strict team passes at 95; an old repo starts at 70 and raises the bar as it cleans up.' },
        only: { type: 'array', items: { type: 'string' }, description: 'Run only the named checks (context, binaries, path, flakes, cache). Cannot be combined with skip.' },
        skip: { type: 'array', items: { type: 'string' }, description: 'Run every check except the named ones. The cache check runs the build twice, so skipping it is the fast path when the build itself is not under suspicion. Cannot be combined with only.' },
        cache: { type: 'boolean', description: 'Reuse the scan cache for unchanged files (.dev-diagnosis-cache.json at the repo root) in the context check: a second scan of an unchanged tree skips re-reading files whose size and mtime still match. Opt-in; the context result carries a cached field saying how many files were reused.' },
        secretsBaseline: { type: 'string', description: 'Secrets baseline file (relative to the repo) for the context check: findings it already covers are suppressed, and a secret finding it does not cover fails the check even when the score passes.' },
        top: { type: 'integer', description: 'Show only the N highest-ranked flaky tests.' },
      },
    },
  },
  {
    name: 'diagnose_secrets',
    outputSchema: { type: 'object' },
    description: 'Scan named files for secrets only: the same content-level credential shapes the context check looks for (AWS keys, GitHub tokens, private keys, Slack tokens, high-entropy values assigned to a key-like name). Use when checking a commit message file, or any file before sharing it — the message is not a file in the repo tree, so diagnose_context can never see a key pasted into it. Returns the findings (file, rule, line — never the value) and fails when one is found. Keywords: secret, credential, API key, commit message, leak, rotate.',
    // Read-only unless writeSecretsBaseline is given: then it writes
    // one baseline file recording the findings found (fingerprints
    // only, never values). Re-recording the same findings records the
    // same set, so the write is idempotent in effect.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'Files to scan, relative to the sandbox root (or the current directory without one). Directories are not scanned — scan a whole repo with diagnose_context.' },
        secretsBaseline: { type: 'string', description: 'Secrets baseline file (relative to the sandbox root): findings it already covers are suppressed. A missing file warns and scans unsuppressed.' },
        writeSecretsBaseline: { type: 'string', description: 'Write a secrets baseline file to this path recording the findings found (fingerprints only, never values), instead of judging them. Cannot be combined with secretsBaseline.' },
      },
      required: ['paths'],
    },
  },
];

/**
 * Prompts: the third MCP primitive, next to tools and resources.
 * FastMCP — the framework behind ~70% of MCP servers — treats a
 * prompt as a user-invoked reusable message template: the client
 * lists it, fills in its arguments, and injects the rendered
 * messages into the conversation. Tools are what the model calls on
 * its own; a prompt is what the user picks from a menu to start a
 * workflow. Our servers had none, so an MCP client that surfaces
 * prompts showed nothing to pick — the user had to know which tool
 * to call and with what. One prompt per server, the canonical
 * workflow, rendered as a single user message that tells the agent
 * which tools to call and what not to write without asking.
 */
const PROMPTS = [
  {
    name: 'diagnose_repo',
    description: 'Diagnose a repo before starting work in it: one full health check, the token-noise report, and the fix plan — without writing anything until the user agrees.',
    arguments: [
      { name: 'path', description: 'Repo to diagnose (default: the sandbox root, or the current directory).', required: false },
    ],
  },
];

function renderPrompt(name, args) {
  const input = args && typeof args === 'object' ? args : {};
  switch (name) {
    case 'diagnose_repo': {
      const target = typeof input.path === 'string' && input.path !== '' ? input.path : '.';
      return {
        description: PROMPTS[0].description,
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: `Diagnose the repo at "${target}" before starting work in it. Call diagnose_all with path "${target}" and report the overall score, the token-noise total, and the top noise items. If the context score is below 100, list the .aiignore entries the fix would add — call diagnose_context with fix: true and dryRun: true to preview them — and ask before writing anything: do not write .aiignore without the user agreeing.`,
          },
        }],
      };
    }
    default:
      throw new Error(`unknown prompt: ${name}`);
  }
}

/** Resolve a tool argument to an absolute path inside the sandbox, or throw. */
export function resolveInSandbox(sandbox, value, label) {
  if (value == null || value === '') return sandbox || process.cwd();
  const resolved = path.resolve(sandbox || process.cwd(), value);
  if (!sandbox) return resolved;
  const root = path.resolve(sandbox);
  if (resolved === root) return resolved;
  const rel = path.relative(root, resolved);
  if (rel.startsWith(`..${path.sep}`) || rel === '..' || path.isAbsolute(rel)) {
    throw new Error(`${label} is outside the sandbox (${sandbox}): ${value}`);
  }
  return resolved;
}

function textResult(payload) {
  // Structured output (MCP 2025-03-26): the same object the text
  // serializes is also the typed result, so a calling application
  // can read fields without parsing text. Error results never
  // carry one (errorResult below is unchanged).
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], structuredContent: payload, isError: false };
}

function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function callTool(name, args, sandbox, version) {
  const input = args && typeof args === 'object' ? args : {};
  switch (name) {
    case 'diagnose_context': {
      const target = resolveInSandbox(sandbox, input.path, 'path');
      // --new-from-rev implies --changed, so staged with it is fine.
      if (input.staged && input.changedRef == null && input.newFromRev == null) throw new UsageError('diagnose_context staged needs changedRef');
      // The baseline path is relative to the repo, like --cache-dir
      // is relative to the project — and it stays inside the sandbox.
      const secretsBaselinePath = input.secretsBaseline
        ? resolveInSandbox(sandbox, path.resolve(target, input.secretsBaseline), 'secretsBaseline')
        : null;
      const check = runContextCheck(target, {
        ...(input.changedRef != null ? { changedRef: input.changedRef, staged: input.staged === true } : {}),
        ...(input.newFromRev != null ? { newFromRev: input.newFromRev } : {}),
        ...(secretsBaselinePath != null ? { secretsBaselinePath } : {}),
        ...(input.cache === true ? { cache: true } : {}),
        ...(input.minScore != null ? { minScore: input.minScore } : {}),
      });
      // With fix, the tool answers with the post-fix scan — an agent
      // reading the result needs to know whether the repo is fixed
      // now, not what it scored before the fix. With fix + dryRun it
      // only previews: the result is the repo as it stands, with the
      // fix object marked dryRun: true, and nothing is written.
      if (input.dryRun && !input.fix) throw new UsageError('diagnose_context dryRun needs fix: true');
      if (input.fix && input.dryRun) {
        previewContextFix(check);
        return textResult(check.result);
      }
      if (input.fix) return textResult(applyContextFixAndRescan(check).result);
      return textResult(check.result);
    }
    case 'diagnose_binaries': {
      const target = resolveInSandbox(sandbox, input.path, 'path');
      return textResult(runBinariesCheck(target, { top: input.top }).result);
    }
    case 'diagnose_path': {
      if (!input.command) throw new UsageError('diagnose_path needs a command');
      return textResult(runPathCheck(input.command).result);
    }
    case 'diagnose_cache': {
      if (!Array.isArray(input.command) || input.command.length === 0) {
        throw new UsageError('diagnose_cache needs a build command array');
      }
      const root = resolveInSandbox(sandbox, input.path, 'path');
      const cacheDir = input.cacheDir
        ? resolveInSandbox(sandbox, path.resolve(root, input.cacheDir), 'cacheDir')
        : undefined;
      const check = runCacheCheck({ buildCommand: input.command, cacheDir, cwd: root, runs: input.runs });
      return textResult(stripCacheStdout(check.result));
    }
    case 'diagnose_flakes': {
      if (!input.path) throw new UsageError('diagnose_flakes needs a runs directory');
      const dir = resolveInSandbox(sandbox, input.path, 'path');
      const check = runFlakesCheck(dir);
      const out = input.top != null ? { ...check.result, tests: check.result.tests.slice(0, input.top) } : check.result;
      return textResult(out);
    }
    case 'diagnose_all': {
      const root = resolveInSandbox(sandbox, input.path, 'path');
      // flakesDir is relative to the sandbox (or cwd), like the CLI's
      // --flakes is relative to the process cwd — not to the repo root.
      const flakesDir = input.flakesDir
        ? resolveInSandbox(sandbox, input.flakesDir, 'flakesDir')
        : null;
      // cacheDir is relative to the repo root, like the CLI's
      // --cache-dir.
      const cacheDir = input.cacheDir
        ? resolveInSandbox(sandbox, path.resolve(root, input.cacheDir), 'cacheDir')
        : null;
      if (input.staged && input.changedRef == null && input.newFromRev == null) throw new UsageError('diagnose_all staged needs changedRef');
      if (input.fix) {
        const { selected } = selectChecks({ only: input.only, skip: input.skip });
        if (!selected.includes('context')) throw new UsageError('diagnose_all fix needs the context check: drop context from skip, or add it to only.');
      }
      const secretsBaselinePath = input.secretsBaseline
        ? resolveInSandbox(sandbox, path.resolve(root, input.secretsBaseline), 'secretsBaseline')
        : null;
      const run = runAll({
        root,
        commandName: input.command || null,
        flakesDir,
        buildCommand: Array.isArray(input.buildCommand) && input.buildCommand.length > 0 ? input.buildCommand : null,
        cacheDir,
        runs: input.runs,
        changedRef: input.changedRef != null ? input.changedRef : null,
        staged: input.staged === true,
        newFromRev: input.newFromRev != null ? input.newFromRev : null,
        minScore: input.minScore ?? null,
        only: input.only ?? null,
        skip: input.skip ?? null,
        ...(secretsBaselinePath != null ? { secretsBaselinePath } : {}),
        ...(input.cache === true ? { cache: true } : {}),
      });
      if (input.dryRun && !input.fix) throw new UsageError('diagnose_all dryRun needs fix: true');
      if (input.fix) {
        if (input.dryRun) previewContextFix(run.checks.context);
        else {
          run.applyContextFix();
          rescanContext(run);
        }
      }
      return textResult(allJson(run, input.top != null ? input.top : null));
    }
    case 'diagnose_secrets': {
      if (!Array.isArray(input.paths) || input.paths.length === 0) {
        throw new UsageError('diagnose_secrets needs a paths array, for example ["COMMIT_EDITMSG"]');
      }
      if (input.paths.some((file) => typeof file !== 'string' || file === '')) {
        throw new UsageError('diagnose_secrets paths must be non-empty strings');
      }
      if (input.secretsBaseline != null && input.writeSecretsBaseline != null) {
        throw new UsageError('diagnose_secrets secretsBaseline and writeSecretsBaseline cannot be combined: one reads a baseline, the other writes one.');
      }
      const files = input.paths.map((file) => resolveInSandbox(sandbox, file, 'path'));
      const secretsBaselinePath = input.secretsBaseline
        ? resolveInSandbox(sandbox, input.secretsBaseline, 'secretsBaseline')
        : null;
      const check = runSecretsCheck(files, {
        ...(secretsBaselinePath != null ? { secretsBaselinePath } : {}),
      });
      if (input.writeSecretsBaseline != null) {
        // Same contract as the CLI's write mode: refuse to record
        // over unreadable files, so a partial scan never blesses the
        // file it could not read.
        if (check.result.errors.length > 0) {
          throw new Error(`diagnose_secrets cannot write a baseline: ${check.result.errors.map((error) => `${error.file} (${error.reason})`).join(', ')}`);
        }
        const target = resolveInSandbox(sandbox, input.writeSecretsBaseline, 'writeSecretsBaseline');
        const written = writeSecretsBaseline(target, check.result.findings, { generator: `dev-diagnosis-cli ${version}` });
        return textResult({ ...check.result, secretsBaselineWritten: written });
      }
      return textResult(check.result);
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

function handleMessage(message, sandbox, version) {
  if (message == null || typeof message !== 'object' || Array.isArray(message)) {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
  }
  const { method, id, params } = message;
  // A notification (no id) never gets a response.
  const isNotification = id === undefined;
  if (typeof method !== 'string') {
    return isNotification ? null : { jsonrpc: '2.0', id: id ?? null, error: { code: -32600, message: 'Invalid Request' } };
  }
  if (method.startsWith('notifications/')) return null;
  if (isNotification) return null;

  const respond = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, text) => ({ jsonrpc: '2.0', id, error: { code, message: text } });

  try {
    switch (method) {
      case 'initialize':
        return respond({
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {}, prompts: {} },
          serverInfo: { name: 'dev-diagnosis', version },
        });
      case 'ping':
        return respond({});
      case 'tools/list':
        return respond({ tools: TOOLS });
      case 'prompts/list':
        return respond({ prompts: PROMPTS });
      case 'prompts/get': {
        if (!params || typeof params.name !== 'string') return fail(-32602, 'prompts/get needs a prompt name');
        try {
          return respond(renderPrompt(params.name, params.arguments));
        } catch (error) {
          // An unknown prompt name is a bad parameter, not a tool
          // result: the prompt itself does not exist to render.
          return fail(-32602, error.message);
        }
      }
      case 'tools/call': {
        if (!params || typeof params.name !== 'string') return fail(-32602, 'tools/call needs a tool name');
        try {
          return respond(callTool(params.name, params.arguments, sandbox, version));
        } catch (error) {
          // A tool failure is a tool result with isError, not a
          // JSON-RPC error: the call itself worked, the check did not.
          return respond(errorResult(error.message));
        }
      }
      default:
        return fail(-32601, `Method not found: ${method}`);
    }
  } catch (error) {
    return fail(-32603, error.message);
  }
}

/**
 * Serve MCP over stdio until stdin closes. One JSON message per line;
 * a malformed line gets a -32700 parse error and the server keeps going.
 * Resolves when stdin ends; never throws for a bad message.
 */
export function runMcpServer(options = {}) {
  const sandbox = options.sandbox ? path.resolve(options.sandbox) : null;
  const version = options.version || '0.2.0';
  if (sandbox) {
    let stat;
    try { stat = fs.statSync(sandbox); } catch { stat = null; }
    if (!stat || !stat.isDirectory()) throw new Error(`sandbox is not a directory: ${sandbox}`);
  }
  let buffer = '';
  const write = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (line.trim() === '') {
        newline = buffer.indexOf('\n');
        continue;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        newline = buffer.indexOf('\n');
        continue;
      }
      const response = handleMessage(message, sandbox, version);
      if (response) write(response);
      newline = buffer.indexOf('\n');
    }
  });
  return new Promise((resolve) => {
    process.stdin.on('end', resolve);
    process.stdin.resume();
  });
}
