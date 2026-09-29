import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildClassroomCaptureUrl,
  buildClassroomCookieHeader,
  isAllowedClassroomCaptureUrl,
  parseClassroomCaptureAction,
  startClassroomCookieCapture,
} from '../src/classroom-cookie-capture.js';

test('server capture URL uses the configured Classroom account scope', () => {
  assert.equal(
    buildClassroomCaptureUrl('1'),
    'https://classroom.google.com/u/1/a/not-turned-in/all',
  );
  assert.throws(() => buildClassroomCaptureUrl('11'), /CLASSROOM_AUTHUSER_INDEX/u);
});

test('capture browser navigation stays on HTTPS Google properties', () => {
  assert.equal(isAllowedClassroomCaptureUrl('https://classroom.google.com/u/1/'), true);
  assert.equal(isAllowedClassroomCaptureUrl('https://accounts.google.com/'), true);
  assert.equal(isAllowedClassroomCaptureUrl('http://classroom.google.com/u/1/'), false);
  assert.equal(isAllowedClassroomCaptureUrl('https://google.com.attacker.example/'), false);
  assert.equal(isAllowedClassroomCaptureUrl('https://example.com/'), false);
});

test('cookie export joins only applicable browser cookies into a Cookie header', () => {
  assert.equal(buildClassroomCookieHeader([
    { name: 'SID', value: 'session-one' },
    { name: '__Secure-BUCKET', value: 'secure-two', secure: true },
    { name: '', value: 'ignored' },
    null,
  ]), 'SID=session-one; __Secure-BUCKET=secure-two');
  assert.equal(buildClassroomCookieHeader([]), '');
  assert.throws(() => buildClassroomCookieHeader(null), /cookie list/u);
});

test('remote browser actions accept bounded inputs only', () => {
  assert.deepEqual(parseClassroomCaptureAction({ type: 'click', x: 100, y: 200 }), {
    type: 'click', x: 100, y: 200,
  });
  assert.deepEqual(parseClassroomCaptureAction({ type: 'type', text: 'user input' }), {
    type: 'type', text: 'user input',
  });
  assert.deepEqual(parseClassroomCaptureAction({ type: 'press', key: 'Enter' }), {
    type: 'press', key: 'Enter',
  });
  assert.throws(() => parseClassroomCaptureAction({ type: 'click', x: -1, y: 4 }), /coordinates/u);
  assert.throws(() => parseClassroomCaptureAction({ type: 'type', text: 'x'.repeat(2049) }), /too long/u);
  assert.throws(() => parseClassroomCaptureAction({ type: 'evaluate', code: '1+1' }), /Unsupported/u);
});

test('capture mode requires a long access key before launching a browser', async () => {
  let launched = false;
  await assert.rejects(startClassroomCookieCapture({
    env: { CLASSROOM_COOKIE_CAPTURE_ACCESS_KEY: 'short' },
    launchBrowser: async () => {
      launched = true;
      return {};
    },
  }), /at least 32 characters/u);
  assert.equal(launched, false);
});

test('one authorized capture verifies Node auth and logs the header only once', async () => {
  const exportedCookies = [
    { name: 'SID', value: 'test-session-1' },
    { name: 'HSID', value: 'test-session-2' },
    { name: 'SSID', value: 'test-session-3' },
    { name: 'SAPISID', value: 'test-session-4' },
    { name: '__Secure-1PSID', value: 'test-session-5', secure: true },
  ];
  const logs = [];
  let verifiedHeader = null;
  let browserClosed = false;
  let navigationStarted = false;
  const page = {
    url: () => 'https://classroom.google.com/u/1/a/not-turned-in/all',
    setDefaultTimeout() {},
    async route() {},
    async goto() {
      navigationStarted = true;
      await new Promise(() => {});
    },
    async screenshot() { return Buffer.from('fake screenshot'); },
  };
  const context = {
    async newPage() { return page; },
    async cookies() { return exportedCookies; },
  };
  const browser = {
    async newContext() { return context; },
    async close() { browserClosed = true; },
  };

  const capture = await startClassroomCookieCapture({
    env: {
      CLASSROOM_AUTHUSER_INDEX: '1',
      CLASSROOM_COOKIE_CAPTURE_ACCESS_KEY: 'test-access-key-'.padEnd(32, 'x'),
    },
    logger: (message) => logs.push(message),
    launchBrowser: async () => browser,
    verifyNode: async ({ cookieHeader }) => {
      verifiedHeader = cookieHeader;
      return true;
    },
    port: 0,
    host: '127.0.0.1',
    timeoutMs: 60_000,
  });
  const address = capture.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    assert.equal(navigationStarted, true);
    assert.equal((await fetch(`${baseUrl}/healthz`)).status, 200);
    const unauthenticated = await fetch(`${baseUrl}/capture/classroom/frame`);
    assert.equal(unauthenticated.status, 404);

    const loginPage = await fetch(`${baseUrl}/capture/classroom`);
    assert.equal(loginPage.status, 200);
    assert.match(await loginPage.text(), /type="password"/u);

    const login = await fetch(`${baseUrl}/capture/classroom/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'test-access-key-'.padEnd(32, 'x') }),
    });
    assert.equal(login.status, 200);
    const sessionCookie = login.headers.get('set-cookie').split(';', 1)[0];
    assert.match(login.headers.get('set-cookie'), /HttpOnly/u);
    assert.match(login.headers.get('set-cookie'), /SameSite=Strict/u);

    const exported = await fetch(`${baseUrl}/capture/classroom/export`, {
      method: 'POST',
      headers: { cookie: sessionCookie },
    });
    assert.equal(exported.status, 200);
    const result = await exported.json();
    assert.equal(result.nodeAccepted, true);
    assert.equal(result.count, 5);
    assert.deepEqual(result.names, exportedCookies.map(({ name }) => name));
    assert.equal(verifiedHeader, 'SID=test-session-1; HSID=test-session-2; SSID=test-session-3; SAPISID=test-session-4; __Secure-1PSID=test-session-5');
    assert.equal(logs.filter((message) => message.includes('CLASSROOM_COOKIE_HEADER=')).length, 1);
    assert.ok(logs.some((message) => message.includes(`CLASSROOM_COOKIE_HEADER=${verifiedHeader}`)));
    assert.doesNotMatch(JSON.stringify(result), /test-session/u);
    assert.equal(browserClosed, true);

    const secondExport = await fetch(`${baseUrl}/capture/classroom/export`, {
      method: 'POST',
      headers: { cookie: sessionCookie },
    });
    assert.equal(secondExport.status, 410);
  } finally {
    await capture.close();
  }
});

test('capture does not log a header when Node cannot read coursework', async () => {
  const logs = [];
  let browserClosed = false;
  const page = {
    url: () => 'https://classroom.google.com/u/1/a/not-turned-in/all',
    setDefaultTimeout() {},
    async route() {},
    async goto() {},
  };
  const browser = {
    async newContext() {
      return {
        async newPage() { return page; },
        async cookies() {
          return Array.from({ length: 5 }, (_, index) => ({
            name: `cookie-${index}`,
            value: `fake-${index}`,
          }));
        },
      };
    },
    async close() { browserClosed = true; },
  };
  const capture = await startClassroomCookieCapture({
    env: {
      CLASSROOM_AUTHUSER_INDEX: '1',
      CLASSROOM_COOKIE_CAPTURE_ACCESS_KEY: 'test-access-key-'.padEnd(32, 'x'),
    },
    logger: (message) => logs.push(message),
    launchBrowser: async () => browser,
    verifyNode: async () => false,
    port: 0,
    host: '127.0.0.1',
    timeoutMs: 60_000,
  });
  const address = capture.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const login = await fetch(`${baseUrl}/capture/classroom/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'test-access-key-'.padEnd(32, 'x') }),
    });
    const sessionCookie = login.headers.get('set-cookie').split(';', 1)[0];
    const exported = await fetch(`${baseUrl}/capture/classroom/export`, {
      method: 'POST',
      headers: { cookie: sessionCookie },
    });

    assert.equal(exported.status, 502);
    assert.match((await exported.json()).error, /header не выведен/u);
    assert.equal(logs.some((message) => message.includes('CLASSROOM_COOKIE_HEADER=')), false);
    assert.equal(browserClosed, false);
  } finally {
    await capture.close();
  }
});
