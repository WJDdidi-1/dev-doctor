import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../scripts/support.mjs';
import { scanDirectory } from '../lib/context.mjs';
import { runAll } from '../lib/checks.mjs';
import { formatReportMarkdown } from '../lib/report.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'bin', 'dev-diagnosis.js');
const demoRepo = path.join(root, 'examples', 'demo-repo');

function makeRepo(files) {
  const dir = tempDir('dev-diagnosis-unknowns-');
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(dir, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

function run(args) {
  return spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });
}

test('unknowns: a clean scan reports no unknowns and 100% visible files', () => {
  const dir = makeRepo({ 'src/a.js': 'x\n', 'src/b.js': 'y\n' });
  const result = scanDirectory(dir);
  assert.deepEqual(result.unknowns, []);
  assert.equal(result.visibleFilesPct, 100);
  assert.equal(result.truncated, false);
});

test('unknowns: a scan stopped at the file limit counts what it skipped', () => {
  const files = {};
  for (let i = 0; i < 10; i += 1) files[`src/f${i}.js`] = 'x\n';
  const dir = makeRepo(files);
  const result = scanDirectory(dir, { maxFiles: 5 });
  assert.equal(result.truncated, true);
  assert.equal(result.files, 5);
  assert.equal(result.visibleFilesPct, 50);
  assert.equal(result.unknowns.length, 1);
  assert.equal(result.unknowns[0].kind, 'truncated');
  assert.equal(result.unknowns[0].files, 5);
  // Each file is 'x\n' — 2 bytes, so 5 skipped files are 10 bytes.
  assert.equal(result.unknowns[0].bytes, 10);
  assert.match(result.unknowns[0].detail, /5 files/);
  assert.match(result.unknowns[0].detail, /lower bound/);
});

test('unknowns: the coverage percentage rounds to one decimal', () => {
  const dir = makeRepo({ 'a.js': 'x\n', 'b.js': 'x\n', 'c.js': 'x\n' });
  const result = scanDirectory(dir, { maxFiles: 2 });
  assert.equal(result.visibleFilesPct, 66.7);
  assert.equal(result.unknowns[0].files, 1);
});

test('unknowns: a file over the secret-scan cap is an unknown, not a clean bill', () => {
  const dir = makeRepo({ 'src/a.js': 'x\n' });
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'big.bin'), 'a'.repeat(1100 * 1024));
  const result = scanDirectory(dir);
  assert.equal(result.visibleFilesPct, 100);
  const entry = result.unknowns.find((u) => u.kind === 'unscanned-for-secrets');
  assert.ok(entry, 'expected an unscanned-for-secrets unknown');
  assert.equal(entry.files, 1);
  assert.ok(entry.bytes > 1024 * 1024);
  assert.match(entry.detail, /not content-scanned for secrets/);
});

test('unknowns: a dangling symlink is its own unknown, not unreadable', () => {
  // A link whose target does not exist has nothing to read — calling
  // it "could not be read" sent a real user hunting for an unreadable
  // file that did not exist, the same lesson as the unfollowed
  // directory links (round 79). `just`'s www/man/en and www/man/zh
  // point at unbuilt docs and showed up this way on a dogfood run.
  const dir = makeRepo({ 'src/a.js': 'x\n' });
  fs.symlinkSync('does-not-exist', path.join(dir, 'dangling.js'));
  const result = scanDirectory(dir);
  assert.equal(result.visibleFilesPct, 100);
  assert.equal(result.unknowns.find((u) => u.kind === 'unreadable'), undefined);
  const entry = result.unknowns.find((u) => u.kind === 'dangling-symlink');
  assert.ok(entry, 'expected a dangling-symlink unknown');
  assert.equal(entry.files, 1);
  assert.match(entry.detail, /does not exist/);
  assert.doesNotMatch(entry.detail, /could not be read/);
  // The path is named, not just counted: a count alone sent a real
  // user hunting with `find` for a file that did not exist.
  assert.deepEqual(entry.paths, ['dangling.js']);
  assert.match(entry.detail, /dangling\.js/);
});

test('unknowns: a symlink to a directory is unfollowed, not unreadable', () => {
  // ripgrep's HomebrewFormula -> pkg/brew was reported as "1 file or
  // directory could not be read" — false: the scan chose not to
  // follow it, and everything in the repo was readable.
  const dir = makeRepo({ 'src/a.js': 'x\n' });
  fs.mkdirSync(path.join(dir, 'pkg', 'brew'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'pkg', 'brew', 'formula.rb'), 'x\n');
  fs.symlinkSync('pkg/brew', path.join(dir, 'HomebrewFormula'));
  const result = scanDirectory(dir);
  assert.equal(result.visibleFilesPct, 100);
  assert.equal(result.unknowns.find((u) => u.kind === 'unreadable'), undefined);
  const entry = result.unknowns.find((u) => u.kind === 'unfollowed-symlink');
  assert.ok(entry, 'expected an unfollowed-symlink unknown');
  assert.equal(entry.files, 1);
  assert.deepEqual(entry.paths, ['HomebrewFormula']);
  assert.match(entry.detail, /not followed/);
  assert.match(entry.detail, /HomebrewFormula/);
  assert.doesNotMatch(entry.detail, /could not be read/);
});

test('unknowns: more than five unknown paths cap the list and say how many more', () => {
  const dir = makeRepo({ 'src/a.js': 'x\n' });
  for (let i = 0; i < 7; i += 1) {
    fs.symlinkSync('does-not-exist', path.join(dir, `dangling${i}.js`));
  }
  const result = scanDirectory(dir);
  const entry = result.unknowns.find((u) => u.kind === 'dangling-symlink');
  assert.ok(entry, 'expected a dangling-symlink unknown');
  assert.equal(entry.files, 7);
  assert.equal(entry.paths.length, 5);
  assert.match(entry.detail, /… and 2 more/);
  assert.match(entry.detail, /dangling0\.js/);
});

test('unknowns: the CLI --json names the unfollowed symlink path', () => {
  const dir = makeRepo({ 'src/a.js': 'x\n' });
  fs.mkdirSync(path.join(dir, 'pkg'), { recursive: true });
  fs.symlinkSync('pkg', path.join(dir, 'link-dir'));
  const result = run(['context', dir, '--json']);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  const entry = parsed.unknowns.find((u) => u.kind === 'unfollowed-symlink');
  assert.ok(entry, 'expected an unfollowed-symlink unknown');
  assert.deepEqual(entry.paths, ['link-dir']);
});

test('unknowns: the CLI --json names the dangling symlink path', () => {
  const dir = makeRepo({ 'src/a.js': 'x\n' });
  fs.symlinkSync('does-not-exist', path.join(dir, 'dangling.js'));
  const result = run(['context', dir, '--json']);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.unknowns.find((u) => u.kind === 'unreadable'), undefined);
  const entry = parsed.unknowns.find((u) => u.kind === 'dangling-symlink');
  assert.ok(entry, 'expected a dangling-symlink unknown');
  assert.deepEqual(entry.paths, ['dangling.js']);
});

test('unknowns: a cached rescan still names the unfollowed symlink', () => {
  // The walk runs on a cached scan too, so the unknowns are
  // re-derived, not restored from the cache — verify the path
  // survives the second run.
  const dir = makeRepo({ 'src/a.js': 'x\n' });
  fs.mkdirSync(path.join(dir, 'pkg'), { recursive: true });
  fs.symlinkSync('pkg', path.join(dir, 'link-dir'));
  const first = JSON.parse(run(['context', dir, '--json', '--cache']).stdout);
  const second = JSON.parse(run(['context', dir, '--json', '--cache']).stdout);
  assert.ok(second.cached, 'expected the second run to reuse the cache');
  assert.equal(first.unknowns.length, 1);
  assert.deepEqual(first.unknowns, second.unknowns);
  assert.deepEqual(second.unknowns[0].paths, ['link-dir']);
});

test('unknowns: a symlink to a real file is counted as that file', () => {
  const dir = makeRepo({ 'src/a.js': 'x\n' });
  fs.symlinkSync('src/a.js', path.join(dir, 'link-to-a.js'));
  const result = scanDirectory(dir);
  assert.equal(result.files, 2);
  assert.deepEqual(result.unknowns, []);
});

test('unknowns: the markdown report prints the unknowns section and the coverage note', () => {
  const run = runAll({ root: demoRepo });
  run.checks.context.result.truncated = true;
  run.checks.context.result.visibleFilesPct = 50;
  run.checks.context.result.unknowns = [
    {
      kind: 'truncated',
      detail: 'scan stopped at the 100,000-file limit: 5 files (10 B) not counted — the score and totals are a lower bound',
      files: 5,
      bytes: 10,
    },
    {
      kind: 'unscanned-for-secrets',
      detail: '1 file over 1 MB (1.68 MB) was not content-scanned for secrets — a credential inside one would not be found',
      files: 1,
      bytes: 1760000,
    },
  ];
  const md = formatReportMarkdown(run);
  assert.match(md, /^### Unknowns$/m);
  assert.match(md, /score is based on 50% of files \(5 not counted\)/);
  assert.match(md, /^- scan stopped at the 100,000-file limit: 5 files/m);
  assert.match(md, /^- 1 file over 1 MB \(1\.68 MB\) was not content-scanned for secrets/m);
});

test('unknowns: the CLI --json carries unknowns and visibleFilesPct', () => {
  const dir = makeRepo({ 'src/a.js': 'x\n' });
  const result = run(['context', dir, '--json']);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(parsed.unknowns, []);
  assert.equal(parsed.visibleFilesPct, 100);
});

test('unknowns: the demo repo names its over-cap file as unscanned for secrets', () => {
  // The demo fixture's 1.68 MB data dump is over the 1 MB secret-scan
  // cap, so a real run on it must say so — the score stays 75/100
  // (the unknown costs no points), only the honesty changes.
  const result = run(['context', demoRepo, '--json']);
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.score, 75);
  const entry = parsed.unknowns.find((u) => u.kind === 'unscanned-for-secrets');
  assert.ok(entry, 'expected the demo dump to be listed as unscanned for secrets');
  assert.equal(entry.files, 1);
  assert.match(result.stdout, /"visibleFilesPct": 100/);
});
