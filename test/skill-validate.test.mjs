import assert from 'node:assert/strict';
import test from 'node:test';
import { SKILL_MD, SKILL_DIR_NAME, validateSkillMd } from '../lib/skill.mjs';

const valid = (overrides = {}) => {
  const name = overrides.name ?? 'dev-diagnosis';
  const description = overrides.description ?? 'Diagnose a repo before working in it.';
  const extra = overrides.extra ?? '';
  return `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# dev-diagnosis\n`;
};

test('skill-validate: the SKILL.md we generate passes validation', () => {
  assert.deepEqual(validateSkillMd(SKILL_MD, SKILL_DIR_NAME), { valid: true });
});

test('skill-validate: a minimal valid file passes', () => {
  assert.deepEqual(validateSkillMd(valid(), 'dev-diagnosis'), { valid: true });
});

test('skill-validate: optional keys are accepted', () => {
  const text = valid({ extra: 'license: Apache-2.0\ncompatibility: Claude Code\nallowed-tools: Read Bash\n' });
  assert.deepEqual(validateSkillMd(text, 'dev-diagnosis'), { valid: true });
});

test('skill-validate: metadata block is accepted', () => {
  const text = valid({ extra: 'metadata:\n  version: "1"\n' });
  assert.deepEqual(validateSkillMd(text, 'dev-diagnosis'), { valid: true });
});

test('skill-validate: missing frontmatter fails', () => {
  const result = validateSkillMd('# dev-diagnosis\n', 'dev-diagnosis');
  assert.equal(result.valid, false);
  assert.match(result.problems.join(' '), /missing frontmatter/);
});

test('skill-validate: unclosed frontmatter fails', () => {
  const result = validateSkillMd('---\nname: dev-diagnosis\n', 'dev-diagnosis');
  assert.equal(result.valid, false);
  assert.match(result.problems.join(' '), /never closes/);
});

test('skill-validate: a line that is not "key: value" fails', () => {
  const result = validateSkillMd('---\nname dev-diagnosis\ndescription: x\n---\n\n# d\n', 'dev-diagnosis');
  assert.equal(result.valid, false);
  assert.match(result.problems.join(' '), /not "key: value"/);
});

test('skill-validate: unknown keys and duplicates fail', () => {
  const unknown = validateSkillMd(valid({ extra: 'frobnicate: yes\n' }), 'dev-diagnosis');
  assert.equal(unknown.valid, false);
  assert.match(unknown.problems.join(' '), /unknown frontmatter key "frobnicate"/);
  const duplicate = validateSkillMd('---\nname: dev-diagnosis\nname: dev-diagnosis\ndescription: x\n---\n\n# d\n', 'dev-diagnosis');
  assert.equal(duplicate.valid, false);
  assert.match(duplicate.problems.join(' '), /duplicate frontmatter key "name"/);
});

test('skill-validate: missing name or description fails', () => {
  const noName = validateSkillMd('---\ndescription: x\n---\n\n# d\n', 'dev-diagnosis');
  assert.match(noName.problems.join(' '), /missing "name"/);
  const noDescription = validateSkillMd('---\nname: dev-diagnosis\n---\n\n# d\n', 'dev-diagnosis');
  assert.match(noDescription.problems.join(' '), /missing "description"/);
});

test('skill-validate: name must be kebab-case and match the directory', () => {
  for (const name of ['Dev-Diagnosis', '-dev-diagnosis', 'dev-diagnosis-', 'dev--diagnosis', 'dev_diagnosis', 'a'.repeat(65)]) {
    const result = validateSkillMd(valid({ name }), 'dev-diagnosis');
    assert.equal(result.valid, false, name);
    assert.match(result.problems.join(' '), /name /);
  }
  // A valid kebab name that is simply not this skill's directory.
  const mismatch = validateSkillMd(valid({ name: 'other-skill' }), 'dev-diagnosis');
  assert.equal(mismatch.valid, false);
  assert.match(mismatch.problems.join(' '), /does not match the skill directory "dev-diagnosis"/);
});

test('skill-validate: description length and angle brackets', () => {
  const empty = validateSkillMd(valid({ description: '' }), 'dev-diagnosis');
  assert.match(empty.problems.join(' '), /description must be 1-1024/);
  const long = validateSkillMd(valid({ description: 'x'.repeat(1025) }), 'dev-diagnosis');
  assert.match(long.problems.join(' '), /description must be 1-1024/);
  const angled = validateSkillMd(valid({ description: 'Diagnose <this> repo.' }), 'dev-diagnosis');
  assert.match(angled.problems.join(' '), /must not contain < or >/);
  const boundary = validateSkillMd(valid({ description: 'x'.repeat(1024) }), 'dev-diagnosis');
  assert.deepEqual(boundary, { valid: true });
});

test('skill-validate: compatibility over 500 chars fails', () => {
  const result = validateSkillMd(valid({ extra: `compatibility: ${'x'.repeat(501)}\n` }), 'dev-diagnosis');
  assert.equal(result.valid, false);
  assert.match(result.problems.join(' '), /compatibility must be at most 500/);
});

test('skill-validate: empty body fails', () => {
  const result = validateSkillMd('---\nname: dev-diagnosis\ndescription: x\n---\n', 'dev-diagnosis');
  assert.equal(result.valid, false);
  assert.match(result.problems.join(' '), /no body/);
});

test('skill-validate: all problems are reported, not just the first', () => {
  const result = validateSkillMd('---\nname: Bad_Name\ndescription: <x>\n---\n', 'dev-diagnosis');
  assert.equal(result.valid, false);
  assert.ok(result.problems.length >= 3, result.problems.join('; '));
});
