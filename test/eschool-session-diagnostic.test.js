import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadEschoolCookieJar,
  runEschoolSessionDiagnostic,
} from '../src/eschool-session-diagnostic-cli.js';

const COOKIE_DATA = {
  version: 1,
  cookies: [
    {
      name: 'refresh_token',
      value: 'artificial-parent-refresh',
      domain: '.eschool-ua.com',
      path: '/',
      expires: '2026-10-31T23:59:59.000Z',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
    },
    {
      name: 'session_token',
      value: 'artificial-parent-session',
      domain: '.eschool-ua.com',
      path: '/',
      expires: null,
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
    },
    {
      name: 'application_token',
      value: 'artificial-diary-application',
      domain: 'diary.eschool-ua.com',
      path: '/',
      expires: '2026-10-31T23:59:59.000Z',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
    },
  ],
};

async function withCookieFile(callback, data = COOKIE_DATA) {
  const directory = await mkdtemp(join(tmpdir(), 'eschool-diagnostic-'));
  const filePath = join(directory, 'eschool-cookies.json');
  await writeFile(filePath, JSON.stringify(data), 'utf8');
  try {
    return await callback(filePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function responseFor(url, body, options = {}) {
  const response = new Response(body, options);
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

test('cookie loader preserves parent and diary domain scope without exposing values', async () => {
  await withCookieFile(async (filePath) => {
    const { jar } = await loadEschoolCookieJar(filePath);
    assert.match(await jar.getCookieString('https://eschool-ua.com/'), /refresh_token=/);
    assert.match(await jar.getCookieString('https://eschool-ua.com/'), /session_token=/);
    assert.match(await jar.getCookieString('https://diary.eschool-ua.com/'), /application_token=/);
    assert.doesNotMatch(
      await jar.getCookieString('https://eschool-ua.com/'),
      /application_token=/,
    );
  });
});

test('diagnostic uses the imported session and never requests login', async () => {
  await withCookieFile(async (filePath) => {
    const requests = [];
    const logs = [];
    const fetchImpl = async (url, options = {}) => {
      const textUrl = String(url);
      requests.push({ url: textUrl, method: options.method ?? 'GET' });
      if (textUrl === 'https://eschool-ua.com/portal') {
        return responseFor(textUrl, 'portal ok', {
          status: 200,
          headers: {
            'set-cookie': 'refresh_token=artificial-parent-refresh-rotated; Domain=.eschool-ua.com; Path=/; Secure',
          },
        });
      }
      if (textUrl.endsWith('/api/v1/seplogin')) {
        if (options.method === 'POST') {
          return responseFor(textUrl, JSON.stringify({ ok: true }), {
            status: 200,
            headers: {
              'set-cookie': 'application_token=artificial-diary-application-rotated; Domain=diary.eschool-ua.com; Path=/; Secure',
            },
          });
        }
        return responseFor(textUrl, JSON.stringify({
          Items: [{ school_id: 8276, user_id: 1, role: 'schoolboy' }],
        }), { status: 200 });
      }
      if (textUrl.includes('/Appointment')) {
        return responseFor(textUrl, JSON.stringify({ Appointment: [] }), { status: 200 });
      }
      throw new Error('unexpected request');
    };

    const result = await runEschoolSessionDiagnostic({
      cookiePath: filePath,
      fetchImpl,
      logger: (line) => logs.push(line),
    });

    assert.equal(result.code, 'RESULT_A');
    assert.equal(requests.some(({ url }) => url.endsWith('/login')), false);
    assert.equal(requests.some(({ url }) => url === 'https://eschool-ua.com/portal'), true);
    assert.equal(logs.some((line) => line.includes('artificial-parent-refresh')), false);
    assert.equal(logs.some((line) => line.includes('artificial-parent-session')), false);
    assert.equal(logs.some((line) => line.includes('artificial-diary-application')), false);
    assert.equal(logs.some((line) => line.includes('"refresh_token_rotated":true')), true);
    assert.equal(logs.some((line) => line.includes('"application_token_rotated":true')), true);
    assert.equal(JSON.stringify(result).includes('artificial-parent-refresh'), false);
    assert.equal(JSON.stringify(result).includes('artificial-parent-session'), false);
    assert.equal(JSON.stringify(result).includes('artificial-diary-application'), false);
  });
});

test('diagnostic classifies an existing Diary session plus portal challenge as RESULT_B', async () => {
  await withCookieFile(async (filePath) => {
    const fetchImpl = async (url) => {
      const textUrl = String(url);
      if (textUrl === 'https://eschool-ua.com/portal') {
        return responseFor(textUrl, 'challenge', {
          status: 403,
          headers: { 'cf-mitigated': 'challenge' },
        });
      }
      if (textUrl.includes('/Appointment')) {
        return responseFor(textUrl, JSON.stringify({ Appointment: [] }), { status: 200 });
      }
      if (textUrl.endsWith('/api/v1/seplogin')) {
        return responseFor(textUrl, JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error('unexpected request');
    };

    const lines = [];
    const result = await runEschoolSessionDiagnostic({
      cookiePath: filePath,
      fetchImpl,
      logger: (line) => lines.push(line),
    });

    assert.equal(result.code, 'RESULT_B');
    assert.match(lines.at(-1), /^RESULT_B$/);
  });
});
