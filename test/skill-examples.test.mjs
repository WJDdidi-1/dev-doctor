import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { SKILL_MD } from '../lib/skill.mjs';
import { tempDir } from '../scripts/support.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'bin', 'dev-diagnosis.js');

function run(args, options = {}) {
  return spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', ...options });
}

// The lines the Examples section in SKILL.md quotes. If the CLI's
// output format changes, these tests fail until the skill is updated
// — the examples must stay real output, not remembered output. The
// method is the demo tape's --check: pin the shown lines to live runs.
const EXAMPLE_1_LINES = [
  'data/export.json — large file (1.68 MB, ≈ 439k tokens)',
  'Estimated tokens wasted on this noise: ≈ 439k tokens',
  'Overall: FAIL',
];
const EXAMPLE_2_LINES = [
  'Created .aiignore with 1 entry: data/export.json',
  'Re-scanned after fix: Score: 94/100',
  'PASS  context is clean',
];

test('skill-examples: SKILL.md has an Examples section quoting the real output', () => {
  assert.match(SKILL_MD, /^## Examples$/m);
  for (const line of [...EXAMPLE_1_LINES, ...EXAMPLE_2_LINES]) {
    assert.ok(SKILL_MD.includes(line), `SKILL.md quotes "${line}"`);
  }
  // The Rules carry their why, not bare commands (skill-creator:
  // explain why, never a bare ALWAYS/NEVER).
  assert.match(SKILL_MD, /the re-run is the only proof the fix worked/);
});

test('skill-examples: example 1 — `all` on the demo repo produces the quoted lines', () => {
  const result = run([
    'all', 'examples/demo-repo', '--command', 'node',
    '--flakes', 'examples/runs', '--', 'node', 'build.mjs',
  ], { cwd: root });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  for (const line of EXAMPLE_1_LINES) {
    assert.ok(result.stdout.includes(line), `live output is missing: ${line}`);
  }
});

test('skill-examples: example 2 — `context --fix` on a staged copy produces the quoted lines', () => {
  const dir = tempDir('dev-diagnosis-skill-example-');
  const copy = path.join(dir, 'demo-repo');
  fs.cpSync(path.join(root, 'examples', 'demo-repo'), copy, { recursive: true });
  const result = run(['context', copy, '--fix'], { cwd: dir });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const line of EXAMPLE_2_LINES) {
    assert.ok(result.stdout.includes(line), `live output is missing: ${line}`);
  }
});
