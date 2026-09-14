import test from 'node:test';
import assert from 'node:assert/strict';

import { HEALTH_PATH, startHealthServer } from '../src/health-server.js';

async function get(server, path) {
  const address = server.server.address();
  return fetch(`http://127.0.0.1:${address.port}${path}`);
}

test('health server uses PORT and binds all interfaces', async () => {
  const previousPort = process.env.PORT;
  process.env.PORT = '0';
  let server;
  try {
    server = await startHealthServer();
    const address = server.server.address();
    assert.equal(address.address, '0.0.0.0');
    assert.ok(address.port > 0);
    assert.equal((await get(server, HEALTH_PATH)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${address.port}${HEALTH_PATH}`, { method: 'HEAD' })).status, 200);
  } finally {
    await server?.close();
    if (previousPort === undefined) {
      delete process.env.PORT;
    } else {
      process.env.PORT = previousPort;
    }
  }
});

test('sync diagnostics report degradation without changing process readiness', async () => {
  let fail = false;
  const server = await startHealthServer({
    port: 0, host: '127.0.0.1',
    diagnostics: () => {
      if (fail) throw new Error('private database error');
      return { eschool: { status: 'error', stage: 'appointments', stale: true } };
    },
  });
  try {
    const response = await get(server, HEALTH_PATH);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).sync.eschool.stage, 'appointments');
    fail = true;
    const failed = await get(server, HEALTH_PATH);
    assert.equal(failed.status, 200);
    assert.deepEqual(await failed.json(), { status: 'ok', sync: { status: 'unavailable' } });
    const head = await fetch(`http://127.0.0.1:${server.server.address().port}${HEALTH_PATH}`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  } finally {
    await server.close();
  }
});

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

test('HEAD health checks preserve readiness status and headers without a response body', async () => {
  let ready = true;
  const server = await startHealthServer({
    port: 0,
    host: '127.0.0.1',
    readiness: () => ready,
  });
  const origin = `http://127.0.0.1:${server.server.address().port}`;

  try {
    for (const status of [200, 503]) {
      ready = status === 200;
      const response = await fetch(`${origin}${HEALTH_PATH}`, { method: 'HEAD' });
      assert.equal(response.status, status);
      assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(await response.text(), '');
    }

    const root = await fetch(`${origin}/`, { method: 'HEAD' });
    assert.equal(root.status, 404);
    const unsupported = await fetch(`${origin}${HEALTH_PATH}`, { method: 'POST' });
    assert.equal(unsupported.status, 404);
  } finally {
    await server.close();
  }
});
