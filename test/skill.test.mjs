import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { tempDir } from '../scripts/support.mjs';
import { fileURLToPath } from 'node:url';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'dev-diagnosis.js');

function run(args, options = {}) {
  return spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', ...options });
}

test('skill: --skill-generate writes a project SKILL.md and prints its path', () => {
  const dir = tempDir('dev-diagnosis-skill-project-');
  const result = run(['--skill-generate'], { cwd: dir });
  assert.equal(result.status, 0, result.stderr);
  const target = path.join(dir, '.claude', 'skills', 'dev-diagnosis', 'SKILL.md');
  assert.match(result.stdout, new RegExp(`Wrote ${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  const content = fs.readFileSync(target, 'utf8');
  assert.match(content, /^---\nname: dev-diagnosis\n/m);
  assert.match(content, /dev-diagnosis all/);
  assert.match(content, /context --fix/);
  assert.match(content, /re-run/);
});

test('skill: a second --skill-generate refuses to overwrite', () => {
  const dir = tempDir('dev-diagnosis-skill-exists-');
  const first = run(['--skill-generate'], { cwd: dir });
  assert.equal(first.status, 0, first.stderr);
  const target = path.join(dir, '.claude', 'skills', 'dev-diagnosis', 'SKILL.md');
  fs.writeFileSync(target, 'my own edits\n');
  const second = run(['--skill-generate'], { cwd: dir });
  assert.equal(second.status, 1);
  assert.match(second.stderr, /already exists/);
  assert.match(second.stderr, /refusing to overwrite/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'my own edits\n');
});

test('skill: --skill-generate --global writes under a temp HOME', () => {
  const home = tempDir('dev-diagnosis-skill-home-');
  const dir = tempDir('dev-diagnosis-skill-global-');
  const result = run(['--skill-generate', '--global'], {
    cwd: dir,
    env: { ...process.env, HOME: home },
  });
  assert.equal(result.status, 0, result.stderr);
  const target = path.join(home, '.claude', 'skills', 'dev-diagnosis', 'SKILL.md');
  assert.match(result.stdout, new RegExp(`Wrote ${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.ok(fs.existsSync(target));
  // The project directory is untouched in global mode.
  assert.ok(!fs.existsSync(path.join(dir, '.claude')));
});

test('skill: --skill-generate --global --project is a usage error', () => {
  const dir = tempDir('dev-diagnosis-skill-both-');
  const result = run(['--skill-generate', '--global', '--project'], { cwd: dir });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /choose one of --global or --project/);
});

test('skill: --skill-generate also creates AGENTS.md with the discovery section', () => {
  const dir = tempDir('dev-diagnosis-skill-agents-');
  const result = run(['--skill-generate'], { cwd: dir });
  assert.equal(result.status, 0, result.stderr);
  const agents = path.join(dir, 'AGENTS.md');
  assert.match(result.stdout, new RegExp(`Wrote ${agents.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  const content = fs.readFileSync(agents, 'utf8');
  assert.match(content, /## dev-diagnosis/);
  assert.match(content, /dev-diagnosis all/);
  assert.match(content, /context --fix/);
  assert.match(content, /https:\/\/github\.com\/WJDdidi-1\/dev-doctor/);
});

test('skill: --skill-generate appends to an existing AGENTS.md without touching it', () => {
  const dir = tempDir('dev-diagnosis-skill-agents-append-');
  const agents = path.join(dir, 'AGENTS.md');
  fs.writeFileSync(agents, '# My repo rules\n\nNever deploy on Friday.\n');
  const result = run(['--skill-generate'], { cwd: dir });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Appended a section to/);
  const content = fs.readFileSync(agents, 'utf8');
  assert.ok(content.startsWith('# My repo rules\n\nNever deploy on Friday.\n'));
  assert.match(content, /## dev-diagnosis/);
});

test('skill: a second --skill-generate leaves AGENTS.md byte-identical', () => {
  const dir = tempDir('dev-diagnosis-skill-agents-twice-');
  const first = run(['--skill-generate'], { cwd: dir });
  assert.equal(first.status, 0, first.stderr);
  const agents = path.join(dir, 'AGENTS.md');
  const before = fs.readFileSync(agents, 'utf8');
  const second = run(['--skill-generate'], { cwd: dir });
  assert.equal(second.status, 1);
  assert.match(second.stderr, /already exists/);
  assert.equal(fs.readFileSync(agents, 'utf8'), before);
});

test('skill: --skill-generate --global skips AGENTS.md (it belongs to a repo)', () => {
  const home = tempDir('dev-diagnosis-skill-agents-home-');
  const dir = tempDir('dev-diagnosis-skill-agents-global-');
  const result = run(['--skill-generate', '--global'], {
    cwd: dir,
    env: { ...process.env, HOME: home },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Note: --global has no repo/);
  assert.ok(!fs.existsSync(path.join(dir, 'AGENTS.md')));
  assert.ok(fs.existsSync(path.join(home, '.claude', 'skills', 'dev-diagnosis', 'SKILL.md')));
});

test('skill: all --json writes no AGENTS.md and stays valid JSON', () => {
  const dir = tempDir('dev-diagnosis-skill-json-');
  const demoRepo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'demo-repo');
  const result = run(['all', demoRepo, '--json'], { cwd: dir });
  JSON.parse(result.stdout); // still valid JSON
  assert.ok(!fs.existsSync(path.join(dir, 'AGENTS.md')));
});

test('skill: --global without --skill-generate is a usage error', () => {
  const result = run(['--global']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /only apply to --skill-generate/);
});
