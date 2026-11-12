/**
 * Agent Skills generation: `dev-diagnosis --skill-generate`.
 *
 * Writes a Claude Agent Skills SKILL.md that tells an agent to run
 * dev-diagnosis when it starts work in a repo, read the verdicts, fix
 * what fails, and re-run to confirm. Default scope is --project
 * (./.claude/skills/dev-diagnosis/SKILL.md); --global writes
 * ~/.claude/skills/dev-diagnosis/SKILL.md instead.
 *
 * Never overwrites: if the SKILL.md already exists, generation stops
 * with a plain message and the caller exits 1 — the file may hold the
 * user's own edits.
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveHome } from './home.mjs';

export const SKILL_DIR_NAME = 'dev-diagnosis';

export const SKILL_MD = `---
name: dev-diagnosis
description: Diagnose a repo before working in it — context noise that wastes tokens, missing commands, build-cache value, flaky tests. Run when starting work in a repository, after a build or test failure, or when an agent session feels slow.
---

# dev-diagnosis

Run this before reading a repo, and again after fixing what it finds.

## When to use it

- Starting work in a repository you have not diagnosed yet.
- An agent session feels slow, or the context looks full of files it should not be reading.
- A build is slow, a command is missing, or tests keep failing on retry.

## Run it

\`\`\`sh
dev-diagnosis all
\`\`\`

If the command is not installed, use \`npx dev-diagnosis-cli\` instead. Run it in the repo directory; pass a path to diagnose another one (\`dev-diagnosis all ./other-repo\`).

## Read the verdicts

- **context FAIL** — the repo has noise an AI agent should not read (build output, lockfiles, logs, oversized files). The report lists the files and the token estimate. Fix it with \`dev-diagnosis context --fix\`, which writes the suggestions into \`.aiignore\`, then re-run \`dev-diagnosis all\` to confirm the score is 100/100.
- **path FAIL** — a command is missing in the current shell. The report says which shell contexts have it and prints a copy-paste fix; apply the fix, then re-run.
- **flakes FAIL** — the report ranks the flaky tests. Look at the top-ranked test first; a test marked \`new\` broke recently, \`chronic\` has been unstable for a while.
- **cache FAIL** — the verdict says whether the build cache pays. If it costs more than it saves, the cache setup is the problem, not the build.

Skipped checks are not failures: they just need their input
(\`--command <name>\` for path, \`--flakes <runs-dir>\` for flakes,
\`-- <build-command>\` for cache).

## Rules

- Fix what FAILs before starting the real work; a 75/100 repo costs real tokens on every turn.
- Always re-run \`dev-diagnosis all\` after a fix and confirm it passes.
- Never edit \`.aiignore\` by hand to hide a failure you have not read — the file is the record of what the agent agreed not to read.
`;

export function skillPath(scope = 'project', base = process.cwd()) {
  if (scope === 'global') {
    return path.join(resolveHome(), '.claude', 'skills', SKILL_DIR_NAME, 'SKILL.md');
  }
  return path.join(path.resolve(base), '.claude', 'skills', SKILL_DIR_NAME, 'SKILL.md');
}

/**
 * Write the SKILL.md. Returns `{ path, created: true }` on success,
 * or `{ path, created: false, reason }` when the file already exists —
 * the caller prints the reason and exits 1.
 */
export function generateSkill(scope = 'project', base = process.cwd()) {
  const target = skillPath(scope, base);
  if (fs.existsSync(target)) {
    return { path: target, created: false, reason: `already exists: ${target}` };
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, SKILL_MD);
  return { path: target, created: true };
}
