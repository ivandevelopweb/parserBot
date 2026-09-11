import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CookieJar } from 'tough-cookie';

import {
  CLASSROOM_COURSES_PATH,
  CLASSROOM_COURSES_RPC_ID,
  CLASSROOM_COURSES_URL,
  CLASSROOM_HOME_PATH,
  CLASSROOM_HOME_URL,
  CLASSROOM_TURNED_IN_PATH,
  CLASSROOM_TURNED_IN_URL,
  CLASSROOM_NOT_TURNED_IN_STATES,
  MAX_CLASSROOM_COURSEWORK_PAGES,
  CLASSROOM_RPC_ID,
  callClassroomRpc,
  createClassroomCookieJar,
  createClassroomWebClient,
  createCourseListRpcPayload,
  createCourseWorkRpcPayload,
  decodeBatchexecuteResponse,
  decodeCourseListPayload,
  decodeCourseWorkPayload,
  extractClassroomBootstrap,
  extractCourseWorkContinuationToken,
  getCourses,
  getCourseWorkForCourse,
  inspectClassroomPayload,
  inspectClassroomRawResponse,
  inspectBatchexecuteResponse,
  loadClassroomCookies,
  parseClassroomCookies,
  parseClassroomCookieHeader,
} from '../src/classroom-web.js';

const BOOTSTRAP = {
  at: 'at-test-value',
  fSid: 'sid-test-value',
  bl: 'build-test-value',
};

const KNOWN_COURSE_WORK_PAYLOAD = JSON.parse(String.raw`[[100,null,1,0],[[[1,1,1,1,1,null,null,[1,1,1,null,1,1,1],1,1,1,1,1,1,null,null,null,null,1,null,null,null,1,[1],1,[null,null,1,1,1,null,1]],[1,1,1,1,1,1,[1],1,null,[1,1],1,1,null,1,[[1,1,[],[null,1]],1,1],null,null,null,1],[null,1],null,[1,1]],[[1,1,1,1,1,null,null,[1,1,1,null,1,1,1],1,1,1,1,1,1,null,null,null,null,1,null,null,null,1,[1],1,[null,null,1,1,1,null,1]]],[[1,1,1,1,1,null,null,[1,1,1,null,1,1,1],1,1,1,1,1,1,null,null,null,null,1,null,null,null,1,[1],1,[null,null,1,1,1,null,1]],[1,1,1,1,1,1,[1],1,null,[1,1],1,1,null,1,[[1,1,[],[null,1]],1,1],null,null,null,1],[1]],null,null,[[1,1,1,1,1,null,null,[1,1,1,null,1,1,1],1,1,1,1,1,1,null,null,null,null,1,null,null,null,1,[1],1,[null,null,1,1,1,null,1]]]],[[null,[[544644036115]],[2,5],[2],null,null,null,null,null,null,null,null,null,null,[3,4,8,10,5,7,9,6,11]]]]`);
// Keep the wire-shape fixture intact while reflecting the new default request filter.
KNOWN_COURSE_WORK_PAYLOAD[2][0][14] = [1, 2];

function bootstrapHtml() {
  return `<!doctype html><html><head><title>Classroom</title></head><body>
    <script>window.WIZ_global_data = ${JSON.stringify({
      SNlM0e: BOOTSTRAP.at,
      FdrFJe: BOOTSTRAP.fSid,
      cfb2h: BOOTSTRAP.bl,
    })};</script>
  </body></html>`;
}

function batchexecuteResponse(rpcid, payload) {
  const nested = JSON.stringify(payload);
  const outer = JSON.stringify([['wrb.fr', rpcid, nested, null, null, null, 'generic']]);
  return `)]}'\n${Buffer.byteLength(outer)}\n${outer}`;
}

test('Classroom cookie loader accepts browser arrays, wrappers, and map objects', async () => {
  const jar = await createClassroomCookieJar({
    cookies: [
      { name: 'SID', value: 'sid-value', domain: '.google.com', secure: true },
      { name: 'HSID', value: 'hsid-value', domain: 'classroom.google.com', path: '/' },
    ],
  });
  const cookieString = await jar.getCookieString(CLASSROOM_HOME_URL);
  assert.match(cookieString, /SID=sid-value/);
  assert.match(cookieString, /HSID=hsid-value/);

  const wrapped = await createClassroomCookieJar({
    cookies: { cookies: [{ name: 'A', value: 'one', domain: 'google.com' }] },
  });
  assert.match(await wrapped.getCookieString(CLASSROOM_HOME_URL), /A=one/);

  const mapped = await createClassroomCookieJar({
    cookies: { B: 'two' },
  });
  assert.match(await mapped.getCookieString(CLASSROOM_HOME_URL), /B=two/);
});

test('Classroom Cookie header parser accepts ordinary pairs and values containing equals signs', async () => {
  const records = parseClassroomCookieHeader(' SID=sid-value; PREF=one=two ; EMPTY= ');
  assert.deepEqual(records.map(({ name, value }) => ({ name, value })), [
    { name: 'SID', value: 'sid-value' },
    { name: 'PREF', value: 'one=two' },
    { name: 'EMPTY', value: '' },
  ]);
  assert.equal(records[0].domain, 'classroom.google.com');

  const jar = await createClassroomCookieJar({
    cookieHeader: 'SID=sid-value; PREF=one=two',
  });
  const cookieString = await jar.getCookieString(CLASSROOM_HOME_URL);
  assert.match(cookieString, /SID=sid-value/);
  assert.match(cookieString, /PREF=one=two/);
});

test('Classroom cookie JSON errors use stable text without input or parser details', () => {
  const marker = 'COOKIE_JSON_SECRET_MARKER';

  assert.throws(
    () => parseClassroomCookies(`{"broken":"${marker}"`),
    (error) => error.message === 'Could not parse Classroom cookies JSON.'
      && !error.message.includes(marker),
  );
});

test('raw Classroom Cookie headers reject control characters before fetch or Headers.set', () => {
  const marker = 'COOKIE_HEADER_SECRET_MARKER';
  let fetchCalls = 0;

  assert.throws(
    () => createClassroomWebClient({
      env: { CLASSROOM_COOKIE_HEADER: `SID=sid-value\r\nX-Leak: ${marker}` },
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response('unexpected');
      },
    }),
    (error) => error.message === 'Classroom Cookie header contains invalid characters.'
      && !error.message.includes(marker),
  );
  assert.equal(fetchCalls, 0);

  assert.throws(
    () => parseClassroomCookieHeader(`SID=sid-value\nX-Leak=${marker}`),
    (error) => error.message === 'Classroom Cookie header contains invalid characters.'
      && !error.message.includes(marker),
  );
});

test('Classroom network errors expose only a safe status to callers and logs', async () => {
  const marker = 'NETWORK_ERROR_SECRET_MARKER';
  const client = createClassroomWebClient({
    env: { CLASSROOM_COOKIE_HEADER: 'SID=sid-value' },
    fetchImpl: async () => {
      throw new Error(`fetch failed for https://classroom.google.com/?at=${marker}`);
    },
  });

  await assert.rejects(
    client.getAuthenticatedPage(),
    (error) => error.code === 'CLASSROOM_NETWORK_ERROR'
      && error.message === 'Classroom request failed due to a network error.'
      && !error.message.includes(marker)
      && !error.cause,
  );
});

test('Classroom cookie jar reports a safe indexed configuration error', async () => {
  const marker = 'COOKIE_VALUE_SECRET_MARKER';

  await assert.rejects(
    createClassroomCookieJar({
      cookies: [{
        name: marker,
        value: marker,
        domain: 'not-classroom.example',
      }],
    }),
    (error) => error.message === 'Could not load Classroom cookie #1. Check the cookie export format.'
      && !error.message.includes(marker)
      && error.name === 'ConfigError',
  );
});

test('raw Classroom Cookie header is sent unchanged on the first GET before jar import', async () => {
  const rawHeader = 'SID=sid-value; PREF=one=two';
  const calls = [];
  const jar = new CookieJar();
  const client = createClassroomWebClient({
    env: { CLASSROOM_COOKIE_HEADER: rawHeader },
    cookieJar: jar,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(bootstrapHtml(), {
        status: 200,
        headers: { 'content-type': 'text/html; charset=UTF-8' },
      });
    },
  });

  const page = await client.getAuthenticatedPage();
  assert.equal(new Headers(calls[0].init.headers).get('cookie'), rawHeader);
  assert.equal(calls[0].init.redirect, 'manual');
  assert.deepEqual(page.diagnostics, {
    cookieHeaderConfigured: true,
    cookieHeaderLength: rawHeader.length,
    status: 200,
    finalUrl: 'classroom.google.com/a/not-turned-in/all',
    contentType: 'text/html; charset=UTF-8',
    responseLength: bootstrapHtml().length,
    looksLikeGoogleLogin: false,
    looksLikeClassroom: true,
    redirectChain: ['classroom.google.com/a/not-turned-in/all'],
  });

  assert.match(await jar.getCookieString(CLASSROOM_HOME_URL), /SID=sid-value/);
  assert.match(await jar.getCookieString(CLASSROOM_HOME_URL), /PREF=one=two/);
});

test('Classroom RPC reuses imported Cookie header and reports GET/POST parity safely', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'classroom-rpc-cookie-parity-'));
  const artifactPath = join(directory, 'response.debug.txt');
  const rawHeader = 'SID=sid-value; PREF=one=two';
  const calls = [];
  const client = createClassroomWebClient({
    env: { CLASSROOM_COOKIE_HEADER: rawHeader },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (calls.length === 1) {
        return new Response(bootstrapHtml(), {
          status: 200,
          headers: { 'content-type': 'text/html; charset=UTF-8' },
        });
      }
      return new Response(batchexecuteResponse(CLASSROOM_RPC_ID, { courseWork: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=UTF-8' },
      });
    },
  });

  try {
    const result = await client.getCourseWorkForCourse('course-1', {
      debug: true,
      debugArtifactPath: artifactPath,
    });
    const cookieDiagnostics = result.rpcDiagnostics.cookies;
    const postCookieHeader = new Headers(calls[1].init.headers).get('cookie');

    assert.deepEqual(cookieDiagnostics.get, {
      count: 2,
      length: rawHeader.length,
    });
    assert.equal(cookieDiagnostics.post.count, 2);
    assert.equal(cookieDiagnostics.post.length > 0, true);
    assert.equal(cookieDiagnostics.sameNames, true);
    assert.equal(typeof cookieDiagnostics.sameHeader, 'boolean');
    assert.equal(postCookieHeader.includes('sid-value'), true);
    assert.equal(postCookieHeader.includes('one=two'), true);
    assert.equal(result.rpcDiagnostics.request.bootstrapFromAuthenticatedPage, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('raw Classroom Cookie redirect diagnostics strip Google login query parameters', async () => {
  const calls = [];
  const client = createClassroomWebClient({
    env: { CLASSROOM_COOKIE_HEADER: 'SID=sid-value' },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (calls.length === 1) {
        return new Response(null, {
          status: 302,
          headers: {
            location: 'https://accounts.google.com/v3/signin?continue=https%3A%2F%2Fclassroom.google.com%2F&token=secret',
          },
        });
      }
      return new Response(
        '<html><title>Sign in - Google Accounts</title><input id="identifierId"></html>',
        { status: 200, headers: { 'content-type': 'text/html' } },
      );
    },
  });

  await assert.rejects(
    client.getAuthenticatedPage(),
    (error) => error.message === 'Classroom browser session expired; re-authentication required',
  );
  const diagnostics = client.getLastDiagnostics();
  assert.deepEqual(diagnostics.redirectChain, [
    'classroom.google.com/a/not-turned-in/all',
    'accounts.google.com/v3/signin',
  ]);
  assert.doesNotMatch(JSON.stringify(diagnostics), /\?|token|secret|SID|sid-value/);
  assert.equal(new Headers(calls[1].init.headers).has('cookie'), false);
});

test('Classroom Cookie header takes precedence over JSON and file sources', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'classroom-cookie-priority-'));
  const filePath = join(directory, 'cookies.json');
  try {
    await writeFile(filePath, JSON.stringify([{ name: 'FILE', value: 'file-value' }]));
    const cookies = loadClassroomCookies({
      env: {
        CLASSROOM_COOKIE_HEADER: 'HEADER=header-value',
        CLASSROOM_COOKIES_JSON: JSON.stringify([{ name: 'JSON', value: 'json-value' }]),
        CLASSROOM_COOKIES_FILE: filePath,
      },
      defaultPath: join(directory, 'not-present.json'),
    });
    assert.deepEqual(cookies.map(({ name }) => name), ['HEADER']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('malformed Classroom Cookie header errors do not echo cookie names or values', () => {
  assert.throws(
    () => parseClassroomCookieHeader('SID=secret-value; malformed'),
    (error) => error.message.includes('position 2')
      && !error.message.includes('SID')
      && !error.message.includes('secret-value'),
  );
});

test('malformed Classroom cookie records do not echo cookie names or values', () => {
  assert.throws(
    () => parseClassroomCookies([{ name: 'SENSITIVE_COOKIE_NAME' }]),
    (error) => error.message.includes('cookie #1')
      && !error.message.includes('SENSITIVE_COOKIE_NAME')
      && !error.message.includes('secret-value'),
  );
});

test('Classroom cookie file loading honors an explicitly configured path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'classroom-cookies-'));
  const filePath = join(directory, 'cookies.json');
  try {
    await writeFile(filePath, JSON.stringify([{ name: 'SID', value: 'file-value' }]));
    const cookies = loadClassroomCookies({
      env: { CLASSROOM_COOKIES_FILE: filePath },
      defaultPath: join(directory, 'not-present.json'),
    });
    assert.deepEqual(cookies.map(({ name }) => name), ['SID']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Classroom bootstrap extraction reads WIZ global aliases without exposing values in the source label', () => {
  const result = extractClassroomBootstrap(bootstrapHtml());
  assert.deepEqual(result, {
    ...BOOTSTRAP,
    source: 'WIZ_global_data (SNlM0e/FdrFJe/cfb2h)',
  });
  assert.doesNotMatch(result.source, /test-value/);
});

test('Classroom bootstrap extraction supports direct DOM fields', () => {
  const result = extractClassroomBootstrap(`
    <input name="at" value="at-dom">
    <input name="f.sid" value="sid-dom">
    <input name="bl" value="bl-dom">
  `);
  assert.equal(result.at, 'at-dom');
  assert.equal(result.fSid, 'sid-dom');
  assert.equal(result.bl, 'bl-dom');
});

test('pONvgf payload substitutes the requested course id and keeps the opaque mask stable', () => {
  const first = createCourseWorkRpcPayload('544644036115');
  const second = createCourseWorkRpcPayload('different-course');

  assert.equal(first[2][0][1][0][0], 544644036115);
  assert.equal(second[2][0][1][0][0], 'different-course');
  assert.equal(first[1][2].length, 3);
  assert.deepEqual(first[1][2][2], [1]);
  assert.equal(first[2][0].length, 15);
  assert.deepEqual(first, KNOWN_COURSE_WORK_PAYLOAD);
  assert.deepEqual(first[0], second[0]);
  assert.notDeepEqual(first, second);
});

test('pONvgf payload accepts an explicit Classroom state filter', () => {
  const payload = createCourseWorkRpcPayload('course-1', { displayStates: [3, 4] });
  assert.deepEqual(payload[2][0][14], [3, 4]);
  assert.deepEqual(CLASSROOM_NOT_TURNED_IN_STATES, [1, 2]);
});

test('batchexecute decoder handles XSSI, length framing, and nested JSON', () => {
  const payload = { courseWork: [{ assignmentId: 'work-1', title: 'Test' }] };
  const decoded = decodeBatchexecuteResponse(
    batchexecuteResponse(CLASSROOM_RPC_ID, payload),
    CLASSROOM_RPC_ID,
  );
  assert.deepEqual(decoded, payload);

  const withRaw = decodeBatchexecuteResponse(
    batchexecuteResponse(CLASSROOM_RPC_ID, payload),
    CLASSROOM_RPC_ID,
    { includeRaw: true },
  );
  assert.deepEqual(withRaw.payload, payload);
  assert.equal(withRaw.raw.length, 1);
});

test('batchexecute inspector distinguishes a raw null payload from nested JSON', () => {
  const rawNullDocument = JSON.stringify([
    ['wrb.fr', CLASSROOM_RPC_ID, null, null, null, null, 'generic'],
    ['wrb.fr', 'otherRpc', JSON.stringify({ ok: true }), null],
  ]);
  const rawNullResponse = `)]}'\n${Buffer.byteLength(rawNullDocument) + 2}\n${rawNullDocument}\n`;
  const rawNullDiagnostics = inspectBatchexecuteResponse(rawNullResponse, CLASSROOM_RPC_ID);

  assert.equal(rawNullDiagnostics.rawResponseLength, rawNullResponse.length);
  assert.equal(rawNullDiagnostics.firstFrameLength, Buffer.byteLength(rawNullDocument) + 2);
  assert.equal(rawNullDiagnostics.firstFramePrefix, `wrb.fr/${CLASSROOM_RPC_ID}`);
  assert.equal(rawNullDiagnostics.wrbFrFramesCount, 2);
  assert.deepEqual(rawNullDiagnostics.rpcIds, [CLASSROOM_RPC_ID, 'otherRpc']);
  assert.equal(rawNullDiagnostics.payloadFieldType, 'null');
  assert.equal(
    decodeBatchexecuteResponse(rawNullResponse, CLASSROOM_RPC_ID, { includeRaw: true }).payload,
    null,
  );

  const nestedResponse = batchexecuteResponse(CLASSROOM_RPC_ID, { ok: true });
  const nestedDiagnostics = inspectBatchexecuteResponse(nestedResponse, CLASSROOM_RPC_ID);
  assert.equal(nestedDiagnostics.payloadFieldType, 'string');
  assert.notEqual(
    decodeBatchexecuteResponse(nestedResponse, CLASSROOM_RPC_ID),
    null,
  );
});

test('batchexecute inspector handles multiple length-prefixed response chunks', () => {
  const firstDocument = JSON.stringify([['wrb.fr', 'firstRpc', JSON.stringify({ first: true })]]);
  const secondDocument = JSON.stringify([[
    'wrb.fr',
    CLASSROOM_RPC_ID,
    JSON.stringify({ second: true, title: 'Завдання' }),
  ]]);
  const response = `)]}'\n${Buffer.byteLength(firstDocument)}\n${firstDocument}`
    + `${Buffer.byteLength(secondDocument)}\n${secondDocument}`;
  const diagnostics = inspectBatchexecuteResponse(response, CLASSROOM_RPC_ID);

  assert.equal(diagnostics.wrbFrFramesCount, 2);
  assert.deepEqual(diagnostics.rpcIds, ['firstRpc', CLASSROOM_RPC_ID]);
  assert.equal(diagnostics.payloadFieldType, 'string');
  assert.deepEqual(decodeBatchexecuteResponse(response, CLASSROOM_RPC_ID), { second: true, title: 'Завдання' });
});

test('batchexecute decoder surfaces an RPC error frame', () => {
  const outer = JSON.stringify([['er', CLASSROOM_RPC_ID, 'permission denied']]);
  assert.throws(
    () => decodeBatchexecuteResponse(`)]}'\n${outer}`, CLASSROOM_RPC_ID),
    /returned an error/,
  );
});

test('Classroom payload inspector recursively finds values in nested JSON strings and reports array context', () => {
  const payload = [
    'wrapper',
    JSON.stringify({
      coursework: [[
        '878109743041',
        {
          courseId: '544644036115',
          title: '11.09 Кайдашева сім’я',
        },
      ]],
    }),
  ];
  const diagnostics = inspectClassroomPayload(payload, {
    assignmentId: '878109743041',
    courseId: '544644036115',
    titleFragment: '11.09 Кайдашева',
  });

  assert.equal(diagnostics.matches.assignmentId.found, true);
  assert.equal(diagnostics.matches.courseId.found, true);
  assert.equal(diagnostics.matches.titleFragment.found, true);
  assert.match(diagnostics.matches.assignmentId.paths[0], /<nested-json>/);
  assert.equal(diagnostics.contexts.length, 1);
  assert.equal(diagnostics.contexts[0].parentLength, 2);
  assert.deepEqual(diagnostics.contexts[0].neighbours, [{ index: 1, type: 'object' }]);
});

test('Classroom raw payload inspection stays at the pre-nested-decoding layer', () => {
  const diagnostics = inspectClassroomRawResponse(
    'prefix 878109743041 and 544644036115; no title',
    {
      assignmentId: '878109743041',
      courseId: '544644036115',
      titleFragment: '11.09 Кайдашева',
    },
  );
  assert.deepEqual(diagnostics, {
    assignmentId: true,
    courseId: true,
    titleFragment: false,
  });
});

test('Classroom RPC helper sends the expected safe request shape and returns decoded payload', async () => {
  const calls = [];
  const rpcPayload = {
    courseWork: [{
      assignmentId: 'work-1',
      courseId: 'course-1',
      title: 'Тестове завдання',
    }],
  };
  const client = {
    requestIdFactory: () => '4321',
    async request(url, init) {
      calls.push({ url, init });
      return new Response(batchexecuteResponse(CLASSROOM_RPC_ID, rpcPayload), { status: 200 });
    },
  };

  const result = await callClassroomRpc({
    client,
    rpcid: CLASSROOM_RPC_ID,
    sourcePath: '/a/not-turned-in/all',
    bootstrap: BOOTSTRAP,
    payload: createCourseWorkRpcPayload('course-1'),
  });

  assert.deepEqual(result, rpcPayload);
  assert.equal(calls.length, 1);
  const requestUrl = new URL(calls[0].url);
  assert.equal(requestUrl.searchParams.get('rpcids'), CLASSROOM_RPC_ID);
  assert.equal(requestUrl.searchParams.get('source-path'), '/a/not-turned-in/all');
  assert.equal(requestUrl.searchParams.get('f.sid'), BOOTSTRAP.fSid);
  assert.equal(requestUrl.searchParams.get('bl'), BOOTSTRAP.bl);
  assert.equal(requestUrl.searchParams.get('_reqid'), '4321');

  const body = calls[0].init.body;
  const fReq = JSON.parse(body.get('f.req'));
  assert.equal(fReq[0][0][0], CLASSROOM_RPC_ID);
  assert.deepEqual(JSON.parse(fReq[0][0][1]), createCourseWorkRpcPayload('course-1'));
  assert.equal(body.get('at'), BOOTSTRAP.at);
});

test('Classroom RPC debug captures response metadata and saves only the raw body', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'classroom-rpc-debug-'));
  const artifactPath = join(directory, 'response.debug.txt');
  const calls = [];
  const rawResponse = batchexecuteResponse(CLASSROOM_RPC_ID, { courseWork: [] });
  const client = {
    requestIdFactory: () => '4321',
    async request(url, init) {
      calls.push({ url, init });
      return new Response(rawResponse, {
        status: 200,
        headers: { 'content-type': 'application/json; charset=UTF-8' },
      });
    },
  };

  try {
    const result = await callClassroomRpc({
      client,
      rpcid: CLASSROOM_RPC_ID,
      sourcePath: '/a/not-turned-in/all',
      bootstrap: BOOTSTRAP,
      payload: createCourseWorkRpcPayload('course-1'),
      expectedCourseId: 'course-1',
      debugTargets: {
        assignmentId: '878109743041',
        courseId: '544644036115',
        titleFragment: '11.09 Кайдашева',
      },
      debug: true,
      debugArtifactPath: artifactPath,
    });

    assert.deepEqual(result.payload, { courseWork: [] });
    assert.equal(await readFile(artifactPath, 'utf8'), rawResponse);
    assert.equal(result.diagnostics.status, 200);
    assert.equal(result.diagnostics.contentType, 'application/json; charset=UTF-8');
    assert.equal(result.diagnostics.rawResponseLength, rawResponse.length);
    assert.equal(result.diagnostics.hasXssiPrefix, true);
    assert.equal(result.diagnostics.firstFrameLength, rawResponse.split('\n')[1] && Number(rawResponse.split('\n')[1]));
    assert.equal(result.diagnostics.firstFrameActualLength, rawResponse.split('\n').slice(2).join('\n').length);
    assert.equal(result.diagnostics.firstFramePrefix, `wrb.fr/${CLASSROOM_RPC_ID}`);
    assert.equal(result.diagnostics.wrbFrFramesCount, 1);
    assert.deepEqual(result.diagnostics.rpcIds, [CLASSROOM_RPC_ID]);
    assert.equal(result.diagnostics.payloadFieldType, 'string');
    assert.deepEqual(result.diagnostics.rawMatches, {
      assignmentId: false,
      courseId: false,
      titleFragment: false,
    });
    assert.equal(result.diagnostics.request.rpcid, CLASSROOM_RPC_ID);
    assert.equal(result.diagnostics.request.sourcePath, '/a/not-turned-in/all');
    assert.equal(
      result.diagnostics.request.fReqLength,
      new URLSearchParams(calls[0].init.body).get('f.req').length,
    );
    assert.equal(result.diagnostics.request.fReqContainsCourseId, true);
    assert.equal(result.diagnostics.request.formBodyLength, calls[0].init.body.toString().length);
    assert.equal(result.diagnostics.request.atConfigured, true);
    assert.equal(result.diagnostics.request.fSidConfigured, true);
    assert.equal(result.diagnostics.request.blConfigured, true);
    assert.equal(result.diagnostics.request.bootstrapFromAuthenticatedPage, false);
    assert.equal(result.diagnostics.request.headers.originExact, true);
    assert.equal(result.diagnostics.request.headers.refererExact, true);
    assert.equal(result.diagnostics.request.headers.contentTypeExact, true);
    assert.equal(result.diagnostics.request.headers.sameDomain, true);
    assert.equal(result.diagnostics.request.headers.acceptConfigured, true);
    assert.equal(result.diagnostics.request.headers.userAgentConfigured, true);
    assert.equal(result.diagnostics.request.body.fReqWrapperMatches, true);
    assert.equal(result.diagnostics.request.body.fReqEncodedOnce, true);
    assert.equal(result.diagnostics.request.body.contentTypeExact, true);
    assert.equal(result.diagnostics.cookies, null);
    assert.equal(result.diagnostics.debugRunId, null);
    assert.equal(result.diagnostics.debugArtifactPath, artifactPath);
    assert.equal(calls[0].init.headers['Content-Type'], 'application/x-www-form-urlencoded;charset=UTF-8');
    const serializedBody = calls[0].init.body.toString();
    assert.match(serializedBody, /f\.req=%5B/);
    assert.doesNotMatch(serializedBody, /%255B/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Classroom RPC 429 is bounded and does not retry', async () => {
  let requestCount = 0;
  const client = {
    requestIdFactory: () => '4321',
    async request() {
      requestCount += 1;
      return new Response('rate limited', { status: 429 });
    },
  };

  await assert.rejects(
    callClassroomRpc({
      client,
      rpcid: CLASSROOM_RPC_ID,
      bootstrap: BOOTSTRAP,
      payload: createCourseWorkRpcPayload('course-1'),
    }),
    (error) => error.code === 'CLASSROOM_RATE_LIMIT' && error.status === 429,
  );
  assert.equal(requestCount, 1);
});

test('authenticated Classroom page is cached and extracts bootstrap once', async () => {
  let fetchCount = 0;
  const client = createClassroomWebClient({
    cookies: [{ name: 'SID', value: 'sid-value' }],
    fetchImpl: async () => {
      fetchCount += 1;
      return new Response(bootstrapHtml(), { status: 200 });
    },
  });

  const first = await client.getAuthenticatedPage();
  const second = await client.getAuthenticatedPage();
  assert.equal(fetchCount, 1);
  assert.equal(first.bootstrap.at, BOOTSTRAP.at);
  assert.equal(second.bootstrap.bl, BOOTSTRAP.bl);
});

test('Classroom refreshes the cached session once after a session refusal', async () => {
  let pageLoads = 0;
  let requestCount = 0;
  let invalidations = 0;
  const client = {
    requestIdFactory: () => '4321',
    invalidateSession() {
      invalidations += 1;
    },
    async getAuthenticatedPage({ force = false } = {}) {
      pageLoads += 1;
      assert.equal(force, pageLoads > 1);
      return { bootstrap: BOOTSTRAP };
    },
    async request() {
      requestCount += 1;
      if (requestCount === 1) {
        return new Response('expired', { status: 401 });
      }
      return new Response(
        batchexecuteResponse(CLASSROOM_RPC_ID, courseWorkPage([], 'done')),
        { status: 200 },
      );
    },
  };

  assert.deepEqual(await getCourseWorkForCourse(client, 'course-1'), []);
  assert.equal(pageLoads, 2);
  assert.equal(requestCount, 2);
  assert.equal(invalidations, 1);
});

test('Classroom does not loop after a second session refusal', async () => {
  let pageLoads = 0;
  let requestCount = 0;
  const client = {
    requestIdFactory: () => '4321',
    invalidateSession() {},
    async getAuthenticatedPage({ force = false } = {}) {
      pageLoads += 1;
      assert.equal(force, pageLoads > 1);
      return { bootstrap: BOOTSTRAP };
    },
    async request() {
      requestCount += 1;
      return new Response('expired', { status: 401 });
    },
  };

  await assert.rejects(
    getCourseWorkForCourse(client, 'course-1'),
    (error) => error.code === 'CLASSROOM_SESSION_EXPIRED',
  );
  assert.equal(pageLoads, 2);
  assert.equal(requestCount, 2);
});

test('invalid Classroom session fails with the required re-authentication message', async () => {
  const client = createClassroomWebClient({
    cookies: [{ name: 'SID', value: 'sid-value' }],
    fetchImpl: async () => {
      const response = new Response(
        '<html><title>Sign in - Google Accounts</title><input id="identifierId"></html>',
        { status: 200 },
      );
      Object.defineProperty(response, 'url', { value: 'https://accounts.google.com/v3/signin' });
      return response;
    },
  });

  await assert.rejects(
    client.getAuthenticatedPage(),
    (error) => error.message === 'Classroom browser session expired; re-authentication required',
  );
});

test('Classroom HTTP requests have a timeout', async () => {
  const client = createClassroomWebClient({
    cookies: [{ name: 'SID', value: 'sid-value' }],
    timeoutMs: 10,
    fetchImpl: async (_url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  });

  await assert.rejects(
    client.getAuthenticatedPage(),
    (error) => error.code === 'CLASSROOM_TIMEOUT',
  );
});

test('Classroom HTTP timeout remains active while the response body is read', async () => {
  const client = createClassroomWebClient({
    cookies: [{ name: 'SID', value: 'sid-value' }],
    timeoutMs: 10,
    fetchImpl: async (_url, { signal }) => {
      const response = new Response('placeholder', { status: 200 });
      response.text = () => new Promise((resolve, reject) => {
        const fallback = setTimeout(() => reject(new Error('body deadline missing')), 80);
        signal.addEventListener('abort', () => {
          clearTimeout(fallback);
          reject(new Error('body aborted'));
        }, { once: true });
      });
      return response;
    },
  });

  await assert.rejects(
    client.getAuthenticatedPage(),
    (error) => error.code === 'CLASSROOM_TIMEOUT',
  );
});

test('Classroom request combines external cancellation with its deadline', async () => {
  const externalController = new AbortController();
  let requestSignal;
  const client = createClassroomWebClient({
    cookies: [{ name: 'SID', value: 'sid-value' }],
    timeoutMs: 100,
    fetchImpl: async (_url, { signal }) => {
      requestSignal = signal;
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
  });

  const request = client.getAuthenticatedPage({ signal: externalController.signal });
  setTimeout(() => externalController.abort(), 10);
  await assert.rejects(
    request,
    (error) => error.code === 'CLASSROOM_ABORTED',
  );
  assert.notEqual(requestSignal, externalController.signal);
  assert.equal(externalController.signal.aborted, true);
});

test('coursework decoder extracts only explicit coursework fields and attachments', () => {
  const payload = {
    courseWork: [{
      id: '878109743041',
      courseId: '544644036115',
      title: '11.09 Кайдашева сім’я',
      description: 'Прочитати розділ',
      dueAt: '2026-09-11T08:00:00Z',
      updateTime: '2026-09-09T09:00:00Z',
      alternateLink: 'https://classroom.google.com/custom/course-work',
      materials: [{
        link: { url: 'https://example.test/task-file' },
      }],
    }],
  };
  const decoded = decodeCourseWorkPayload(payload, { courseId: '544644036115' });
  assert.deepEqual(decoded, [{
    source: 'classroom',
    courseId: '544644036115',
    assignmentId: '878109743041',
    title: '11.09 Кайдашева сім’я',
    description: 'Прочитати розділ',
    dueAt: '2026-09-11T08:00:00.000Z',
    updatedAt: '2026-09-09T09:00:00.000Z',
    publishedAt: null,
    attachments: [{ url: 'https://example.test/task-file' }],
    url: 'https://classroom.google.com/custom/course-work',
  }]);

  const debug = decodeCourseWorkPayload(payload, { courseId: '544644036115', debug: true });
  assert.equal(debug.assignments[0].raw.id, '878109743041');
  assert.equal(debug.raw.courseWork[0].title, '11.09 Кайдашева сім’я');
});

test('coursework decoder extracts the confirmed array-only pONvgf record shape', () => {
  const record = Array(28).fill(null);
  record[0] = ['878109743041', ['544644036115']];
  record[2] = Date.parse('2026-09-09T09:00:00Z');
  record[5] = '11.09 Кайдашева сім’я';
  record[9] = [2, ['stream-1'], Date.parse('2026-09-09T09:00:00Z'), null, Date.parse('2026-09-11T08:00:00Z'), 4];
  record[27] = [[null, null, null, null, null, null, ['edu.rt', 'Прочитати розділ']]];

  assert.deepEqual(
    decodeCourseWorkPayload([record], { courseId: '544644036115' }),
    [{
      source: 'classroom',
      courseId: '544644036115',
      assignmentId: '878109743041',
      title: '11.09 Кайдашева сім’я',
      description: 'Прочитати розділ',
      dueAt: '2026-09-11T08:00:00.000Z',
      updatedAt: '2026-09-09T09:00:00.000Z',
      publishedAt: '2026-09-09T09:00:00.000Z',
      attachments: [],
    }],
  );
});

test('coursework decoder extracts a date-only due tuple', () => {
  const record = Array(28).fill(null);
  record[0] = ['878109743042', ['544644036115']];
  record[2] = Date.parse('2026-09-09T09:00:00Z');
  record[5] = 'Завдання зі строком 17';
  record[9] = [2, ['stream-2'], Date.parse('2026-09-09T09:00:00Z'), null, [2026, 9, 17], 4];

  assert.deepEqual(
    decodeCourseWorkPayload([record], { courseId: '544644036115' }),
    [{
      source: 'classroom',
      courseId: '544644036115',
      assignmentId: '878109743042',
      title: 'Завдання зі строком 17',
      description: '',
      dueAt: '2026-09-17',
      updatedAt: '2026-09-09T09:00:00.000Z',
      publishedAt: '2026-09-09T09:00:00.000Z',
      attachments: [],
    }],
  );
});

test('coursework decoder does not invent assignments from unknown numeric arrays', () => {
  const decoded = decodeCourseWorkPayload(
    [[100, null, 1, 0], [[1, 2, 3, 4]]],
    { courseId: '544644036115' },
  );
  assert.deepEqual(decoded, []);
});

function courseListRecord(courseId, name, marker = 1) {
  const record = Array(54).fill(null);
  record[0] = [String(courseId)];
  record[5] = name;
  record[20] = marker;
  return record;
}

function courseWorkArrayRecord(assignmentId, courseId, title) {
  const record = Array(28).fill(null);
  record[0] = [String(assignmentId), [String(courseId)]];
  record[2] = Date.parse('2026-09-10T09:00:00Z');
  record[5] = title;
  return record;
}

function courseWorkPage(records, continuationToken = null) {
  return [
    'hrq.cus',
    continuationToken === null ? [true, ['next-token']] : [true],
    records,
  ];
}

function streamItemPage(records, continuationToken = null) {
  return [
    'hrsi.qr',
    continuationToken === null ? [false] : [true, [continuationToken]],
    records.map((record) => [1, [record, null, null, null, null]]),
  ];
}

test('coursework decoder recognizes the live stream-item envelope and nested assignments', () => {
  const payload = streamItemPage([
    courseWorkArrayRecord('work-1', 'course-1', 'Assignment'),
  ]);
  const decoded = decodeCourseWorkPayload(payload, { courseId: 'course-1', includeMetadata: true });
  assert.equal(decoded.recognized, true);
  assert.deepEqual(decoded.assignments.map(({ assignmentId }) => assignmentId), ['work-1']);
});

test('coursework decoder recognizes empty stream-item responses with omitted or empty records', () => {
  for (const payload of [['hrsi.qr', [false]], streamItemPage([])]) {
    assert.deepEqual(
      decodeCourseWorkPayload(payload, { courseId: 'course-1', includeMetadata: true }),
      { assignments: [], recognized: true },
    );
  }
});

test('assignment envelope due timestamp takes precedence over base-record metadata', () => {
  const record = courseWorkArrayRecord('work-1', 'course-1', 'Assignment');
  record[9] = [2, ['author'], 1789110157405, null, [2026, 9, 11]];
  const payload = ['hrsi.qr', [false], [
    [2, [record, [1789754340000, 1789110158502, true, 12, false]]],
  ]];
  const decoded = decodeCourseWorkPayload(JSON.stringify(payload), {
    courseId: 'course-1', debug: true,
  });
  assert.equal(decoded.recognized, true);
  assert.equal(decoded.assignments.length, 1);
  assert.equal(decoded.assignments[0].dueAt, '2026-09-18T17:59:00.000Z');
  assert.equal(decoded.rawCandidates.length, 1);
  assert.deepEqual(decoded.rawCandidates[0].path.slice(-4), [2, 0, 1, 0]);

  payload[2][0][1][1][0] = null;
  const withoutDue = decodeCourseWorkPayload(payload, { courseId: 'course-1' });
  assert.equal(withoutDue[0].dueAt, null);
});

test('coursework decoder rejects malformed and partially unknown stream-item collections', () => {
  const record = courseWorkArrayRecord('work-1', 'course-1', 'Assignment');
  const payloads = [
    ['hrsi.qr'],
    ['hrsi.qr', [], []],
    ['hrsi.qr', [false], {}],
    ['hrsi.qr', [false], [[1, [null]]]],
    ['hrsi.qr', [false], [[1, [record]], [1, [null]]]],
    streamItemPage([courseWorkArrayRecord('work-1', 'another-course', 'Assignment')]),
    ['hrsi.qr', [true, ['next-token']]],
  ];
  for (const payload of payloads) {
    const decoded = decodeCourseWorkPayload(payload, { courseId: 'course-1', includeMetadata: true });
    assert.equal(decoded.recognized, false);
  }
});

test('coursework decoder rejects partially recognized hrq.cus collections', () => {
  const record = courseWorkArrayRecord('work-1', 'course-1', 'Assignment');
  const decoded = decodeCourseWorkPayload([
    'hrq.cus',
    [true],
    [record, { unexpected: true }],
  ], { courseId: 'course-1', includeMetadata: true });
  assert.equal(decoded.recognized, false);
});

test('coursework fetch follows live stream-item pages and accepts the terminal empty response', async () => {
  const calls = [];
  const client = {
    requestIdFactory: () => '4321',
    async getAuthenticatedPage() {
      return { bootstrap: BOOTSTRAP };
    },
    async request(_url, init) {
      const fReq = JSON.parse(init.body.get('f.req'));
      const payload = JSON.parse(fReq[0][0][1]);
      calls.push(payload);
      const responsePayload = payload[0][1] === null
        ? streamItemPage([courseWorkArrayRecord('work-1', 'course-1', 'Assignment')], 'next-token')
        : ['hrsi.qr', [false]];
      return new Response(batchexecuteResponse(CLASSROOM_RPC_ID, responsePayload), { status: 200 });
    },
  };

  const result = await getCourseWorkForCourse(client, 'course-1', { includePagination: true });
  assert.deepEqual(result.assignments.map(({ assignmentId }) => assignmentId), ['work-1']);
  assert.deepEqual(result.pageCounts, [1, 0]);
  assert.equal(result.recognized, true);
  assert.equal(result.complete, true);
  assert.equal(calls[1][0][1], 'next-token');
});

test('coursework decoder accepts an explicitly valid empty collection', () => {
  assert.deepEqual(
    decodeCourseWorkPayload(courseWorkPage([], 'done'), { courseId: 'course-1' }),
    [],
  );
});

test('coursework continuation token is read only from the confirmed response field', () => {
  assert.equal(
    extractCourseWorkContinuationToken(courseWorkPage([])),
    'next-token',
  );
  assert.equal(
    extractCourseWorkContinuationToken(['hrq.cus', [true], []]),
    null,
  );
  assert.throws(
    () => extractCourseWorkContinuationToken(['hrq.cus', [true, 'unexpected'], []]),
    (error) => error.code === 'CLASSROOM_PAGINATION_RESPONSE_ERROR',
  );
});

test('coursework fetch follows continuation pages, deduplicates, and keeps the array contract by default', async () => {
  const calls = [];
  const pageOne = courseWorkPage([
    courseWorkArrayRecord('work-1', 'course-1', 'Перше завдання'),
  ]);
  const pageTwo = courseWorkPage([
    courseWorkArrayRecord('work-2', 'course-1', 'Друге завдання'),
    courseWorkArrayRecord('work-1', 'course-1', 'Перше завдання'),
  ], 'next-token');
  const client = {
    requestIdFactory: () => '4321',
    async getAuthenticatedPage() {
      return { bootstrap: BOOTSTRAP };
    },
    async request(_url, init) {
      const fReq = JSON.parse(init.body.get('f.req'));
      const payload = JSON.parse(fReq[0][0][1]);
      calls.push(payload);
      const responsePayload = payload[0][1] === null ? pageOne : pageTwo;
      return new Response(batchexecuteResponse(CLASSROOM_RPC_ID, responsePayload), { status: 200 });
    },
  };

  const result = await getCourseWorkForCourse(client, 'course-1', {
    includePagination: true,
  });

  assert.deepEqual(result.assignments.map(({ assignmentId }) => assignmentId), ['work-1', 'work-2']);
  assert.deepEqual(result.pageCounts, [1, 2]);
  assert.equal(result.pagesFetched, 2);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0][0], 100);
  assert.equal(calls[0][0][1], null);
  assert.equal(calls[1][0][0], 100);
  assert.equal(calls[1][0][1], 'next-token');

  const defaultResult = await getCourseWorkForCourse(client, 'course-1');
  assert.deepEqual(defaultResult.map(({ assignmentId }) => assignmentId), ['work-1', 'work-2']);
});

test('coursework fetch uses the turned-in route for explicit completed states', async () => {
  const calls = [];
  const client = {
    requestIdFactory: () => '4321',
    async getAuthenticatedPage() {
      return { bootstrap: BOOTSTRAP };
    },
    async request(url, init) {
      calls.push({ url, init });
      return new Response(
        batchexecuteResponse(CLASSROOM_RPC_ID, courseWorkPage([], 'done')),
        { status: 200 },
      );
    },
  };

  await getCourseWorkForCourse(client, 'course-1', {
    displayStates: [3, 4],
  });

  const requestUrl = new URL(calls[0].url);
  assert.equal(requestUrl.searchParams.get('source-path'), CLASSROOM_TURNED_IN_PATH);
  assert.equal(calls[0].init.headers.Referer, CLASSROOM_TURNED_IN_URL);
  const fReq = JSON.parse(calls[0].init.body.get('f.req'));
  assert.deepEqual(JSON.parse(fReq[0][0][1])[2][0][14], [3, 4]);
});

test('coursework fetch rejects an unknown response schema before returning an empty snapshot', async () => {
  const client = {
    requestIdFactory: () => '4321',
    async getAuthenticatedPage() {
      return { bootstrap: BOOTSTRAP };
    },
    async request() {
      return new Response(
        batchexecuteResponse(CLASSROOM_RPC_ID, { unrelated: [] }),
        { status: 200 },
      );
    },
  };

  await assert.rejects(
    getCourseWorkForCourse(client, 'course-1'),
    (error) => error.code === 'CLASSROOM_RESPONSE_SCHEMA_UNKNOWN',
  );
});

test('coursework pagination stops on a repeated continuation value', async () => {
  let requestCount = 0;
  const client = {
    requestIdFactory: () => '4321',
    async getAuthenticatedPage() {
      return { bootstrap: BOOTSTRAP };
    },
    async request() {
      requestCount += 1;
      return new Response(
        batchexecuteResponse(CLASSROOM_RPC_ID, courseWorkPage([])),
        { status: 200 },
      );
    },
  };

  await assert.rejects(
    getCourseWorkForCourse(client, 'course-1'),
    (error) => error.code === 'CLASSROOM_PAGINATION_LOOP',
  );
  assert.equal(requestCount, 2);
  assert.equal(MAX_CLASSROOM_COURSEWORK_PAGES > 1, true);
});

test('course-list payload keeps the live opaque request mask stable', () => {
  const payload = createCourseListRpcPayload();

  assert.deepEqual(payload[0], [100, null, 1, 0]);
  assert.equal(payload[1].length, 57);
  assert.equal(payload[1][40].length, 23);
  assert.deepEqual(payload[2], [[null, [[1]]], null, null, [1, 2, 3], null, null, [1, 2]]);
  assert.equal(JSON.stringify(payload).length, 477);
});

test('course-list decoder returns visible courses, deduplicates ids, and leaves teacher unknown', () => {
  const payload = [
    'hrq.cus',
    [true],
    [
      courseListRecord('course-1', 'Алгебра'),
      courseListRecord('course-2', 'Геометрія'),
      courseListRecord('archived-1', 'Архівний курс', 2),
      courseListRecord('course-1', 'Дубль'),
    ],
  ];

  assert.deepEqual(decodeCourseListPayload(payload), [
    { courseId: 'course-1', name: 'Алгебра', teacherName: null },
    { courseId: 'course-2', name: 'Геометрія', teacherName: null },
  ]);
});

test('getCourses uses the home-page RPC and returns dynamically decoded courses', async () => {
  const calls = [];
  const payload = [
    'hrq.cus',
    [true],
    [courseListRecord('course-1', 'Алгебра')],
  ];
  const client = {
    requestIdFactory: () => '4321',
    async getAuthenticatedHomePage() {
      return { bootstrap: BOOTSTRAP };
    },
    async request(url, init) {
      calls.push({ url, init });
      return new Response(batchexecuteResponse(CLASSROOM_COURSES_RPC_ID, payload), { status: 200 });
    },
  };

  assert.deepEqual(await getCourses(client), [
    { courseId: 'course-1', name: 'Алгебра', teacherName: null },
  ]);
  assert.equal(calls.length, 1);
  const requestUrl = new URL(calls[0].url);
  assert.equal(requestUrl.searchParams.get('rpcids'), CLASSROOM_COURSES_RPC_ID);
  assert.equal(requestUrl.searchParams.get('source-path'), CLASSROOM_COURSES_PATH);
  assert.equal(calls[0].init.headers.Referer, CLASSROOM_COURSES_URL);
  const requestBody = calls[0].init.body;
  const fReq = JSON.parse(requestBody.get('f.req'));
  assert.equal(fReq[0][0][0], CLASSROOM_COURSES_RPC_ID);
  assert.deepEqual(JSON.parse(fReq[0][0][1]), createCourseListRpcPayload());
  assert.equal(requestBody.get('at'), BOOTSTRAP.at);
});
