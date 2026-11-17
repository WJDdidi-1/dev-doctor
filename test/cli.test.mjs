import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { git, gitCommit, hasGit, makeGitRepo, tempDir, writeRepoFile } from '../scripts/support.mjs';
import { estimateTokens, formatBytes, AIIGNORE_HEADER } from '../lib/context.mjs';
import { formatTokens, starPromptLine } from '../lib/report.mjs';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgVersion = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;

// The demo fixture's listed noise is its one large file. Its byte count
// is the source of the token estimate and the summary's noise size —
// read it from the fixture instead of hardcoding a number, so the
// assertions hold on a Windows checkout too (CRLF conversion grows the
// file by one byte per line).
const demoNoiseFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'demo-repo', 'data', 'export.json');
const demoNoiseBytes = fs.statSync(demoNoiseFile).size;

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'dev-diagnosis.js');
const demoRepo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'demo-repo');
const demoRuns = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'runs');

function run(args, options = {}) {
  return spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', ...options });
}

// Tests that run a build against the demo repo get a private copy of
// it. The cache check moves the repo's .cache aside and back, so two
// of them running in parallel on the shared fixture (node --test runs
// test files concurrently) corrupt each other's cold/warm runs and
// flake. Read-only checks keep using the shared fixture.
function freshDemoRepo() {
  const dir = tempDir('dev-diagnosis-demo-');
  const copy = path.join(dir, 'demo-repo');
  fs.cpSync(demoRepo, copy, { recursive: true });
  return copy;
}

test('cli: starPromptLine only fires on a TTY', () => {
  assert.equal(starPromptLine(true), 'If this saved you time, star dev-diagnosis: https://github.com/WJDdidi-1/dev-doctor');
  assert.equal(starPromptLine(false), null);
  assert.equal(starPromptLine(undefined), null);
});

test('cli: piped all output never carries the star prompt', () => {
  const result = run(['all', demoRepo]);
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /star dev-diagnosis/);
});

test('cli: all --json never carries the star prompt', () => {
  const result = run(['all', demoRepo, '--json']);
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /star dev-diagnosis/);
  JSON.parse(result.stdout); // still valid JSON with no prompt in it
});

// Run the CLI with stdout on a pty, so process.stdout.isTTY is true in
// the child. `script` is the obvious tool but its behaviour differs per
// platform: on macOS it exits as soon as its stdin hits EOF, and under
// a test harness stdin is already EOF, so the child is killed before it
// prints anything (empty output, exit 1). python3's pty.spawn is the
// same on Linux and macOS, waits for the child, and relays its output;
// pty.spawn returns the raw wait status, so convert it with
// os.waitstatus_to_exitcode. Windows has no pty need — the test is
// skipped there.
const PTY_CODE = 'import os,pty,sys; sys.exit(os.waitstatus_to_exitcode(pty.spawn(sys.argv[1:])))';
function runOnTty(args) {
  if (spawnSync('which', ['python3']).status !== 0) return null;
  return spawnSync('python3', ['-c', PTY_CODE, process.execPath, bin, ...args], { encoding: 'utf8' });
}

test('cli: all on a TTY prints the star prompt after the summary', { skip: process.platform === 'win32' }, (t) => {
  const result = runOnTty(['all', demoRepo]);
  if (result === null) {
    t.skip('no python3 for a pty');
    return;
  }
  assert.equal(result.status, 1); // the demo repo still FAILs; the prompt does not change the exit code
  assert.match(result.stdout, /If this saved you time, star dev-diagnosis: https:\/\/github\.com\/WJDdidi-1\/dev-doctor/);
});

test('cli: all --report writes a Markdown report file', () => {
  const dir = tempDir('dev-diagnosis-report-');
  const report = path.join(dir, 'report.md');
  const result = run(['all', demoRepo, '--report', report]);
  assert.equal(result.status, 1); // the demo repo still FAILs; the report does not change the exit code
  assert.match(result.stdout, new RegExp(`Wrote report to ${report.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  const md = fs.readFileSync(report, 'utf8');
  assert.match(md, /^# dev-diagnosis report$/m);
  assert.match(md, /Score: \d+\/100/);
  assert.match(md, /data\/export\.json/);
  assert.match(md, /^## skipped$/m);
});

test('cli: all --report --json keeps stdout parseable and notes the report on stderr', () => {
  const dir = tempDir('dev-diagnosis-report-');
  const report = path.join(dir, 'report.md');
  const result = run(['all', demoRepo, '--json', '--report', report]);
  assert.equal(result.status, 1);
  JSON.parse(result.stdout); // still valid JSON with no report line in it
  assert.match(result.stderr, /Wrote report to/);
  assert.ok(fs.existsSync(report));
  assert.match(fs.readFileSync(report, 'utf8'), /^# dev-diagnosis report$/m);
});

test('cli: all writes the Step Summary when GITHUB_STEP_SUMMARY is set, without changing the exit code', () => {
  const dir = tempDir('dev-diagnosis-summary-');
  const summary = path.join(dir, 'summary.md');
  const result = run(['all', demoRepo], { env: { ...process.env, GITHUB_STEP_SUMMARY: summary } });
  assert.equal(result.status, 1); // the demo repo still FAILs; the summary does not change the exit code
  const md = fs.readFileSync(summary, 'utf8');
  assert.match(md, /^# dev-diagnosis report$/m);
  assert.match(md, /^Overall: FAIL — /m);
  assert.match(md, /data\/export\.json/);
});

test('cli: all --json writes the Step Summary too, and stdout stays parseable', () => {
  const dir = tempDir('dev-diagnosis-summary-');
  const summary = path.join(dir, 'summary.md');
  const result = run(['all', demoRepo, '--json'], { env: { ...process.env, GITHUB_STEP_SUMMARY: summary } });
  assert.equal(result.status, 1);
  JSON.parse(result.stdout); // still valid JSON with no summary line in it
  assert.match(fs.readFileSync(summary, 'utf8'), /^# dev-diagnosis report$/m);
});

test('cli: all with an unwritable Step Summary warns and keeps the verdict exit code', () => {
  const dir = tempDir('dev-diagnosis-summary-');
  const summary = path.join(dir, 'no-such-dir', 'summary.md');
  const result = run(['all', demoRepo], { env: { ...process.env, GITHUB_STEP_SUMMARY: summary } });
  assert.equal(result.status, 1); // the demo repo FAILs; the unwritable summary does not add a failure
  assert.match(result.stderr, /Warning: could not write the step summary/);
});

test('cli: --report without a value is a usage error', () => {
  const result = run(['all', demoRepo, '--report']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--report needs a value/);
});

test('cli: --report with a single check is a usage error', () => {
  const result = run(['context', demoRepo, '--report', 'report.md']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--report only applies to all/);
});

test('cli: --report to an unwritable path exits 1 with a clear error', () => {
  const result = run(['all', demoRepo, '--report', path.join('definitely-not-a-directory-xyz', 'report.md')]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /could not write report to/);
  assert.doesNotMatch(result.stdout, /Wrote report to/);
});

test('cli: --report with --fix reports the post-fix score', () => {
  const dir = tempDir('dev-diagnosis-report-');
  const copy = freshDemoRepo();
  const report = path.join(dir, 'report.md');
  const result = run(['all', copy, '--fix', '--report', report]);
  const rescanned = result.stdout.match(/Re-scanned after fix: Score: (\d+)\/100/);
  assert.ok(rescanned, 'expected a post-fix re-scan line');
  const score = Number(rescanned[1]);
  assert.equal(result.status, score >= 85 ? 0 : 1);
  assert.match(result.stdout, /Wrote report to/);
  assert.match(fs.readFileSync(report, 'utf8'), new RegExp(`Score: ${score}/100`));
});

test('cli: --help lists all five checks and the secrets command', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0);
  for (const word of ['context', 'binaries', 'path', 'cache', 'flakes', 'all', 'secrets', '--fix', '--report']) {
    assert.ok(result.stdout.includes(word), `help should mention ${word}`);
  }
});

test('cli: --help ends with copy-pasteable examples', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Examples:\n  dev-diagnosis {2,}run every check on this repo/);
  for (const line of ['dev-diagnosis context --fix', 'dev-diagnosis all --changed --staged', 'dev-diagnosis doctor']) {
    assert.ok(result.stdout.includes(line), `help examples should include ${line}`);
  }
});

test('cli: context names unused .aiignore entries without failing', () => {
  const dir = tempDir('dev-diagnosis-unused-aiignore-');
  fs.writeFileSync(path.join(dir, 'src.js'), 'x\n');
  fs.writeFileSync(path.join(dir, 'work.tmp'), 'x\n');
  fs.writeFileSync(path.join(dir, '.aiignore'), 'deleted-file.log\n*.tmp\n');
  const result = run(['context', dir]);
  // Advisory only: the score stays 100 and the exit code stays 0 —
  // a dead entry is housekeeping, not a failure.
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Score: 100\/100/);
  assert.match(result.stdout, /Unused \.aiignore entry \(1\) — matches nothing in this repo; safe to remove:/);
  assert.match(result.stdout, /deleted-file\.log  \(\.aiignore\)/);
  const json = run(['context', dir, '--json']);
  assert.equal(json.status, 0);
  assert.deepEqual(JSON.parse(json.stdout).unusedAiignore, [{ file: '.aiignore', pattern: 'deleted-file.log' }]);
});

test('cli: --version prints the package version', () => {
  const result = run(['--version']);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), pkgVersion);
});

test('cli: an unknown command is a usage error', () => {
  const result = run(['frobnicate']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown command/);
});

test('cli: a mistyped command suggests the intended command', () => {
  const al = run(['al']);
  assert.equal(al.status, 2);
  assert.match(al.stderr, /Did you mean 'all'\?/);
  const cntext = run(['cntext']);
  assert.equal(cntext.status, 2);
  assert.match(cntext.stderr, /Did you mean 'context'\?/);
});

test('cli: a mistyped option suggests the intended option', () => {
  const result = run(['context', '--fx']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown option: --fx/);
  assert.match(result.stderr, /Did you mean '--fix'\?/);
  // The part after '=' is a value, not part of the name.
  const equals = run(['context', '--comand=node']);
  assert.equal(equals.status, 2);
  assert.match(equals.stderr, /Did you mean '--command'\?/);
});

test('cli: a flag-shaped subcommand suggests the subcommand', () => {
  const contex = run(['--contex']);
  assert.equal(contex.status, 2);
  assert.match(contex.stderr, /unknown option: --contex/);
  assert.match(contex.stderr, /Did you mean 'context'\?/);
  // The exact command name, typed as a flag, suggests too.
  const all = run(['--all']);
  assert.equal(all.status, 2);
  assert.match(all.stderr, /Did you mean 'all'\?/);
  // An option typo still wins over a command near-miss.
  const json = run(['--jsonn']);
  assert.match(json.stderr, /Did you mean '--json'\?/);
  // After a command was parsed, a flag-shaped command is noise.
  const after = run(['context', '--contex']);
  assert.equal(after.status, 2);
  assert.doesNotMatch(after.stderr, /Did you mean/);
});

test('cli: a far-off typo gets no suggestion', () => {
  const command = run(['frobnicate']);
  assert.equal(command.status, 2);
  assert.match(command.stderr, /unknown command/);
  assert.doesNotMatch(command.stderr, /Did you mean/);
  const option = run(['context', '--frobnicate']);
  assert.equal(option.status, 2);
  assert.match(option.stderr, /unknown option/);
  assert.doesNotMatch(option.stderr, /Did you mean/);
});

test('cli: a bare path means all on that path', () => {
  const result = run([demoRepo]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, new RegExp(`dev-diagnosis — ${demoRepo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(result.stdout, /== context ==/);
  assert.match(result.stdout, /== skipped ==/);
  assert.match(result.stdout, /Overall: FAIL/);
});

test('cli: a bare path with options runs all with those options', () => {
  const result = run([demoRepo, '--command', 'node']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /== path ==/);
  assert.match(result.stdout, /node resolves to/);
});

test('cli: a bare path that is not a directory is still a usage error', () => {
  const result = run(['./definitely-not-a-directory-xyz']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown command/);
});

test('cli: context on the demo repo finds noise and exits 1', () => {
  const result = run(['context', demoRepo]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Score: 75\/100/);
  assert.match(result.stdout, /data\/export\.json/);
  // The demo's dist/, log and lockfile are each 0% of the total and
  // lose 0 points, so they are not listed as noise any more.
  assert.doesNotMatch(result.stdout, /dist\//);
  assert.doesNotMatch(result.stdout, /package-lock\.json/);
  assert.match(result.stdout, /FAIL/);
});

test('cli: context --json is valid JSON', () => {
  const result = run(['context', demoRepo, '--json']);
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.ok(parsed.score < 85);
  assert.ok(Array.isArray(parsed.noise));
});

test('cli: path finds node and misses a made-up command', () => {
  const found = run(['path', 'node']);
  assert.equal(found.status, 0);
  assert.match(found.stdout, /current\s+\S*node/);
  const missed = run(['path', 'definitely-not-a-command-xyz']);
  assert.equal(missed.status, 1);
  assert.match(missed.stdout, /MISS/);
});

test('cli: path verdict says "not found in any shell context" when it misses everywhere', () => {
  const result = run(['path', 'definitely-not-a-command-xyz']);
  assert.equal(result.status, 1);
  // The old verdict said "missing in the current shell", which understated
  // a miss in all four contexts — it sounded like the command might exist
  // somewhere else.
  assert.match(result.stdout, /definitely-not-a-command-xyz is not found in any shell context/);
  assert.doesNotMatch(result.stdout, /missing in the current shell/);
});

test('cli: path verdict names the context where a command resolves', () => {
  // A command that only the login shell can see: the classic "works in
  // the terminal, not in the IDE" case. The verdict should say where it
  // resolves instead of just saying the current shell misses it.
  const dir = tempDir('dev-diagnosis-path-login-');
  const binDir = path.join(dir, 'bin');
  const emptyDir = path.join(dir, 'empty');
  fs.mkdirSync(binDir);
  fs.mkdirSync(emptyDir);
  const tool = process.platform === 'win32' ? path.join(binDir, 'mytool.cmd') : path.join(binDir, 'mytool');
  fs.writeFileSync(tool, process.platform === 'win32' ? '@echo off\n' : '#!/bin/sh\necho hi\n');
  if (process.platform !== 'win32') fs.chmodSync(tool, 0o755);
  const env = {
    ...process.env,
    PATH: emptyDir,
    DEV_DOCTOR_LOGIN_PATH: binDir,
    DEV_DOCTOR_NON_LOGIN_PATH: emptyDir,
    DEV_DOCTOR_DAEMON_PATH: emptyDir,
  };
  const result = run(['path', 'mytool'], { env });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /current\s+MISS/);
  assert.match(result.stdout, /login\s+\S*mytool/);
  assert.match(result.stdout, /mytool is missing in the current shell, but resolves in login/);
  assert.match(result.stdout, /Fix: it resolves in another shell context/);
});

test('cli: flakes on the demo runs ranks the always-failing test first', () => {
  const result = run(['flakes', demoRuns]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /always-failing: 1/);
  assert.match(result.stdout, /rejectsExpiredToken/);
  assert.match(result.stdout, /appliesCoupon/);
});

test('cli: flakes --json --top limits the tests array but not the totals', () => {
  const result = run(['flakes', demoRuns, '--json', '--top', '1']);
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.tests.length, 1);
  assert.equal(parsed.totals.tests, 5);
  assert.equal(parsed.tests[0].id, 'com.example.LoginTest::rejectsExpiredToken');
});

test('cli: all --json --top limits the embedded flakes tests', () => {
  const result = run(['all', demoRepo, '--flakes', demoRuns, '--json', '--top', '1']);
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.checks.flakes.tests.length, 1);
  assert.equal(parsed.checks.flakes.totals.tests, 5);
});

test('cli: all --json keeps the reason when flakes cannot run', () => {
  const missing = path.join(demoRepo, 'no-such-runs');
  const result = run(['all', demoRepo, '--flakes', missing, '--json']);
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.overall, 'FAIL');
  assert.ok(parsed.checks.context, 'context still present');
  assert.match(parsed.checks.flakes.error, /runs directory not found/);
  assert.match(parsed.checks.flakes.error, /no-such-runs/);
});

test('cli: all --json keeps the reason when the cache build fails', () => {
  const dir = tempDir('dev-diagnosis-all-cache-');
  fs.mkdirSync(path.join(dir, '.cache'), { recursive: true });
  const result = run(['all', dir, '--json', '--', process.execPath, '-e', 'process.exit(3)']);
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.overall, 'FAIL');
  assert.match(parsed.checks.cache.error, /cold build failed \(exit 3\)/);
});

test('cli: flakes with only a broken XML file fails and names the file', () => {
  const dir = tempDir('dev-diagnosis-flakes-broken-');
  fs.mkdirSync(path.join(dir, 'run-01'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'run-01', 'broken.xml'), '<testsuites><testsuite><testcase classname="T" name="t"><failure/></testcase></testsuite>');
  const result = run(['flakes', dir]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /tests: 0/);
  assert.match(result.stdout, /Warning: 1 file could not be parsed/);
  assert.match(result.stdout, /broken\.xml/);
  assert.match(result.stdout, /FAIL/);
  assert.match(result.stdout, /1 file could not be parsed/);
});

test('cli: flakes with only an empty XML file fails and names the file', () => {
  const dir = tempDir('dev-diagnosis-flakes-empty-');
  fs.mkdirSync(path.join(dir, 'run-01'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'run-01', 'empty.xml'), '');
  const result = run(['flakes', dir]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /tests: 0/);
  assert.match(result.stdout, /Warning: 1 file could not be parsed/);
  assert.match(result.stdout, /empty\.xml/);
  assert.match(result.stdout, /no root element/);
  assert.match(result.stdout, /FAIL/);
  assert.match(result.stdout, /1 file could not be parsed/);
});

test('cli: flakes with an empty run directory fails and names the run', () => {
  const dir = tempDir('dev-diagnosis-flakes-empty-run-');
  fs.mkdirSync(path.join(dir, 'run-01'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'run-02-empty'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'run-01', 'results.xml'), `<?xml version="1.0"?><testsuites><testsuite><testcase classname="T" name="t"/></testsuite></testsuites>`);
  const result = run(['flakes', dir]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /runs: 1/);
  assert.match(result.stdout, /No flaky tests/);
  assert.match(result.stdout, /run-02-empty/);
  assert.match(result.stdout, /no JUnit XML files/);
  assert.match(result.stdout, /FAIL/);
  assert.match(result.stdout, /1 run directory had no JUnit XML files/);
});

test('cli: flakes --json reports the skipped run directory', () => {
  const dir = tempDir('dev-diagnosis-flakes-empty-run-json-');
  fs.mkdirSync(path.join(dir, 'run-01'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'run-02-empty'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'run-01', 'results.xml'), `<?xml version="1.0"?><testsuites><testsuite><testcase classname="T" name="t"/></testsuite></testsuites>`);
  const result = run(['flakes', dir, '--json']);
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.totals.runs, 1);
  assert.deepEqual(parsed.skippedRuns, [{ id: 'run-02-empty', reason: 'no JUnit XML files found' }]);
});

test('cli: flakes with a broken file next to a clean run still fails', () => {  const dir = tempDir('dev-diagnosis-flakes-mixed-');
  fs.mkdirSync(path.join(dir, 'run-01'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'run-02'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'run-01', 'results.xml'), `<?xml version="1.0"?><testsuites><testsuite><testcase classname="T" name="t"/></testsuite></testsuites>`);
  fs.writeFileSync(path.join(dir, 'run-02', 'broken.xml'), '<testsuites><testcase>');
  const result = run(['flakes', dir]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /No flaky tests/);
  assert.match(result.stdout, /Warning: 1 file could not be parsed/);
  assert.match(result.stdout, /FAIL/);
});

test('cli: cache on the demo repo pays', () => {
  // --runs 3: the verdict is on medians, so a loaded runner cannot flip
  // it with one slow warm run (the 2026-11-15 macOS Node 18 failure —
  // the same code passed the same job on the parent commit).
  const result = run(['cache', '--runs', '3', '--cwd', freshDemoRepo(), '--', 'node', 'build.mjs']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Verdict: cache pays/);
});

test('cli: cache --json leaves the build stdout out of the JSON', () => {
  const result = run(['cache', '--cwd', freshDemoRepo(), '--json', '--', 'node', 'build.mjs']);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.verdict, 'cache pays');
  assert.ok(Number.isFinite(parsed.coldMs) && Number.isFinite(parsed.warmMs));
  assert.ok(!('coldStdout' in parsed) && !('warmStdout' in parsed));
});

test('cli: cache --runs 3 times cold and warm and shows the spread', () => {
  const result = run(['cache', '--cwd', freshDemoRepo(), '--runs', '3', '--', 'node', 'build.mjs']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Verdict: cache pays/);
  assert.match(result.stdout, /Runs: 3 cold \(\d+ ms–\d+ ms\) and 3 warm \(\d+ ms–\d+ ms\); times are medians/);
});

test('cli: cache --runs 3 --json carries the runs and the verdict uses the medians', () => {
  const result = run(['cache', '--cwd', freshDemoRepo(), '--runs=3', '--json', '--', 'node', 'build.mjs']);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.runs, 3);
  assert.equal(parsed.coldRuns.length, 3);
  assert.equal(parsed.warmRuns.length, 3);
  const sorted = [...parsed.coldRuns].sort((a, b) => a - b);
  assert.equal(parsed.coldMs, sorted[1]);
  assert.equal(parsed.verdict, 'cache pays');
});

test('cli: cache --runs outside 1..10 is a usage error', () => {
  for (const args of [['cache', '--runs', '0'], ['cache', '--runs', '11'], ['cache', '--runs=abc']]) {
    const result = run([...args, '--', 'node', 'build.mjs']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--runs needs an integer from 1 to 10/);
  }
  const missing = run(['cache', '--runs', '--', 'node', 'build.mjs']);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /--runs needs an integer from 1 to 10/);
});

test('cli: all --runs 3 --json passes the repeat count to the cache check', () => {
  const result = run(['all', freshDemoRepo(), '--command', 'node', '--flakes', demoRuns, '--runs', '3', '--json', '--', 'node', 'build.mjs']);
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.checks.cache.runs, 3);
  assert.equal(parsed.checks.cache.coldRuns.length, 3);
});

test('cli: all --json leaves the build stdout out of the cache check', () => {
  const result = run(['all', freshDemoRepo(), '--command', 'node', '--flakes', demoRuns, '--json', '--', 'node', 'build.mjs']);
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.checks.cache.verdict, 'cache pays');
  assert.ok(Number.isFinite(parsed.checks.cache.coldMs));
  assert.ok(!('coldStdout' in parsed.checks.cache) && !('warmStdout' in parsed.checks.cache));
});

test('cli: all on the demo repo runs all five checks and reports the skips honestly', () => {
  const result = run(['all', freshDemoRepo(), '--command', 'node', '--flakes', demoRuns, '--', 'node', 'build.mjs']);
  assert.equal(result.status, 1);
  for (const section of ['== context ==', '== binaries ==', '== path ==', '== flakes ==', '== cache ==']) {
    assert.ok(result.stdout.includes(section), `all should print ${section}`);
  }
  assert.match(result.stdout, /Overall: FAIL/);
});

test('cli: all without options runs context and lists the other three as skipped', () => {
  const result = run(['all', demoRepo]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /== skipped ==/);
  assert.match(result.stdout, /--command/);
  assert.match(result.stdout, /--flakes/);
});

test('cli: context --fix writes .aiignore and is idempotent', () => {
  const dir = tempDir('dev-diagnosis-fix-');
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'dist', 'app.js'), 'bundled\n');
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}\n');
  fs.writeFileSync(path.join(dir, 'src.js'), 'x\n');
  // The fix command reports the repo as it stands after the fix: it
  // re-scans and exits 0 when the fix leaves the repo clean, instead
  // of exiting 1 on the pre-fix verdict after a successful fix.
  const first = run(['context', dir, '--fix']);
  assert.equal(first.status, 0);
  assert.match(first.stdout, /Created \.aiignore with 2 entries/);
  assert.match(first.stdout, /Re-scanned after fix: Score: 100\/100/);
  assert.match(first.stdout, /PASS  context is clean/);
  const ignore = fs.readFileSync(path.join(dir, '.aiignore'), 'utf8');
  assert.ok(ignore.includes('dist/\n'), ignore);
  assert.ok(ignore.includes('package-lock.json\n'), ignore);
  // A second scan honours .aiignore: the noise is hidden, the repo is
  // clean, and there is nothing left to add.
  const second = run(['context', dir, '--fix']);
  assert.equal(second.status, 0);
  assert.match(second.stdout, /Score: 100\/100/);
  assert.match(second.stdout, /Nothing to add to \.aiignore: no suggestions/);
  assert.equal(fs.readFileSync(path.join(dir, '.aiignore'), 'utf8'), ignore);
});

test('cli: a nested .aiignore excludes its own subtree', () => {
  const dir = tempDir('dev-diagnosis-nested-aiignore-');
  fs.mkdirSync(path.join(dir, 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'pkg', 'big.log'), 'x'.repeat(200 * 1024));
  fs.writeFileSync(path.join(dir, 'pkg', '.aiignore'), 'big.log\n');
  fs.writeFileSync(path.join(dir, 'src.js'), 'x\n');
  const result = run(['context', dir]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Score: 100\/100/);
  assert.match(result.stdout, /PASS  context is clean/);
});

test('cli: context --fix never writes review suggestions', () => {
  const dir = tempDir('dev-diagnosis-fix-review-');
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'dist', 'app.js'), 'bundled\n'.repeat(100));
  fs.writeFileSync(path.join(dir, 'secret.js'), 'const s = "not-a-real-key";\n');
  fs.mkdirSync(path.join(dir, 'test', 'fixtures', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'test', 'fixtures', 'lib', 'secret.js'), 'module.exports = {};\n');
  const first = run(['context', dir, '--fix']);
  assert.equal(first.status, 0); // the fix leaves the repo clean, so the post-fix verdict is PASS
  assert.match(first.stdout, /Created \.aiignore with 1 entry: dist\//);
  const ignore = fs.readFileSync(path.join(dir, '.aiignore'), 'utf8');
  assert.ok(ignore.includes('dist/\n'), ignore);
  assert.ok(!ignore.includes('secret.js'), ignore);
  // The review item is shown as advisory instead, and the fixture is
  // still listed on a re-scan — it was not silently hidden.
  assert.match(first.stdout, /Consider for \.aiignore \(advisory — --fix does not write these\):/);
  const second = run(['context', dir]);
  assert.equal(second.status, 0);
  assert.match(second.stdout, /test\/fixtures\/lib\/secret\.js — environment-like file/);
});

test('cli: context terminal says how many review items it truncated', () => {
  // The terminal prints the first 10 review items; it used to drop
  // the rest silently, so a long review list read as a short one —
  // the report already said "… and N more", the terminal did not.
  // Eleven files with distinct keys (built at runtime, never written
  // as literals, so this file stays clean under dogfood).
  const dir = tempDir('dev-diagnosis-review-cap-');
  let seed = 20261117;
  const rand = () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < 11; i += 1) {
    let key = '';
    for (let j = 0; j < 32; j += 1) key += Math.floor(rand() * 16).toString(16);
    fs.writeFileSync(path.join(dir, `file${String(i).padStart(2, '0')}.js`), `api_key = "${key}"\n`);
  }
  const result = run(['context', dir]);
  assert.equal(result.status, 0); // secrets are advisory, the score is 100
  assert.match(result.stdout, /Worth a look before sharing:/);
  assert.match(result.stdout, /… and 1 more/);
});

test('cli: context --json --fix reports the fix in the JSON', () => {
  const dir = tempDir('dev-diagnosis-fix-json-');
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'dist', 'app.js'), 'bundled\n');
  const result = run(['context', dir, '--json', '--fix']);
  assert.equal(result.status, 0); // the JSON reports the post-fix scan
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.score, 100);
  assert.deepEqual(parsed.fix.added, ['dist/']);
  assert.equal(parsed.fix.created, true);
});

test('cli: context --fix --dry-run previews the fix without writing', () => {
  const repo = freshDemoRepo();
  const result = run(['context', repo, '--fix', '--dry-run']);
  // Nothing was fixed, so the pre-fix verdict stands (75/100 on the
  // demo repo) and the exit code is 1 — the score fails and the fix
  // would change .aiignore, so either reason alone would fail it.
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Would create \.aiignore with 1 entry \(dry run — nothing was written\):/);
  assert.match(result.stdout, /\+ # \.aiignore — written by/);
  assert.match(result.stdout, /\+ data\/export\.json/);
  assert.match(result.stdout, /Dry run — nothing was written\. Re-run without --dry-run to apply the fix\./);
  assert.match(result.stdout, /Would change \.aiignore — exiting 1\./);
  assert.doesNotMatch(result.stdout, /Re-scanned after fix/);
  assert.equal(fs.existsSync(path.join(repo, '.aiignore')), false);
  // The preview agrees with the fix: applying it writes exactly the
  // entries the preview listed.
  const fixed = run(['context', repo, '--fix']);
  assert.equal(fixed.status, 0);
  assert.equal(fs.readFileSync(path.join(repo, '.aiignore'), 'utf8'), `${AIIGNORE_HEADER.join('\n')}\ndata/export.json\n`);
  // A second dry run surfaces new suggestions: with the 1.68 MB file
  // gone, the small files are now a big share of the repo and lose
  // points — the preview lists them, and still writes nothing. The
  // score is 94/100, so the repo passes — but the fix would still
  // change .aiignore, so the dry run exits 1 (prettier --check's
  // rule: the dry run answers "would the fix change anything?").
  const again = run(['context', repo, '--fix', '--dry-run']);
  assert.equal(again.status, 1);
  assert.match(again.stdout, /Would change \.aiignore — exiting 1\./);
  assert.match(again.stdout, /Would add 3 entries to \.aiignore/);
  assert.match(again.stdout, /\+ dist\//);
  assert.match(again.stdout, /\+ package-lock\.json/);
  // Regression: the Top 3 share once printed 101.5% — the per-item
  // rounded token counts (25 + 24 + 20 = 69) summed past the total
  // (68). Estimating from the summed bytes keeps the share ≤ 100%.
  // The absolute total is platform-dependent (a Windows checkout
  // adds CRLF bytes, so the same files estimate 69 tokens there),
  // so only the share is pinned exactly.
  assert.match(again.stdout, /Top 3 noise items: ≈ \d+ tokens \(100% of this noise\)/);
  assert.equal(fs.readFileSync(path.join(repo, '.aiignore'), 'utf8'), `${AIIGNORE_HEADER.join('\n')}\ndata/export.json\n`);
});

test('cli: context --json --fix --dry-run reports the preview in the JSON', () => {
  const repo = freshDemoRepo();
  const result = run(['context', repo, '--json', '--fix', '--dry-run']);
  assert.equal(result.status, 1); // the pre-fix score, not the post-fix one
  const parsed = JSON.parse(result.stdout);
  assert.ok(parsed.score < 85);
  assert.equal(parsed.fix.dryRun, true);
  assert.equal(parsed.fix.wouldChange, true);
  assert.equal(parsed.fix.created, true);
  assert.deepEqual(parsed.fix.added, ['data/export.json']);
  assert.equal(fs.existsSync(path.join(repo, '.aiignore')), false);
});

test('cli: context --fix --dry-run exits 1 when the score passes but a fix is pending', () => {
  // The prettier --check case: one 300 KB log scores 85/100, exactly
  // on the pass line, so plain `context` exits 0 — but the fix would
  // still add `*.log` to .aiignore, so the dry run exits 1. Without
  // this, no CI gate could tell "clean" from "fix pending".
  const dir = tempDir('dev-diagnosis-dry-run-pass-');
  fs.writeFileSync(path.join(dir, 'big.log'), 'x'.repeat(300000));
  const plain = run(['context', dir]);
  assert.equal(plain.status, 0); // 85/100 passes the threshold
  const result = run(['context', dir, '--fix', '--dry-run']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /PASS  context is clean/);
  assert.match(result.stdout, /Would change \.aiignore — exiting 1\./);
  assert.equal(fs.existsSync(path.join(dir, '.aiignore')), false);
});

test('cli: context --json --fix --dry-run carries wouldChange', () => {
  const dir = tempDir('dev-diagnosis-dry-run-json-');
  fs.writeFileSync(path.join(dir, 'big.log'), 'x'.repeat(300000));
  const pending = run(['context', dir, '--json', '--fix', '--dry-run']);
  assert.equal(pending.status, 1);
  const parsed = JSON.parse(pending.stdout);
  assert.ok(parsed.score >= 85);
  assert.equal(parsed.fix.dryRun, true);
  assert.equal(parsed.fix.wouldChange, true);
  assert.deepEqual(parsed.fix.added, ['*.log']);
  // A clean repo: nothing would change, wouldChange is false, exit 0.
  const clean = tempDir('dev-diagnosis-dry-run-clean-');
  fs.writeFileSync(path.join(clean, 'a.txt'), 'hello\n');
  const cleanResult = run(['context', clean, '--json', '--fix', '--dry-run']);
  assert.equal(cleanResult.status, 0);
  const cleanParsed = JSON.parse(cleanResult.stdout);
  assert.equal(cleanParsed.score, 100);
  assert.equal(cleanParsed.fix.wouldChange, false);
  assert.deepEqual(cleanParsed.fix.added, []);
});

test('cli: context --fix --dry-run exits 0 when nothing would change', () => {
  const dir = tempDir('dev-diagnosis-dry-run-clean-text-');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
  const result = run(['context', dir, '--fix', '--dry-run']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Nothing to add to \.aiignore: no suggestions\./);
  assert.doesNotMatch(result.stdout, /Would change \.aiignore/);
  assert.equal(fs.existsSync(path.join(dir, '.aiignore')), false);
});

test('cli: all --fix --dry-run exits 1 when the score passes but a fix is pending', () => {
  const dir = tempDir('dev-diagnosis-dry-run-all-');
  fs.writeFileSync(path.join(dir, 'big.log'), 'x'.repeat(300000));
  const result = run(['all', dir, '--fix', '--dry-run']);
  assert.equal(result.status, 1);
  // The checks passed — the exit code is about the pending fix, not
  // the score, and the line above says so.
  assert.match(result.stdout, /Overall: PASS/);
  assert.match(result.stdout, /Would change \.aiignore — exiting 1\./);
  assert.equal(fs.existsSync(path.join(dir, '.aiignore')), false);
});

test('cli: --dry-run without --fix (or setup) is a usage error', () => {
  const result = run(['context', freshDemoRepo(), '--dry-run']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--dry-run only applies to setup, or with --fix/);
});

test('cli: context --changed scopes the scan to the change, not the repo', (t) => {
  if (!hasGit()) t.skip('git is not installed');
  const repo = makeGitRepo();
  writeRepoFile(repo, 'src/app.js', 'console.log("clean");\n');
  writeRepoFile(repo, 'old-debug.log', 'x'.repeat(1200000));
  gitCommit(repo, 'commit 1: clean app + committed log');
  writeRepoFile(repo, 'logs/new-debug.log', 'y'.repeat(1200000));
  // The unscoped scan blames both logs equally; the scoped scan sees
  // only the change — the committed log is pre-existing noise, not
  // something this change introduced.
  const whole = run(['context', repo]);
  assert.match(whole.stdout, /old-debug\.log — local log file/);
  assert.match(whole.stdout, /logs\/new-debug\.log — local log file/);
  const changed = run(['context', repo, '--changed']);
  assert.equal(changed.status, 0);
  assert.match(changed.stdout, /Files: 1  Size: 1\.14 MB/);
  assert.match(changed.stdout, /Scope: changed files vs HEAD \(1 file\)/);
  assert.match(changed.stdout, /logs\/new-debug\.log — local log file/);
  assert.doesNotMatch(changed.stdout, /old-debug\.log/);
});

test('cli: context --changed=HEAD~1 includes the previous commit, and --json carries the scope', (t) => {
  if (!hasGit()) t.skip('git is not installed');
  const repo = makeGitRepo();
  writeRepoFile(repo, 'src/app.js', 'console.log("clean");\n');
  writeRepoFile(repo, 'old-debug.log', 'x'.repeat(1200000));
  gitCommit(repo, 'commit 1: clean app + committed log');
  fs.appendFileSync(path.join(repo, 'src/app.js'), 'console.log("more");\n');
  gitCommit(repo, 'commit 2: extend app');
  writeRepoFile(repo, 'logs/new-debug.log', 'y'.repeat(1200000));
  const result = run(['context', repo, '--json', '--changed=HEAD~1']);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.changed.ref, 'HEAD~1');
  assert.deepEqual(parsed.changed.files, ['logs/new-debug.log', 'src/app.js']);
  assert.equal(parsed.files, 2);
  // The committed log is in neither commit after HEAD~1 nor the
  // working tree change, so it is not listed at all.
  assert.ok(!parsed.noise.some((item) => item.path === 'old-debug.log'));
});

test('cli: context --changed --fix only fixes the change', (t) => {
  if (!hasGit()) t.skip('git is not installed');
  const repo = makeGitRepo();
  writeRepoFile(repo, 'src/app.js', 'console.log("clean");\n');
  writeRepoFile(repo, 'old-debug.log', 'x'.repeat(1200000));
  gitCommit(repo, 'commit 1: clean app + committed log');
  writeRepoFile(repo, 'logs/new-debug.log', 'y'.repeat(1200000));
  const fixed = run(['context', repo, '--fix', '--changed']);
  assert.equal(fixed.status, 0, fixed.stderr);
  assert.match(fixed.stdout, /Created \.aiignore with 1 entry: \*\.log/);
  assert.match(fixed.stdout, /Re-scanned after fix: Score: 100\/100/);
  // The report is scoped throughout: the scope line is on the
  // pre-fix report, and the re-scan leaves the change clean.
  assert.match(fixed.stdout, /Scope: changed files vs HEAD/);
});

test('cli: --changed outside a git repo, with the wrong command, or with no value after = are errors', () => {
  const plain = tempDir('dev-diagnosis-not-git-');
  const outside = run(['context', plain, '--changed']);
  assert.equal(outside.status, 1);
  assert.match(outside.stderr, /not a git repository: .* — --changed needs a git repo/);
  const wrongCommand = run(['flakes', demoRuns, '--changed']);
  assert.equal(wrongCommand.status, 2);
  assert.match(wrongCommand.stderr, /--changed only applies to context \(and all\)/);
  const noValue = run(['context', demoRepo, '--changed=']);
  assert.equal(noValue.status, 2);
  assert.match(noValue.stderr, /--changed needs a value after =/);
});

test('cli: all --changed scopes the context section', (t) => {
  if (!hasGit()) t.skip('git is not installed');
  const repo = makeGitRepo();
  writeRepoFile(repo, 'src/app.js', 'console.log("clean");\n');
  writeRepoFile(repo, 'old-debug.log', 'x'.repeat(1200000));
  gitCommit(repo, 'commit 1: clean app + committed log');
  writeRepoFile(repo, 'logs/new-debug.log', 'y'.repeat(1200000));
  const result = run(['all', repo, '--changed']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Scope: changed files vs HEAD \(1 file\)/);
  assert.doesNotMatch(result.stdout, /old-debug\.log/);
});

test('cli: --staged without --changed is a usage error', () => {
  const result = run(['context', demoRepo, '--staged']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--staged only applies with --changed \(context and all\)/);
});

test('cli: context --changed --staged judges only the staged set', (t) => {
  if (!hasGit()) t.skip('git is not installed');
  const repo = makeGitRepo();
  writeRepoFile(repo, 'src/app.js', 'console.log("clean");\n');
  writeRepoFile(repo, 'old-debug.log', 'x'.repeat(1200000));
  gitCommit(repo, 'commit 1: clean app + committed log');
  writeRepoFile(repo, 'src/feature.js', '// new feature\n');
  git(repo, 'add', 'src/feature.js'); // staged, clean
  writeRepoFile(repo, 'unstaged.json', 'y'.repeat(1200000)); // unstaged noise
  // The working-tree scope fails on noise this commit does not
  // include — the exact false positive the pre-commit hook used to
  // hit. The staged scope passes: it judges only what will be
  // committed.
  const changed = run(['context', repo, '--changed']);
  assert.equal(changed.status, 1);
  assert.match(changed.stdout, /75\/100/);
  assert.match(changed.stdout, /unstaged\.json/);
  const staged = run(['context', repo, '--changed', '--staged']);
  assert.equal(staged.status, 0, staged.stderr);
  assert.match(staged.stdout, /Files: 1  Size: 15 B  Score: 100\/100/);
  assert.match(staged.stdout, /Scope: staged files vs HEAD \(1 file\)/);
  assert.doesNotMatch(staged.stdout, /unstaged\.json/);
  const json = run(['context', repo, '--json', '--changed', '--staged']);
  const parsed = JSON.parse(json.stdout);
  assert.deepEqual(parsed.changed, { ref: 'HEAD', files: ['src/feature.js'], staged: true, newFromRev: null });
});

test('cli: context --changed --staged --fix only fixes the staged change', (t) => {
  if (!hasGit()) t.skip('git is not installed');
  const repo = makeGitRepo();
  writeRepoFile(repo, 'src/app.js', 'console.log("clean");\n');
  writeRepoFile(repo, 'old-debug.log', 'x'.repeat(1200000));
  gitCommit(repo, 'commit 1: clean app + committed log');
  writeRepoFile(repo, 'staged.json', 'y'.repeat(1200000));
  git(repo, 'add', 'staged.json'); // staged noise
  writeRepoFile(repo, 'unstaged.json', 'z'.repeat(1200000)); // unstaged noise
  const failed = run(['context', repo, '--changed', '--staged']);
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /75\/100/);
  assert.match(failed.stdout, /staged\.json/);
  assert.doesNotMatch(failed.stdout, /unstaged\.json/);
  const fixed = run(['context', repo, '--fix', '--changed', '--staged']);
  assert.equal(fixed.status, 0, fixed.stderr);
  assert.match(fixed.stdout, /Created \.aiignore with 1 entry: staged\.json/);
  assert.match(fixed.stdout, /Re-scanned after fix: Score: 100\/100/);
  assert.match(fixed.stdout, /Scope: staged files vs HEAD/);
});

test('cli: context --changed works on the first commit — unborn HEAD is not an error', (t) => {
  if (!hasGit()) t.skip('git is not installed');
  const repo = makeGitRepo(); // no commits yet — HEAD is unborn
  writeRepoFile(repo, 'src/feature.js', '// new feature\n');
  git(repo, 'add', 'src/feature.js'); // staged, clean
  // A clean first commit passes with a verdict, not the old
  // "cannot list changes vs HEAD" error — this is the commit the
  // pre-commit hook runs on, so it has to work here.
  const clean = run(['context', repo, '--changed', '--staged']);
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /Files: 1  Size: 15 B  Score: 100\/100/);
  assert.match(clean.stdout, /Scope: staged files vs HEAD \(1 file\)/);
  assert.doesNotMatch(clean.stdout, /cannot list changes/);
  // A noisy first commit fails with the verdict, not an error — and
  // --new-from-rev treats every file as new, since nothing was ever
  // committed.
  writeRepoFile(repo, 'staged.json', 'y'.repeat(1200000));
  git(repo, 'add', 'staged.json'); // staged noise
  const failed = run(['context', repo, '--changed', '--staged']);
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /75\/100/);
  assert.match(failed.stdout, /staged\.json/);
  assert.doesNotMatch(failed.stdout, /cannot list changes/);
  const fresh = run(['context', repo, '--new-from-rev']);
  assert.equal(fresh.status, 1);
  assert.match(fresh.stdout, /75\/100/);
  // An explicit ref that does not exist still fails loudly.
  const bad = run(['context', repo, '--changed=no-such-ref']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /cannot list changes vs no-such-ref/);
});

test('cli: all --changed --staged scopes the context section to the staged set', (t) => {
  if (!hasGit()) t.skip('git is not installed');
  const repo = makeGitRepo();
  writeRepoFile(repo, 'src/app.js', 'console.log("clean");\n');
  writeRepoFile(repo, 'old-debug.log', 'x'.repeat(1200000));
  gitCommit(repo, 'commit 1: clean app + committed log');
  writeRepoFile(repo, 'src/feature.js', '// new feature\n');
  git(repo, 'add', 'src/feature.js');
  writeRepoFile(repo, 'unstaged.json', 'y'.repeat(1200000));
  const result = run(['all', repo, '--changed', '--staged']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Scope: staged files vs HEAD \(1 file\)/);
  assert.doesNotMatch(result.stdout, /unstaged\.json/);
});

// A committed lockfile the change only touches: --changed blames the
// whole 2 MB file (the pain that motivated --new-from-rev), while
// --new-from-rev sees the bump added no new noise and passes.
function lockfileBumpRepo(t) {
  if (!hasGit()) t.skip('git is not installed');
  const repo = makeGitRepo();
  writeRepoFile(repo, 'src/index.js', 'console.log("clean");\n');
  writeRepoFile(repo, 'package-lock.json', '{\n  "version": "1.0.1"\n}\n'.padEnd(2000000, ' '));
  gitCommit(repo, 'commit 1: clean src + committed lockfile');
  // A dependabot-style bump: the version string changes in place, so
  // the file is the same size it was at the ref — zero new noise.
  const lockfile = path.join(repo, 'package-lock.json');
  fs.writeFileSync(lockfile, fs.readFileSync(lockfile, 'utf8').replace('"1.0.1"', '"1.0.2"'));
  return repo;
}

test('cli: context --new-from-rev passes a lockfile bump --changed fails', (t) => {
  const repo = lockfileBumpRepo(t);
  const changed = run(['context', repo, '--changed']);
  assert.equal(changed.status, 1);
  assert.match(changed.stdout, /80\/100/);
  assert.match(changed.stdout, /package-lock\.json — lockfile/);
  const fresh = run(['context', repo, '--changed', '--new-from-rev']);
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.match(fresh.stdout, /Score: 100\/100/);
  assert.match(fresh.stdout, /Scope: new noise in changed files vs HEAD \(1 file\)/);
  assert.doesNotMatch(fresh.stdout, /package-lock\.json — lockfile/);
  // A bare --new-from-rev implies --changed: the same verdict with
  // no --changed on the command line, and --json carries the scope.
  const bare = run(['context', repo, '--json', '--new-from-rev']);
  assert.equal(bare.status, 0, bare.stderr);
  const parsed = JSON.parse(bare.stdout);
  assert.equal(parsed.score, 100);
  assert.deepEqual(parsed.changed, { ref: 'HEAD', files: ['package-lock.json'], staged: false, newFromRev: 'HEAD' });
});

test('cli: context --new-from-rev still fails on genuinely new noise', (t) => {
  const repo = lockfileBumpRepo(t);
  // A 10 MB new binary dwarfs the 2 MB lockfile, so the new noise
  // alone fails the change — the lockfile bump is forgiven, the new
  // file is not.
  writeRepoFile(repo, 'data.bin', 'y'.repeat(10 * 1024 * 1024));
  const result = run(['context', repo, '--changed', '--new-from-rev']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /data\.bin — large file/);
  assert.doesNotMatch(result.stdout, /package-lock\.json — lockfile/);
});

test('cli: context --new-from-rev=HEAD~1 with a growth delta reports the delta', (t) => {
  if (!hasGit()) t.skip('git is not installed');
  const repo = makeGitRepo();
  writeRepoFile(repo, 'src/app.js', 'console.log("clean");\n');
  writeRepoFile(repo, 'package-lock.json', '{\n  "version": "1.0.1"\n}\n'.padEnd(2000000, ' '));
  gitCommit(repo, 'commit 1: clean src + committed lockfile');
  fs.appendFileSync(path.join(repo, 'src/app.js'), 'console.log("more");\n');
  gitCommit(repo, 'commit 2: extend app');
  // The lockfile grows by exactly 100 KB after HEAD~1.
  fs.appendFileSync(path.join(repo, 'package-lock.json'), ' '.repeat(100000));
  const result = run(['context', repo, '--json', '--new-from-rev=HEAD~1']);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.changed.newFromRev, 'HEAD~1');
  assert.deepEqual(parsed.changed.files, ['package-lock.json', 'src/app.js']);
  assert.equal(parsed.noise.length, 1);
  assert.equal(parsed.noise[0].path, 'package-lock.json');
  assert.equal(parsed.noise[0].bytes, 100000);
  assert.equal(parsed.noise[0].totalBytes, 2100000);
  // The terminal line names the growth against the file it grew from,
  // not the file as a 97 KB one: delta's "show exactly what changed".
  const text = run(['context', repo, '--new-from-rev=HEAD~1']);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /package-lock\.json — lockfile \(97.7 KB of 2\.00 MB, ≈ 25k tokens\)/);
});

test('cli: context --new-from-rev --fix re-scans with the same new-only scope', (t) => {
  const repo = lockfileBumpRepo(t);
  // Grow the lockfile by 100 KB so there is new noise to fix.
  fs.appendFileSync(path.join(repo, 'package-lock.json'), ' '.repeat(100000));
  const fixed = run(['context', repo, '--fix', '--changed', '--new-from-rev']);
  assert.equal(fixed.status, 0, fixed.stderr);
  assert.match(fixed.stdout, /Created \.aiignore with 1 entry: package-lock\.json/);
  assert.match(fixed.stdout, /Re-scanned after fix: Score: 100\/100/);
  assert.match(fixed.stdout, /Scope: new noise in changed files vs HEAD/);
});

test('cli: --new-from-rev with two different refs, with the wrong command, or with no value after = are errors', () => {
  const conflict = run(['context', demoRepo, '--changed=HEAD~1', '--new-from-rev=HEAD']);
  assert.equal(conflict.status, 2);
  assert.match(conflict.stderr, /--new-from-rev HEAD and --changed HEAD~1 name different refs/);
  const wrongCommand = run(['binaries', demoRepo, '--new-from-rev']);
  assert.equal(wrongCommand.status, 2);
  assert.match(wrongCommand.stderr, /--new-from-rev only applies to context \(and all\)/);
  const noValue = run(['context', demoRepo, '--new-from-rev=']);
  assert.equal(noValue.status, 2);
  assert.match(noValue.stderr, /--new-from-rev needs a value after =/);
  // --staged with --new-from-rev is fine: the flag implies --changed.
  const staged = run(['context', demoRepo, '--staged', '--new-from-rev']);
  assert.notEqual(staged.status, 2);
});

test('cli: all --fix --dry-run previews without writing or re-scanning', () => {
  const repo = freshDemoRepo();
  const result = run(['all', repo, '--fix', '--dry-run']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Would create \.aiignore with 1 entry/);
  assert.match(result.stdout, /\+ data\/export\.json/);
  assert.match(result.stdout, /Would change \.aiignore — exiting 1\./);
  assert.doesNotMatch(result.stdout, /Re-scanned after fix/);
  assert.match(result.stdout, /Overall: FAIL/);
  assert.equal(fs.existsSync(path.join(repo, '.aiignore')), false);
});

test('cli: all --fix applies the context fix', () => {
  const dir = tempDir('dev-diagnosis-fix-all-');
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}\n');
  const result = run(['all', dir, '--fix']);
  assert.equal(result.status, 0); // the only failing check was fixed
  assert.match(result.stdout, /Created \.aiignore with 1 entry: package-lock\.json/);
  assert.match(result.stdout, /Re-scanned after fix: Score: 100\/100/);
  assert.match(result.stdout, /Overall: PASS/);
  assert.equal(fs.readFileSync(path.join(dir, '.aiignore'), 'utf8'), `${AIIGNORE_HEADER.join('\n')}\npackage-lock.json\n`);
});

test('cli: all --fix still fails when another check fails', () => {
  // The fix must not mask a failure it did not fix: context comes back
  // clean (94/100 on the demo repo — the small files still count, but
  // pass), while the flaky test still fails the run.
  const repo = freshDemoRepo();
  const result = run(['all', repo, '--flakes', demoRuns, '--fix']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Re-scanned after fix: Score: 94\/100/);
  assert.match(result.stdout, /PASS  context is clean/);
  assert.match(result.stdout, /Overall: FAIL/);
  assert.equal(fs.readFileSync(path.join(repo, '.aiignore'), 'utf8'), `${AIIGNORE_HEADER.join('\n')}\ndata/export.json\n`);
});

test('cli: --fix on a check without an .aiignore fix is a usage error', () => {
  const result = run(['path', 'node', '--fix']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--fix only applies to context/);
});

test('cli: all skips cache when the repo has no cache directory', () => {
  const dir = tempDir('dev-diagnosis-nocache-');
  fs.writeFileSync(path.join(dir, 'index.js'), 'console.log(1)\n');
  const result = run(['all', dir, '--', 'node', '-e', '1']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /== skipped ==/);
  assert.match(result.stdout, /no cache directory found/);
  assert.match(result.stdout, /Overall: PASS/);
});

test('cli: context --json reports the token estimate, null when clean', () => {
  const noisy = run(['context', demoRepo, '--json']);
  assert.equal(noisy.status, 1);
  const parsed = JSON.parse(noisy.stdout);
  // The demo's listed noise is the data dump: the estimate is its byte
  // count at ~4 bytes per token (see estimateTokens). The range below
  // is a sanity bound; the exact line is asserted in the next test.
  assert.ok(Number.isInteger(parsed.estimatedTokens));
  assert.ok(parsed.estimatedTokens > 400000 && parsed.estimatedTokens < 500000);
  const dir = tempDir('dev-diagnosis-tokens-clean-');
  fs.writeFileSync(path.join(dir, 'index.js'), 'console.log(1)\n');
  const clean = run(['context', dir, '--json']);
  assert.equal(clean.status, 0);
  assert.equal(JSON.parse(clean.stdout).estimatedTokens, null);
});

test('cli: context prints the token estimate line next to the noise', () => {
  const result = run(['context', demoRepo]);
  assert.equal(result.status, 1);
  const expected = formatTokens(estimateTokens(demoNoiseBytes));
  assert.match(result.stdout, new RegExp(`Estimated tokens wasted on this noise: ≈ ${expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} tokens \\(estimate, ~4 bytes per token\\)`));
});

test('cli: context lists per-item tokens, biggest first, with the top-items share', () => {
  const dir = tempDir('dev-diagnosis-tokens-');
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'dist', 'a.js'), 'x'.repeat(1500000));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'big.bin'), 'y'.repeat(2000000));
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'logs', 'app.log'), 'l'.repeat(100000));
  fs.writeFileSync(path.join(dir, 'logs', 'b.log'), 'l'.repeat(50000));
  fs.writeFileSync(path.join(dir, 'index.js'), 'console.log(1)\n');
  const result = run(['context', dir]);
  assert.equal(result.status, 1);
  // Each noise line carries its own token cost, biggest first.
  assert.match(result.stdout, /data\/big\.bin — large file \(1\.91 MB, ≈ 500k tokens\)/);
  assert.match(result.stdout, /dist\/ — generated build output \(1\.43 MB, ≈ 375k tokens\)/);
  assert.ok(result.stdout.indexOf('data/big.bin') < result.stdout.indexOf('dist/'));
  // Top 3 of 4 items: 900k of 912.5k tokens = 98.6% of the waste.
  assert.match(result.stdout, /Top 3 noise items: ≈ 900k tokens \(98\.6% of this noise\)/);
  // --json carries the same per-item tokens, ranked the same way.
  const parsed = JSON.parse(run(['context', dir, '--json']).stdout);
  assert.equal(parsed.noise[0].label, 'data/big.bin');
  assert.equal(parsed.noise[0].tokens, 500000);
  assert.equal(parsed.noise[1].label, 'dist/');
  assert.equal(parsed.noise[1].tokens, 375000);
});

test('cli: all prints a summary line with counts, noise and cache saving', () => {
  const result = run(['all', freshDemoRepo(), '--command', 'node', '--flakes', demoRuns, '--', 'node', 'build.mjs']);
  assert.equal(result.status, 1);
  const expectedSize = formatBytes(demoNoiseBytes);
  assert.match(result.stdout, new RegExp(`Summary: 5 checks — 3 passed, 2 failed, 0 skipped; context noise ${expectedSize.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}; cache saved \\d+%`));
});

test('cli: all --json includes the summary object', () => {
  const result = run(['all', freshDemoRepo(), '--command', 'node', '--flakes', demoRuns, '--json', '--', 'node', 'build.mjs']);
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(parsed.summary.checks, { total: 5, passed: 3, failed: 2, skipped: 0 });
  assert.ok(parsed.summary.contextNoiseBytes > 1000000);
  assert.ok(Number.isInteger(parsed.summary.cacheSavedPct));
});

test('cli: all with skips counts them in the summary', () => {
  const result = run(['all', demoRepo, '--json']);
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(parsed.summary.checks, { total: 5, passed: 1, failed: 1, skipped: 3 });
  assert.equal(parsed.summary.cacheSavedPct, null);
});

test('cli: --help lists --mcp, --sandbox and --skill-generate', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0);
  for (const word of ['--mcp', '--sandbox', '--root', '--read-only', '--skill-generate', '--global', '--project']) {
    assert.ok(result.stdout.includes(word), `help should mention ${word}`);
  }
});

test('cli: --sandbox without --mcp is a usage error', () => {
  const result = run(['--sandbox', demoRepo]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--sandbox\/--root only applies to --mcp/);
});

test('cli: --read-only without --mcp is a usage error', () => {
  const result = run(['--read-only']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--read-only only applies to --mcp/);
});

test('cli: --mcp and --skill-generate together is a usage error', () => {
  const result = run(['--mcp', '--skill-generate']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /cannot be combined/);
});

// Corpus lines are built from fragments, never written as one literal:
// this file itself is scanned by the tool's own dogfood run, so a
// complete fake credential on one line would be a finding in our own
// repo. The fragments never co-occur on a physical line.
const baselineKeyLine = ['api', 'key'].join('_') + ' = "' + '9f8e7d6c' + '5b4a3928' + '1706f5e4' + 'd3c2b1a0' + '"';
const baselineOtherKeyLine = ['api', 'key'].join('_') + ' = "' + '1a2b3c4d' + '5e6f7a8b' + '9c0d1e2f' + '3a4b5c6d' + '"';

function makeSecretRepo() {
  const dir = tempDir('dev-diagnosis-baseline-cli-');
  fs.writeFileSync(path.join(dir, 'config.js'), `${baselineKeyLine}\n`);
  fs.writeFileSync(path.join(dir, 'index.js'), 'x\n');
  return dir;
}

test('cli: context --write-secrets-baseline records findings and exits 0', () => {
  const repo = makeSecretRepo();
  const result = run(['context', repo, '--write-secrets-baseline', 'baseline.json'], { cwd: repo });
  assert.equal(result.status, 0, result.stderr);
  const file = path.join(repo, 'baseline.json');
  assert.ok(fs.existsSync(file));
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(data.version, 1);
  assert.equal(data.findings.length, 1);
  assert.equal(data.findings[0].rule, 'generic-api-key');
  assert.match(result.stdout, /recorded: config\.js:1 \(generic-api-key\)/);
  assert.match(result.stdout, /Baseline written to baseline\.json \(1 finding\)/);
  // The recorded finding stops alerting on the next run.
  const suppressed = run(['context', repo, '--secrets-baseline', 'baseline.json'], { cwd: repo });
  assert.equal(suppressed.status, 0, suppressed.stderr);
  assert.match(suppressed.stdout, /1 secret finding suppressed by baseline baseline\.json/);
  assert.doesNotMatch(suppressed.stdout, /possible secret/);
});

test('cli: context --secrets-baseline fails on a new secret', () => {
  const repo = makeSecretRepo();
  const wrote = run(['context', repo, '--write-secrets-baseline', 'baseline.json'], { cwd: repo });
  assert.equal(wrote.status, 0, wrote.stderr);
  fs.writeFileSync(path.join(repo, 'other.js'), `${baselineOtherKeyLine}\n`);
  const result = run(['context', repo, '--secrets-baseline', 'baseline.json'], { cwd: repo });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /new secret not in the baseline/);
  assert.match(result.stdout, /possible secret/);
});

test('cli: context --secrets-baseline with a missing file warns and scans unsuppressed', () => {
  const repo = makeSecretRepo();
  const result = run(['context', repo, '--secrets-baseline', 'no-such.json'], { cwd: repo });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /secrets baseline 'no-such\.json' not found/);
  assert.match(result.stdout, /possible secret/);
});

test('cli: --secrets-baseline and --write-secrets-baseline cannot be combined', () => {
  const result = run(['context', demoRepo, '--secrets-baseline', 'a.json', '--write-secrets-baseline', 'b.json']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /cannot be combined/);
});

test('cli: --write-secrets-baseline needs context or secrets, and refuses --fix', () => {
  const onAll = run(['all', demoRepo, '--write-secrets-baseline', 'b.json']);
  assert.equal(onAll.status, 2);
  assert.match(onAll.stderr, /only applies to context/);
  const withFix = run(['context', demoRepo, '--write-secrets-baseline', 'b.json', '--fix']);
  assert.equal(withFix.status, 2);
  assert.match(withFix.stderr, /cannot be combined with --fix/);
});

test('cli: --secrets-baseline on path is a usage error', () => {
  const result = run(['path', 'node', '--secrets-baseline', 'a.json']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /only applies to context/);
});

test('cli: context --fix --json with --secrets-baseline keeps the baseline on the re-scan', () => {
  const repo = makeSecretRepo();
  fs.mkdirSync(path.join(repo, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'dist', 'bundle.js'), 'x'.repeat(100000));
  const wrote = run(['context', repo, '--write-secrets-baseline', 'baseline.json'], { cwd: repo });
  assert.equal(wrote.status, 0, wrote.stderr);
  const result = run(['context', repo, '--fix', '--json', '--secrets-baseline', 'baseline.json'], { cwd: repo });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.score, 100);
  // The post-fix re-scan reloaded the same baseline: the triaged
  // finding is still suppressed, not re-reported.
  assert.deepEqual(parsed.secretsBaseline, { path: 'baseline.json', loaded: true, suppressed: 1 });
  assert.equal(parsed.review.filter((item) => item.kind === 'secret').length, 0);
  assert.ok(fs.existsSync(path.join(repo, '.aiignore')));
});

test('cli: all --skip cache skips the cache check and never runs the build', () => {
  // Read-only on the shared fixture: the build command is parsed but
  // never executed, so no private copy is needed.
  const result = run(['all', demoRepo, '--command', 'node', '--flakes', demoRuns, '--skip', 'cache', '--', 'node', 'build.mjs']);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /cache — skipped by --skip cache/);
  assert.doesNotMatch(result.stdout, /== cache ==/);
  assert.match(result.stdout, /Summary: 5 checks — 2 passed, 2 failed, 1 skipped; context noise 1\.68 MB/);
  assert.doesNotMatch(result.stdout, /cache saved/);
});

test('cli: all --only context runs only context', () => {
  const result = run(['all', demoRepo, '--only', 'context']);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /binaries — not in --only context/);
  assert.match(result.stdout, /path — not in --only context/);
  assert.match(result.stdout, /flakes — not in --only context/);
  assert.match(result.stdout, /cache — not in --only context/);
  assert.match(result.stdout, /Summary: 5 checks — 0 passed, 1 failed, 4 skipped; context noise 1\.68 MB/);
});

test('cli: all --json --only context lists only context in checks', () => {
  const result = run(['all', demoRepo, '--json', '--only', 'context']);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const out = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(out.checks), ['context']);
  assert.deepEqual(out.skipped, [
    'binaries — not in --only context',
    'path — not in --only context',
    'flakes — not in --only context',
    'cache — not in --only context',
  ]);
});

test('cli: --skip accumulates across repeats and accepts the = form', () => {
  const result = run(['all', demoRepo, '--command', 'node', '--skip=cache', '--skip', 'flakes']);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /cache — skipped by --skip cache,flakes/);
  assert.match(result.stdout, /flakes — skipped by --skip cache,flakes/);
  assert.match(result.stdout, /Summary: 5 checks — 2 passed, 1 failed, 2 skipped/);
});

test('cli: --only/--skip misuse is a usage error (exit 2)', () => {
  const cases = [
    [['all', demoRepo, '--only', 'bogus'], /unknown check in --only: bogus/],
    [['all', demoRepo, '--only', 'context', '--skip', 'cache'], /cannot combine --only and --skip/],
    [['all', demoRepo, '--skip', 'context', '--fix'], /--fix writes the context check .aiignore suggestions, so it needs the context check/],
    [['context', demoRepo, '--skip', 'cache'], /--only and --skip only apply to all/],
    [['doctor', '--skip', 'cache'], /doctor takes no options except --json/],
    [['setup', '--skip', 'cache'], /setup cannot be combined with.*--skip/],
  ];
  for (const [args, pattern] of cases) {
    const result = run(args);
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, pattern);
  }
});

test('cli: all --annotations prints the failing score and the top noise file as workflow commands', () => {
  const result = run(['all', demoRepo, '--annotations']);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /::error title=dev-diagnosis — context score below threshold::context score 75\/100 is below the 85 threshold/);
  assert.match(result.stdout, /::warning file=data\/export\.json,title=dev-diagnosis — context noise #1 · large file::data\/export\.json — large file \(1\.68 MB, ≈ 439k tokens\)/);
});

test('cli: context --annotations prints the same lines', () => {
  const result = run(['context', demoRepo, '--annotations']);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /::error title=dev-diagnosis — context score below threshold::/);
  assert.match(result.stdout, /::warning file=data\/export\.json/);
});

test('cli: all --json --annotations keeps stdout parseable and puts the lines on stderr', () => {
  const result = run(['all', demoRepo, '--json', '--annotations']);
  assert.equal(result.status, 1, result.stderr);
  JSON.parse(result.stdout); // still valid JSON with no annotation in it
  assert.doesNotMatch(result.stdout, /::warning/);
  assert.match(result.stderr, /::error title=dev-diagnosis — context score below threshold::/);
  assert.match(result.stderr, /::warning file=data\/export\.json/);
});

test('cli: --annotations only applies to context and all', () => {
  const cases = [
    [['path', 'node', '--annotations'], /--annotations only applies to context \(and all\)/],
    [['doctor', '--annotations'], /doctor takes no options except --json/],
    [['setup', '--annotations'], /setup cannot be combined with.*--annotations/],
  ];
  for (const [args, pattern] of cases) {
    const result = run(args);
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, pattern);
  }
});

test('cli: all --skip context does not crash on the missing context check', () => {
  // Regression: warnMissingSecretsBaseline dereferenced
  // run.checks.context unconditionally, so skipping the context
  // check crashed the run instead of listing it as skipped.
  const result = run(['all', demoRepo, '--skip', 'context']);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /Cannot read properties/);
  assert.match(result.stdout, /context — skipped by --skip context/);
});

test('cli: all --skip context --annotations emits nothing', () => {
  const result = run(['all', demoRepo, '--skip', 'context', '--annotations']);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /::/);
  assert.doesNotMatch(result.stderr, /::/);
});

test('cli: context --cache reuses the scan on the second run and the cache file is not scanned', () => {
  const copy = freshDemoRepo();
  const first = run(['context', copy, '--cache']);
  assert.equal(first.status, 1, first.stderr);
  assert.doesNotMatch(first.stdout, /^Cache: /m);
  const cacheFile = path.join(copy, '.dev-diagnosis-cache.json');
  assert.ok(fs.existsSync(cacheFile));
  const second = run(['context', copy, '--cache']);
  assert.equal(second.status, 1, second.stderr);
  assert.match(second.stdout, /^Cache: \d+ files unchanged since \d\d:\d\d \(metadata\)$/m);
  // The cache file itself never enters the scan: the second run sees
  // the same file count and the same score as the first, which ran
  // before the file existed.
  assert.match(first.stdout, /Score: 75\/100/);
  assert.match(second.stdout, /Score: 75\/100/);
});

test('cli: context --json --cache keeps stdout parseable and the two runs agree except cached', () => {
  const copy = freshDemoRepo();
  const first = JSON.parse(run(['context', copy, '--json', '--cache']).stdout);
  assert.equal(first.cached, null);
  const second = JSON.parse(run(['context', copy, '--json', '--cache']).stdout);
  assert.ok(second.cached.files > 0);
  assert.equal(second.cached.strategy, 'metadata');
  delete first.cached;
  delete second.cached;
  assert.deepEqual(second, first);
});

test('cli: --cache-location needs --cache', () => {
  const result = run(['context', demoRepo, '--cache-location', 'sub/cache.json']);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /--cache-location needs --cache/);
});

test('cli: --cache only applies to context and all', () => {
  const cases = [
    [['path', 'node', '--cache'], /--cache only applies to context \(and all\)/],
    [['doctor', '--cache'], /doctor takes no options except --json/],
    [['setup', '--cache'], /setup cannot be combined with.*--cache/],
    [['flakes', 'examples/runs', '--cache'], /--cache only applies to context \(and all\)/],
    [['--mcp', '--cache'], /--cache, --cache-location and --min-score only apply to context \(and all\), not to --mcp or --skill-generate/],
    [['--skill-generate', '--cache'], /--cache, --cache-location and --min-score only apply to context \(and all\), not to --mcp or --skill-generate/],
  ];
  for (const [args, pattern] of cases) {
    const result = run(args);
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, pattern);
  }
});

test('cli: all --cache prints the Cache line on the second run', () => {
  const copy = freshDemoRepo();
  run(['all', copy, '--cache']);
  const second = run(['all', copy, '--cache']);
  assert.equal(second.status, 1, second.stderr);
  assert.match(second.stdout, /^Cache: \d+ files unchanged since \d\d:\d\d \(metadata\)$/m);
});

test('cli: context --fix --cache writes the fix and the cache together', () => {
  const copy = freshDemoRepo();
  const result = run(['context', copy, '--fix', '--cache']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(path.join(copy, '.aiignore')));
  assert.ok(fs.existsSync(path.join(copy, '.dev-diagnosis-cache.json')));
  const second = run(['context', copy, '--cache']);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /^Cache: \d+ files unchanged since \d\d:\d\d \(metadata\)$/m);
});

test('cli: context --json --cache --annotations keeps stdout parseable', () => {
  const copy = freshDemoRepo();
  run(['context', copy, '--cache']);
  const result = run(['context', copy, '--json', '--cache', '--annotations']);
  assert.equal(result.status, 1, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.ok(parsed.cached.files > 0);
  assert.doesNotMatch(result.stdout, /::warning/);
  assert.match(result.stderr, /::error title=dev-diagnosis — context score below threshold::/);
});

test('cli: --fix --annotations annotates the post-fix result, not the pre-fix one', () => {
  const copy = freshDemoRepo();
  const result = run(['context', copy, '--fix', '--annotations']);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /file=data\/export\.json/);
  assert.match(result.stdout, /::warning file=package-lock\.json/);
  assert.doesNotMatch(result.stdout, /::error/);
});

// A repo that scores exactly 85: one 1.2 MB file is 60% of the 2 MB
// total, so the large-file category loses 25 * 0.6 = 15 points. The
// probe in the run log verified the score before this test was
// written; 'x' content keeps the scan secret-free.
function repoScoring85() {
  const dir = tempDir('dev-diagnosis-min-score-');
  writeRepoFile(dir, 'data/export.json', 'x'.repeat(1200000));
  writeRepoFile(dir, 'src/index.js', 'x'.repeat(800000));
  return dir;
}

test('cli: context --min-score moves the bar — 85 passes at 70, fails at 90, and the threshold line names it', () => {
  const repo85 = repoScoring85();
  const def = run(['context', repo85]);
  assert.equal(def.status, 0, def.stderr);
  assert.match(def.stdout, /Score: 85\/100/);
  assert.doesNotMatch(def.stdout, /Threshold:/);
  const strict = run(['context', repo85, '--min-score', '90']);
  assert.equal(strict.status, 1, strict.stderr);
  assert.match(strict.stdout, /Threshold: --min-score 90 \(default 85\)/);
  assert.match(strict.stdout, /FAIL  score 85\/100 is below the --min-score 90 bar/);
  const lenient = run(['context', repo85, '--min-score=70']);
  assert.equal(lenient.status, 0, lenient.stderr);
  assert.match(lenient.stdout, /Threshold: --min-score 70 \(default 85\)/);
  assert.match(lenient.stdout, /PASS  context is clean/);
  // The demo repo scores 75: it passes at 70 and fails at 80.
  assert.equal(run(['context', demoRepo, '--min-score', '70']).status, 0);
  assert.equal(run(['context', demoRepo, '--min-score', '80']).status, 1);
});

test('cli: context --json carries minScore, and a bad --min-score is a usage error', () => {
  const repo85 = repoScoring85();
  const strict = run(['context', repo85, '--json', '--min-score', '90']);
  assert.equal(strict.status, 1, strict.stderr);
  const parsed = JSON.parse(strict.stdout);
  assert.equal(parsed.score, 85);
  assert.equal(parsed.minScore, 90);
  const def = JSON.parse(run(['context', repo85, '--json']).stdout);
  assert.equal(def.minScore, 85);
  for (const bad of [['101'], ['abc'], ['85.5'], ['-5'], []]) {
    const result = run(['context', repo85, '--min-score', ...bad]);
    assert.equal(result.status, 2, `--min-score ${bad.join(' ')}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /--min-score needs a whole number from 0 to 100/);
  }
  const empty = run(['context', repo85, '--min-score=']);
  assert.equal(empty.status, 2, empty.stderr);
  assert.match(empty.stderr, /--min-score needs a whole number from 0 to 100/);
});

test('cli: --min-score only applies to context and all', () => {
  const cases = [
    [['path', 'node', '--min-score', '90'], /--min-score only applies to context \(and all\)/],
    [['doctor', '--min-score', '90'], /doctor takes no options except --json/],
    [['setup', '--min-score', '90'], /setup cannot be combined with.*--min-score/],
    [['flakes', 'examples/runs', '--min-score', '90'], /--min-score only applies to context \(and all\)/],
    [['binaries', demoRepo, '--min-score', '90'], /--min-score only applies to context \(and all\)/],
    [['--mcp', '--min-score', '90'], /--cache, --cache-location and --min-score only apply to context \(and all\), not to --mcp or --skill-generate/],
    [['--skill-generate', '--min-score', '90'], /--cache, --cache-location and --min-score only apply to context \(and all\), not to --mcp or --skill-generate/],
  ];
  for (const [args, pattern] of cases) {
    const result = run(args);
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, pattern);
  }
});

test('cli: all --min-score follows the bar, and context --fix re-scans against it', () => {
  assert.equal(run(['all', demoRepo, '--min-score', '70']).status, 0);
  assert.equal(run(['all', demoRepo, '--min-score', '80']).status, 1);
  const copy = freshDemoRepo();
  const fixed = run(['context', copy, '--fix', '--min-score', '90']);
  assert.equal(fixed.status, 0, fixed.stderr);
  assert.match(fixed.stdout, /Re-scanned after fix: Score: 94\/100/);
  assert.match(fixed.stdout, /PASS  context is clean/);
  assert.ok(fs.existsSync(path.join(copy, '.aiignore')));
});

test('cli: context --fix --dry-run --min-score 70 still exits 1 when the fix would change .aiignore', () => {
  // The demo repo scores 75, so it passes at 70 — but the fix would
  // still write entries, and the prettier --check rule says a pending
  // fix exits 1 even when the score passes.
  const text = run(['context', demoRepo, '--fix', '--dry-run', '--min-score', '70']);
  assert.equal(text.status, 1, text.stderr);
  assert.match(text.stdout, /Would change \.aiignore — exiting 1\./);
  const json = run(['context', demoRepo, '--fix', '--dry-run', '--min-score', '70', '--json']);
  assert.equal(json.status, 1, json.stderr);
  assert.equal(JSON.parse(json.stdout).fix.wouldChange, true);
});

test('cli: the README states no test count — counts rot every round', () => {
  // The Contributing block once said "436 tests" while the suite was
  // already 466. A count in the README goes stale the next round
  // that adds a test, and the suite prints its own count on every
  // run — so the README carries no number to go stale.
  const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.doesNotMatch(readme, /\d+ tests, run serially/);
  assert.match(readme, /npm test\s+# node:test, no extra dependencies, run serially/);
});
