/**
 * Agent Skills generation: `dev-diagnosis --skill-generate`.
 *
 * Writes a Claude Agent Skills SKILL.md that tells an agent to run
 * dev-diagnosis when it starts work in a repo, read the verdicts, fix
 * what fails, and re-run to confirm. Default scope is --project
 * (./.claude/skills/dev-diagnosis/SKILL.md); --global writes
 * ~/.claude/skills/dev-diagnosis/SKILL.md instead.
 *
 * --agents writes the same file to the shared `.agents/skills/`
 * location instead (./.agents/skills/dev-diagnosis/SKILL.md, or
 * ~/.agents/skills/ with --global): Gemini CLI discovers skills from
 * `.agents/skills/` and `~/.agents/skills/` — its own docs call the
 * alias "an interoperable path … compatible across different AI
 * tools" — and Codex scans `.agents/skills` too, so one folder
 * serves both. The skill body is the same spec-valid file in both
 * places; only the destination differs.
 *
 * Never overwrites: if the SKILL.md already exists, generation stops
 * with a plain message and the caller exits 1 — the file may hold the
 * user's own edits.
 *
 * In --project scope it also appends a short section to the repo-root
 * AGENTS.md: coding agents read AGENTS.md by default at startup,
 * while SKILL.md only helps once the agent already discovers the
 * skill, so the section is the discovery entry point. Append-only and
 * idempotent — an existing AGENTS.md is never rewritten and a second
 * run adds nothing. --global has no repo to attach it to, so it skips
 * AGENTS.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveHome } from './home.mjs';

export const SKILL_DIR_NAME = 'dev-diagnosis';

export const SKILL_MD = `---
name: dev-diagnosis
description: Diagnose a repo before working in it — context noise that wastes tokens, native-binary hardening, missing commands, build-cache value, flaky tests. Run when starting work in a repository, after a build or test failure, or when an agent session feels slow.
---

# dev-diagnosis

Run this before reading a repo, and again after fixing what it finds.

## When to use it

- Starting work in a repository you have not diagnosed yet.
- An agent session feels slow, or the context looks full of files it should not be reading.
- A build is slow, a command is missing, or tests keep failing on retry.
- A repo vendors native binaries, or you are about to ship one — run \`dev-diagnosis binaries\`; it gives each of the largest binaries a hardening table (PIE, NX, RELRO, stripped, entropy). It always passes: it is a checkup, not a verdict.
- A single file needs checking before sharing it — a commit message, a pasted config — run \`dev-diagnosis secrets <file>\`; it reports the file, rule and line of any possible secret, never the value.
- The build is slow and you only want the cheap checks: \`dev-diagnosis all --skip cache\` — the cache check runs the build twice, so skipping it is the fast path when the build itself is not under suspicion.
- Re-scanning a large repo you already scanned: \`dev-diagnosis context --cache\` reuses the scan cache for unchanged files (size + mtime), so the second scan takes seconds instead of a minute. Opt-in; the cache file is \`.dev-diagnosis-cache.json\` at the repo root — add it to .gitignore, it is machine-local.
- A change touches a file that was already noisy at HEAD — a lockfile bump, a generated file — and you only want to know what the change itself added: \`dev-diagnosis context --new-from-rev\` (implies --changed) counts only noise that is new since the ref; a file that was already noisy counts only its growth. Renamed files count as new.
- A strict team wants a higher bar than the default 85, or an old repo wants to start low and raise it as it cleans up: \`dev-diagnosis context --min-score 95\` (or \`--min-score 70\`) — the verdict, the exit code and the report all follow the bar you set, and the result carries it as \`minScore\`.

## Run it

\`\`\`sh
dev-diagnosis all
\`\`\`

If the command is not installed, use \`npx dev-diagnosis-cli\` instead. Run it in the repo directory; pass a path to diagnose another one (\`dev-diagnosis all ./other-repo\`).

## Read the verdicts

- **context FAIL** — the repo has noise an AI agent should not read (build output, lockfiles, logs, oversized files). The report lists the files and the token estimate. Fix it with \`dev-diagnosis context --fix\`, which writes the suggestions into \`.aiignore\`, then re-run \`dev-diagnosis all\` to confirm the score is 100/100.
- **binaries** — always passes: the report lists the largest native binaries with a hardening table each (PIE, NX, RELRO, stripped, stack protector, entropy). Read it before shipping a vendored binary; an \`unknown\` value means the headers could not tell — read the note next to it, do not read it as safe.
- **path FAIL** — a command is missing in the current shell. The report says which shell contexts have it and prints a copy-paste fix; apply the fix, then re-run.
- **flakes FAIL** — the report ranks the flaky tests. Look at the top-ranked test first; a test marked \`new\` broke recently, \`chronic\` has been unstable for a while.
- **cache FAIL** — the verdict says whether the build cache pays. If it costs more than it saves, the cache setup is the problem, not the build.

Skipped checks are not failures: they just need their input
(\`--command <name>\` for path, \`--flakes <runs-dir>\` for flakes,
\`-- <build-command>\` for cache).

## Examples

Real runs against the demo repo in this project
(\`examples/demo-repo\`), so the numbers are reproducible — run them
from the repo root:

**1. A noisy repo — diagnose first, then fix.**

\`\`\`sh
$ dev-diagnosis all examples/demo-repo --command node --flakes examples/runs -- node build.mjs
...
data/export.json — large file (1.68 MB, ≈ 439k tokens)
Estimated tokens wasted on this noise: ≈ 439k tokens
...
Overall: FAIL
\`\`\`

Next step: \`dev-diagnosis context examples/demo-repo --fix\`, then
re-run \`dev-diagnosis all\` to confirm.

**2. The fix, and the re-run that proves it.**

\`\`\`sh
$ dev-diagnosis context examples/demo-repo --fix
...
Created .aiignore with 1 entry: data/export.json
Re-scanned after fix: Score: 94/100
PASS  context is clean
\`\`\`

Next step: re-run \`dev-diagnosis all\` — the clean repo scores 94/100,
and the remaining points are the small files the agent still reads.

## Rules

- Fix what FAILs before starting the real work; a 75/100 repo costs real tokens on every turn.
- Always re-run \`dev-diagnosis all\` after a fix and confirm it passes — the re-run is the only proof the fix worked; a fix that does not move the score did not fix the problem.
- Never edit \`.aiignore\` by hand to hide a failure you have not read — the file is the record of what the agent agreed not to read.
`;

// Frontmatter keys the Agent Skills spec allows. Anything else is a
// typo the agent will silently ignore — or a key from another tool.
const SKILL_FRONTMATTER_KEYS = new Set([
  'name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools',
]);

// name: 1-64 chars, lowercase letters/digits/single hyphens, no
// leading/trailing/double hyphen — the spec's kebab-case rule.
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Validate a SKILL.md against the Agent Skills spec
 * (agentskills.io/specification), as far as a dependency-free parser
 * can: frontmatter present and closed, only known keys, name
 * kebab-case and matching the skill directory, description 1-1024
 * chars with no angle brackets, compatibility at most 500 chars, and
 * a non-empty body. Returns `{ valid: true }`, or
 * `{ valid: false, problems: [...] }` with every problem found, so
 * the caller can name the first one and count the rest.
 *
 * Why this exists: a SKILL.md with a broken frontmatter (name that
 * does not match its directory, a description over the limit) is
 * silently never triggered — the agent gives no error, the user just
 * never sees the tool run. `doctor` calls this so the breakage is
 * visible instead of silent. Multi-line values are joined with a
 * space for the length checks; `metadata` block contents are not
 * deep-validated — a full YAML parser is out of scope for this check.
 */
export function validateSkillMd(text, dirName) {
  const problems = [];
  // A skill file checked out on Windows carries CRLF; strip the \r
  // so a valid skill is not rejected for its line endings.
  const lines = String(text).split('\n').map((line) => line.replace(/\r$/, ''));
  if (lines[0] !== '---') {
    problems.push('missing frontmatter: file must start with ---');
    return { valid: false, problems };
  }
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { close = i; break; }
  }
  if (close === -1) {
    problems.push('frontmatter never closes: missing closing ---');
    return { valid: false, problems };
  }
  const fields = {};
  let current = null;
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    if (/^\s/.test(line)) {
      if (current === null) {
        problems.push(`frontmatter line ${i + 1} is indented with no key above it`);
      } else {
        // Continuation of the previous value (YAML multi-line or a
        // metadata block); joined for the length checks below.
        fields[current] += ` ${line.trim()}`;
      }
      continue;
    }
    const match = line.match(/^([A-Za-z0-9_-]+):(?:[ \t](.*))?$/);
    if (!match) {
      problems.push(`frontmatter line ${i + 1} is not "key: value"`);
      current = null;
      continue;
    }
    current = match[1];
    if (current in fields) problems.push(`duplicate frontmatter key "${current}"`);
    fields[current] = match[2] ?? '';
  }
  for (const key of Object.keys(fields)) {
    if (!SKILL_FRONTMATTER_KEYS.has(key)) problems.push(`unknown frontmatter key "${key}"`);
  }
  if (!('name' in fields)) {
    problems.push('frontmatter is missing "name"');
  } else {
    const name = fields.name;
    if (name.length < 1 || name.length > 64) problems.push(`name must be 1-64 characters (is ${name.length})`);
    if (!SKILL_NAME_RE.test(name)) problems.push(`name "${name}" must be lowercase letters, digits and single hyphens (no leading, trailing or double hyphen)`);
    if (dirName && name !== dirName) problems.push(`name "${name}" does not match the skill directory "${dirName}"`);
  }
  if (!('description' in fields)) {
    problems.push('frontmatter is missing "description"');
  } else {
    const description = fields.description;
    if (description.length < 1 || description.length > 1024) problems.push(`description must be 1-1024 characters (is ${description.length})`);
    if (/[<>]/.test(description)) problems.push('description must not contain < or >');
  }
  if ('compatibility' in fields && fields.compatibility.length > 500) {
    problems.push(`compatibility must be at most 500 characters (is ${fields.compatibility.length})`);
  }
  if ('license' in fields && fields.license.trim() === '') problems.push('license must not be empty');
  if ('allowed-tools' in fields && fields['allowed-tools'].trim() === '') problems.push('allowed-tools must not be empty');
  const body = lines.slice(close + 1).join('\n').trim();
  if (!body) problems.push('SKILL.md has no body after the frontmatter');
  return problems.length ? { valid: false, problems } : { valid: true };
}

export function skillPath(scope = 'project', base = process.cwd(), flavor = 'claude') {
  const skillsDir = flavor === 'agents' ? '.agents' : '.claude';
  if (scope === 'global') {
    return path.join(resolveHome(), skillsDir, 'skills', SKILL_DIR_NAME, 'SKILL.md');
  }
  return path.join(path.resolve(base), skillsDir, 'skills', SKILL_DIR_NAME, 'SKILL.md');
}

/**
 * The AGENTS.md section: tool name, one-line purpose, the two most-used
 * commands, repo link. The marker line is what makes the write
 * idempotent — if it is already in the file, there is nothing to add.
 */
export const AGENTS_MARKER = '<!-- dev-diagnosis: agents-section -->';

export const AGENTS_SECTION = `${AGENTS_MARKER}
## dev-diagnosis

Before starting work in this repo, run \`dev-diagnosis all\` (or \`npx dev-diagnosis-cli all\` if it is not installed): it finds context noise an AI agent should not read, native-binary hardening, missing commands, build-cache waste, and flaky tests. Fix what FAILs, then re-run to confirm; \`dev-diagnosis context --fix\` writes the fixes into \`.aiignore\`. Full skill: \`.claude/skills/dev-diagnosis/SKILL.md\`. Repo: https://github.com/WJDdidi-1/dev-doctor
`;

/**
 * The AGENTS.md section for a skill flavor: the same text, but the
 * "Full skill:" path must point at the file that was actually
 * written — an --agents install that points at .claude/skills sends
 * the reader to a file that does not exist.
 */
export function agentsSection(flavor = 'claude') {
  if (flavor !== 'agents') return AGENTS_SECTION;
  return AGENTS_SECTION.replace('.claude/skills/dev-diagnosis/SKILL.md', '.agents/skills/dev-diagnosis/SKILL.md');
}

/**
 * Append the AGENTS.md section to the repo root. Returns
 * `{ path, status }` with status 'created' (no file existed),
 * 'appended' (added to an existing file, content untouched),
 * 'already-present' (marker found, no-op), or 'skipped' (--global:
 * AGENTS.md belongs to a repo, and --global has no repo).
 */
export function ensureAgentsSection(scope = 'project', base = process.cwd(), flavor = 'claude') {
  if (scope === 'global') {
    return { path: null, status: 'skipped', reason: '--global has no repo: AGENTS.md belongs to a repo, run --skill-generate in the repo instead' };
  }
  const section = agentsSection(flavor);
  const target = path.join(path.resolve(base), 'AGENTS.md');
  if (fs.existsSync(target)) {
    const existing = fs.readFileSync(target, 'utf8');
    if (existing.includes(AGENTS_MARKER)) {
      return { path: target, status: 'already-present' };
    }
    const join = existing.length === 0 ? '' : (existing.endsWith('\n') ? '\n' : '\n\n');
    fs.appendFileSync(target, `${join}${section}`);
    return { path: target, status: 'appended' };
  }
  fs.writeFileSync(target, section);
  return { path: target, status: 'created' };
}

/**
 * Write the SKILL.md. Returns `{ path, created: true }` on success,
 * or `{ path, created: false, reason }` when the file already exists —
 * the caller prints the reason and exits 1.
 */
export function generateSkill(scope = 'project', base = process.cwd(), flavor = 'claude') {
  const target = skillPath(scope, base, flavor);
  if (fs.existsSync(target)) {
    return { path: target, created: false, reason: `already exists: ${target}` };
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, SKILL_MD);
  return { path: target, created: true };
}
