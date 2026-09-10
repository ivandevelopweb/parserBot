import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('Render runtime contract is Node 24.21+ and node:sqlite imports without a flag', async () => {
  const [major, minor] = process.versions.node.split('.').map(Number);
  assert.equal(major, 24);
  assert.ok(minor >= 21, `expected Node 24.21+, got ${process.versions.node}`);

  const sqlite = await import('node:sqlite');
  assert.equal(typeof sqlite.DatabaseSync, 'function');

  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.engines.node, '>=24.21.0 <25');

  const renderBlueprint = readFileSync(new URL('../render.yaml', import.meta.url), 'utf8');
  assert.match(renderBlueprint, /type:\s*worker/);
  assert.match(renderBlueprint, /startCommand:\s*npm run bot/);
  assert.match(renderBlueprint, /maxShutdownDelaySeconds:\s*120/);
  assert.match(renderBlueprint, /mountPath:\s*\/var\/data/);
});
