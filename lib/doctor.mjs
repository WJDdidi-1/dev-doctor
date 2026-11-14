/**
 * Self-check: `dev-diagnosis doctor`.
 *
 * The method is Claude Code's `claude doctor`: one read-only command
 * that answers "is my install healthy?" instead of making the user
 * debug each piece by hand. The terminal form changes nothing — it
 * only reports, with a copy-paste fix per failure — so it works even
 * when the rest of the tool is misbehaving. The checks are the
 * failure modes from our own history:
 *
 * - node: engines says >= 18; a too-old Node fails everything before
 *   it starts.
 * - command: is `dev-diagnosis` resolvable on PATH? The 0.2.0 release
 *   wrote skill/config files to the wrong HOME on macOS/Windows, and
 *   the only way to see it was to look at the paths by hand; a check
 *   that names the resolved paths catches that class of mistake on
 *   the user's machine. Inside the dev-diagnosis source repo itself
 *   the fix is different (npx resolves the local package — see the
 *   README Troubleshooting entry), so that case gets its own fix.
 * - home: $HOME vs os.homedir() — the exact disagreement behind the
 *   0.2.0 bug. setup and --skill-generate --global write under
 *   resolveHome() ($HOME when set); if the OS reports a different
 *   home, the user is looking in the wrong place.
 * - skill: is a SKILL.md installed (project or global), and is its
 *   frontmatter valid? A broken frontmatter (name not matching the
 *   directory, description over the spec's limit) makes the skill
 *   silently never trigger, so existence alone is not enough.
 *   Advisory — the CLI works without it.
 * - mcp: reuses checkSetup() — which detected agents are wired.
 *   Advisory — agents are optional.
 * - aiignore: in a git repo, is there an .aiignore? Advisory.
 *
 * No update check: the tool is offline by design (no network, no
 * account), so a newer-version check would need a network call the
 * tool promises never to make.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveHome } from './home.mjs';
import { lookupCommand } from './pathcheck.mjs';
import { checkSetup } from './setup.mjs';
import { skillPath, validateSkillMd, SKILL_DIR_NAME } from './skill.mjs';

export const MIN_NODE_MAJOR = 18;

// One check: { id, name, status: 'ok' | 'warn' | 'fail', detail, fix? }.
// Warnings never fail the run — they are for optional wiring (skill,
// MCP, .aiignore). Failures are for things the tool itself needs.
export function runDoctor(options = {}) {
  const home = options.home || resolveHome();
  const pathEnv = options.pathEnv !== undefined ? options.pathEnv : process.env.PATH || '';
  const cwd = options.cwd || process.cwd();
  const nodeVersion = options.nodeVersion || process.version;
  // os.homedir() is injectable for tests: on POSIX it honours $HOME,
  // so a mismatch can only be produced on Windows (where it reads
  // the profile instead) — the test passes a different value in.
  const osHome = options.osHome || os.homedir();
  const checks = [];

  // Node: the engines floor. A too-old Node fails every check before
  // it starts, so this one is a failure, not a warning.
  const major = Number.parseInt(String(nodeVersion).replace(/^v/, '').split('.')[0], 10);
  checks.push(Number.isFinite(major) && major >= MIN_NODE_MAJOR
    ? { id: 'node', name: 'Node.js', status: 'ok', detail: `${nodeVersion} (>= ${MIN_NODE_MAJOR})` }
    : {
      id: 'node', name: 'Node.js', status: 'fail',
      detail: `${nodeVersion} is below the minimum ${MIN_NODE_MAJOR}`,
      fix: 'Install Node.js 18 or newer: https://nodejs.org',
    });

  // Command: is dev-diagnosis itself on PATH? The lookup reuses the
  // path check's own logic, so it reports broken symlinks and
  // non-executable copies instead of a bare "not found".
  const found = lookupCommand('dev-diagnosis', pathEnv);
  if (found.resolved) {
    checks.push({ id: 'command', name: 'Command', status: 'ok', detail: `dev-diagnosis resolves to ${found.path}` });
  } else {
    // Inside the source repo the installed command is the wrong fix:
    // npx resolves the local package, which has no node_modules/.bin
    // (see the README Troubleshooting entry) — run the local bin.
    let inSourceRepo = false;
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
      inSourceRepo = pkg.name === 'dev-diagnosis-cli';
    } catch { inSourceRepo = false; }
    checks.push({
      id: 'command', name: 'Command', status: 'fail',
      detail: `dev-diagnosis is not on PATH (${found.reason})`,
      fix: inSourceRepo
        ? 'You are inside the dev-diagnosis source repo: run node bin/dev-diagnosis.js here, or install it globally with npm install -g dev-diagnosis-cli'
        : 'Install it globally: npm install -g dev-diagnosis-cli (or run one-off with npx dev-diagnosis-cli)',
    });
  }

  // Home: the directory setup and --skill-generate --global write
  // into. Two failure modes: it is not writable, or $HOME and
  // os.homedir() disagree — the 0.2.0 bug was exactly that
  // disagreement, with files landing where the user was not looking.
  const envHome = process.env.HOME;
  let homeCheck;
  try {
    fs.accessSync(home, fs.constants.W_OK);
    homeCheck = { id: 'home', name: 'Home', status: 'ok', detail: `home resolves to ${home}` };
  } catch {
    homeCheck = {
      id: 'home', name: 'Home', status: 'fail',
      detail: `home directory is not writable: ${home}`,
      fix: 'Point HOME at a writable directory, or fix the permissions on it',
    };
  }
  if (homeCheck.status === 'ok' && envHome && envHome !== osHome) {
    homeCheck = {
      id: 'home', name: 'Home', status: 'warn',
      detail: `HOME=${envHome} but os.homedir()=${osHome} — setup and --skill-generate --global write under HOME`,
      fix: `If the files land somewhere unexpected, check ${envHome} first`,
    };
  }
  checks.push(homeCheck);

  // Skill: advisory — the CLI works without it, but an agent that
  // never finds the skill never runs the tool. Existence is not
  // enough: a broken frontmatter makes the skill silently never
  // trigger, so the installed file is validated too. A broken skill
  // warns (it never fails the run) and names the first problem.
  const projectSkill = skillPath('project', cwd);
  const globalSkill = skillPath('global');
  const foundSkill = fs.existsSync(projectSkill)
    ? { scope: 'project', path: projectSkill }
    : (fs.existsSync(globalSkill) ? { scope: 'global', path: globalSkill } : null);
  if (foundSkill === null) {
    checks.push({
      id: 'skill', name: 'Skill', status: 'warn',
      detail: 'no SKILL.md installed (project or global)',
      fix: 'Run dev-diagnosis --skill-generate in a repo, or --skill-generate --global for every repo',
    });
  } else {
    let validation;
    try {
      validation = validateSkillMd(fs.readFileSync(foundSkill.path, 'utf8'), SKILL_DIR_NAME);
    } catch {
      validation = { valid: false, problems: ['could not read SKILL.md'] };
    }
    if (validation.valid) {
      checks.push({ id: 'skill', name: 'Skill', status: 'ok', detail: `${foundSkill.scope} skill installed and valid: ${foundSkill.path}` });
    } else {
      const first = validation.problems[0];
      const more = validation.problems.length > 1 ? ` (+${validation.problems.length - 1} more)` : '';
      checks.push({
        id: 'skill', name: 'Skill', status: 'warn',
        detail: `${foundSkill.scope} skill is invalid: ${first}${more}`,
        fix: 'Fix the SKILL.md frontmatter (name must match the skill directory, description 1–1024 chars, no < or >), or delete it and re-run dev-diagnosis --skill-generate',
      });
    }
  }

  // MCP wiring: reuses checkSetup(), the same rows `setup --check`
  // prints. Advisory — agents are optional, and no detected agent
  // means there is nothing to wire.
  const setup = checkSetup({ home, pathEnv });
  if (setup.detected === 0) {
    checks.push({ id: 'mcp', name: 'MCP wiring', status: 'ok', detail: 'no supported agent detected — nothing to wire' });
  } else if (setup.allWired) {
    checks.push({ id: 'mcp', name: 'MCP wiring', status: 'ok', detail: `${setup.detected} detected agent(s), all wired` });
  } else {
    const unwired = setup.rows.filter((row) => !row.wired).map((row) => row.name);
    checks.push({
      id: 'mcp', name: 'MCP wiring', status: 'warn',
      detail: `${unwired.length} of ${setup.detected} detected agent(s) not wired: ${unwired.join(', ')}`,
      fix: 'Run dev-diagnosis setup to wire them',
    });
  }

  // .aiignore: advisory, and only in a git repo — outside one there
  // is nothing to ignore yet, so the check passes silently.
  if (!fs.existsSync(path.join(cwd, '.git'))) {
    checks.push({ id: 'aiignore', name: '.aiignore', status: 'ok', detail: 'not a git repo — nothing to check' });
  } else if (fs.existsSync(path.join(cwd, '.aiignore'))) {
    checks.push({ id: 'aiignore', name: '.aiignore', status: 'ok', detail: '.aiignore present in this repo' });
  } else {
    checks.push({
      id: 'aiignore', name: '.aiignore', status: 'warn',
      detail: 'no .aiignore in this repo',
      fix: 'Run dev-diagnosis context --fix to create one from the scan',
    });
  }

  const failed = checks.filter((check) => check.status === 'fail').length;
  const warnings = checks.filter((check) => check.status === 'warn').length;
  return { checks, passed: failed === 0, failed, warnings };
}
