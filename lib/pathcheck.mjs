/**
 * Missing-command diagnosis.
 *
 * Core lookup logic adapted from cli-path-doctor (WJDdidi-1/cli-path-doctor,
 * Apache-2.0): PATHEXT handling on Windows, broken-symlink reporting,
 * shadowed copies, and the four PATH contexts (current, login, non-login,
 * daemon-like). The npm-metadata and toolchain-metadata detail of the
 * original is reduced here to a toolchain-bin search: the check names the
 * directory a command was installed into and the fix that adds it to PATH.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const DEFAULT_PATHEXT = [
  '.COM', '.EXE', '.BAT', '.CMD', '.VBS', '.VBE', '.JS', '.JSE', '.WSF', '.WSH', '.MSC', '.PS1',
];

export function pathDelimiter(platform = process.platform) {
  return platform === 'win32' ? ';' : ':';
}

export function pathApi(platform = process.platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

export function splitPathValue(pathValue, platform = process.platform) {
  return String(pathValue == null ? '' : pathValue).split(pathDelimiter(platform));
}

export function windowsExtensions(env = process.env) {
  const raw = env && env.PATHEXT ? String(env.PATHEXT) : '';
  const extensions = raw
    .split(';')
    .map((ext) => ext.trim())
    .filter(Boolean)
    .map((ext) => (ext.startsWith('.') ? ext : `.${ext}`));
  return extensions.length > 0 ? extensions : DEFAULT_PATHEXT;
}

export function commandNames(command, platform = process.platform, env = process.env) {
  if (platform !== 'win32') return [command];
  const api = pathApi(platform);
  if (api.extname(command) !== '') return [command];
  return [command, ...windowsExtensions(env).map((ext) => `${command}${ext}`)];
}

function isWindowsExecutableExtension(candidate, env) {
  const extension = path.win32.extname(candidate).toLowerCase();
  if (!extension) return false;
  return windowsExtensions(env).some((entry) => entry.toLowerCase() === extension);
}

function executableOnPlatform(candidate, stat, platform, env) {
  if (platform === 'win32') return stat.isFile() && isWindowsExecutableExtension(candidate, env);
  if (!stat.isFile()) return false;
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function inspectFile(candidate, options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  let linkStat;
  try {
    linkStat = fs.lstatSync(candidate);
  } catch (error) {
    return { path: candidate, exists: false, broken: false, error: error.code === 'ENOENT' ? undefined : error.message };
  }
  const symlink = linkStat.isSymbolicLink();
  let linkTarget = null;
  if (symlink) {
    try { linkTarget = fs.readlinkSync(candidate); } catch { linkTarget = null; }
  }
  let stat;
  try {
    stat = fs.statSync(candidate);
  } catch (error) {
    return {
      path: candidate, exists: true, broken: Boolean(symlink && error.code === 'ENOENT'),
      symlink, linkTarget, executable: false, isFile: false, error: error.message,
    };
  }
  // Always resolve the real path, not only for symlinked files: the
  // symlink can be an intermediate directory (/bin -> usr/bin), in
  // which case the file itself is not a symlink but its real path still
  // differs from the spelling. Copies are deduplicated on real paths.
  let realPath = null;
  try { realPath = fs.realpathSync(candidate); } catch { realPath = null; }
  return {
    path: candidate, exists: true, broken: false, symlink, linkTarget, realPath,
    isFile: stat.isFile(), isDirectory: stat.isDirectory(),
    executable: executableOnPlatform(candidate, stat, platform, env), mode: stat.mode,
  };
}

function lookupInDirectories(command, directories, options) {
  const platform = options.platform;
  const env = options.env;
  const api = pathApi(platform);
  const names = commandNames(command, platform, env);
  let foundNonExecutable = null;
  let foundBroken = null;
  let checked = 0;
  for (const rawDirectory of directories) {
    const directory = rawDirectory === '' ? '.' : rawDirectory;
    checked += 1;
    for (const name of names) {
      const candidate = api.join(directory, name);
      const inspected = inspectFile(candidate, { platform, env });
      if (inspected.broken) {
        if (!foundBroken) foundBroken = inspected;
        continue;
      }
      if (!inspected.exists || !inspected.isFile) continue;
      if (inspected.executable) {
        return {
          resolved: true, path: candidate, realPath: inspected.realPath,
          symlink: inspected.symlink, linkTarget: inspected.linkTarget, mode: inspected.mode, checked,
        };
      }
      if (!foundNonExecutable) foundNonExecutable = inspected;
    }
  }
  if (foundNonExecutable) {
    return {
      resolved: false, path: null,
      reason: `found at ${foundNonExecutable.path} but it is not executable`,
      foundPath: foundNonExecutable.path, nonExecutable: foundNonExecutable, checked,
    };
  }
  if (foundBroken) {
    return {
      resolved: false, path: null,
      reason: `broken symlink ${foundBroken.path} -> ${foundBroken.linkTarget || '?'}`,
      foundPath: foundBroken.path, brokenLink: foundBroken, checked,
    };
  }
  return { resolved: false, path: null, reason: 'not found on PATH', checked };
}

export function lookupCommand(command, pathValue, options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const cwd = options.cwd || process.cwd();
  const api = pathApi(platform);
  if (typeof command !== 'string' || command.length === 0) {
    return { resolved: false, path: null, reason: 'no command was given', checked: 0 };
  }
  const looksLikePath = command.includes('/')
    || (platform === 'win32' && (command.includes('\\') || /^[A-Za-z]:/.test(command)));
  if (looksLikePath) {
    const absolute = api.isAbsolute(command) ? command : api.resolve(cwd, command);
    const names = api.extname(absolute) === '' && platform === 'win32'
      ? commandNames(absolute, platform, env) : [absolute];
    for (const candidate of names) {
      const inspected = inspectFile(candidate, { platform, env });
      if (inspected.broken) {
        return { resolved: false, path: null, reason: `broken symlink ${candidate} -> ${inspected.linkTarget || '?'}`, foundPath: candidate, brokenLink: inspected, checked: 1 };
      }
      if (inspected.exists && inspected.isFile && inspected.executable) {
        return { resolved: true, path: candidate, realPath: inspected.realPath, symlink: inspected.symlink, linkTarget: inspected.linkTarget, mode: inspected.mode, checked: 1 };
      }
      if (inspected.exists && inspected.isFile && !inspected.executable) {
        return { resolved: false, path: null, reason: `found at ${candidate} but it is not executable`, foundPath: candidate, nonExecutable: inspected, checked: 1 };
      }
    }
    return { resolved: false, path: null, reason: `${command} does not exist`, checked: names.length };
  }
  return lookupInDirectories(command, splitPathValue(pathValue, platform), { platform, env });
}

export function findCommandCopies(command, pathValue, options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const api = pathApi(platform);
  if (typeof command !== 'string' || command.length === 0) {
    return { command: null, copies: [], winner: null, shadowed: [] };
  }
  if (command.includes('/') || (platform === 'win32' && (command.includes('\\') || /^[A-Za-z]:/.test(command)))) {
    return { command, copies: [], winner: null, shadowed: [] };
  }
  const directories = splitPathValue(pathValue, platform);
  const names = commandNames(command, platform, env);
  const seen = new Set();
  const copies = [];
  for (const rawDirectory of directories) {
    const directory = rawDirectory === '' ? '.' : rawDirectory;
    for (const name of names) {
      const candidate = api.join(directory, name);
      const inspected = inspectFile(candidate, { platform, env });
      if (!inspected.exists || inspected.broken || !inspected.isFile || !inspected.executable) continue;
      // Two PATH entries can point at the same file (on Ubuntu /bin is a
      // symlink to /usr/bin, so /bin/node and /usr/bin/node are one copy).
      // Deduplicate on the real path, not the spelling.
      const key = platform === 'win32'
        ? (inspected.realPath || candidate).toLowerCase()
        : (inspected.realPath || candidate);
      if (seen.has(key)) break;
      seen.add(key);
      copies.push({
        path: candidate, directory, realPath: inspected.realPath || null,
        symlink: Boolean(inspected.symlink), linkTarget: inspected.linkTarget || null, executable: true,
      });
      break;
    }
  }
  const marked = copies.map((copy, index) => ({ ...copy, winner: index === 0, shadowed: index > 0 }));
  return { command, copies: marked, winner: marked[0] || null, shadowed: marked.slice(1) };
}

// --- PATH contexts -------------------------------------------------------

const PATH_START = '__DEV_DOCTOR_PATH__';
const PATH_END = '__DEV_DOCTOR_END__';

export function defaultDaemonPath(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const root = env.SystemRoot || env.windir || 'C:\\Windows';
    const api = path.win32;
    return [
      api.join(root, 'System32'), root,
      api.join(root, 'System32', 'Wbem'),
      api.join(root, 'System32', 'WindowsPowerShell', 'v1.0'),
    ].join(';');
  }
  return ['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin'].join(':');
}

function isUsableShell(candidate) {
  if (!candidate || typeof candidate !== 'string') return false;
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

export function resolveShell(env = process.env, platform = process.platform) {
  if (platform === 'win32') return env.ComSpec || env.COMSPEC || null;
  const configured = env.DEV_DOCTOR_SHELL || env.SHELL;
  if (isUsableShell(configured)) return configured;
  for (const fallback of ['/bin/sh', '/usr/bin/sh', '/bin/bash']) {
    if (isUsableShell(fallback)) return fallback;
  }
  return null;
}

function probeShellPath(shell, login, env, timeout) {
  if (!shell) return { ok: false, reason: 'no usable shell found' };
  // The sentinel lets us ignore anything a noisy shell profile prints.
  const script = `printf '%s%s%s' '${PATH_START}' "$PATH" '${PATH_END}'`;
  const variants = login ? [['-l', '-c', script], ['-c', script]] : [['-c', script]];
  const perVariantTimeout = Math.max(500, Math.floor(Math.max(1, timeout) / variants.length));
  const failures = [];
  for (const args of variants) {
    let result;
    try {
      result = spawnSync(shell, args, {
        encoding: 'utf8', env, timeout: perVariantTimeout, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      failures.push(error && error.message ? error.message : 'could not start shell');
      continue;
    }
    const stdout = result && result.stdout ? String(result.stdout) : '';
    const start = stdout.lastIndexOf(PATH_START);
    if (start !== -1) {
      const end = stdout.indexOf(PATH_END, start + PATH_START.length);
      if (end !== -1) {
        return { ok: true, pathValue: stdout.slice(start + PATH_START.length, end), args };
      }
    }
    if (result && result.error) failures.push(result.error.message);
    else if (result && typeof result.status === 'number' && result.status !== 0) failures.push(`shell exited with status ${result.status}`);
    else failures.push('shell did not report PATH');
  }
  return { ok: false, reason: failures[failures.length - 1] || 'shell probe failed' };
}

function contextRow(name, pathValue, source, note = null, reliable = true) {
  return { name, pathValue, source, note, reliable: Boolean(reliable) };
}

/**
 * The four PATH environments a command can be missing in. Shell probing is
 * best-effort: a failed probe keeps the row with the current PATH and a
 * note, rather than hiding the context.
 */
export function buildContexts(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const timeout = options.timeout == null ? 5000 : options.timeout;
  const currentPath = env.PATH == null ? '' : String(env.PATH);
  const contexts = [contextRow('current', currentPath, 'this process (process.env.PATH)')];

  if (platform === 'win32') {
    const loginOverride = env.DEV_DOCTOR_LOGIN_PATH;
    const nonLoginOverride = env.DEV_DOCTOR_NON_LOGIN_PATH;
    contexts.push(contextRow('login', loginOverride == null ? currentPath : String(loginOverride),
      loginOverride == null ? 'Windows process PATH (no portable login shell)' : 'DEV_DOCTOR_LOGIN_PATH', null, loginOverride != null));
    contexts.push(contextRow('non-login', nonLoginOverride == null ? currentPath : String(nonLoginOverride),
      nonLoginOverride == null ? 'Windows process PATH (no portable non-login shell)' : 'DEV_DOCTOR_NON_LOGIN_PATH', null, nonLoginOverride != null));
  } else {
    const shell = resolveShell(env, platform);
    const loginOverride = env.DEV_DOCTOR_LOGIN_PATH;
    const nonLoginOverride = env.DEV_DOCTOR_NON_LOGIN_PATH;
    if (loginOverride != null) {
      contexts.push(contextRow('login', String(loginOverride), 'DEV_DOCTOR_LOGIN_PATH'));
    } else {
      const login = probeShellPath(shell, true, env, timeout);
      contexts.push(login.ok
        ? contextRow('login', login.pathValue, `${shell} ${login.args.slice(0, -1).join(' ')}`)
        : contextRow('login', currentPath, 'this process (login shell probe failed)', login.reason, false));
    }
    if (nonLoginOverride != null) {
      contexts.push(contextRow('non-login', String(nonLoginOverride), 'DEV_DOCTOR_NON_LOGIN_PATH'));
    } else {
      const nonLogin = probeShellPath(shell, false, env, timeout);
      contexts.push(nonLogin.ok
        ? contextRow('non-login', nonLogin.pathValue, `${shell} ${nonLogin.args.slice(0, -1).join(' ')}`)
        : contextRow('non-login', currentPath, 'this process (non-login shell probe failed)', nonLogin.reason, false));
    }
  }

  const daemonOverride = env.DEV_DOCTOR_DAEMON_PATH;
  contexts.push(contextRow('daemon-like',
    daemonOverride == null ? defaultDaemonPath(platform, env) : String(daemonOverride),
    daemonOverride == null ? 'minimal system PATH (daemon/CI-like)' : 'DEV_DOCTOR_DAEMON_PATH'));
  return contexts;
}

// --- Toolchain bins ------------------------------------------------------

export function toolchainBinDirs(options = {}) {
  const platform = options.platform || process.platform;
  const home = os.homedir();
  const api = pathApi(platform);
  const candidates = platform === 'win32'
    ? [
      api.join(home, '.cargo', 'bin'),
      api.join(home, '.bun', 'bin'),
      api.join(home, 'go', 'bin'),
      api.join(home, 'AppData', 'Local', 'Programs', 'Python'),
      api.join(home, '.local', 'bin'),
    ]
    : [
      api.join(home, '.cargo', 'bin'),
      api.join(home, '.bun', 'bin'),
      api.join(home, '.volta', 'bin'),
      api.join(home, 'go', 'bin'),
      api.join(home, '.deno', 'bin'),
      api.join(home, '.local', 'bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
    ];
  return candidates.filter((dir) => {
    try { return fs.statSync(dir).isDirectory(); } catch { return false; }
  });
}

export function searchToolchainBins(command, options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const hits = [];
  for (const dir of toolchainBinDirs({ platform })) {
    const result = lookupCommand(command, dir, { platform, env });
    if (result.resolved) hits.push({ directory: dir, path: result.path });
  }
  return hits;
}

export function rcFileForShell(env = process.env) {
  const shell = String(env.SHELL || '');
  if (shell.endsWith('zsh')) return '~/.zshrc';
  if (shell.endsWith('fish')) return '~/.config/fish/config.fish';
  if (shell.endsWith('bash')) return '~/.bashrc';
  return '~/.zshrc or ~/.bashrc';
}

/** A copy-paste fix for a command found in a directory that is not on PATH. */
export function fixForDirectory(directory, platform = process.platform) {
  if (platform === 'win32') {
    return `setx PATH "%PATH%;${directory}"  (then open a new terminal)`;
  }
  return `export PATH="${directory}:$PATH"  # add to ${rcFileForShell()} to keep it`;
}
