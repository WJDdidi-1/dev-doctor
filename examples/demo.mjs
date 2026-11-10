/**
 * Demo: run dev-diagnosis against the fixture repo and print the report.
 * The output is pasted verbatim into the README, so this script prints
 * only the CLI's own output. The demo repo has real noise and a failing
 * test on purpose, so the exit code is 1; this script exits 0 so that
 * `npm run example` stays a demo, not a failing check.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'bin', 'dev-diagnosis.js');
const result = spawnSync(
  process.execPath,
  [bin, 'all', 'examples/demo-repo', '--command', 'node', '--flakes', 'examples/runs', '--', 'node', 'build.mjs'],
  { cwd: root, encoding: 'utf8' },
);
process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
