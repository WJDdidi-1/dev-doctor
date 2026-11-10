import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildContexts, commandNames, findCommandCopies, lookupCommand,
} from '../lib/pathcheck.mjs';

function makeBin(dir, name, content = '#!/bin/sh\nexit 0\n') {
  fs.mkdirSync(dir, { recursive: true });
  const full = path.join(dir, name);
  fs.writeFileSync(full, content);
  fs.chmodSync(full, 0o755);
  return full;
}

test('lookupCommand: finds an executable on PATH', () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-diagnosis-bin-'));
  const target = makeBin(bin, 'mytool');
  const result = lookupCommand('mytool', bin);
  assert.equal(result.resolved, true);
  assert.equal(result.path, target);
});

test('lookupCommand: a missing command says so', () => {
  const result = lookupCommand('definitely-not-a-command-xyz', '/usr/bin:/bin');
  assert.equal(result.resolved, false);
  assert.match(result.reason, /not found on PATH/);
});

test('lookupCommand: a non-executable file is reported, not resolved', () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-diagnosis-bin-'));
  const full = path.join(bin, 'mytool');
  fs.writeFileSync(full, 'not executable\n');
  fs.chmodSync(full, 0o644);
  const result = lookupCommand('mytool', bin);
  assert.equal(result.resolved, false);
  assert.match(result.reason, /not executable/);
});

test('lookupCommand: a broken symlink is reported as broken', () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-diagnosis-bin-'));
  fs.symlinkSync(path.join(bin, 'missing-target'), path.join(bin, 'mytool'));
  const result = lookupCommand('mytool', bin);
  assert.equal(result.resolved, false);
  assert.match(result.reason, /broken symlink/);
});

test('findCommandCopies: the first copy wins, later copies are shadowed', () => {
  const first = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-diagnosis-bin1-'));
  const second = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-diagnosis-bin2-'));
  makeBin(first, 'mytool');
  makeBin(second, 'mytool');
  const delimiter = process.platform === 'win32' ? ';' : ':';
  const result = findCommandCopies('mytool', [first, second].join(delimiter));
  assert.equal(result.copies.length, 2);
  assert.equal(result.winner.path, path.join(first, 'mytool'));
  assert.equal(result.shadowed.length, 1);
  assert.equal(result.shadowed[0].path, path.join(second, 'mytool'));
});

test('findCommandCopies: two PATH entries pointing at the same file count once', () => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-diagnosis-bin-'));
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
