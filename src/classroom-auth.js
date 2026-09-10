import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';

import { google } from 'googleapis';

import { ConfigError, SmokeTestError, errorMessage } from './utils.js';

export const CLASSROOM_SCOPES = [
  'https://www.googleapis.com/auth/classroom.courses.readonly',
  'https://www.googleapis.com/auth/classroom.coursework.me.readonly',
];

export const DEFAULT_GOOGLE_CREDENTIALS_PATH = resolve(
  process.cwd(),
  'google-credentials.json',
);
export const LEGACY_GOOGLE_CREDENTIALS_PATH = resolve(
  process.cwd(),
  'googlecredentials.json',
);
export const DEFAULT_GOOGLE_TOKEN_PATH = resolve(process.cwd(), 'google-token.json');
export const CLASSROOM_AUTH_TIMEOUT_MS = 5 * 60 * 1000;

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

export function resolveGoogleCredentialsPath({
  preferredPath = DEFAULT_GOOGLE_CREDENTIALS_PATH,
  fallbackPath = LEGACY_GOOGLE_CREDENTIALS_PATH,
} = {}) {
  if (existsSync(preferredPath)) {
    return preferredPath;
  }
  if (existsSync(fallbackPath)) {
    return fallbackPath;
  }
  return null;
}

function readJsonFile(filePath, label) {
  let content;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new ConfigError(`Could not read ${label} ${filePath}: ${errorMessage(error)}`);
  }

  try {
    return JSON.parse(content);
  } catch (error) {
    throw new ConfigError(`Could not parse ${label} ${filePath} as JSON: ${errorMessage(error)}`);
  }
}

export function readGoogleClientCredentials(filePath = resolveGoogleCredentialsPath()) {
  if (!filePath) {
    throw new ConfigError(
      'Google OAuth credentials file was not found. Add google-credentials.json to the project root.',
    );
  }

  const payload = readJsonFile(filePath, 'Google OAuth credentials file');
  const keys = payload?.installed ?? payload?.web ?? payload;
  const clientId = keys?.client_id;
  const clientSecret = keys?.client_secret;
  const redirectUris = Array.isArray(keys?.redirect_uris) ? keys.redirect_uris : [];

  if (!hasValue(clientId) || !hasValue(clientSecret)) {
    throw new ConfigError(
      `Google OAuth credentials file ${filePath} does not contain client_id and client_secret.`,
    );
  }

  return {
    clientId: String(clientId),
    clientSecret: String(clientSecret),
    redirectUris,
    filePath,
  };
}

function readTokenFile(filePath) {
  const payload = readJsonFile(filePath, 'Google OAuth token file');
  const token = payload?.tokens ?? payload;
  if (!hasValue(token?.refresh_token)) {
    throw new ConfigError(
      `Google OAuth token file ${filePath} does not contain a refresh_token. Run npm run classroom:auth again.`,
    );
  }
  return token;
}

function createOAuthClient({ clientId, clientSecret, redirectUri } = {}) {
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

export function createClassroomAuth({
  env = process.env,
  tokenPath = DEFAULT_GOOGLE_TOKEN_PATH,
  credentialsPath = resolveGoogleCredentialsPath(),
} = {}) {
  const clientId = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  const refreshToken = env.GOOGLE_REFRESH_TOKEN;
  const configuredValues = [clientId, clientSecret, refreshToken].filter(hasValue).length;

  if (configuredValues > 0 && configuredValues < 3) {
    throw new ConfigError(
      'Google Classroom production auth requires GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN together.',
    );
  }

  if (configuredValues === 3) {
    const client = createOAuthClient({
      clientId: String(clientId),
      clientSecret: String(clientSecret),
    });
    client.setCredentials({ refresh_token: String(refreshToken) });
    return client;
  }

  if (!existsSync(tokenPath)) {
    return null;
  }

  const token = readTokenFile(tokenPath);
  const localCredentials = credentialsPath
    ? readGoogleClientCredentials(credentialsPath)
    : null;
  const localClientId = token.client_id ?? localCredentials?.clientId;
  const localClientSecret = token.client_secret ?? localCredentials?.clientSecret;

  if (!hasValue(localClientId) || !hasValue(localClientSecret)) {
    throw new ConfigError(
      'Google OAuth token is present but its client credentials are missing. Add google-credentials.json or the three GOOGLE_* variables.',
    );
  }

  const client = createOAuthClient({
    clientId: String(localClientId),
    clientSecret: String(localClientSecret),
  });
  client.setCredentials({ ...token, refresh_token: String(token.refresh_token) });
  return client;
}

function openBrowser(url) {
  let child;
  if (process.platform === 'win32') {
    child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
  } else if (process.platform === 'darwin') {
    child = spawn('open', [url], { detached: true, stdio: 'ignore' });
  } else {
    child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
  }
  child.unref();
}

function getLoopbackRedirectUri(baseUri, port) {
  let redirectUri;
  try {
    redirectUri = new URL(baseUri || 'http://localhost');
  } catch (error) {
    throw new ConfigError(`Google OAuth redirect URI is invalid: ${errorMessage(error)}`);
  }

  if (redirectUri.protocol !== 'http:' || redirectUri.hostname !== 'localhost') {
    throw new ConfigError(
      'Google OAuth desktop credentials must contain an http://localhost redirect URI.',
    );
  }

  redirectUri.port = String(port);
  return redirectUri;
}

export async function saveGoogleToken({
  tokens,
  credentials,
  tokenPath = DEFAULT_GOOGLE_TOKEN_PATH,
} = {}) {
  if (!tokens || !hasValue(tokens.refresh_token)) {
    throw new ConfigError(
      'Google did not return a refresh token. Run the authorization again and approve the offline access consent prompt.',
    );
  }

  await mkdir(dirname(tokenPath), { recursive: true });
  const temporaryPath = `${tokenPath}.tmp-${process.pid}-${randomUUID()}`;
  const payload = {
    type: 'authorized_user',
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    refresh_token: tokens.refresh_token,
    token_type: tokens.token_type,
    access_token: tokens.access_token,
    expiry_date: tokens.expiry_date,
    scope: tokens.scope,
  };

  try {
    await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporaryPath, tokenPath);
  } catch (error) {
    throw new SmokeTestError(
      `Could not atomically save Google OAuth token ${tokenPath}: ${errorMessage(error)}`,
      { code: 'CLASSROOM_AUTH_ERROR', cause: error },
    );
  } finally {
    try {
      await unlink(temporaryPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        // Preserve the original error and avoid leaking token contents.
      }
    }
  }
}

export async function authorizeClassroom({
  credentialsPath = resolveGoogleCredentialsPath(),
  tokenPath = DEFAULT_GOOGLE_TOKEN_PATH,
  openBrowserFn = openBrowser,
  timeoutMs = CLASSROOM_AUTH_TIMEOUT_MS,
} = {}) {
  const credentials = readGoogleClientCredentials(credentialsPath);
  const baseRedirectUri = credentials.redirectUris[0] ?? 'http://localhost';
  const client = createOAuthClient({
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
  });

  const server = createServer();
  const result = await new Promise((resolveResult, rejectResult) => {
    let settled = false;
    let timer = null;
    let redirectUri = null;
    let oauthState = null;

    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      callback(value);
      server.close();
    };

    server.on('request', async (request, response) => {
      try {
        const requestUrl = new URL(request.url ?? '/', 'http://localhost');
        if (!redirectUri || requestUrl.pathname !== redirectUri.pathname) {
          response.statusCode = 404;
          response.end('Invalid OAuth callback path.');
          return;
        }

        if (requestUrl.searchParams.get('state') !== oauthState) {
          response.statusCode = 400;
          response.end('Invalid OAuth state.');
          finish(rejectResult, new ConfigError('Google OAuth state validation failed.'));
          return;
        }

        const oauthError = requestUrl.searchParams.get('error');
        if (oauthError) {
          response.statusCode = 400;
          response.end('Google authorization was rejected.');
          finish(rejectResult, new ConfigError(`Google authorization failed: ${oauthError}`));
          return;
        }

        const code = requestUrl.searchParams.get('code');
        if (!code) {
          response.statusCode = 400;
          response.end('No authorization code was provided.');
          finish(rejectResult, new ConfigError('Google OAuth callback did not contain an authorization code.'));
          return;
        }

        const { tokens } = await client.getToken({
          code,
          redirect_uri: redirectUri.toString(),
        });
        if (!hasValue(tokens?.refresh_token)) {
          response.statusCode = 400;
          response.end('No refresh token was returned. Please approve offline access and try again.');
          finish(
            rejectResult,
            new ConfigError(
              'Google did not return a refresh token. Run the authorization again and approve the offline access consent prompt.',
            ),
          );
          return;
        }

        response.statusCode = 200;
        response.end('Authorization successful. You can return to the terminal.');
        finish(resolveResult, tokens);
      } catch (error) {
        response.statusCode = 500;
        response.end('Google authorization failed.');
        finish(rejectResult, new SmokeTestError(
          `Google OAuth token exchange failed: ${errorMessage(error)}`,
          { code: 'CLASSROOM_AUTH_ERROR', cause: error },
        ));
      }
    });

    server.once('error', (error) => {
      finish(rejectResult, new SmokeTestError(
        `Could not start the local Google OAuth callback server: ${errorMessage(error)}`,
        { code: 'CLASSROOM_AUTH_ERROR', cause: error },
      ));
    });

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      if (!port) {
        finish(rejectResult, new SmokeTestError(
          'Could not determine the local Google OAuth callback port',
          { code: 'CLASSROOM_AUTH_ERROR' },
        ));
        return;
      }

      try {
        redirectUri = getLoopbackRedirectUri(baseRedirectUri, port);
        oauthState = randomUUID();
        const authorizationUrl = client.generateAuthUrl({
          access_type: 'offline',
          prompt: 'consent',
          redirect_uri: redirectUri.toString(),
          scope: CLASSROOM_SCOPES,
          state: oauthState,
        });
        openBrowserFn(authorizationUrl);
      } catch (error) {
        finish(rejectResult, error);
      }
    });

    timer = setTimeout(() => {
      finish(rejectResult, new ConfigError(
        'Google OAuth authorization timed out. Run npm run classroom:auth again.',
      ));
    }, timeoutMs);
  });

  await saveGoogleToken({ tokens: result, credentials, tokenPath });
  return { tokenPath };
}
