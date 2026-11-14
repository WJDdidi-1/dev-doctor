import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tempDir } from '../scripts/support.mjs';
import { runDoctor } from '../lib/doctor.mjs';
import { fileURLToPath } from 'node:url';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'dev-diagnosis.js');
const VERSION = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version;

function run(args, options = {}) {
  return spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', ...options });
}

// A fake dev-diagnosis binary on PATH: detection only checks that the
// file exists and is executable. On Windows a bare name is never
// executable — lookup tries the PATHEXT extensions — so the fake is a
// .cmd file there. It is never run, so the content does not matter.
function writeFakeBinary(dir, name) {
  const file = process.platform === 'win32'
    ? path.join(dir, `${name}.cmd`)
    : path.join(dir, name);
  fs.writeFileSync(file, process.platform === 'win32' ? '@echo off\n' : '#!/bin/sh\nexit 0\n');
  if (process.platform !== 'win32') fs.chmodSync(file, 0o755);
}

// Env for a sandboxed run: HOME points at a temp dir (so the home
// check warns — HOME disagrees with os.homedir() — and no real config
// is ever read), PATH is exactly the given bin dir (so the command
// check sees only what the test put there).
function envFor(home, binDir, cwd) {
  const env = { ...process.env, HOME: home, PATH: binDir };
  if (process.platform === 'win32') {
    env.APPDATA = path.join(home, 'AppData', 'Roaming');
  }
  return { env, cwd };
}

function snapshot(dir) {
  return fs.readdirSync(dir).sort();
}

test('doctor: node version below the floor fails (unit level)', () => {
  const result = runDoctor({ nodeVersion: 'v16.20.0' });
  const node = result.checks.find((check) => check.id === 'node');
  assert.equal(node.status, 'fail');
  assert.match(node.fix, /Node\.js 18/);
  assert.equal(result.passed, false);
  // No exact failed count: the command check also fails in this
  // environment (dev-diagnosis is not on PATH here), and that is
  // outside what this test is about.
  const current = runDoctor({ nodeVersion: process.version });
  assert.equal(current.checks.find((check) => check.id === 'node').status, 'ok');
});

test('doctor: HOME disagreeing with os.homedir() warns (unit level)', () => {
  // On POSIX os.homedir() honours $HOME, so a mismatch can only
  // happen on Windows (where it reads the profile) — inject it.
  const result = runDoctor({ osHome: '/definitely-not-home' });
  const home = result.checks.find((check) => check.id === 'home');
  assert.equal(home.status, 'warn');
  assert.match(home.detail, /but os\.homedir\(\)=\/definitely-not-home/);
  assert.match(home.detail, /write under HOME/);
});

test('doctor: bare temp dir — command fails, nothing is written', () => {
  const home = tempDir('dev-diagnosis-doctor-home-');
  const binDir = tempDir('dev-diagnosis-doctor-bin-');
  const cwd = tempDir('dev-diagnosis-doctor-cwd-');
  const beforeHome = snapshot(home);
  const beforeCwd = snapshot(cwd);
  const result = run(['doctor'], envFor(home, binDir, cwd));
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /\[FAIL\] Command — dev-diagnosis is not on PATH/);
  assert.match(result.stdout, /Fix: Install it globally: npm install -g dev-diagnosis-cli/);
  // On POSIX os.homedir() honours $HOME, so the sandboxed HOME
  // agrees with it and the home check passes; the disagreeing case
  // (Windows, where os.homedir() reads the profile) is covered by
  // the unit-level test above.
  assert.match(result.stdout, /\[ok\] Home — home resolves to /);
  assert.match(result.stdout, /\[warn\] Skill — no SKILL\.md installed/);
  assert.match(result.stdout, /\[ok\] MCP wiring — no supported agent detected/);
  assert.match(result.stdout, /\[ok\] \.aiignore — not a git repo/);
  assert.match(result.stdout, /Doctor: 1 failing check/);
  // Read-only: doctor changes nothing.
  assert.deepEqual(snapshot(home), beforeHome);
  assert.deepEqual(snapshot(cwd), beforeCwd);
});

test('doctor: command on PATH passes, exit 0 with only warnings', () => {
  const home = tempDir('dev-diagnosis-doctor-home-');
  const binDir = tempDir('dev-diagnosis-doctor-bin-');
  writeFakeBinary(binDir, 'dev-diagnosis');
  const cwd = tempDir('dev-diagnosis-doctor-cwd-');
  const result = run(['doctor'], envFor(home, binDir, cwd));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[ok\] Command — dev-diagnosis resolves to .*dev-diagnosis/);
  assert.match(result.stdout, /Doctor: healthy/);
});

test('doctor: project skill passes the skill check', () => {
  const home = tempDir('dev-diagnosis-doctor-home-');
  const binDir = tempDir('dev-diagnosis-doctor-bin-');
  writeFakeBinary(binDir, 'dev-diagnosis');
  const cwd = tempDir('dev-diagnosis-doctor-cwd-');
  fs.mkdirSync(path.join(cwd, '.claude', 'skills', 'dev-diagnosis'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.claude', 'skills', 'dev-diagnosis', 'SKILL.md'),
    '---\nname: dev-diagnosis\ndescription: Diagnose a repo before working in it.\n---\n\n# dev-diagnosis\n');
  const result = run(['doctor'], envFor(home, binDir, cwd));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[ok\] Skill — project skill installed and valid:/);
});

test('doctor: global skill passes the skill check', () => {
  const home = tempDir('dev-diagnosis-doctor-home-');
  const binDir = tempDir('dev-diagnosis-doctor-bin-');
  writeFakeBinary(binDir, 'dev-diagnosis');
  const cwd = tempDir('dev-diagnosis-doctor-cwd-');
  fs.mkdirSync(path.join(home, '.claude', 'skills', 'dev-diagnosis'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'skills', 'dev-diagnosis', 'SKILL.md'),
    '---\nname: dev-diagnosis\ndescription: Diagnose a repo before working in it.\n---\n\n# dev-diagnosis\n');
  const result = run(['doctor'], envFor(home, binDir, cwd));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[ok\] Skill — global skill installed and valid:/);
});

test('doctor: broken skill frontmatter warns and names the problem, without failing', () => {
  const home = tempDir('dev-diagnosis-doctor-home-');
  const binDir = tempDir('dev-diagnosis-doctor-bin-');
  writeFakeBinary(binDir, 'dev-diagnosis');
  const cwd = tempDir('dev-diagnosis-doctor-cwd-');
  fs.mkdirSync(path.join(cwd, '.claude', 'skills', 'dev-diagnosis'), { recursive: true });
  // Name is uppercase and does not match the directory; description
  // contains angle brackets — both make the skill silently never
  // trigger, and doctor used to report it as installed and fine.
  fs.writeFileSync(path.join(cwd, '.claude', 'skills', 'dev-diagnosis', 'SKILL.md'),
    '---\nname: Dev-Diagnosis\ndescription: Diagnose a repo <broken>.\n---\n\n# dev-diagnosis\n');
  const result = run(['doctor'], envFor(home, binDir, cwd));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[warn\] Skill — project skill is invalid: name "Dev-Diagnosis" must be lowercase/);
  assert.match(result.stdout, /Fix: Fix the SKILL\.md frontmatter/);
});

test('doctor: MCP wiring warns when detected but not wired, passes when wired', () => {
  const home = tempDir('dev-diagnosis-doctor-home-');
  const binDir = tempDir('dev-diagnosis-doctor-bin-');
  writeFakeBinary(binDir, 'dev-diagnosis');
  const cwd = tempDir('dev-diagnosis-doctor-cwd-');
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: { other: { command: 'other', args: [] } },
  }, null, 2));
  const unwired = run(['doctor'], envFor(home, binDir, cwd));
  assert.equal(unwired.status, 0, unwired.stderr);
  assert.match(unwired.stdout, /\[warn\] MCP wiring — 1 of 1 detected agent\(s\) not wired: Claude Code/);
  assert.match(unwired.stdout, /Fix: Run dev-diagnosis setup/);
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: { other: { command: 'other', args: [] }, 'dev-diagnosis': { command: 'dev-diagnosis', args: ['--mcp'] } },
  }, null, 2));
  const wired = run(['doctor'], envFor(home, binDir, cwd));
  assert.equal(wired.status, 0, wired.stderr);
  assert.match(wired.stdout, /\[ok\] MCP wiring — 1 detected agent\(s\), all wired/);
});

test('doctor: .aiignore in a git repo warns when missing, passes when present', () => {
  const home = tempDir('dev-diagnosis-doctor-home-');
  const binDir = tempDir('dev-diagnosis-doctor-bin-');
  writeFakeBinary(binDir, 'dev-diagnosis');
  const cwd = tempDir('dev-diagnosis-doctor-cwd-');
  fs.mkdirSync(path.join(cwd, '.git'));
  const missing = run(['doctor'], envFor(home, binDir, cwd));
  assert.equal(missing.status, 0, missing.stderr);
  assert.match(missing.stdout, /\[warn\] \.aiignore — no \.aiignore in this repo/);
  assert.match(missing.stdout, /Fix: Run dev-diagnosis context --fix/);
  fs.writeFileSync(path.join(cwd, '.aiignore'), '# stub\n');
  const present = run(['doctor'], envFor(home, binDir, cwd));
  assert.equal(present.status, 0, present.stderr);
  assert.match(present.stdout, /\[ok\] \.aiignore — \.aiignore present in this repo/);
});

test('doctor: --json is machine-readable', () => {
  const home = tempDir('dev-diagnosis-doctor-home-');
  const binDir = tempDir('dev-diagnosis-doctor-bin-');
  const cwd = tempDir('dev-diagnosis-doctor-cwd-');
  const result = run(['doctor', '--json'], envFor(home, binDir, cwd));
  assert.equal(result.status, 1, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.version, VERSION);
  assert.equal(parsed.checks.length, 6);
  assert.deepEqual(parsed.checks.map((check) => check.id), ['node', 'command', 'home', 'skill', 'mcp', 'aiignore']);
  assert.equal(parsed.passed, false);
  assert.equal(parsed.failed, 1);
  assert.equal(parsed.warnings, 1);
  for (const check of parsed.checks) {
    assert.ok(['ok', 'warn', 'fail'].includes(check.status));
    assert.equal(typeof check.detail, 'string');
  }
});

test('doctor: inside the source repo the fix names the local bin', () => {
  const home = tempDir('dev-diagnosis-doctor-home-');
  const binDir = tempDir('dev-diagnosis-doctor-bin-');
  const cwd = tempDir('dev-diagnosis-doctor-cwd-');
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'dev-diagnosis-cli', version: '0.0.0' }));
  const result = run(['doctor'], envFor(home, binDir, cwd));
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /\[FAIL\] Command — dev-diagnosis is not on PATH/);
  assert.match(result.stdout, /Fix: You are inside the dev-diagnosis source repo: run node bin\/dev-diagnosis\.js here/);
});

test('doctor: HOME agreeing with os.homedir() passes the home check', () => {
  const binDir = tempDir('dev-diagnosis-doctor-bin-');
  const cwd = tempDir('dev-diagnosis-doctor-cwd-');
  // No HOME in the child env: resolveHome() falls back to
  // os.homedir(), so there is nothing to disagree with. The child
  // only reads the real home (skill, MCP configs) — doctor writes
  // nothing, so that is safe.
  const env = { ...process.env, PATH: binDir };
  delete env.HOME;
  const result = run(['doctor'], { env, cwd });
  assert.match(result.stdout, /\[ok\] Home — home resolves to /);
});

test('doctor: rejects other options', () => {
  const result = run(['doctor', '--fix']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /doctor takes no options except --json/);
  const extra = run(['doctor', 'extra']);
  assert.equal(extra.status, 2);
  assert.match(extra.stderr, /doctor takes no options except --json/);
  const check = run(['doctor', '--check']);
  assert.equal(check.status, 2);
  assert.match(check.stderr, /--check only applies to setup/);
});
