import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { generateCompletion, GLOBAL_OPTIONS, knownCommands, knownOptions } from '../lib/completion.mjs';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'dev-diagnosis.js');

function run(args) {
  return spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });
}

// Drive the generated bash function the way bash does: source the
// script, set COMP_WORDS / COMP_CWORD, call the function, read
// COMPREPLY. This is a real completion, not a string match.
function bashComplete(words, cword) {
  const script = generateCompletion('bash');
  const quoted = words.map((word) => `'${word}'`).join(' ');
  const probe = `${script}\nCOMP_WORDS=(${quoted})\nCOMP_CWORD=${cword}\nCOMPREPLY=()\n_dev_diagnosis\nprintf '%s\\n' "\${COMPREPLY[@]}"\n`;
  const result = spawnSync('bash', ['--norc', '-c', probe], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split('\n').filter(Boolean);
}

function syntaxCheck(shell, command) {
  const script = generateCompletion(shell);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dev-diagnosis-completion-')), `dev-diagnosis.${shell}`);
  fs.writeFileSync(file, script, 'utf8');
  const result = spawnSync(command, ['-n', file], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return script;
}

test('completion: spec is the single source of truth — every command and option the parser knows', () => {
  // The bin derives KNOWN_COMMANDS / KNOWN_OPTIONS from this spec, so
  // the spec and the parser cannot drift by construction. What can
  // drift is the spec against --help, which is written by hand next
  // to the parser: check both directions.
  const help = run(['--help']);
  assert.equal(help.status, 0);
  for (const command of knownCommands()) {
    assert.match(help.stdout, new RegExp(`\\b${command}\\b`), `command ${command} missing from --help`);
  }
  for (const option of knownOptions()) {
    assert.ok(help.stdout.includes(option), `option ${option} missing from --help`);
  }
  const mentioned = new Set([
    ...help.stdout.matchAll(/--[a-z][a-z-]*/g),
    ...help.stdout.matchAll(/(?<![a-zA-Z0-9-])-[a-z](?![a-zA-Z0-9-])/g),
  ].map((match) => match[0]));
  mentioned.delete('--'); // the build-command separator, not an option
  for (const option of mentioned) {
    assert.ok(knownOptions().includes(option), `option ${option} is in --help but not in the completion spec`);
  }
});

test('completion: every shell script names every command and its options', () => {
  for (const shell of ['bash', 'zsh', 'fish']) {
    const script = generateCompletion(shell);
    assert.equal(typeof script, 'string');
    for (const command of knownCommands()) {
      assert.ok(script.includes(command), `${shell} script is missing command ${command}`);
    }
    for (const option of knownOptions()) {
      // Fish writes long options as `-l name` and short ones as
      // `-s x`, so the check is on the bare name there.
      const needle = shell === 'fish' ? option.replace(/^-+/, '') : option;
      assert.ok(script.includes(needle), `${shell} script is missing option ${option}`);
    }
    assert.ok(script.includes('bash'), `${shell} script does not complete the shell names`);
    assert.ok(script.includes('zsh'), `${shell} script does not complete the shell names`);
    assert.ok(script.includes('fish'), `${shell} script does not complete the shell names`);
  }
  assert.equal(generateCompletion('powershell'), null);
  assert.equal(generateCompletion(''), null);
});

test('completion: bash and zsh scripts pass their shell syntax check', () => {
  syntaxCheck('bash', 'bash');
  syntaxCheck('zsh', 'zsh');
  // No fish installed here, so the fish script is verified by the
  // content assertions above and by the CLI tests below.
});

test('completion: bash completes commands at the first word', () => {
  assert.deepEqual(bashComplete(['dev-diagnosis', 'con'], 1), ['context']);
  assert.deepEqual(bashComplete(['dev-diagnosis', ''], 1).sort(), [
    'all', 'cache', 'completion', 'context', 'doctor', 'flakes', 'path', 'setup',
    ...GLOBAL_OPTIONS,
  ].sort());
});

test('completion: bash completes only the options of the command typed', () => {
  const contextOpts = bashComplete(['dev-diagnosis', 'context', '--'], 2);
  assert.ok(contextOpts.includes('--fix'));
  assert.ok(contextOpts.includes('--dry-run'));
  assert.ok(contextOpts.includes('--json'));
  assert.ok(contextOpts.includes('--changed'));
  assert.ok(!contextOpts.includes('--top'), 'context must not offer --top');
  assert.ok(!contextOpts.includes('--check'), 'context must not offer --check');
  const flakesOpts = bashComplete(['dev-diagnosis', 'flakes', '--'], 2);
  assert.ok(flakesOpts.includes('--top'));
  assert.ok(!flakesOpts.includes('--fix'), 'flakes must not offer --fix');
  assert.ok(!flakesOpts.includes('--changed'), 'flakes must not offer --changed');
  const allOpts = bashComplete(['dev-diagnosis', 'all', '--'], 2);
  assert.ok(allOpts.includes('--changed'));
  assert.ok(allOpts.includes('--report'));
  const cacheOpts = bashComplete(['dev-diagnosis', 'cache', '--'], 2);
  assert.ok(cacheOpts.includes('--runs'));
  assert.ok(!cacheOpts.includes('--top'), 'cache must not offer --top');
  assert.ok(!contextOpts.includes('--runs'), 'context must not offer --runs');
  const globalOpts = bashComplete(['dev-diagnosis', '--'], 1);
  assert.ok(globalOpts.includes('--mcp'));
  assert.ok(globalOpts.includes('--skill-generate'));
  assert.ok(!globalOpts.includes('--check'), 'top level must not offer setup-only --check');
});

test('completion: bash completes shell names after the completion command', () => {
  assert.deepEqual(bashComplete(['dev-diagnosis', 'completion', 'ba'], 2), ['bash']);
  assert.deepEqual(bashComplete(['dev-diagnosis', 'completion', ''], 2).sort(), ['bash', 'fish', 'zsh']);
});

test('completion: bash offers filenames, not options, after a value-taking option', () => {
  // After --top the function returns with COMPREPLY empty, so bash
  // falls back to its default (filename) completion via -o default.
  assert.deepEqual(bashComplete(['dev-diagnosis', 'flakes', '--top', ''], 3), []);
});

test('completion: CLI prints the script, and bad shells are usage errors', () => {
  const bash = run(['completion', 'bash']);
  assert.equal(bash.status, 0);
  assert.match(bash.stdout, /_dev_diagnosis/);
  assert.match(bash.stdout, /complete -o default -F _dev_diagnosis dev-diagnosis/);
  const zsh = run(['completion', 'zsh']);
  assert.equal(zsh.status, 0);
  assert.match(zsh.stdout, /#compdef dev-diagnosis/);
  const fish = run(['completion', 'fish']);
  assert.equal(fish.status, 0);
  assert.match(fish.stdout, /complete -c dev-diagnosis/);

  const missing = run(['completion']);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /completion needs a shell: bash, zsh or fish/);
  const unknown = run(['completion', 'powershell']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown shell: powershell/);
  const extra = run(['completion', 'bash', 'zsh']);
  assert.equal(extra.status, 2);
  assert.match(extra.stderr, /unexpected argument: zsh/);
});

test('completion: --help lists the completion command', () => {
  const help = run(['--help']);
  assert.match(help.stdout, /completion <bash\|zsh\|fish>/);
});
