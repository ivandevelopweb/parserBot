import { load } from 'cheerio';
import makeFetchCookie from 'fetch-cookie';
import { CookieJar } from 'tough-cookie';

import {
  ConfigError,
  HttpError,
  SmokeTestError,
  errorMessage,
  maskToken,
} from './utils.js';

export const ORIGIN = 'https://eschool-ua.com';
export const LOGIN_URL = `${ORIGIN}/login`;
export const PORTAL_URL = `${ORIGIN}/portal`;
export const DEFAULT_HTTP_TIMEOUT_MS = 30000;
const COOKIE_URL = `${ORIGIN}/`;

const REQUIRED_FORM_FIELDS = [
  '$ACTION_REF_1',
  '$ACTION_1:0',
  '$ACTION_1:1',
  '$ACTION_KEY',
  'from',
  'username',
  'password',
];

function getInputValues($, form) {
  const values = new Map();

  $(form)
    .find('input[name]')
    .each((_, input) => {
      const name = $(input).attr('name');
      if (name) {
        values.set(name, $(input).attr('value') ?? '');
      }
    });

  return values;
}

function parseActionDescriptor(rawValue) {
  let descriptor;

  try {
    descriptor = JSON.parse(rawValue);
  } catch (error) {
    throw new SmokeTestError(
      `Unable to parse the Next.js $ACTION_1:0 value: ${errorMessage(error)}`,
      { code: 'LOGIN_FORM_ERROR', cause: error },
    );
  }

  if (!descriptor || typeof descriptor.id !== 'string' || !descriptor.id) {
    throw new SmokeTestError(
      'The Next.js $ACTION_1:0 value does not contain a valid action id',
      { code: 'LOGIN_FORM_ERROR' },
    );
  }

  return descriptor;
}

export function parseLoginForm(html) {
  const $ = load(html);
  let selectedValues = null;

  $('form').each((_, form) => {
    if (selectedValues) {
      return;
    }

    const values = getInputValues($, form);
    if (REQUIRED_FORM_FIELDS.every((field) => values.has(field))) {
      selectedValues = values;
    }
  });

  if (!selectedValues) {
    throw new SmokeTestError(
      'Could not find the login form with the expected Next.js Server Action fields',
      { code: 'LOGIN_FORM_ERROR' },
    );
  }

  const actionDescriptor = parseActionDescriptor(selectedValues.get('$ACTION_1:0'));

  return {
    actionRef: selectedValues.get('$ACTION_REF_1'),
    action0: selectedValues.get('$ACTION_1:0'),
    action1: selectedValues.get('$ACTION_1:1'),
    actionKey: selectedValues.get('$ACTION_KEY'),
    from: selectedValues.get('from'),
    actionId: actionDescriptor.id,
  };
}

function addRedirectSafeHeaders(headers, currentUrl) {
  return {
    accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
    referer: currentUrl,
    ...headers,
  };
}

export function createAuthClient({
  fetchImpl = globalThis.fetch,
  jar = new CookieJar(),
  username = process.env.ESCHOOL_USERNAME,
  password = process.env.ESCHOOL_PASSWORD,
  logger = console.log,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new ConfigError('Node.js built-in fetch is not available');
  }

  const fetchWithCookies = makeFetchCookie(fetchImpl, jar);

  function log(message, enabled = true) {
    if (enabled) {
      logger(message);
    }
  }

  async function getCookieValue(name, url = COOKIE_URL) {
    const cookies = await jar.getCookies(url);
    return cookies.find((cookie) => cookie.key === name)?.value ?? null;
  }

  async function getCookiePresence() {
    const [refreshToken, sessionToken] = await Promise.all([
      getCookieValue('refresh_token'),
      getCookieValue('session_token'),
    ]);

    return {
      refreshToken: Boolean(refreshToken),
      sessionToken: Boolean(sessionToken),
    };
  }

  async function request(url, options = {}) {
    return fetchWithCookies(url, {
      redirect: 'follow',
      signal: options.signal ?? AbortSignal.timeout(DEFAULT_HTTP_TIMEOUT_MS),
      ...options,
    });
  }

  function getCredentials() {
    const resolvedUsername = username ?? process.env.ESCHOOL_USERNAME;
    const resolvedPassword = password ?? process.env.ESCHOOL_PASSWORD;

    if (!resolvedUsername || !resolvedPassword) {
      throw new ConfigError(
        'Missing ESCHOOL_USERNAME or ESCHOOL_PASSWORD. Put both values in the local .env file.',
      );
    }

    return {
      username: resolvedUsername,
      password: resolvedPassword,
    };
  }

  async function fullLogin({ logOutput = true } = {}) {
    const credentials = getCredentials();
    log('[auth] Fetching login page...', logOutput);

    const loginPageResponse = await request(LOGIN_URL, {
      method: 'GET',
      headers: addRedirectSafeHeaders({}, ORIGIN),
    });

    const loginHtml = await loginPageResponse.text();
    if (!loginPageResponse.ok) {
      throw new HttpError(
        `Login page request failed with HTTP ${loginPageResponse.status} ${loginPageResponse.statusText}`,
        {
          url: LOGIN_URL,
          status: loginPageResponse.status,
          statusText: loginPageResponse.statusText,
        },
      );
    }

    const form = parseLoginForm(loginHtml);
    log(`[auth] Found Server Action: ${maskToken(form.actionId)}`, logOutput);

    const body = new FormData();
    body.append('1_$ACTION_REF_1', form.actionRef);
    body.append('1_$ACTION_1:0', form.action0);
    body.append('1_$ACTION_1:1', form.action1);
    body.append('1_$ACTION_KEY', form.actionKey);
    body.append('1_from', form.from);
    body.append('1_username', credentials.username);
    body.append('1_password', credentials.password);
    body.append('0', JSON.stringify([{ ok: true }, '$K1']));

    const loginResponse = await request(LOGIN_URL, {
      method: 'POST',
      headers: {
        accept: 'text/x-component',
        'next-action': form.actionId,
        origin: ORIGIN,
        referer: LOGIN_URL,
      },
      body,
    });

    // Consume the final response so the underlying connection can be reused.
    await loginResponse.arrayBuffer();

    const cookiePresence = await getCookiePresence();
    if (loginResponse.status >= 400) {
      throw new HttpError(
        `Login request failed with HTTP ${loginResponse.status} ${loginResponse.statusText}`,
        {
          url: LOGIN_URL,
          status: loginResponse.status,
          statusText: loginResponse.statusText,
        },
      );
    }

    if (!cookiePresence.refreshToken || !cookiePresence.sessionToken) {
      const missing = [
        !cookiePresence.refreshToken ? 'refresh_token' : null,
        !cookiePresence.sessionToken ? 'session_token' : null,
      ].filter(Boolean);

      throw new SmokeTestError(
        `Login response did not set required cookies: ${missing.join(', ')}`,
        { code: 'LOGIN_COOKIE_ERROR' },
      );
    }

    log('[auth] Login successful', logOutput);
    log('[auth] refresh_token: present', logOutput);
    log('[auth] session_token: present', logOutput);

    return cookiePresence;
  }

  async function refreshSession({ logOutput = true } = {}) {
    const response = await request(PORTAL_URL, {
      method: 'GET',
      headers: addRedirectSafeHeaders({}, LOGIN_URL),
    });

    await response.arrayBuffer();

    if (response.status >= 400) {
      throw new HttpError(
        `Session refresh through /portal failed with HTTP ${response.status} ${response.statusText}`,
        {
          url: PORTAL_URL,
          status: response.status,
          statusText: response.statusText,
        },
      );
    }

    const sessionToken = await getCookieValue('session_token');
    if (!sessionToken) {
      throw new SmokeTestError(
        'Session refresh through /portal completed without a session_token cookie',
        { code: 'SESSION_REFRESH_ERROR' },
      );
    }

    log('[auth] /portal session refresh successful', logOutput);
    return sessionToken;
  }

  async function removeCookie(name, url = COOKIE_URL) {
    const cookies = await jar.getCookies(url);
    const matchingCookies = cookies.filter((cookie) => cookie.key === name);

    for (const cookie of matchingCookies) {
      const domain = cookie.domain?.replace(/^\./, '') ?? new URL(url).hostname;
      const protocol = cookie.secure ? 'https' : 'http';
      const cookieUrl = `${protocol}://${domain}${cookie.path || '/'}`;
      const domainAttribute = cookie.hostOnly === false ? `; Domain=${cookie.domain}` : '';
      const expiredCookie = `${name}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=${cookie.path || '/'}${domainAttribute}`;
      await jar.setCookie(expiredCookie, cookieUrl);
    }

    return matchingCookies.length;
  }

  return {
    jar,
    fetch: request,
    fullLogin,
    refreshSession,
    removeSessionToken: () => removeCookie('session_token'),
    getCookieValue,
    getCookiePresence,
  };
}
