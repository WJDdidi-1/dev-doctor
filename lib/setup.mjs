/**
 * One-command install: `dev-diagnosis setup`.
 *
 * Detects which agents are installed on this machine and writes the MCP
 * config that wires dev-diagnosis into each of them — Claude Code,
 * Codex CLI, Cursor, Gemini CLI and VS Code. The command always shows a preview of
 * exactly what would be written before it writes anything, and it
 * never silently overwrites:
 *
 * - a config that already mentions dev-diagnosis is reported as
 *   already wired and left alone;
 * - a config that exists without it is merged (other entries kept) and
 *   the change is reported;
 * - a missing config is created with just the dev-diagnosis entry.
 *
 * A config file that cannot be parsed is left alone and reported as an
 * error for that agent — the tool never rewrites a file it cannot read.
 * TOML (Codex) is appended to, never rewritten: only the
 * `[mcp_servers.dev-diagnosis]` section is added when it is absent.
 *
 * Detection is by config file or by the agent's CLI being on PATH, so
 * an agent with no config yet still gets one. The MCP entry itself is
 * the same shape the README documents: command `dev-diagnosis`, args
 * `["--mcp"]`. If `dev-diagnosis` is not on PATH, setup warns that the
 * agents will not be able to run it until it is installed globally.
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveHome } from './home.mjs';
import { lookupCommand } from './pathcheck.mjs';
import { runCommand } from './run-command.mjs';

export const MCP_COMMAND = 'dev-diagnosis';
export const MCP_ARGS = ['--mcp'];
export const MCP_ENTRY = { command: MCP_COMMAND, args: MCP_ARGS };

export function mcpEntryJson() {
  return { mcpServers: { 'dev-diagnosis': MCP_ENTRY } };
}

export function vscodeSettingsPath(home, env = process.env) {
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Code', 'User', 'settings.json');
  }
  if (process.platform === 'win32') {
    const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'Code', 'User', 'settings.json');
  }
  return path.join(home, '.config', 'Code', 'User', 'settings.json');
}

/**
 * The agents setup knows about. Each entry describes where its MCP
 * config lives and how it is stored. `configPath` is a function of
 * the home directory so tests can point it at a temp dir.
 */
export function agentDefs(home) {
  return [
    {
      id: 'claude-code',
      name: 'Claude Code',
      binaries: ['claude'],
      format: 'json',
      configPath: path.join(home, '.claude.json'),
      mergeKey: ['mcpServers'],
    },
    {
      id: 'codex',
      name: 'Codex CLI',
      binaries: ['codex'],
      format: 'toml',
      configPath: path.join(home, '.codex', 'config.toml'),
      mergeKey: null,
    },
    {
      id: 'cursor',
      name: 'Cursor',
      binaries: ['cursor'],
      format: 'json',
      configPath: path.join(home, '.cursor', 'mcp.json'),
      mergeKey: ['mcpServers'],
    },
    {
      id: 'gemini-cli',
      name: 'Gemini CLI',
      binaries: ['gemini'],
      format: 'json',
      configPath: path.join(home, '.gemini', 'settings.json'),
      mergeKey: ['mcpServers'],
    },
    {
      id: 'vscode',
      name: 'VS Code',
      binaries: ['code'],
      format: 'json',
      configPath: vscodeSettingsPath(home),
      mergeKey: ['mcp', 'servers'],
    },
  ];
}

function binaryOnPath(name, pathEnv) {
  return lookupCommand(name, pathEnv || process.env.PATH || '').resolved;
}

function readJsonFile(file) {
  try {
    return { data: JSON.parse(fs.readFileSync(file, 'utf8')), error: null };
  } catch (error) {
    return { data: null, error: error.message };
  }
}

function nestedGet(obj, keys) {
  let current = obj;
  for (const key of keys) {
    if (current == null || typeof current !== 'object') return undefined;
    current = current[key];
  }
  return current;
}

function nestedSet(obj, keys, value) {
  let current = obj;
  for (let i = 0; i < keys.length - 1; i += 1) {
    if (current[keys[i]] == null || typeof current[keys[i]] !== 'object') current[keys[i]] = {};
    current = current[keys[i]];
  }
  current[keys[keys.length - 1]] = value;
  return obj;
}

function tomlSection() {
  return '[mcp_servers.dev-diagnosis]\ncommand = "dev-diagnosis"\nargs = ["--mcp"]\n';
}

function hasTomlEntry(content) {
  return /^\s*\[mcp_servers\.dev-diagnosis\]/m.test(content);
}

/**
 * Detect installed agents. `options` takes { home, pathEnv } so tests
 * can point detection at a temp HOME without touching the real one.
 * An agent counts as installed when its config file exists or its CLI
 * is on PATH. Returns one row per agent: { id, name, format,
 * configPath, detected, via } where via is 'config', 'binary' or
 * 'config+binary'.
 */
export function detectAgents(options = {}) {
  const home = options.home || resolveHome();
  const pathEnv = options.pathEnv !== undefined ? options.pathEnv : process.env.PATH || '';
  return agentDefs(home).map((def) => {
    const hasConfig = fs.existsSync(def.configPath);
    const hasBinary = def.binaries.some((name) => binaryOnPath(name, pathEnv));
    const via = hasConfig && hasBinary ? 'config+binary' : hasConfig ? 'config' : hasBinary ? 'binary' : null;
    return { ...def, detected: hasConfig || hasBinary, via };
  });
}

/**
 * Work out what setup would do for each detected agent, without
 * writing anything. Returns { agents, commandOnPath } where each agent
 * row carries:
 *   status: 'already-wired' | 'merge' | 'create' | 'unreadable'
 *   preview: the exact text that would be written or added (for
 *     'merge' on JSON, the added entry; for 'create', the full file)
 *   note: human-readable explanation for unreadable configs.
 */
export function planSetup(options = {}) {
  const home = options.home || resolveHome();
  const agents = detectAgents({ home, pathEnv: options.pathEnv }).filter((agent) => agent.detected);
  const commandOnPath = binaryOnPath(MCP_COMMAND, options.pathEnv !== undefined ? options.pathEnv : process.env.PATH || '');
  const planned = agents.map((agent) => {
    const row = { id: agent.id, name: agent.name, format: agent.format, configPath: agent.configPath, mergeKey: agent.mergeKey };
    if (agent.format === 'toml') {
      if (!fs.existsSync(agent.configPath)) {
        return { ...row, status: 'create', preview: tomlSection() };
      }
      const content = fs.readFileSync(agent.configPath, 'utf8');
      if (hasTomlEntry(content)) return { ...row, status: 'already-wired', preview: null };
      return { ...row, status: 'merge', preview: tomlSection() };
    }
    // JSON formats: merge under mergeKey, never touch other entries.
    if (!fs.existsSync(agent.configPath)) {
      const data = nestedSet({}, agent.mergeKey, { 'dev-diagnosis': MCP_ENTRY });
      return { ...row, status: 'create', preview: `${JSON.stringify(data, null, 2)}\n` };
    }
    const { data, error } = readJsonFile(agent.configPath);
    if (error) {
      return { ...row, status: 'unreadable', preview: null, note: `could not parse ${agent.configPath}: ${error} — left alone` };
    }
    const existing = nestedGet(data, agent.mergeKey);
    if (existing && typeof existing === 'object' && existing['dev-diagnosis'] !== undefined) {
      return { ...row, status: 'already-wired', preview: null };
    }
    if (existing !== undefined && (existing === null || typeof existing !== 'object')) {
      return { ...row, status: 'unreadable', preview: null, note: `${agent.mergeKey.join('.')} in ${agent.configPath} is not an object — left alone` };
    }
    return { ...row, status: 'merge', preview: JSON.stringify({ 'dev-diagnosis': MCP_ENTRY }, null, 2) };
  });
  return { agents: planned, commandOnPath };
}

/**
 * Carry out a plan from planSetup(). Writes only 'merge' and 'create'
 * rows; 'already-wired' and 'unreadable' rows are reported and left
 * alone. Returns one result per agent: { id, name, configPath,
 * action: 'already-wired' | 'merged' | 'created' | 'unreadable',
 * detail }.
 */
export function applySetup(plan) {
  return plan.agents.map((row) => {
    const base = { id: row.id, name: row.name, configPath: row.configPath };
    if (row.status === 'already-wired') return { ...base, action: 'already-wired', detail: 'dev-diagnosis is already in this config' };
    if (row.status === 'unreadable') return { ...base, action: 'unreadable', detail: row.note };
    fs.mkdirSync(path.dirname(row.configPath), { recursive: true });
    if (row.format === 'toml') {
      if (row.status === 'create') {
        fs.writeFileSync(row.configPath, row.preview);
        return { ...base, action: 'created', detail: 'created with the dev-diagnosis MCP server entry' };
      }
      const existing = fs.readFileSync(row.configPath, 'utf8');
      const joined = existing.endsWith('\n') || existing === '' ? `${existing}${row.preview}` : `${existing}\n${row.preview}`;
      fs.writeFileSync(row.configPath, joined);
      return { ...base, action: 'merged', detail: 'appended [mcp_servers.dev-diagnosis] to the existing config' };
    }
    if (row.status === 'create') {
      fs.writeFileSync(row.configPath, row.preview);
      return { ...base, action: 'created', detail: 'created with the dev-diagnosis MCP server entry' };
    }
    const { data } = readJsonFile(row.configPath);
    nestedSet(data, [...row.mergeKey, 'dev-diagnosis'], MCP_ENTRY);
    fs.writeFileSync(row.configPath, `${JSON.stringify(data, null, 2)}\n`);
    return { ...base, action: 'merged', detail: 'added dev-diagnosis under the existing MCP servers, other entries kept' };
  });
}

/**
 * Report which detected agents are wired and which are not. Returns
 * { rows, detected, allWired } where each row is { id, name,
 * configPath, wired }. An agent with an unreadable config counts as
 * not wired.
 */
export function checkSetup(options = {}) {
  const plan = planSetup(options);
  const rows = plan.agents.map((row) => ({
    id: row.id,
    name: row.name,
    configPath: row.configPath,
    wired: row.status === 'already-wired',
    status: row.status,
  }));
  return {
    rows,
    detected: rows.length,
    allWired: rows.length > 0 && rows.every((row) => row.wired),
  };
}

// ---------------------------------------------------------------------------
// Native git hooks (`setup --hooks`) — husky's method: the hook is a
// file, not a config entry. The README already documents installing
// these two hook commands by hand under husky (which needs husky
// itself); `setup --hooks` does the same thing with no second tool:
// it writes the two versioned hook files into `.githooks/` and points
// git at them with `core.hooksPath`, so every clone gets the
// enforcement once the files are committed. The hook commands are the
// exact ones the README documents — `npx dev-diagnosis-cli ...` — so
// the README, the installed hook and the test can never disagree
// about what a commit runs. Install the CLI as a devDependency and
// npx resolves it locally instead of downloading it on every commit.
//
// The installer never silently overwrites: a `core.hooksPath` that
// already points elsewhere, or a hook file that is not ours, stops
// the install with a message naming it. A hook file that carries the
// marker is ours and is left alone; a missing one is written and an
// unset path is set, so a partial install completes instead of
// erroring.
// ---------------------------------------------------------------------------

export const HOOKS_DIR = '.githooks';
export const HOOK_MARKER = '# Managed by dev-diagnosis';

/**
 * The exact command each hook runs. These are the commands the
 * README's Husky section documents; keep them in lockstep with it.
 */
export const HOOK_COMMANDS = {
  'pre-commit': 'npx dev-diagnosis-cli context --changed --staged',
  'commit-msg': 'npx dev-diagnosis-cli secrets "$1"',
};

/**
 * The full text of the hook file `name` ('pre-commit' or
 * 'commit-msg'). The marker line is what planHooks uses to recognise
 * a file it installed, so it is never dropped.
 */
export function hookScript(name) {
  const command = HOOK_COMMANDS[name];
  const why = name === 'pre-commit'
    ? 'Blocks a commit that stages context noise an AI agent should not read.'
    : 'Blocks a commit whose message contains a possible secret (the value is never printed).';
  return `#!/bin/sh
${HOOK_MARKER} — installed by \`dev-diagnosis setup --hooks\`.
# ${why}
# Runs \`${command}\`. To remove: delete this file and run
# \`git config --unset core.hooksPath\` (only if nothing else uses it).
${command}
`;
}

/**
 * Work out what `setup --hooks` would do in `options.cwd` (default:
 * the current directory), without writing anything. `options.run`
 * injects the git runner (default: runCommand) so tests can drive
 * the status logic without a repo. Returns a plan with:
 *   status: 'create' | 'already-installed' | 'not-a-repo' |
 *     'foreign-hooks-path' | 'foreign-hook'
 *   repoRoot, hooksDir, hooksPath, files: [{ name, path, exists, ours }]
 *   steps: { write: [hook names to write], setConfig: bool } (create only)
 *   note: human-readable explanation for the refusing statuses.
 */
export function planHooks(options = {}) {
  const cwd = options.cwd || process.cwd();
  const run = options.run || runCommand;
  const base = { repoRoot: null, hooksDir: null, hooksPath: null, files: [], steps: { write: [], setConfig: false }, note: null };
  const root = run(['git', 'rev-parse', '--show-toplevel'], { cwd });
  if (!root.ok) {
    return { ...base, status: 'not-a-repo', note: 'not a git repository — run setup --hooks inside a repo' };
  }
  const repoRoot = root.stdout.trim();
  const hooksDir = path.join(repoRoot, HOOKS_DIR);
  const config = run(['git', 'config', '--get', 'core.hooksPath'], { cwd: repoRoot });
  // git config --get exits 1 with empty stdout when the key is unset;
  // that is "no hooks path", not an error.
  const hooksPath = config.stdout.trim() || null;
  const files = Object.keys(HOOK_COMMANDS).map((name) => {
    const file = path.join(hooksDir, name);
    const exists = fs.existsSync(file);
    const content = exists ? fs.readFileSync(file, 'utf8') : null;
    return { name, path: file, exists, ours: content != null && content.includes(HOOK_MARKER) };
  });
  const plan = { ...base, repoRoot, hooksDir, hooksPath, files };
  const hooksPathIsOurs = hooksPath != null && path.resolve(repoRoot, hooksPath) === path.resolve(repoRoot, HOOKS_DIR);
  if (hooksPath != null && !hooksPathIsOurs) {
    return { ...plan, status: 'foreign-hooks-path', note: `core.hooksPath is already set to '${hooksPath}' — unset it (git config --unset core.hooksPath) or install the hooks there yourself` };
  }
  const foreign = files.find((file) => file.exists && !file.ours);
  if (foreign) {
    return { ...plan, status: 'foreign-hook', note: `${path.join(HOOKS_DIR, foreign.name)} already exists and is not managed by dev-diagnosis — move it aside first` };
  }
  const write = files.filter((file) => !file.exists).map((file) => file.name);
  const setConfig = !hooksPathIsOurs;
  if (write.length === 0 && !setConfig) {
    return { ...plan, status: 'already-installed', note: null };
  }
  return { ...plan, status: 'create', steps: { write, setConfig } };
}

/**
 * Carry out a 'create' plan from planHooks(). Writes the missing hook
 * files (mode 755) and sets `core.hooksPath` when needed. Returns
 * { action, detail }. Any other status is reported, not applied.
 */
export function applyHooks(plan, options = {}) {
  const run = options.run || runCommand;
  if (plan.status !== 'create') return { action: plan.status, detail: plan.note };
  fs.mkdirSync(plan.hooksDir, { recursive: true });
  for (const name of plan.steps.write) {
    const file = path.join(plan.hooksDir, name);
    fs.writeFileSync(file, hookScript(name), { mode: 0o755 });
    // writeFileSync's mode is masked by the umask, so a strict umask
    // (027) would leave the hook non-executable for the group and git
    // would refuse to run it — set the bits explicitly.
    fs.chmodSync(file, 0o755);
  }
  if (plan.steps.setConfig) {
    const result = run(['git', 'config', 'core.hooksPath', HOOKS_DIR], { cwd: plan.repoRoot });
    if (!result.ok) {
      return { action: 'config-failed', detail: `wrote the hook files but could not set core.hooksPath: ${result.stderr.trim() || result.error || 'git config failed'}` };
    }
  }
  const written = plan.steps.write.length > 0 ? `wrote ${plan.steps.write.map((name) => `${HOOKS_DIR}/${name}`).join(', ')}` : 'hook files already in place';
  const configured = plan.steps.setConfig ? ' and set core.hooksPath to .githooks' : '';
  return { action: 'installed', detail: `${written}${configured} — commit .githooks/ so every clone gets the hooks` };
}

/**
 * Report whether the native git hooks are installed in
 * `options.cwd`. Returns { status, installed, repoRoot, hooksPath,
 * note }.
 */
export function checkHooks(options = {}) {
  const plan = planHooks(options);
  return {
    status: plan.status,
    installed: plan.status === 'already-installed',
    repoRoot: plan.repoRoot,
    hooksPath: plan.hooksPath,
    note: plan.note,
  };
}
