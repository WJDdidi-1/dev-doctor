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
 * too. The one prompt, `diagnose_repo`, is the same workflow as a
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
  runCacheCheck, runContextCheck, runFlakesCheck, runPathCheck,
  stripCacheStdout,
} from './checks.mjs';

export const MCP_PROTOCOL_VERSION = '2024-11-05';

const TOOLS = [
  {
    name: 'diagnose_context',
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
      },
    },
  },
  {
    name: 'diagnose_path',
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
    description: 'Run every check that has what it needs and print one unified report: context always runs, path runs with a command name, flakes with a runs directory, cache with a build command. Use when starting work in an unfamiliar repo, or when you want the full health picture in one shot. Checks without their input are listed as skipped. Keywords: repo health, full diagnosis, onboarding, all checks.',
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
        top: { type: 'integer', description: 'Show only the N highest-ranked flaky tests.' },
      },
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
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: false };
}

function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function callTool(name, args, sandbox) {
  const input = args && typeof args === 'object' ? args : {};
  switch (name) {
    case 'diagnose_context': {
      const target = resolveInSandbox(sandbox, input.path, 'path');
      const check = runContextCheck(target, input.changedRef != null ? { changedRef: input.changedRef } : {});
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
      const run = runAll({
        root,
        commandName: input.command || null,
        flakesDir,
        buildCommand: Array.isArray(input.buildCommand) && input.buildCommand.length > 0 ? input.buildCommand : null,
        cacheDir,
        runs: input.runs,
        changedRef: input.changedRef != null ? input.changedRef : null,
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
          return respond(callTool(params.name, params.arguments, sandbox));
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
