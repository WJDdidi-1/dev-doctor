import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { tempDir } from '../scripts/support.mjs';
import { vscodeSettingsPath } from '../lib/setup.mjs';
import { fileURLToPath } from 'node:url';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'dev-diagnosis.js');

function run(args, options = {}) {
  return spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', ...options });
}

// A fake agent binary on PATH: detection only checks that the file
// exists and is executable. On Windows a bare name is never
// executable — lookup tries the PATHEXT extensions — so the fake is a
// .cmd file there. It is never run, so the content does not matter.
function writeFakeBinary(dir, name) {
  const file = process.platform === 'win32'
    ? path.join(dir, `${name}.cmd`)
    : path.join(dir, name);
  fs.writeFileSync(file, process.platform === 'win32' ? '@echo off\n' : '#!/bin/sh\nexit 0\n');
  if (process.platform !== 'win32') fs.chmodSync(file, 0o755);
}

// A HOME with a Claude config (another server, no dev-diagnosis) and a
// Codex config (no dev-diagnosis section). Cursor and VS Code have no
// config and no binary, so they are not detected.
function fixtureHome() {
  const home = tempDir('dev-diagnosis-setup-home-');
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: { other: { command: 'other', args: [] } },
  }, null, 2));
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), '[other]\nfoo = 1\n');
  return home;
}

function envFor(home, extraBin) {
  const env = { ...process.env, HOME: home };
  if (process.platform === 'win32') {
    // VS Code settings live under %APPDATA% on Windows: point it inside
    // the sandboxed home so the test never touches the real profile.
    env.APPDATA = path.join(home, 'AppData', 'Roaming');
  }
  if (extraBin) env.PATH = `${extraBin}${path.delimiter}${process.env.PATH || ''}`;
  return env;
}

test('setup: --dry-run previews the merge without writing anything', () => {
  const home = fixtureHome();
  const beforeClaude = fs.readFileSync(path.join(home, '.claude.json'), 'utf8');
  const beforeCodex = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
  const result = run(['setup', '--dry-run'], { env: envFor(home) });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Dry run — nothing will be written/);
  assert.match(result.stdout, /Claude Code \(.*\.claude\.json\)/);
  assert.match(result.stdout, /merge — will write:/);
  assert.match(result.stdout, /"dev-diagnosis"/);
  assert.match(result.stdout, /Codex CLI \(.*config\.toml\)/);
  assert.match(result.stdout, /\[mcp_servers\.dev-diagnosis\]/);
  // Nothing was written.
  assert.equal(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'), beforeClaude);
  assert.equal(fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8'), beforeCodex);
});

test('setup: writes the merge, keeps other entries, second run says already wired', () => {
  const home = fixtureHome();
  const first = run(['setup'], { env: envFor(home) });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Claude Code: merged/);
  assert.match(first.stdout, /Codex CLI: merged/);
  const claude = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
  assert.deepEqual(claude.mcpServers.other, { command: 'other', args: [] });
  assert.deepEqual(claude.mcpServers['dev-diagnosis'], { command: 'dev-diagnosis', args: ['--mcp'] });
  const codex = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
  assert.match(codex, /\[other\]\nfoo = 1\n/);
  assert.match(codex, /\[mcp_servers\.dev-diagnosis\]\ncommand = "dev-diagnosis"\nargs = \["--mcp"\]/);

  const second = run(['setup'], { env: envFor(home) });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /Claude Code: already-wired/);
  assert.match(second.stdout, /Codex CLI: already-wired/);
  // Second run changed nothing.
  assert.equal(fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8'), codex);
});

test('setup: a detected binary with no config gets a created config', () => {
  const home = tempDir('dev-diagnosis-setup-bin-');
  const fakeBin = tempDir('dev-diagnosis-setup-fakebin-');
  writeFakeBinary(fakeBin, 'cursor');
  const result = run(['setup'], { env: envFor(home, fakeBin) });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Cursor: created/);
  const created = JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8'));
  assert.deepEqual(created, { mcpServers: { 'dev-diagnosis': { command: 'dev-diagnosis', args: ['--mcp'] } } });
});

test('setup: VS Code settings merge under mcp.servers and keep other settings', () => {
  const home = tempDir('dev-diagnosis-setup-vscode-');
  const fakeBin = tempDir('dev-diagnosis-setup-vsbin-');
  writeFakeBinary(fakeBin, 'code');
  const env = envFor(home, fakeBin);
  // Seed the settings where setup looks for them on this platform:
  // ~/Library/Application Support on macOS, %APPDATA% on Windows,
  // ~/.config on Linux — the hardcoded Linux path is wrong elsewhere.
  const settingsPath = vscodeSettingsPath(home, env);
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({ 'editor.fontSize': 14 }, null, 2));
  const result = run(['setup'], { env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /VS Code: merged/);
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(settings['editor.fontSize'], 14);
  assert.deepEqual(settings.mcp.servers['dev-diagnosis'], { command: 'dev-diagnosis', args: ['--mcp'] });
});

test('setup: --check reports not wired (exit 1) then wired (exit 0)', () => {
  const home = fixtureHome();
  const before = run(['setup', '--check'], { env: envFor(home) });
  assert.equal(before.status, 1);
  assert.match(before.stdout, /Claude Code: not wired/);
  assert.match(before.stdout, /Codex CLI: not wired/);
  const wired = run(['setup'], { env: envFor(home) });
  assert.equal(wired.status, 0, wired.stderr);
  const after = run(['setup', '--check'], { env: envFor(home) });
  assert.equal(after.status, 0, after.stderr);
  assert.match(after.stdout, /Claude Code: wired/);
  assert.match(after.stdout, /Codex CLI: wired/);
});

test('setup: no supported agent found exits 1', () => {
  const home = tempDir('dev-diagnosis-setup-none-');
  // A PATH with no agent binaries at all: this machine has `codex` on
  // PATH, so the real PATH would detect it.
  const emptyBin = tempDir('dev-diagnosis-setup-emptybin-');
  const env = { ...process.env, HOME: home, PATH: emptyBin };
  const result = run(['setup'], { env });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /No supported agent found/);
  const checked = run(['setup', '--check'], { env });
  assert.equal(checked.status, 1);
  assert.match(checked.stdout, /No supported agent found/);
});

test('setup: an unreadable config is left alone and reported', () => {
  const home = tempDir('dev-diagnosis-setup-bad-');
  fs.writeFileSync(path.join(home, '.claude.json'), '{ not json');
  const fakeBin = tempDir('dev-diagnosis-setup-badbin-');
  writeFakeBinary(fakeBin, 'cursor');
  const result = run(['setup'], { env: envFor(home, fakeBin) });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Claude Code: unreadable/);
  assert.match(result.stdout, /Cursor: created/);
  assert.equal(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'), '{ not json');
});

test('setup: --dry-run and --check together is a usage error', () => {
  const result = run(['setup', '--dry-run', '--check']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /choose one of --dry-run or --check/);
});

test('setup: --dry-run without setup is a usage error', () => {
  const result = run(['--dry-run']);
  assert.equal(result.status, 2);
  // --dry-run is also valid with --fix (context and all), so the
  // message names that exception.
  assert.match(result.stderr, /--dry-run only applies to setup, or with --fix/);
});

test('setup: setup with --mcp is a usage error', () => {
  const result = run(['setup', '--mcp']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /cannot be combined/);
});
