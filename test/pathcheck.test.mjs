import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { tempDir } from '../scripts/support.mjs';
import {
  buildContexts, commandNames, findCommandCopies, lookupCommand,
} from '../lib/pathcheck.mjs';

function makeBin(dir, name, content = '#!/bin/sh\nexit 0\n') {
  fs.mkdirSync(dir, { recursive: true });
  // Windows cannot execute an extensionless file: give it a .cmd suffix
  // so PATHEXT lookup can resolve it, and return the real file path.
  const fileName = process.platform === 'win32' && path.extname(name) === ''
    ? `${name}.cmd` : name;
  const full = path.join(dir, fileName);
  fs.writeFileSync(full, process.platform === 'win32' && fileName.endsWith('.cmd')
    ? '@echo off\r\nexit /b 0\r\n' : content);
  fs.chmodSync(full, 0o755);
  return full;
}

function assertSamePath(actual, expected) {
  // Windows paths are case-insensitive: PATHEXT spells the suffix .CMD
  // while the fixture file is .cmd, and both spellings are the same file.
  if (process.platform === 'win32') {
    assert.equal(String(actual).toLowerCase(), String(expected).toLowerCase());
  } else {
    assert.equal(actual, expected);
  }
}

test('lookupCommand: finds an executable on PATH', () => {
  const bin = tempDir('dev-diagnosis-bin-');
  const target = makeBin(bin, 'mytool');
  const result = lookupCommand('mytool', bin);
  assert.equal(result.resolved, true);
  assertSamePath(result.path, target);
});

test('lookupCommand: a missing command says so', () => {
  const result = lookupCommand('definitely-not-a-command-xyz', '/usr/bin:/bin');
  assert.equal(result.resolved, false);
  assert.match(result.reason, /not found on PATH/);
});

test('lookupCommand: a non-executable file is reported, not resolved', () => {
  const bin = tempDir('dev-diagnosis-bin-');
  const full = path.join(bin, 'mytool');
  fs.writeFileSync(full, 'not executable\n');
  fs.chmodSync(full, 0o644);
  const result = lookupCommand('mytool', bin);
  assert.equal(result.resolved, false);
  assert.match(result.reason, /not executable/);
});

test('lookupCommand: a broken symlink is reported as broken', () => {
  const bin = tempDir('dev-diagnosis-bin-');
  fs.symlinkSync(path.join(bin, 'missing-target'), path.join(bin, 'mytool'));
  const result = lookupCommand('mytool', bin);
  assert.equal(result.resolved, false);
  assert.match(result.reason, /broken symlink/);
});

test('findCommandCopies: the first copy wins, later copies are shadowed', () => {
  const first = tempDir('dev-diagnosis-bin1-');
  const second = tempDir('dev-diagnosis-bin2-');
  const firstTool = makeBin(first, 'mytool');
  const secondTool = makeBin(second, 'mytool');
  const delimiter = process.platform === 'win32' ? ';' : ':';
  const result = findCommandCopies('mytool', [first, second].join(delimiter));
  assert.equal(result.copies.length, 2);
  assertSamePath(result.winner.path, firstTool);
  assert.equal(result.shadowed.length, 1);
  assertSamePath(result.shadowed[0].path, secondTool);
});

test('findCommandCopies: two PATH entries pointing at the same file count once', () => {
  const real = tempDir('dev-diagnosis-bin-');
  makeBin(real, 'mytool');
  const linkDir = path.join(os.tmpdir(), `dev-diagnosis-link-${process.pid}`);
  try { fs.symlinkSync(real, linkDir, 'dir'); } catch { /* Windows without privilege: skip */ return; }
  const delimiter = process.platform === 'win32' ? ';' : ':';
  const result = findCommandCopies('mytool', [real, linkDir].join(delimiter));
  assert.equal(result.copies.length, 1);
  fs.rmSync(linkDir, { force: true });
});
test('commandNames: Windows tries PATHEXT suffixes, POSIX does not', () => {
  assert.deepEqual(commandNames('node', 'win32', { PATHEXT: '.COM;.EXE;.BAT' }), ['node', 'node.COM', 'node.EXE', 'node.BAT']);
  assert.deepEqual(commandNames('node', 'linux', {}), ['node']);
  // A name that already has an extension is not suffixed again.
  assert.deepEqual(commandNames('node.exe', 'win32', { PATHEXT: '.COM;.EXE' }), ['node.exe']);
});

test('buildContexts: always returns the four contexts', () => {
  const contexts = buildContexts();
  assert.deepEqual(contexts.map((c) => c.name), ['current', 'login', 'non-login', 'daemon-like']);
  assert.ok(contexts.every((c) => typeof c.pathValue === 'string'));
});
