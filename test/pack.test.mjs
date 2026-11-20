import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../lib/run-command.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Every relative file the README links must ship in the npm tarball:
 * npm renders the README on the package page, and a link to a file the
 * `files` whitelist leaves out is a broken image or a 404 there. This
 * caught docs/demo.gif and llms.txt, which the 0.2.2 tarball did not
 * contain — the package page showed a broken demo image while the
 * same README rendered fine on GitHub.
 */
test('pack: every relative file the README links ships in the npm tarball', () => {
  // On Windows `npm` is an `npm.cmd` shim, which spawnSync cannot run
  // without a shell — and naming the shim is not enough either: a bare
  // spawnSync('npm.cmd', ...) still comes back with status null on
  // all four Windows jobs (CI run #62). lib/run-command.mjs retries
  // a failed direct spawn through cmd.exe, which is the path its own
  // test suite pins on Windows, so run npm pack through it.
  const packed = runCommand(['npm', 'pack', '--dry-run', '--json'], { cwd: root });
  assert.equal(packed.status, 0, packed.stderr || packed.error);
  // npm lists tarball paths with forward slashes, but normalise
  // anyway: a backslash-separated listing must not fail the check
  // for a file that does ship.
  const files = new Set(JSON.parse(packed.stdout)[0].files.map((file) => file.path.replace(/\\/g, '/')));
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const links = [...readme.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1]);
  const relative = links.filter((link) => !link.startsWith('http') && !link.startsWith('#') && !link.startsWith('mailto:'));
  // The README must link at least one relative file, or this test
  // would pass vacuously.
  assert.ok(relative.length > 0, 'README should link at least one relative file');
  for (const link of relative) {
    assert.ok(files.has(link), `README links ${link} but npm pack does not ship it`);
  }
});
