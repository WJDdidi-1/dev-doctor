import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { tempDir } from '../scripts/support.mjs';
import { AIIGNORE_HEADER, applyAiignore, classifyPath, isGitignored, matchesAiignore, parseGitignore, planAiignore, scanDirectory, topNoiseDirectories } from '../lib/context.mjs';

function makeRepo(files) {
  const root = tempDir('dev-diagnosis-context-');
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

test('classifyPath: build output, lockfiles, logs and large files are noise', () => {
  assert.equal(classifyPath('dist/app.js').noise.reason, 'generated build output');
  assert.equal(classifyPath('build/index.js').noise.reason, 'generated build output');
  assert.equal(classifyPath('coverage/lcov.info').noise.reason, 'test coverage output');
  assert.equal(classifyPath('package-lock.json').noise.reason, 'lockfile');
  assert.equal(classifyPath('logs/dev.log').noise.reason, 'local log file');
  assert.equal(classifyPath('data/big.bin', 2 * 1024 * 1024).noise.reason, 'large file');
  // A large file's fix is its exact path: no glob can single it out, and
  // without a suggestion --fix could never make its repo come back clean.
  assert.equal(classifyPath('data/big.bin', 2 * 1024 * 1024).suggestion, 'data/big.bin');
  assert.equal(classifyPath('big.bin', 2 * 1024 * 1024).suggestion, 'big.bin');
});

test('classifyPath: templates and secret-like files are review, not noise', () => {
  assert.equal(classifyPath('.env.example').review.reason, 'environment template (usually safe to share)');
  assert.equal(classifyPath('.env').review.reason, 'environment-like file');
  assert.equal(classifyPath('src/index.js').noise, undefined);
  assert.equal(classifyPath('src/index.js').review, undefined);
});

test('classifyPath: Windows-style paths classify the same as POSIX paths', () => {
  // A backslash-joined path must not slip past the noise-dir rule.
  assert.equal(classifyPath('dist\\app.js').noise.reason, 'generated build output');
});

test('classifyPath: a nested build directory is labelled by its full path', () => {
  // A bare dist/ label would be ambiguous when two parts of the tree each
  // have one, and the suggestion it produces would not match the nested
  // directory at all. A top-level directory keeps the short label.
  const nested = classifyPath('packages/foo/dist/app.js');
  assert.equal(nested.noise.label, 'packages/foo/dist/');
  assert.equal(nested.suggestion, 'packages/foo/dist/');
  assert.equal(classifyPath('dist/app.js').noise.label, 'dist/');
  assert.equal(classifyPath('dist/app.js').suggestion, 'dist/');
});

test('scanDirectory: an explicit maxFiles still caps the walk and says so', () => {
  const files = {};
  for (let i = 0; i < 10; i += 1) files[`src/f${i}.js`] = 'x\n';
  const root = makeRepo(files);
  const capped = scanDirectory(root, { maxFiles: 5 });
  assert.equal(capped.files, 5);
  assert.equal(capped.truncated, true);
  const full = scanDirectory(root, { maxFiles: 50 });
  assert.equal(full.files, 10);
  assert.equal(full.truncated, false);
});

test('scanDirectory: the default cap covers a repo bigger than the old 10,000 limit', () => {
  // nodejs/node is ~53,000 files once ignored directories are out; the
  // old 10,000 default made its token estimate a ~2x lower bound.
  // 10,200 tiny files is enough to prove the default is past 10,000
  // without paying for a full big-repo fixture.
  const root = tempDir('dev-diagnosis-context-big-');
  for (let i = 0; i < 10200; i += 1) {
    fs.writeFileSync(path.join(root, `f${i}.js`), 'x\n');
  }
  const result = scanDirectory(root);
  assert.equal(result.files, 10200);
  assert.equal(result.truncated, false);
});

test('scanDirectory: files under one build directory roll up into one row', () => {
  const root = makeRepo({
    'src/index.js': 'x\n',
    'dist/a.js': 'bundled\n'.repeat(100),
    'dist/b.js': 'bundled\n'.repeat(100),
    'dist/c.js': 'bundled\n'.repeat(100),
  });
  const result = scanDirectory(root);
  const build = result.noise.filter((item) => item.reason === 'generated build output');
  assert.equal(build.length, 1);
  assert.equal(build[0].label, 'dist/');
  assert.equal(build[0].bytes, 'bundled\n'.repeat(100).length * 3);
});

test('scanDirectory: --fix round-trips on nested build output', () => {
  // Regression: --fix used to write a bare dist/ entry, which only
  // matches top-level build output, so re-scanning a repo whose dist/
  // lives under packages/foo still failed after the fix.
  const root = makeRepo({
    'src/index.js': 'x\n',
    'packages/foo/dist/app.js': 'bundled\n',
  });
  const first = scanDirectory(root);
  assert.ok(first.suggestions.includes('packages/foo/dist/'));
  const fix = applyAiignore(root, first.suggestions);
  assert.deepEqual(fix.added, ['packages/foo/dist/']);
  const second = scanDirectory(root);
  assert.equal(second.score, 100);
  assert.equal(second.noise.length, 0);
  assert.deepEqual(second.suggestions, []);
});

test('scanDirectory: --fix round-trips on a large file', () => {
  // Regression: large files used to carry no suggestion, so --fix wrote
  // everything else and the next scan still failed on the same file —
  // the documented "fix then re-scan comes back clean" promise did not
  // hold for any repo with one oversized file, including this project's
  // own demo fixture.
  const root = makeRepo({
    'src/index.js': 'x\n',
    'data/export.json': 'x'.repeat(2 * 1024 * 1024),
  });
  const first = scanDirectory(root);
  assert.ok(first.suggestions.includes('data/export.json'));
  const fix = applyAiignore(root, first.suggestions);
  assert.deepEqual(fix.added, ['data/export.json']);
  const second = scanDirectory(root);
  assert.equal(second.score, 100);
  assert.equal(second.noise.length, 0);
  assert.deepEqual(second.suggestions, []);
});

test('scanDirectory: a clean repo scores 100', () => {
  const root = makeRepo({ 'src/index.js': 'console.log("hi");\n', 'README.md': '# hi\n' });
  const result = scanDirectory(root);
  assert.equal(result.score, 100);
  assert.equal(result.noise.length, 0);
  assert.equal(result.passed, undefined); // scan result carries no verdict; the CLI decides
});

test('scanDirectory: a noisy repo scores below clean and suggests fixes', () => {
  const root = makeRepo({
    'src/index.js': 'x\n',
    'dist/app.bundle.js': 'bundled\n'.repeat(500),
    'package-lock.json': '{}\n',
    'logs/dev.log': 'log line\n'.repeat(2000),
    'data/export.json': 'x'.repeat(2 * 1024 * 1024),
  });
  const result = scanDirectory(root);
  // The large file alone costs its full 25 points, so the score is at most
  // 75; the other noise categories push it lower.
  assert.ok(result.score < 85, `expected a noisy score, got ${result.score}`);
  assert.ok(result.noise.length >= 3);
  assert.ok(result.suggestions.includes('dist/'));
  assert.ok(result.suggestions.includes('*.log'));
  assert.ok(result.suggestions.includes('data/export.json'));
  // The 3 B lockfile is 0% of a 2 MB repo and loses 0 points, so it is
  // not listed as noise and not suggested: suggesting a fix that changes
  // nothing about the score would contradict the verdict.
  assert.ok(!result.noise.some((item) => item.reason === 'lockfile'));
  assert.ok(!result.suggestions.includes('package-lock.json'));
});

test('scanDirectory: noise that costs no points is not listed', () => {
  // A 95 B lockfile in a ~2 MB repo is 0% of the total and loses 0 of
  // its 20 points — the scan is 100/100, so there is nothing to fix and
  // the lockfile must not appear as noise or as a suggestion. (This is
  // the repo's own state: package-lock.json is 351 B of 164 KB.)
  const files = { 'package-lock.json': '{}\n' };
  for (let i = 0; i < 100; i += 1) files[`src/file${i}.js`] = 'x\n'.repeat(2000);
  const root = makeRepo(files);
  const result = scanDirectory(root);
  assert.equal(result.score, 100);
  assert.equal(result.noise.length, 0);
  assert.deepEqual(result.suggestions, []);
});

test('scanDirectory: review suggestions are advisory, never --fix suggestions', () => {
  // A secret-like file costs no score points, so its suggestion must
  // not be a --fix suggestion: writing `secret.js` by basename would
  // hide every same-named file in the repo — including the harmless
  // test fixture — while fixing nothing about the score.
  const root = makeRepo({
    'secret.js': 'const s = "AKIAIOSFODNN7EXAMPLE";\n',
    'test/fixtures/lib/secret.js': 'module.exports = {};\n',
    '.env': 'KEY=value\n',
    'dist/app.js': 'bundled\n'.repeat(100),
    'src/index.js': 'x\n',
  });
  const first = scanDirectory(root);
  assert.deepEqual(first.suggestions, ['dist/']);
  assert.deepEqual(first.reviewSuggestions, ['.env*', 'secret.js']);
  assert.equal(first.review.length, 3);
  // --fix writes only the score-costing suggestion, so the review items
  // stay visible on the next scan instead of being silently hidden.
  const fix = applyAiignore(root, first.suggestions);
  assert.deepEqual(fix.added, ['dist/']);
  const second = scanDirectory(root);
  assert.equal(second.score, 100);
  assert.deepEqual(second.suggestions, []);
  assert.deepEqual(second.reviewSuggestions, ['.env*', 'secret.js']);
  assert.equal(second.review.length, 3);
});

test('scanDirectory: a repo that is entirely build output scores 60, the floor', () => {
  // Each category can lose at most its weight, and the weights are shares
  // of one total — so 60 is the lowest this score can go. The test pins
  // that floor rather than assuming a lower score is possible.
  const root = makeRepo({ 'dist/app.bundle.js': 'bundled\n'.repeat(10000), 'src/index.js': 'x\n' });
  const result = scanDirectory(root);
  assert.equal(result.score, 60);
});

test('scanDirectory: a missing directory is an error, not a clean score', () => {
  assert.throws(() => scanDirectory(path.join(os.tmpdir(), 'dev-diagnosis-does-not-exist')), /directory not found/);
});

test('applyAiignore: creates .aiignore with the suggestions', () => {
  const root = makeRepo({ 'src/index.js': 'x\n' });
  const fix = applyAiignore(root, ['dist/', 'package-lock.json']);
  assert.equal(fix.created, true);
  assert.deepEqual(fix.added, ['dist/', 'package-lock.json']);
  // A new file starts with the header saying what wrote it; the header
  // is comments, not patterns, so a second run adds nothing.
  const expected = `${AIIGNORE_HEADER.join('\n')}\ndist/\npackage-lock.json\n`;
  assert.equal(fs.readFileSync(path.join(root, '.aiignore'), 'utf8'), expected);
  const again = applyAiignore(root, ['dist/', 'package-lock.json']);
  assert.deepEqual(again.added, []);
  assert.equal(fs.readFileSync(path.join(root, '.aiignore'), 'utf8'), expected);
  assert.equal(matchesAiignore('dist/app.js', AIIGNORE_HEADER), false);
});

test('applyAiignore: an empty existing file gets the header, a non-empty one does not', () => {  const empty = makeRepo({ 'src/index.js': 'x\n', '.aiignore': '' });
  applyAiignore(empty, ['dist/']);
  assert.equal(
    fs.readFileSync(path.join(empty, '.aiignore'), 'utf8'),
    `${AIIGNORE_HEADER.join('\n')}\ndist/\n`,
  );
  // Existing content is append-only: no header is retrofitted.
  const root = makeRepo({ 'src/index.js': 'x\n', '.aiignore': '# mine\npackage-lock.json\n' });
  applyAiignore(root, ['dist/']);
  assert.equal(fs.readFileSync(path.join(root, '.aiignore'), 'utf8'), '# mine\npackage-lock.json\ndist/\n');
});

test('planAiignore: the --dry-run preview is exactly what --fix would write', () => {
  // The no-drift invariant: the preview and the fix share one
  // computation, so what the preview lists is byte-for-byte what the
  // fix writes — including the header a new file gets and the entries
  // an existing file already has.
  const root = makeRepo({ 'src/index.js': 'x\n' });
  const plan = planAiignore(root, ['dist/', 'package-lock.json']);
  assert.equal(plan.created, true);
  assert.equal(plan.wouldAddHeader, true);
  assert.deepEqual(plan.added, ['dist/', 'package-lock.json']);
  assert.deepEqual(plan.alreadyPresent, []);
  // The preview writes nothing: no .aiignore appears.
  assert.equal(fs.existsSync(path.join(root, '.aiignore')), false);
  const fix = applyAiignore(root, ['dist/', 'package-lock.json']);
  assert.deepEqual(fix.added, plan.added);
  assert.equal(fix.created, plan.created);
  assert.equal(fs.readFileSync(path.join(root, '.aiignore'), 'utf8'), plan.nextContent);
  // With one entry already present, the preview lists only the new
  // one and says the file would not be created.
  const second = planAiignore(root, ['dist/', 'logs/']);
  assert.equal(second.created, false);
  assert.equal(second.wouldAddHeader, false);
  assert.deepEqual(second.added, ['logs/']);
  assert.deepEqual(second.alreadyPresent, ['dist/']);
  // With nothing new, the preview is an empty plan and the fix is a
  // no-op: the file is untouched.
  const third = planAiignore(root, ['dist/', 'package-lock.json']);
  assert.deepEqual(third.added, []);
  assert.equal(third.nextContent, null);
  const before = fs.readFileSync(path.join(root, '.aiignore'), 'utf8');
  applyAiignore(root, ['dist/', 'package-lock.json']);
  assert.equal(fs.readFileSync(path.join(root, '.aiignore'), 'utf8'), before);
});

test('scanDirectory: noise is ranked by cost and carries per-item tokens', () => {
  const root = makeRepo({
    'dist/a.js': 'x'.repeat(1500000),
    'data/big.bin': 'y'.repeat(2000000),
    'src/index.js': 'x\n',
  });
  const result = scanDirectory(root);
  assert.equal(result.noise.length, 2);
  // Biggest first, each with its own token estimate (~4 bytes/token).
  assert.equal(result.noise[0].label, 'data/big.bin');
  assert.equal(result.noise[0].tokens, 500000);
  assert.equal(result.noise[1].label, 'dist/');
  assert.equal(result.noise[1].tokens, 375000);
});

test('applyAiignore: appends only the missing entries and keeps the rest', () => {
  const root = makeRepo({ 'src/index.js': 'x\n', '.aiignore': '# mine\npackage-lock.json\n' });
  const fix = applyAiignore(root, ['dist/', 'package-lock.json', '*.log']);
  assert.equal(fix.created, false);
  assert.deepEqual(fix.added, ['*.log', 'dist/']);
  assert.deepEqual(fix.alreadyPresent, ['package-lock.json']);
  assert.equal(
    fs.readFileSync(path.join(root, '.aiignore'), 'utf8'),
    '# mine\npackage-lock.json\n*.log\ndist/\n',
  );
  // A second run adds nothing: applying the fix is idempotent.
  const again = applyAiignore(root, ['dist/', 'package-lock.json', '*.log']);
  assert.deepEqual(again.added, []);
  assert.equal(fs.readFileSync(path.join(root, '.aiignore'), 'utf8'), '# mine\npackage-lock.json\n*.log\ndist/\n');
});

test('applyAiignore: no suggestions means no file is created', () => {
  const root = makeRepo({ 'src/index.js': 'x\n' });
  const fix = applyAiignore(root, []);
  assert.deepEqual(fix.added, []);
  assert.equal(fix.created, false);
  assert.equal(fs.existsSync(path.join(root, '.aiignore')), false);
});

test('matchesAiignore: directory patterns, globs and basenames', () => {
  assert.equal(matchesAiignore('dist/app.js', ['dist/']), true);
  assert.equal(matchesAiignore('src/dist/app.js', ['dist/']), false);
  assert.equal(matchesAiignore('logs/dev.log', ['*.log']), true);
  assert.equal(matchesAiignore('docs/package-lock.json', ['package-lock.json']), true);
  assert.equal(matchesAiignore('.env', ['.env*']), true);
  assert.equal(matchesAiignore('.env.local', ['.env*']), true);
  assert.equal(matchesAiignore('src/index.js', ['dist/', '*.log']), false);
  assert.equal(matchesAiignore('src/index.js', ['# comment', '', '!dist/']), false);
});

test('scanDirectory: files listed in .aiignore are excluded from the scan', () => {
  const root = makeRepo({
    'src/index.js': 'x\n',
    'dist/app.bundle.js': 'bundled\n'.repeat(500),
    'package-lock.json': '{}\n',
    '.aiignore': '# already handled\n' + 'dist/\n' + 'package-lock.json\n',
  });
  const result = scanDirectory(root);
  assert.equal(result.score, 100);
  assert.equal(result.noise.length, 0);
  assert.equal(result.files, 1); // only src/index.js: .aiignore itself is the tool's own file, not counted
  assert.deepEqual(result.suggestions, []);
});

test('scanDirectory: .git and node_modules are skipped', () => {
  const root = makeRepo({
    'src/index.js': 'x\n',
    '.git/objects/big.bin': 'x'.repeat(2 * 1024 * 1024),
    'node_modules/pkg/dist/out.js': 'x'.repeat(2 * 1024 * 1024),
  });
  const result = scanDirectory(root);
  assert.equal(result.score, 100);
  assert.equal(result.files, 1);
});

test('parseGitignore: comments, negation, directory-only and anchoring', () => {
  const rules = parseGitignore('# comment\n\n*.log\n!keep.log\n' + 'dist/\n' + '/build\n' + 'a/b\n');
  assert.equal(rules.length, 5);
  assert.equal(rules[0].negate, false);
  assert.equal(rules[0].anchored, false); // *.log matches a basename anywhere
  assert.equal(rules[1].negate, true); // !keep.log re-includes
  assert.equal(rules[2].dirOnly, true); // dist/ is directories only
  assert.equal(rules[3].anchored, true); // /build is root-only
  assert.equal(rules[4].anchored, true); // a/b has a slash, so it is anchored
});

test('isGitignored: last matching pattern wins, including negation', () => {
  const stack = [{ base: '', rules: parseGitignore('*.log\n!keep.log\n') }];
  assert.equal(isGitignored('logs/dev.log', false, stack), true);
  assert.equal(isGitignored('logs/keep.log', false, stack), false);
  assert.equal(isGitignored('src/index.js', false, stack), false);
});

test('scanDirectory: files listed in .gitignore are excluded from the scan', () => {
  // A repo whose build output, logs and data dumps are already
  // git-ignored is not noisy for an agent: most agents never see those
  // files, so flagging them would be noise about noise — and --fix
  // would duplicate the entries into .aiignore.
  const root = makeRepo({
    'src/index.js': 'x\n',
    'dist/app.bundle.js': 'bundled\n'.repeat(500),
    'logs/dev.log': 'log\n',
    'data/export.json': 'x'.repeat(2 * 1024 * 1024),
    '.gitignore': 'dist/\n*.log\ndata/export.json\n',
  });
  const result = scanDirectory(root);
  assert.equal(result.score, 100);
  assert.equal(result.noise.length, 0);
  assert.deepEqual(result.suggestions, []);
  assert.equal(result.files, 2); // src/index.js and .gitignore itself
});

test('scanDirectory: .gitignore negation re-includes a file', () => {
  const root = makeRepo({
    'src/index.js': 'x\n',
    'logs/dev.log': 'log\n',
    'logs/keep.log': 'log\n',
    '.gitignore': '*.log\n!keep.log\n',
  });
  const result = scanDirectory(root);
  assert.equal(result.noise.length, 1);
  assert.equal(result.noise[0].label, 'logs/keep.log');
  assert.ok(result.suggestions.includes('*.log'));
});

test('scanDirectory: anchored .gitignore patterns match only at the root', () => {
  const root = makeRepo({
    'src/index.js': 'x\n',
    'build/out.js': 'bundled\n',
    'packages/foo/build/out.js': 'bundled\n',
    '.gitignore': '/build\n',
  });
  const result = scanDirectory(root);
  assert.equal(result.noise.length, 1);
  assert.equal(result.noise[0].label, 'packages/foo/build/');

  // The same pattern without the leading slash matches at any depth.
  const unanchored = makeRepo({
    'src/index.js': 'x\n',
    'build/out.js': 'bundled\n',
    'packages/foo/build/out.js': 'bundled\n',
    '.gitignore': 'build\n',
  });
  assert.equal(scanDirectory(unanchored).noise.length, 0);
});

test('scanDirectory: a nested .gitignore applies to its own subtree', () => {
  const root = makeRepo({
    'src/index.js': 'x\n',
    'data/export.json': 'x'.repeat(2 * 1024 * 1024),
    'sub/data/export.json': 'x'.repeat(2 * 1024 * 1024),
    'sub/.gitignore': 'data/\n',
  });
  const result = scanDirectory(root);
  assert.equal(result.noise.length, 1);
  assert.equal(result.noise[0].label, 'data/export.json');
});

test('scanDirectory: .gitignore ** patterns match at any depth', () => {
  const root = makeRepo({
    'src/index.js': 'x\n',
    'a/generated/out.js': 'bundled\n',
    'a/b/generated/out.js': 'bundled\n',
    '.gitignore': '**/generated\n',
  });
  assert.equal(scanDirectory(root).noise.length, 0);
});

test('scanDirectory: a directory-only .gitignore pattern does not match a file', () => {
  // `cache/` ignores a directory called cache, not a file of the same
  // name — the file is still scanned (and counted).
  const ignored = makeRepo({
    'cache': 'x\n',
    'other.js': 'x\n',
    '.gitignore': 'cache/\n',
  });
  assert.equal(scanDirectory(ignored).files, 3);

  const plain = makeRepo({
    'cache': 'x\n',
    'other.js': 'x\n',
    '.gitignore': 'cache\n',
  });
  assert.equal(scanDirectory(plain).files, 2);
});

test('scanDirectory: estimatedTokens is the listed noise at ~4 bytes per token', () => {
  // 2 MB of large-file noise: the estimate is bytes / 4, and the score
  // itself is unchanged by adding the field.
  const root = makeRepo({
    'src/index.js': 'x\n',
    'data/big.bin': 'x'.repeat(2 * 1024 * 1024),
  });
  const result = scanDirectory(root);
  assert.equal(result.estimatedTokens, Math.round(2 * 1024 * 1024 / 4));
  assert.equal(result.score, 75);
});

test('scanDirectory: estimatedTokens is null when there is no listed noise', () => {
  const root = makeRepo({ 'src/index.js': 'x\n' });
  const result = scanDirectory(root);
  assert.equal(result.estimatedTokens, null);
  assert.equal(result.score, 100);
});

test('scanDirectory: estimatedTokens counts only noise that lost points', () => {
  // A 95 B lockfile in a 1.7 MB repo loses 0 points and is not listed
  // as noise, so it costs no tokens either — the estimate follows the
  // listed noise, not every noise byte the scan saw.
  const root = makeRepo({
    'data/big.bin': 'x'.repeat(1700000),
    'package-lock.json': 'x'.repeat(95),
  });
  const result = scanDirectory(root);
  assert.equal(result.noise.length, 1);
  assert.equal(result.estimatedTokens, Math.round(1700000 / 4));
});

test('topNoiseDirectories: rolls noise up by top-level directory, biggest first', () => {
  // dust's rollup, applied to the noise list: five 20k-token logs in
  // logs/ read as five small rows, but logs/ as a group is 100k
  // tokens — the directory is where the waste lives.
  const noise = [
    { label: 'logs/a.log', path: 'logs/a.log', bytes: 80000, tokens: 20000 },
    { label: 'logs/b.log', path: 'logs/b.log', bytes: 80000, tokens: 20000 },
    { label: 'data/big.bin', path: 'data/big.bin', bytes: 2000000, tokens: 500000 },
    { label: 'package-lock.json', path: 'package-lock.json', bytes: 40000, tokens: 10000 },
  ];
  const dirs = topNoiseDirectories(noise, 550000);
  assert.deepEqual(dirs.map((d) => d.directory), ['data/', 'logs/', '(root)']);
  assert.equal(dirs[0].tokens, 500000);
  assert.equal(dirs[0].share, 90.9);
  assert.equal(dirs[1].tokens, 40000);
  assert.equal(dirs[1].share, 7.3);
  assert.equal(dirs[2].tokens, 10000);
  assert.equal(dirs[2].share, 1.8);
});

test('topNoiseDirectories: caps at three groups and falls back to the label', () => {
  const noise = [
    { label: 'a/f', path: 'a/f', bytes: 4000, tokens: 1000 },
    { label: 'b/f', path: 'b/f', bytes: 3000, tokens: 750 },
    { label: 'c/f', path: 'c/f', bytes: 2000, tokens: 500 },
    { label: 'd/f', path: 'd/f', bytes: 1000, tokens: 250 },
    // No path: the label carries the same repo-relative shape.
    { label: 'e/f', bytes: 500, tokens: 125 },
  ];
  const dirs = topNoiseDirectories(noise, 2625);
  assert.deepEqual(dirs.map((d) => d.directory), ['a/', 'b/', 'c/']);
});

test('topNoiseDirectories: a single directory is no rollup at all', () => {
  // One group would just repeat the file list, so there is nothing
  // to roll up — the caller prints nothing.
  const noise = [
    { label: 'logs/a.log', path: 'logs/a.log', bytes: 80000, tokens: 20000 },
    { label: 'logs/b.log', path: 'logs/b.log', bytes: 80000, tokens: 20000 },
  ];
  assert.deepEqual(topNoiseDirectories(noise, 40000), []);
  assert.deepEqual(topNoiseDirectories([], 0), []);
  assert.deepEqual(topNoiseDirectories(noise, null), []);
});

test('scanDirectory: topDirectories is the same rollup on a real scan', () => {
  const root = makeRepo({
    'src/index.js': 'x\n',
    'logs/a.log': 'x'.repeat(80000),
    'logs/b.log': 'x'.repeat(80000),
    'data/big.bin': 'x'.repeat(2 * 1024 * 1024),
    'package-lock.json': 'x'.repeat(40000),
  });
  const result = scanDirectory(root);
  assert.equal(result.noise.length, 4);
  assert.deepEqual(result.topDirectories.map((d) => d.directory), ['data/', 'logs/', '(root)']);
  assert.equal(result.topDirectories[0].tokens, Math.round(2 * 1024 * 1024 / 4));
});

test('scanDirectory: topDirectories is empty when the noise is one directory', () => {
  const root = makeRepo({
    'src/index.js': 'x\n',
    'data/big.bin': 'x'.repeat(2 * 1024 * 1024),
  });
  const result = scanDirectory(root);
  assert.equal(result.noise.length, 1);
  assert.deepEqual(result.topDirectories, []);
});

test('scanDirectory: a changed scope scans only the changed files', () => {
  const root = makeRepo({
    'old-debug.log': 'x'.repeat(1200000),
    'logs/new-debug.log': 'x'.repeat(1200000),
    'src/app.js': 'x\n',
  });
  const result = scanDirectory(root, { changed: { ref: 'HEAD', files: ['logs/new-debug.log'] } });
  // The committed log is pre-existing noise, not the change: only the
  // new log is listed, and the totals are the change's (1 file,
  // 1.2 MB), so the score is the change's score.
  assert.equal(result.files, 1);
  assert.equal(result.bytes, 1200000);
  assert.equal(result.noise.length, 1);
  assert.equal(result.noise[0].path, 'logs/new-debug.log');
  assert.deepEqual(result.changed, { ref: 'HEAD', files: ['logs/new-debug.log'] });
});

test('scanDirectory: a changed scope with no changed files scores clean', () => {
  const root = makeRepo({
    'old-debug.log': 'x'.repeat(1200000),
    'src/app.js': 'x\n',
  });
  const result = scanDirectory(root, { changed: { ref: 'HEAD', files: [] } });
  assert.equal(result.files, 0);
  assert.equal(result.bytes, 0);
  assert.equal(result.score, 100);
  assert.deepEqual(result.noise, []);
  assert.deepEqual(result.changed, { ref: 'HEAD', files: [] });
});

test('scanDirectory: a changed file the walk excludes still drops out', () => {
  const root = makeRepo({
    '.gitignore': '*.log\n',
    'ignored.log': 'x'.repeat(1200000),
  });
  const result = scanDirectory(root, { changed: { ref: 'HEAD', files: ['ignored.log'] } });
  // A changed set can name a file the walk excludes — a tracked file
  // that .gitignore now covers, for example — and the scoped scan
  // still sees nothing: the walk's exclusions win over the list.
  assert.equal(result.files, 0);
  assert.equal(result.score, 100);
});
