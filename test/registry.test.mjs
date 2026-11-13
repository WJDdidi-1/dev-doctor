import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const server = JSON.parse(readFileSync(path.join(root, 'server.json'), 'utf8'));

// The official MCP registry (registry.modelcontextprotocol.io) checks that
// the npm package carries an mcpName equal to the server name, and that the
// versions agree. These tests pin those invariants so a version bump that
// forgets server.json fails CI instead of shipping a stale registry listing.

test('registry: package.json mcpName matches server.json name', () => {
  assert.equal(pkg.mcpName, server.name);
  assert.equal(server.name, 'io.github.WJDdidi-1/dev-diagnosis');
});

test('registry: server.json version matches the package version', () => {
  assert.equal(server.version, pkg.version);
  assert.equal(server.packages[0].version, pkg.version);
});

test('registry: server.json points at the public npm package over stdio', () => {
  assert.equal(server.packages[0].registryType, 'npm');
  assert.equal(server.packages[0].registryBaseUrl, 'https://registry.npmjs.org');
  assert.equal(server.packages[0].identifier, pkg.name);
  assert.equal(server.packages[0].transport.type, 'stdio');
  assert.ok(server.description.length <= 100, 'registry description must be at most 100 characters');
});
