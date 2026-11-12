/**
 * Shared test helpers.
 *
 * tempDir() is mkdtempSync with cleanup: the directory is removed
 * after the test that created it, so repeated suite runs cannot fill
 * /tmp (a 512 MB tmpfs on this machine — the suite used to leak ~100
 * MB per run and started failing once /tmp filled up). The `after`
 * hook runs even when the test fails, so a failing test still cleans
 * up after itself.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';

export function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
