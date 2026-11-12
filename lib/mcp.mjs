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
 * `tools/list`, `tools/call`, `ping`. Each tool returns the same JSON
 * the CLI's --json output produces, so an agent that already knows the
 * CLI output knows the tool output too.
 *
 * Sandbox: `--sandbox <dir>` (alias `--root`) restricts every path the
 * tools touch to that directory. A path outside it is rejected with a
 * plain error before anything runs. The `path` tool takes only a
 * command name, so it has nothing to sandbox and is always allowed.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  UsageError, allJson, applyContextFixAndRescan, rescanContext, runAll,
  runCacheCheck, runContextCheck, runFlakesCheck, runPathCheck,
  stripCacheStdout,
} from './checks.mjs';

export const MCP_PROTOCOL_VERSION = '2024-11-05';

const TOOLS = [
  {
    name: 'diagnose_context',
    description: 'Find the files an AI coding agent should not read in a repo: build output, lockfiles, logs and oversized files. Returns a 0-100 score, the noise found, the token estimate, and the .aiignore suggestions that would fix it.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Repo to scan (default: the sandbox root, or the current directory without one).' },
        fix: { type: 'boolean', description: 'Write the .aiignore suggestions into <path>/.aiignore.' },
      },
    },
  },
  {
    name: 'diagnose_path',
    description: 'Diagnose why a CLI command is missing: one row per shell context (current, login, non-login, daemon-like), shadowed copies, toolchain installs, and a copy-paste fix.',
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
    description: 'Time one build command cold (cache moved aside) and warm (cache present) and say whether the cache pays. The cache directory is restored afterwards.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Project directory to run the build in (default: the sandbox root, or the current directory without one).' },
        command: { type: 'array', items: { type: 'string' }, description: 'Build command as an argv array, for example ["node", "build.mjs"].' },
        cacheDir: { type: 'string', description: 'Cache directory to measure (default: auto-detected under the project).' },
      },
      required: ['command'],
    },
  },
  {
    name: 'diagnose_flakes',
    description: 'Rank flaky tests from JUnit XML across CI runs, including passed-on-retry. Each subdirectory of the runs directory is one run; each *.xml file directly under it is a run of its own.',
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
    description: 'Run every check that has what it needs and print one unified report: context always runs, path runs with a command name, flakes with a runs directory, cache with a build command. Checks without their input are listed as skipped.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Repo to diagnose (default: the sandbox root, or the current directory without one).' },
        command: { type: 'string', description: 'Command name for the path check, for example "node".' },
        flakesDir: { type: 'string', description: 'JUnit runs directory for the flakes check.' },
        buildCommand: { type: 'array', items: { type: 'string' }, description: 'Build command as an argv array for the cache check.' },
        cacheDir: { type: 'string', description: 'Cache directory to measure (default: auto-detected).' },
        fix: { type: 'boolean', description: 'Write the context check .aiignore suggestions.' },
        top: { type: 'integer', description: 'Show only the N highest-ranked flaky tests.' },
      },
    },
  },
];

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
      const check = runContextCheck(target);
      // With fix, the tool answers with the post-fix scan — an agent
      // reading the result needs to know whether the repo is fixed
      // now, not what it scored before the fix.
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
      const check = runCacheCheck({ buildCommand: input.command, cacheDir, cwd: root });
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
      });
      if (input.fix) {
        run.applyContextFix();
        rescanContext(run);
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
          capabilities: { tools: {} },
          serverInfo: { name: 'dev-diagnosis', version },
        });
      case 'ping':
        return respond({});
      case 'tools/list':
        return respond({ tools: TOOLS });
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
