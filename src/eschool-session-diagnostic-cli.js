import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { Cookie, CookieJar } from 'tough-cookie';

import { createAuthClient, PORTAL_URL } from './auth.js';
import {
  DIARY_ORIGIN,
  initializeDiarySession,
  getAppointments,
} from './eschool.js';

export const ESCHOOL_COOKIE_FILE = resolve(
  process.cwd(),
  'secrets',
  'eschool-cookies.json',
);
export const ESCHOOL_PARENT_COOKIE_URL = 'https://eschool-ua.com/';
export const ESCHOOL_DIARY_COOKIE_URL = `${DIARY_ORIGIN}/`;

const COOKIE_FILE_VERSION = 1;
const COOKIE_DOMAIN_SUFFIX = 'eschool-ua.com';
const REQUIRED_COOKIE_TARGETS = Object.freeze([
  { name: 'refresh_token', url: ESCHOOL_PARENT_COOKIE_URL },
  { name: 'session_token', url: ESCHOOL_PARENT_COOKIE_URL },
  { name: 'application_token', url: ESCHOOL_DIARY_COOKIE_URL },
]);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertCookieString(value, field, index, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new Error(`Cookie record ${index + 1} has an invalid ${field}`);
  }
  if (/[[\]();\r\n]/.test(value)) {
    throw new Error(`Cookie record ${index + 1} has invalid characters in ${field}`);
  }
  return value;
}

function normalizeCookieDomain(value, index) {
  const domain = assertCookieString(value, 'domain', index).toLowerCase();
  const hostname = domain.replace(/^\./, '');
  if (hostname !== COOKIE_DOMAIN_SUFFIX
    && !hostname.endsWith(`.${COOKIE_DOMAIN_SUFFIX}`)) {
    throw new Error(
      `Cookie record ${index + 1} has a domain outside eschool-ua.com`,
    );
  }
  // tough-cookie indexes domain cookies without the browser's leading dot.
  // Keeping the normalized host here preserves parent-domain matching.
  return hostname;
}

function normalizeCookiePath(value, index) {
  const path = value === undefined ? '/' : value;
  if (typeof path !== 'string' || !path.startsWith('/') || /[\r\n]/.test(path)) {
    throw new Error(`Cookie record ${index + 1} has an invalid path`);
  }
  return path;
}

function normalizeCookieExpiry(value, index) {
  if (value === null) {
    return 'Infinity';
  }
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(
      `Cookie record ${index + 1} expires must be an ISO timestamp or null`,
    );
  }
  return new Date(value);
}

function normalizeSameSite(value, index) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`Cookie record ${index + 1} has an invalid sameSite value`);
  }
  const normalized = value.toLowerCase();
  if (!['strict', 'lax', 'none'].includes(normalized)) {
    throw new Error(`Cookie record ${index + 1} has an invalid sameSite value`);
  }
  return normalized;
}

function normalizeCookieRecord(record, index) {
  if (!isPlainObject(record)) {
    throw new Error(`Cookie record ${index + 1} must be an object`);
  }

  const name = assertCookieString(record.name, 'name', index);
  const value = assertCookieString(record.value, 'value', index, { allowEmpty: true });
  const domain = normalizeCookieDomain(record.domain, index);
  const path = normalizeCookiePath(record.path, index);
  const expires = normalizeCookieExpiry(record.expires, index);
  const secure = record.secure ?? false;
  const httpOnly = record.httpOnly ?? false;

  if (typeof secure !== 'boolean' || typeof httpOnly !== 'boolean') {
    throw new Error(`Cookie record ${index + 1} secure/httpOnly must be boolean`);
  }

  const cookie = new Cookie({
    key: name,
    value,
    domain,
    path,
    expires,
    secure,
    httpOnly,
    sameSite: normalizeSameSite(record.sameSite, index),
  });

  const cookieHost = domain.replace(/^\./, '');
  return {
    cookie,
    value,
    name,
    domain,
    path,
    url: `https://${cookieHost}${path}`,
  };
}

export async function loadEschoolCookieJar(filePath = ESCHOOL_COOKIE_FILE) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read E-school cookie file: ${error.name ?? 'error'}`);
  }

  if (!isPlainObject(parsed) || parsed.version !== COOKIE_FILE_VERSION
    || !Array.isArray(parsed.cookies) || parsed.cookies.length === 0) {
    throw new Error(
      'E-school cookie file must contain version 1 and a non-empty cookies array',
    );
  }

  const jar = new CookieJar();
  const records = [];
  for (const [index, record] of parsed.cookies.entries()) {
    const normalized = normalizeCookieRecord(record, index);
    await jar.setCookie(normalized.cookie, normalized.url);
    records.push({
      name: normalized.name,
      domain: normalized.domain,
      path: normalized.path,
    });
  }

  return { jar, records };
}

function formatCookieExpiry(cookie) {
  if (!cookie) {
    return null;
  }
  if (cookie.expires === 'Infinity' || cookie.expires === Infinity) {
    return 'session';
  }
  if (cookie.expires instanceof Date && !Number.isNaN(cookie.expires.getTime())) {
    return cookie.expires.toISOString();
  }
  return null;
}

async function inspectCookie(jar, name, url) {
  const cookie = (await jar.getCookies(url)).find((item) => item.key === name) ?? null;
  return {
    exists: Boolean(cookie?.value),
    expires: formatCookieExpiry(cookie),
    value: cookie?.value ?? null,
  };
}

async function inspectRequiredCookies(jar) {
  const result = {};
  for (const target of REQUIRED_COOKIE_TARGETS) {
    result[target.name] = await inspectCookie(jar, target.name, target.url);
  }
  return result;
}

function redactHeaderCookieNames(headers) {
  let cookieHeader;
  try {
    cookieHeader = new Headers(headers ?? {}).get('cookie');
  } catch {
    return new Set();
  }
  if (!cookieHeader) {
    return new Set();
  }

  return new Set(
    cookieHeader
      .split(';')
      .map((pair) => {
        const separator = pair.indexOf('=');
        return (separator === -1 ? pair : pair.slice(0, separator)).trim();
      })
      .filter(Boolean),
  );
}

function sanitizeUrl(value) {
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return null;
  }
}

function observeFetch(fetchImpl) {
  const requests = [];

  const fetchWithObservation = async (url, options = {}) => {
    const requestUrl = String(url);
    const response = await fetchImpl(url, options);
    let finalUrl = null;
    let finalHost = null;
    if (response?.url) {
      finalUrl = sanitizeUrl(response.url);
      try {
        finalHost = new URL(response.url).host;
      } catch {
        finalHost = null;
      }
    }

    requests.push({
      requestUrl,
      method: String(options.method ?? 'GET').toUpperCase(),
      cookieNames: redactHeaderCookieNames(options.headers),
      response,
      status: Number.isInteger(response?.status) ? response.status : null,
      finalUrl,
      finalHost,
      cfMitigatedChallenge: response?.headers?.get?.('cf-mitigated')
        ?.trim()
        .toLowerCase() === 'challenge',
    });
    return response;
  };

  return { fetchWithObservation, requests };
}

function lastRequest(requests, predicate) {
  return [...requests].reverse().find(predicate) ?? null;
}

function errorSummary(error) {
  return {
    name: typeof error?.name === 'string' ? error.name : 'Error',
    code: typeof error?.code === 'string' ? error.code : null,
    status: Number.isInteger(error?.status) ? error.status : null,
    session_expired: error?.sessionExpired === true,
  };
}

function logEvent(logger, event, fields = {}) {
  logger(JSON.stringify({ event, ...fields }));
}

function withoutFullLogin(auth) {
  const { fullLogin: ignoredFullLogin, ...result } = auth;
  return result;
}

function createStepTwoAuth(auth, controller) {
  const { fullLogin: ignoredFullLogin, refreshSession: ignoredRefresh, ...result } = auth;
  return {
    ...result,
    refreshSession: async () => {
      controller.abort();
      const error = new Error('Diagnostic step 2 refresh is disabled');
      error.name = 'AbortError';
      error.code = 'DIAGNOSTIC_REFRESH_BLOCKED';
      throw error;
    },
  };
}

function cookieRotation(before, after) {
  if (!before.exists || !after.exists) {
    return null;
  }
  return before.value !== after.value;
}

function cookieHeaderContains(request, name) {
  return Boolean(request?.cookieNames?.has(name));
}

function hasCookieRecord(records, name) {
  return records.some((record) => record.name === name);
}

function isPortalCloudflareFailure(request) {
  return request?.status === 403 || request?.cfMitigatedChallenge === true;
}

function resolveResult({
  records,
  stepOne,
  stepTwo,
  stepThree,
  stepFour,
  stepFive,
}) {
  const cookieScopeProblem = REQUIRED_COOKIE_TARGETS.some(({ name }) => {
    if (stepOne[name].exists) {
      return false;
    }
    return hasCookieRecord(records, name);
  })
    || (stepTwo.appointmentResponse && !stepTwo.applicationTokenSent)
    || (stepThree.response && !stepThree.parentCookiesSent)
    || (stepFive.appointmentResponse && !stepFive.applicationTokenSent);

  if (cookieScopeProblem) {
    return {
      code: 'RESULT_C',
      reason: 'required_cookie_not_applied_at_target_domain_or_path',
    };
  }

  if (!stepTwo.success) {
    return {
      code: 'RESULT_D',
      reason: 'imported_diary_application_token_not_accepted',
    };
  }

  if (isPortalCloudflareFailure(stepThree.response)) {
    return {
      code: 'RESULT_B',
      reason: 'existing_application_token_works_but_portal_is_challenged',
    };
  }

  if (stepThree.success
    && stepThree.refreshTokenAfter
    && stepThree.sessionTokenAfter
    && stepFour.success
    && stepFour.applicationTokenAfter
    && stepFive.success) {
    return {
      code: 'RESULT_A',
      reason: 'existing_session_and_bounded_refresh_both_work',
    };
  }

  return {
    code: 'RESULT_D',
    reason: 'session_renewal_or_final_diary_read_failed',
  };
}

export async function runEschoolSessionDiagnostic({
  cookiePath = ESCHOOL_COOKIE_FILE,
  fetchImpl = globalThis.fetch,
  logger = console.log,
} = {}) {
  const { jar, records } = await loadEschoolCookieJar(cookiePath);
  const observed = observeFetch(fetchImpl);
  const auth = createAuthClient({
    fetchImpl: observed.fetchWithObservation,
    jar,
    logger: () => {},
  });
  const noLoginAuth = withoutFullLogin(auth);

  const stepOne = await inspectRequiredCookies(jar);
  logEvent(logger, 'STEP_1', {
    refresh_token_exists: stepOne.refresh_token.exists,
    session_token_exists: stepOne.session_token.exists,
    application_token_exists: stepOne.application_token.exists,
  });

  const stepTwo = {
    attempted: stepOne.application_token.exists,
    success: false,
    applicationTokenSent: false,
    appointmentResponse: null,
    error: null,
  };
  if (stepTwo.attempted) {
    const controller = new AbortController();
    const requestStart = observed.requests.length;
    try {
      await getAppointments(createStepTwoAuth(auth, controller), {
        signal: controller.signal,
        logger: () => {},
      });
      stepTwo.success = true;
    } catch (error) {
      stepTwo.error = errorSummary(error);
    }
    const appointmentRequest = lastRequest(
      observed.requests.slice(requestStart),
      (request) => request.requestUrl.includes('/Appointment'),
    );
    stepTwo.appointmentResponse = appointmentRequest;
    stepTwo.applicationTokenSent = cookieHeaderContains(
      appointmentRequest,
      'application_token',
    );
  }
  logEvent(logger, 'STEP_2', {
    attempted: stepTwo.attempted,
    success: stepTwo.success,
    application_token_sent: stepTwo.applicationTokenSent,
    error: stepTwo.error,
  });

  const parentBefore = {
    refresh_token: stepOne.refresh_token,
    session_token: stepOne.session_token,
  };
  const portalRequestStart = observed.requests.length;
  let portalError = null;
  let portalSuccess = false;
  try {
    await auth.refreshSession({ logOutput: false });
    portalSuccess = true;
  } catch (error) {
    portalError = errorSummary(error);
  }
  const portalResponse = lastRequest(
    observed.requests.slice(portalRequestStart),
    (request) => request.requestUrl === PORTAL_URL,
  );
  const parentAfter = await inspectRequiredCookies(jar);
  const stepThree = {
    attempted: true,
    success: portalSuccess,
    response: portalResponse,
    error: portalError,
    refreshTokenAfter: parentAfter.refresh_token.exists,
    sessionTokenAfter: parentAfter.session_token.exists,
    parentCookiesSent: portalResponse
      ? cookieHeaderContains(portalResponse, 'refresh_token')
        && cookieHeaderContains(portalResponse, 'session_token')
      : null,
  };
  logEvent(logger, 'STEP_3', {
    success: stepThree.success,
    status: portalResponse?.status ?? null,
    final_url: portalResponse?.finalUrl ?? null,
    final_host: portalResponse?.finalHost ?? null,
    cf_mitigated_challenge: portalResponse?.cfMitigatedChallenge ?? false,
    refresh_token_before: parentBefore.refresh_token.exists,
    refresh_token_after: parentAfter.refresh_token.exists,
    refresh_token_expiry_before: parentBefore.refresh_token.expires,
    refresh_token_expiry_after: parentAfter.refresh_token.expires,
    session_token_before: parentBefore.session_token.exists,
    session_token_after: parentAfter.session_token.exists,
    session_token_expiry_before: parentBefore.session_token.expires,
    session_token_expiry_after: parentAfter.session_token.expires,
    refresh_token_rotated: cookieRotation(
      parentBefore.refresh_token,
      parentAfter.refresh_token,
    ),
    error: portalError,
  });

  const diaryBefore = await inspectCookie(
    jar,
    'application_token',
    ESCHOOL_DIARY_COOKIE_URL,
  );
  const diaryRequestStart = observed.requests.length;
  let diarySuccess = false;
  let diaryError = null;
  try {
    await initializeDiarySession(noLoginAuth, { force: true });
    diarySuccess = true;
  } catch (error) {
    diaryError = errorSummary(error);
  }
  const diaryAfter = await inspectCookie(
    jar,
    'application_token',
    ESCHOOL_DIARY_COOKIE_URL,
  );
  const stepFour = {
    success: diarySuccess,
    applicationTokenAfter: diaryAfter.exists,
    error: diaryError,
  };
  logEvent(logger, 'STEP_4', {
    success: diarySuccess,
    application_token_exists_before: diaryBefore.exists,
    application_token_exists_after: diaryAfter.exists,
    application_token_expiry_before: diaryBefore.expires,
    application_token_expiry_after: diaryAfter.expires,
    application_token_rotated: cookieRotation(diaryBefore, diaryAfter),
    seplogin_requests: observed.requests
      .slice(diaryRequestStart)
      .filter((request) => request.requestUrl.endsWith('/api/v1/seplogin')).length,
    error: diaryError,
  });

  const stepFive = {
    attempted: true,
    success: false,
    applicationTokenSent: false,
    appointmentResponse: null,
    error: null,
  };
  const finalRequestStart = observed.requests.length;
  try {
    await getAppointments(noLoginAuth, { logger: () => {} });
    stepFive.success = true;
  } catch (error) {
    stepFive.error = errorSummary(error);
  }
  const finalAppointmentRequest = lastRequest(
    observed.requests.slice(finalRequestStart),
    (request) => request.requestUrl.includes('/Appointment'),
  );
  stepFive.appointmentResponse = finalAppointmentRequest;
  stepFive.applicationTokenSent = cookieHeaderContains(
    finalAppointmentRequest,
    'application_token',
  );
  logEvent(logger, 'STEP_5', {
    attempted: true,
    success: stepFive.success,
    application_token_sent: stepFive.applicationTokenSent,
    error: stepFive.error,
  });

  const result = resolveResult({
    records,
    stepOne,
    stepTwo,
    stepThree,
    stepFour,
    stepFive,
  });
  logEvent(logger, 'RESULT', result);
  logger(result.code);

  return {
    ...result,
    stepOne: {
      refresh_token: {
        exists: stepOne.refresh_token.exists,
        expires: stepOne.refresh_token.expires,
      },
      session_token: {
        exists: stepOne.session_token.exists,
        expires: stepOne.session_token.expires,
      },
      application_token: {
        exists: stepOne.application_token.exists,
        expires: stepOne.application_token.expires,
      },
    },
    stepTwo: {
      attempted: stepTwo.attempted,
      success: stepTwo.success,
      applicationTokenSent: stepTwo.applicationTokenSent,
      error: stepTwo.error,
    },
    stepThree: {
      attempted: stepThree.attempted,
      success: stepThree.success,
      status: stepThree.response?.status ?? null,
      finalUrl: stepThree.response?.finalUrl ?? null,
      finalHost: stepThree.response?.finalHost ?? null,
      cfMitigatedChallenge: stepThree.response?.cfMitigatedChallenge ?? false,
      refreshTokenAfter: stepThree.refreshTokenAfter,
      sessionTokenAfter: stepThree.sessionTokenAfter,
      parentCookiesSent: stepThree.parentCookiesSent,
      error: stepThree.error,
    },
    stepFour: {
      success: stepFour.success,
      applicationTokenAfter: stepFour.applicationTokenAfter,
      error: stepFour.error,
    },
    stepFive: {
      attempted: stepFive.attempted,
      success: stepFive.success,
      applicationTokenSent: stepFive.applicationTokenSent,
      error: stepFive.error,
    },
  };
}

function isMainModule() {
  if (!process.argv[1]) {
    return false;
  }
  return import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
}

if (isMainModule()) {
  runEschoolSessionDiagnostic().then(({ code }) => {
    if (code !== 'RESULT_A') {
      process.exitCode = 1;
    }
  }).catch((error) => {
    console.error(JSON.stringify({
      event: 'FATAL',
      name: typeof error?.name === 'string' ? error.name : 'Error',
      code: typeof error?.code === 'string' ? error.code : null,
    }));
    process.exitCode = 1;
  });
}
