import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('Render runtime contract is Node 24.21+ with free Postgres-backed web service', async () => {
  const [major, minor] = process.versions.node.split('.').map(Number);
  assert.equal(major, 24);
  assert.ok(minor >= 21, `expected Node 24.21+, got ${process.versions.node}`);

  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.engines.node, '>=24.21.0 <25');
  assert.ok(packageJson.dependencies.pg);

  const renderBlueprint = readFileSync(new URL('../render.yaml', import.meta.url), 'utf8');
  assert.match(renderBlueprint, /type:\s*web/);
  assert.match(renderBlueprint, /plan:\s*free/);
  assert.match(renderBlueprint, /startCommand:\s*npm run bot/);
  assert.match(renderBlueprint, /healthCheckPath:\s*\/healthz/);
  assert.match(renderBlueprint, /key: HOMEWORK_DATABASE_URL/);
  assert.match(renderBlueprint, /key: HOMEWORK_SYNC_INTERVAL_MINUTES[\s\S]*value:\s*"20"/);
  assert.doesNotMatch(renderBlueprint, /type:\s*worker|mountPath:|HOMEWORK_DATABASE_PATH/u);

  const envExample = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  assert.match(envExample, /HOMEWORK_DATABASE_URL=/);
  assert.match(envExample, /HOMEWORK_SYNC_INTERVAL_MINUTES=10/);
  assert.doesNotMatch(envExample, /HOMEWORK_DATABASE_PATH/u);
});

test('bot starts the health server before database and initial sync setup', () => {
  const botCli = readFileSync(new URL('../src/bot-cli.js', import.meta.url), 'utf8');
  const healthStart = botCli.indexOf('healthServer = await startHealthServer');
  const databaseStart = botCli.indexOf('database = await createHomeworkDatabase');
  assert.ok(healthStart >= 0);
  assert.ok(databaseStart > healthStart, 'health server must start before database and initial sync');
});
