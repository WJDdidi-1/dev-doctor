/**
 * One-command install: `dev-diagnosis setup`.
 *
 * Detects which agents are installed on this machine and writes the MCP
 * config that wires dev-diagnosis into each of them — Claude Code,
 * Codex CLI, Cursor and VS Code. The command always shows a preview of
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
import os from 'node:os';
import path from 'node:path';
import { lookupCommand } from './pathcheck.mjs';

export const MCP_COMMAND = 'dev-diagnosis';
export const MCP_ARGS = ['--mcp'];
export const MCP_ENTRY = { command: MCP_COMMAND, args: MCP_ARGS };

export function mcpEntryJson() {
  return { mcpServers: { 'dev-diagnosis': MCP_ENTRY } };
}

export function vscodeSettingsPath(home) {
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Code', 'User', 'settings.json');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
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
  const home = options.home || os.homedir();
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
  const home = options.home || os.homedir();
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
