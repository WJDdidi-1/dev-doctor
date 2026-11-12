import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { tempDir } from '../scripts/support.mjs';
import { fileURLToPath } from 'node:url';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const actionFile = path.join(repo, 'action.yml');
const bin = path.join(repo, 'bin', 'dev-diagnosis.js');

test('action: action.yml exists and describes the documented one-step run', () => {
  // A Windows checkout converts line endings to CRLF; normalise first
  // so the structural patterns below read the same on every platform.
  const content = fs.readFileSync(actionFile, 'utf8').replace(/\r\n/g, '\n');
  assert.match(content, /^name: dev-diagnosis$/m);
  assert.match(content, /inputs:\n\s+path:/);
  assert.match(content, /args:/);
  assert.match(content, /using: composite/);
  // The step runs the published package, and a failing check fails the
  // job because a composite `run` step exits non-zero on failure.
  assert.match(content, /npx -y dev-diagnosis-cli@latest all "\$\{\{ inputs\.path \}\}" \$\{\{ inputs\.args \}\}/);
  assert.match(content, /shell: bash/);
});

test('action: action.yml parses as YAML when a parser is available', () => {
  const probe = spawnSync('python3', ['-c', 'import yaml'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    // No YAML parser on this machine (the CLI itself has no YAML
    // dependency): the structural test above is the check.
    return;
  }
  const check = spawnSync('python3', ['-c',
    'import sys, yaml; d = yaml.safe_load(open(sys.argv[1])); '
    + 'assert d["name"] == "dev-diagnosis"; assert d["runs"]["using"] == "composite"; '
    + 'assert "path" in d["inputs"] and "args" in d["inputs"]; '
    + 'assert any("dev-diagnosis-cli" in s.get("run", "") for s in d["runs"]["steps"])',
    actionFile], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
});

test('action: the documented command form really runs and reports a summary', () => {
  // The snippet's command, with the local bin standing in for the
  // published package: same argv shape, same exit behaviour.
  // A private copy of the demo repo: the cache check moves .cache
  // aside and back, so running on the shared fixture while another
  // test does the same corrupts the cold/warm runs and flakes.
  const dir = tempDir('dev-diagnosis-action-');
  const repoCopy = path.join(dir, 'demo-repo');
  fs.cpSync(path.join(repo, 'examples', 'demo-repo'), repoCopy, { recursive: true });
  const result = spawnSync(process.execPath, [bin, 'all', repoCopy, '--command', 'node', '--flakes', 'examples/runs', '--', 'node', 'build.mjs'], { encoding: 'utf8', cwd: repo });
  assert.match(result.stdout, /^Summary: 4 checks/m);
  assert.match(result.stdout, /cache saved \d+%/);
  // The demo fixture is intentionally noisy, so the action step would
  // fail the job (exit 1) — that is the point: a failing check blocks.
  assert.equal(result.status, 1);
});
