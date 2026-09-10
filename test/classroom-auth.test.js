import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CLASSROOM_SCOPES,
  createClassroomAuth,
  readGoogleClientCredentials,
  saveGoogleToken,
} from '../src/classroom-auth.js';

test('Classroom auth uses production environment variables without local token files', () => {
  const client = createClassroomAuth({
    env: {
      GOOGLE_CLIENT_ID: 'client-id',
      GOOGLE_CLIENT_SECRET: 'client-secret',
      GOOGLE_REFRESH_TOKEN: 'refresh-token',
    },
    tokenPath: join(tmpdir(), 'does-not-exist-google-token.json'),
    credentialsPath: null,
  });

  assert.equal(client.credentials.refresh_token, 'refresh-token');
  assert.deepEqual(CLASSROOM_SCOPES, [
    'https://www.googleapis.com/auth/classroom.courses.readonly',
    'https://www.googleapis.com/auth/classroom.coursework.me.readonly',
  ]);
});

test('partial Classroom production auth configuration fails clearly', () => {
  assert.throws(
    () => createClassroomAuth({
      env: {
        GOOGLE_CLIENT_ID: 'client-id',
        GOOGLE_CLIENT_SECRET: '',
        GOOGLE_REFRESH_TOKEN: '',
      },
      tokenPath: join(tmpdir(), 'does-not-exist-google-token.json'),
      credentialsPath: null,
    }),
    /requires GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN together/,
  );
});

test('Google credential and token files are parsed and saved without exposing token output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'classroom-auth-'));
  const credentialsPath = join(directory, 'google-credentials.json');
  const tokenPath = join(directory, 'google-token.json');

  try {
    await writeFile(credentialsPath, JSON.stringify({
      installed: {
        client_id: 'client-id',
        client_secret: 'client-secret',
        redirect_uris: ['http://localhost'],
      },
    }));
    const credentials = readGoogleClientCredentials(credentialsPath);
    assert.equal(credentials.clientId, 'client-id');
    assert.deepEqual(credentials.redirectUris, ['http://localhost']);

    await saveGoogleToken({
      credentials,
      tokens: {
        refresh_token: 'refresh-token',
        token_type: 'Bearer',
      },
      tokenPath,
    });
    const saved = JSON.parse(await readFile(tokenPath, 'utf8'));
    assert.equal(saved.refresh_token, 'refresh-token');
    assert.equal(saved.client_secret, 'client-secret');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
