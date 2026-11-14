import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseTape } from '../scripts/render-demo.mjs';
import { tempDir } from '../scripts/support.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tapePath = path.join(root, 'docs', 'demo.tape');
const renderDemo = path.join(root, 'scripts', 'render-demo.mjs');

function check(tape) {
  return spawnSync(process.execPath, [renderDemo, '--check', '--tape', tape], { encoding: 'utf8' });
}

test('demo tape: parses — label, output, title, 3 scenes, end card', () => {
  const tape = parseTape(fs.readFileSync(tapePath, 'utf8'));
  assert.equal(tape.label, 'v0.2.3');
  assert.equal(tape.output, 'docs/demo.gif');
  assert.equal(tape.title.lines[0], 'Your AI agent just read');
  assert.equal(tape.scenes.length, 3);
  assert.deepEqual(tape.scenes.map((s) => s.name), ['diagnosis', 'fix', 'clean']);
  for (const scene of tape.scenes) {
    assert.ok(scene.run, `scene ${scene.name} has a Run`);
    assert.ok(scene.show.length > 0, `scene ${scene.name} has Show lines`);
  }
  assert.equal(tape.end.lines[0], 'npx dev-diagnosis-cli');
});

test('demo tape: malformed tapes fail to parse', () => {
  const good = fs.readFileSync(tapePath, 'utf8');
  assert.throws(() => parseTape(good.replace('Label v0.2.3', '')), /missing Label/);
  assert.throws(() => parseTape(good.replace(/^Scene fix$/m, 'Scene')), /needs a name/);
  assert.throws(() => parseTape(`${good}\nBogus 1\n`), /unknown directive/);
});

test('demo tape: --check passes against live CLI output', () => {
  const result = check(tapePath);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /demo tape OK: 3 scenes, \d+ lines verified/);
});

test('demo tape: --check fails when a pinned line no longer matches live output', () => {
  const dir = tempDir('dev-diagnosis-demo-tape-');
  const bad = path.join(dir, 'demo.tape');
  // A format change in the CLI (e.g. the per-item token counts added
  // in 0.2.3) must fail the check until the tape is updated — that is
  // the whole point of pinning the shown lines.
  fs.writeFileSync(bad, fs.readFileSync(tapePath, 'utf8')
    .replace('Show data/export.json — large file (1.68 MB, ≈ 439k tokens)',
      'Show data/export.json — large file (1.68 MB, ≈ 999k tokens)'));
  const result = check(bad);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /scene diagnosis: live output has no line containing/);
  assert.match(result.stderr, /999k tokens/);
});
