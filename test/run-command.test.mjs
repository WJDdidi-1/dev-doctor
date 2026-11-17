import assert from 'node:assert/strict';
import test from 'node:test';
import { runCommand } from '../lib/run-command.mjs';

// The build-command runner, tested on its own: the cache check trusts
// it with real builds, and a hanging build must come back as a timed-out
// run, not a hung diagnosis. Coverage (vitest's method, measured with
// Node's built-in --experimental-test-coverage) showed this file at
// 61.64% lines — the reachable gaps were the invalid-argv guard and
// the spawn-error return; the Windows-only .cmd retry and the
// spawnSync-throws catch stay uncovered by design (see the module
// docstring), so they are not chased here.

test('runCommand: invalid argv returns an error, never throws', () => {
  for (const bad of [[], 'not-an-array', [''], [null], [123]]) {
    const result = runCommand(bad);
    assert.equal(result.ok, false);
    assert.equal(result.status, null);
    assert.equal(result.error, 'no command was given');
    assert.equal(result.stdout, '');
  }
});

test('runCommand: a succeeding command returns its output', () => {
  const result = runCommand([process.execPath, '-e', "process.stdout.write('hi')"]);
  assert.equal(result.ok, true);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'hi');
  assert.equal(result.error, null);
  assert.equal(typeof result.ms, 'number');
});

test('runCommand: a failing command reports its exit code, not an error', () => {
  const result = runCommand([process.execPath, '-e', 'process.exit(3)']);
  assert.equal(result.ok, false);
  assert.equal(result.status, 3);
  assert.equal(result.error, null);
});

test('runCommand: a missing binary is a spawn error, not a crash', () => {
  const result = runCommand(['definitely-not-a-real-command-xyz']);
  assert.equal(result.ok, false);
  assert.equal(result.status, null);
  assert.match(result.error, /ENOENT/);
});

test('runCommand: a command that outlives its timeout comes back as an error, fast', () => {
  const start = Date.now();
  const result = runCommand(
    [process.execPath, '-e', 'setTimeout(() => {}, 5000)'],
    { timeoutMs: 100 },
  );
  const elapsed = Date.now() - start;
  assert.equal(result.ok, false);
  assert.equal(result.status, null);
  assert.match(result.error, /ETIMEDOUT/i);
  // The 5-second sleep must not have run to completion.
  assert.ok(elapsed < 2000, `timeout took ${elapsed} ms`);
});
