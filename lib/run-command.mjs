/**
 * Run one command without a shell.
 *
 * The Windows trap this avoids: building a shell string and quoting it by
 * hand. On POSIX the command is run directly with argv, never through a
 * shell, so no quoting is needed at all. On Windows a bare executable name
 * such as `npm` is a `.cmd` shim, which spawnSync cannot run without a
 * shell; only in that case — and only after the direct attempt fails with
 * ENOENT — do we retry through cmd.exe, with each argument double-quoted.
 * That retry path is the one part of this file not exercised on Linux; it
 * is marked as such in the README.
 *
 * The retry has one more Windows-only wrinkle: when the name is not a
 * shim at all but a genuinely missing command, cmd.exe itself spawns
 * fine and exits 1 with "'x' is not recognized as an internal or
 * external command" on stderr. Without the check below that would come
 * back as "exit 1" instead of a spawn error, and the caller could not
 * tell a missing binary from a command that ran and failed.
 * cmdMissingCommandError() is the pure form of that check, so the
 * suite can pin it on Linux.
 */
import { spawnSync } from 'node:child_process';

/**
 * If `stderr` is cmd.exe's "not recognized" message, the command
 * never ran: return the ENOENT-style error for `command`, else null.
 */
export function cmdMissingCommandError(command, stderr) {
  if (/not recognized as an internal or external command/i.test(stderr || '')) {
    return `spawn ${command} ENOENT`;
  }
  return null;
}

export function runCommand(argv, options = {}) {
  if (!Array.isArray(argv) || argv.length === 0 || typeof argv[0] !== 'string' || argv[0] === '') {
    return { ok: false, status: null, stdout: '', stderr: '', ms: 0, error: 'no command was given' };
  }
  const cwd = options.cwd || process.cwd();
  const timeoutMs = options.timeoutMs == null ? 120000 : options.timeoutMs;
  const start = process.hrtime.bigint();
  const ms = () => Math.round(Number(process.hrtime.bigint() - start) / 1e6 * 1000) / 1000;

  let result;
  try {
    result = spawnSync(argv[0], argv.slice(1), {
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
  } catch (error) {
    return { ok: false, status: null, stdout: '', stderr: '', ms: ms(), error: error.message };
  }

  if (result.error && result.error.code === 'ENOENT' && process.platform === 'win32') {
    // Windows-only retry for .cmd/.bat shims (npm, yarn, ...).
    const quoted = argv.map((arg) => `"${String(arg).replace(/"/g, '""')}"`).join(' ');
    try {
      result = spawnSync(quoted, {
        cwd,
        encoding: 'utf8',
        timeout: timeoutMs,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: true,
      });
    } catch (error) {
      return { ok: false, status: null, stdout: '', stderr: '', ms: ms(), error: error.message };
    }
    // The retry ran cmd.exe itself, so a genuinely missing command
    // surfaces as cmd.exe exiting 1 with its "not recognized" text —
    // not as a spawn error. Translate that back, so a missing binary
    // is a spawn error on Windows exactly as on POSIX.
    const missing = cmdMissingCommandError(argv[0], result.stderr);
    if (result.error == null && result.status === 1 && missing != null) {
      return { ok: false, status: null, stdout: result.stdout || '', stderr: result.stderr || '', ms: ms(), error: missing };
    }
  }

  if (result.error) {
    return {
      ok: false,
      status: typeof result.status === 'number' ? result.status : null,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      ms: ms(),
      error: result.error.message,
    };
  }
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    ms: ms(),
    error: null,
  };
}
