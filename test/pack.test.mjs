import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

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
  // without a shell — a bare 'npm' fails to spawn (status null), so
  // name the shim there.
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const packed = spawnSync(npm, ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr);
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
