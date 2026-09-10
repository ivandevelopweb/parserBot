import test from 'node:test';
import assert from 'node:assert/strict';

import { HEALTH_PATH, startHealthServer } from '../src/health-server.js';

async function get(server, path) {
  const address = server.server.address();
  return fetch(`http://127.0.0.1:${address.port}${path}`);
}

test('health server exposes a quiet 200 health endpoint and rejects other paths', async () => {
  const server = await startHealthServer({
    port: 0,
    host: '127.0.0.1',
    readiness: () => true,
  });

  try {
    const health = await get(server, HEALTH_PATH);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });

    const other = await get(server, '/');
    assert.equal(other.status, 404);
  } finally {
    await server.close();
  }
});

test('health server reports unavailable while readiness is false', async () => {
  const server = await startHealthServer({
    port: 0,
    host: '127.0.0.1',
    readiness: () => false,
  });

  try {
    const response = await get(server, HEALTH_PATH);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { status: 'unavailable' });
  } finally {
    await server.close();
  }
});
