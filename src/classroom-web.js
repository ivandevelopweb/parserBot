import { readFileSync, existsSync } from 'node:fs';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import * as cheerio from 'cheerio';
import makeFetchCookie from 'fetch-cookie';
import { Cookie, CookieJar } from 'tough-cookie';

import { ConfigError, SmokeTestError, normalizeDescription } from './utils.js';

export const CLASSROOM_ORIGIN = 'https://classroom.google.com';
export const CLASSROOM_HOME_PATH = '/a/not-turned-in/all';
export const CLASSROOM_HOME_URL = `${CLASSROOM_ORIGIN}${CLASSROOM_HOME_PATH}`;
export const CLASSROOM_TURNED_IN_PATH = '/a/turned-in/all';
export const CLASSROOM_TURNED_IN_URL = `${CLASSROOM_ORIGIN}${CLASSROOM_TURNED_IN_PATH}`;
export const CLASSROOM_COURSES_PATH = '/h';
export const CLASSROOM_COURSES_URL = `${CLASSROOM_ORIGIN}${CLASSROOM_COURSES_PATH}`;
export const CLASSROOM_RPC_PATH = '/_/ClassroomUi/data/batchexecute';
export const CLASSROOM_RPC_ID = 'pONvgf';
export const CLASSROOM_SOURCE_PATH = CLASSROOM_HOME_PATH;
export const CLASSROOM_COURSES_RPC_ID = 'gXtzob';
export const DEFAULT_CLASSROOM_TIMEOUT_MS = 30_000;
export const MAX_CLASSROOM_COURSEWORK_PAGES = 50;
export const DEFAULT_CLASSROOM_COOKIES_PATH = resolve(process.cwd(), 'classroom-cookies.json');
export const DEFAULT_CLASSROOM_RPC_DEBUG_ARTIFACT_PATH = resolve(
  process.cwd(),
  'data',
  'classroom-pONvgf-response.debug.txt',
);
export const MAX_CLASSROOM_REDIRECTS = 10;
const CLASSROOM_BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36';
export const CLASSROOM_RPC_CONTENT_TYPE = 'application/x-www-form-urlencoded;charset=UTF-8';
export const CLASSROOM_NOT_TURNED_IN_STATES = Object.freeze([1, 2]);
export const CLASSROOM_TURNED_IN_STATES = Object.freeze([3, 4, 8, 10, 5, 7, 9, 6, 11]);
export const CLASSROOM_COMPLETED_STATES = Object.freeze([3, 4, 5, 6, 7, 9, 11]);
export const CLASSROOM_UNKNOWN_STATES = Object.freeze([8, 10]);

const BOOTSTRAP_KEY_ALIASES = Object.freeze({
  at: ['at', 'SNlM0e'],
  fSid: ['f.sid', 'f_sid', 'FdrFJe'],
  bl: ['bl', 'cfb2h'],
});

// This is the opaque request mask observed in the Classroom web client. The
// numeric values are intentionally kept as data; this client does not assign
// undocumented meanings to them. The course id and confirmed state filter are
// substituted at runtime.
const COURSE_WORK_FLAGS_A = Object.freeze([
  1, 1, 1, 1, 1, null, null,
  [1, 1, 1, null, 1, 1, 1],
  1, 1, 1, 1, 1, 1,
  null, null, null, null, 1, null, null, null, 1,
  [1], 1, [null, null, 1, 1, 1, null, 1],
]);

const COURSE_WORK_FLAGS_B = Object.freeze([
  1, 1, 1, 1, 1, 1, [1], 1, null, [1, 1], 1, 1, null, 1,
  [[1, 1, [], [null, 1]], 1, 1], null, null, null, 1,
]);

// This value is part of the opaque request mask. A controlled live experiment
// showed that it changes the maximum number of records returned by pONvgf, but
// the web protocol does not document whether it is a page size or another
// limit. Keep the value and its wire position unchanged.
const COURSE_WORK_REQUEST_FIRST_VALUE = 100;

// This is the opaque gXtzob request mask observed on the Classroom home page.
// It is kept as data because the numeric positions have no documented public
// meaning. The payload contains no course or account identifiers; those are
// returned by the RPC and decoded separately.
const COURSE_LIST_REQUEST_PAYLOAD = Object.freeze([
  [100, null, 1, 0],
  [
    1, 1, null, null, 1, 1, null, 1,
    [null, 1, 1, 1, null, 1, [1, 1, 1, 0, 0, 0], null, [1], 1, 1, 1, 1, [1, 1], [1, 0]],
    1, 1, null, null, 1, null, null, null, null, null, null,
    [1, 1, 1, 1, 1, 1, 1], 1, null, null, 1, null, null, null,
    [1, 1], 1, 1, null, null, 1, 1, 1, 1, null, 1, 1,
    [null, null, null, null, 1, 1, null, null, 1, null, null, null, null, null, null, null, null, 1, 1, 1, 1, 1, 1],
    null, [1, 1, 1], [1, 1, null, 1], 1, 1, 1,
    [[[1, 1, 1], 1], [[[1, 1]]], 1],
    null, 1, [1, 1], null, null, 1, null, [null, null, 1], 1,
  ],
  [[null, [[1]]], null, null, [1, 2, 3], null, null, [1, 2]],
]);

export class ClassroomWebError extends SmokeTestError {
  constructor(message, { code = 'CLASSROOM_WEB_ERROR', status, cause } = {}) {
    super(message, { code, cause });
    this.name = 'ClassroomWebError';
    this.status = status;
  }
}

export class ClassroomSessionError extends ClassroomWebError {
  constructor() {
    super('Classroom browser session expired; re-authentication required', {
      code: 'CLASSROOM_SESSION_EXPIRED',
    });
    this.name = 'ClassroomSessionError';
  }
}

export class ClassroomBootstrapError extends ClassroomWebError {
  constructor(message = 'Classroom bootstrap values at/f.sid/bl were not found in authenticated page') {
    super(message, { code: 'CLASSROOM_BOOTSTRAP_ERROR' });
    this.name = 'ClassroomBootstrapError';
  }
}

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function normalizeCookieDomain(domain) {
  const value = String(domain ?? '').trim();
  return value.replace(/^\.+/, '') || undefined;
}

function normalizeCookieExpiry(value) {
  if (value === undefined || value === null || value === '' || value === 0) {
    return undefined;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value < 10_000_000_000 ? value * 1000 : value);
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function normalizeSameSite(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'strict' || normalized === 'lax' || normalized === 'none') {
    return normalized;
  }
  if (normalized === 'no_restriction') {
    return 'none';
  }
  return undefined;
}

function cookieRecordFromMapEntry([name, value]) {
  return { name, value };
}

function unwrapCookieInput(input) {
  if (typeof input === 'string') {
    try {
      return JSON.parse(input);
    } catch {
      throw new ConfigError('Could not parse Classroom cookies JSON.');
    }
  }
  return input;
}

export function parseClassroomCookies(input) {
  const value = unwrapCookieInput(input);
  let records;

  if (Array.isArray(value)) {
    records = value;
  } else if (Array.isArray(value?.cookies)) {
    records = value.cookies;
  } else if (value && typeof value === 'object') {
    records = Object.entries(value).map(cookieRecordFromMapEntry);
  } else {
    throw new ConfigError(
      'Classroom cookies must be a JSON array, an object with a cookies array, or a name/value object.',
    );
  }

  if (records.length === 0) {
    throw new ConfigError('Classroom cookies are empty. Export the cookies from an authenticated Classroom session.');
  }

  return records.map((record, index) => {
    if (!record || typeof record !== 'object') {
      throw new ConfigError(`Classroom cookie #${index + 1} is not an object.`);
    }

    const name = String(record.name ?? record.key ?? '').trim();
    if (!name) {
      throw new ConfigError(`Classroom cookie #${index + 1} has no name.`);
    }
    if (record.value === undefined || record.value === null) {
      throw new ConfigError(`Classroom cookie #${index + 1} has no value.`);
    }

    return {
      name,
      value: String(record.value),
      domain: normalizeCookieDomain(record.domain),
      path: String(record.path ?? '/'),
      expires: normalizeCookieExpiry(record.expirationDate ?? record.expires),
      maxAge: record.maxAge,
      secure: Boolean(record.secure),
      httpOnly: Boolean(record.httpOnly),
      sameSite: normalizeSameSite(record.sameSite),
    };
  });
}

export function parseClassroomCookieHeader(header) {
  if (typeof header !== 'string' || !header.trim()) {
    throw new ConfigError('Classroom Cookie header is empty.');
  }

  // Validate before Headers.set(), whose native error may include the raw
  // header value and therefore leak a copied browser session into logs.
  if (/[\u0000-\u001f\u007f]/u.test(header)) {
    throw new ConfigError('Classroom Cookie header contains invalid characters.');
  }

  const parts = header.split(';');
  const records = [];

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index].trim();
    if (!part) {
      continue;
    }

    const separator = part.indexOf('=');
    if (separator <= 0) {
      throw new ConfigError(
        `Classroom Cookie header contains a malformed pair at position ${index + 1}; expected name=value.`,
      );
    }

    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!name) {
      throw new ConfigError(
        `Classroom Cookie header contains a malformed pair at position ${index + 1}; expected name=value.`,
      );
    }

    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(name)
      || /["\\,;]/u.test(value)
      || /\s/u.test(value)) {
      throw new ConfigError('Classroom Cookie header contains invalid characters.');
    }

    records.push({
      name,
      value,
      domain: 'classroom.google.com',
      path: '/',
    });
  }

  if (records.length === 0) {
    throw new ConfigError('Classroom Cookie header is empty.');
  }

  return records;
}

function summarizeCookieHeader(header) {
  const value = typeof header === 'string' ? header : '';
  const names = new Set();
  let count = 0;

  for (const part of value.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    if (!name) {
      continue;
    }
    count += 1;
    names.add(name);
  }

  return {
    count,
    length: value.length,
    names,
    header: value,
  };
}

function sameCookieNameSet(first, second) {
  if (!first || !second || first.names.size !== second.names.size) {
    return false;
  }
  return [...first.names].every((name) => second.names.has(name));
}

function publicCookieRequestDiagnostics(requests) {
  const get = requests.get;
  const post = requests.post;
  return {
    get: get ? { count: get.count, length: get.length } : null,
    post: post ? { count: post.count, length: post.length } : null,
    sameNames: sameCookieNameSet(get, post),
    sameHeader: Boolean(get && post && get.header === post.header),
  };
}

function readCookieFile(filePath) {
  let content;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    throw new ConfigError('Could not read Classroom cookies file.');
  }
  return parseClassroomCookies(content);
}

export function loadClassroomCookies({
  env = process.env,
  cookieHeader = env.CLASSROOM_COOKIE_HEADER,
  cookiesJson = env.CLASSROOM_COOKIES_JSON,
  cookiesPath = env.CLASSROOM_COOKIES_FILE,
  defaultPath = DEFAULT_CLASSROOM_COOKIES_PATH,
} = {}) {
  if (hasValue(cookieHeader)) {
    return parseClassroomCookieHeader(String(cookieHeader));
  }

  if (hasValue(cookiesJson)) {
    return parseClassroomCookies(cookiesJson);
  }

  const configuredPath = hasValue(cookiesPath) ? String(cookiesPath).trim() : null;
  if (configuredPath) {
    if (!existsSync(configuredPath)) {
      throw new ConfigError('Classroom cookies file was not found.');
    }
    return readCookieFile(configuredPath);
  }

  if (defaultPath && existsSync(defaultPath)) {
    return readCookieFile(defaultPath);
  }

  throw new ConfigError(
    'Classroom cookies are not configured. Set CLASSROOM_COOKIE_HEADER, CLASSROOM_COOKIES_JSON, or CLASSROOM_COOKIES_FILE to an authenticated browser cookie export.',
  );
}

export async function createClassroomCookieJar({
  cookies,
  cookieHeader,
  cookiesJson,
  env = process.env,
  cookiesPath,
  defaultPath = DEFAULT_CLASSROOM_COOKIES_PATH,
  cookieJar = new CookieJar(),
} = {}) {
  const records = cookies !== undefined
    ? parseClassroomCookies(cookies)
    : loadClassroomCookies({ env, cookieHeader, cookiesJson, cookiesPath, defaultPath });

  for (const [index, record] of records.entries()) {
    const cookie = new Cookie({
      key: record.name,
      value: record.value,
      ...(record.domain ? { domain: record.domain } : {}),
      path: record.path || '/',
      ...(record.expires ? { expires: record.expires } : {}),
      ...(record.maxAge !== undefined ? { maxAge: record.maxAge } : {}),
      secure: record.secure,
      httpOnly: record.httpOnly,
      ...(record.sameSite ? { sameSite: record.sameSite } : {}),
    });

    try {
      await cookieJar.setCookie(cookie, CLASSROOM_HOME_URL);
    } catch {
      throw new ConfigError(
        `Could not load Classroom cookie #${index + 1}. Check the cookie export format.`,
      );
    }
  }

  return cookieJar;
}

function findJsonStart(text, fromIndex) {
  for (let index = fromIndex; index < text.length; index += 1) {
    const character = text[index];
    if (character === '{' || character === '[') {
      return index;
    }
    if (character === ';' || character === '\n') {
      // A marker is followed by an assignment in the bootstrap scripts. A
      // newline/semicolon before JSON means this occurrence is not useful.
      const rest = text.slice(fromIndex, index);
      if (!rest.includes('=')) {
        return -1;
      }
    }
  }
  return -1;
}

export function parseBalancedJson(text, startIndex) {
  const start = Number(startIndex);
  if (!Number.isInteger(start) || start < 0 || start >= text.length) {
    return null;
  }

  const opening = text[start];
  if (opening !== '{' && opening !== '[') {
    return null;
  }

  const stack = [];
  let quote = null;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const character = text[index];

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }

    if (character === '{' || character === '[') {
      stack.push(character);
      continue;
    }

    if (character === '}' || character === ']') {
      const expected = character === '}' ? '{' : '[';
      if (stack.pop() !== expected) {
        return null;
      }
      if (stack.length === 0) {
        const raw = text.slice(start, index + 1);
        try {
          return { value: JSON.parse(raw), endIndex: index + 1 };
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

function walkObject(value, callback, path = [], seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) {
    return;
  }
  seen.add(value);
  callback(value, path);
  if (Array.isArray(value)) {
    value.forEach((child, index) => walkObject(child, callback, [...path, index], seen));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    walkObject(child, callback, [...path, key], seen);
  }
}

function valueForAliases(object, aliases) {
  for (const alias of aliases) {
    if (Object.prototype.hasOwnProperty.call(object, alias) && hasValue(object[alias])) {
      return { value: String(object[alias]), alias };
    }
  }
  return null;
}

function extractBootstrapFromObject(value) {
  let found = { at: null, fSid: null, bl: null, aliases: {} };
  walkObject(value, (object) => {
    for (const [field, aliases] of Object.entries(BOOTSTRAP_KEY_ALIASES)) {
      if (found[field]) {
        continue;
      }
      const match = valueForAliases(object, aliases);
      if (match) {
        found = {
          ...found,
          [field]: match.value,
          aliases: { ...found.aliases, [field]: match.alias },
        };
      }
    }
  });
  return found.at && found.fSid && found.bl ? found : null;
}

function decodeQuotedValue(raw) {
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return raw.replace(/\\([\\'"nrt])/g, (_, character) => ({
      n: '\n',
      r: '\r',
      t: '\t',
      '\\': '\\',
      "'": "'",
      '"': '"',
    }[character] ?? character));
  }
}

function extractBootstrapKeyPairs(text) {
  const result = { at: null, fSid: null, bl: null, aliases: {} };
  const aliasToField = new Map(
    Object.entries(BOOTSTRAP_KEY_ALIASES)
      .flatMap(([field, aliases]) => aliases.map((alias) => [alias, field])),
  );
  const pattern = /["'](at|SNlM0e|f\.sid|f_sid|FdrFJe|bl|cfb2h)["']\s*:\s*(?:"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)')/g;

  for (const match of text.matchAll(pattern)) {
    const alias = match[1];
    const field = aliasToField.get(alias);
    if (field && !result[field]) {
      result[field] = decodeQuotedValue(match[2] ?? match[3]);
      result.aliases[field] = alias;
    }
  }

  return result.at && result.fSid && result.bl ? result : null;
}

function extractBootstrapFromDom(html) {
  const $ = cheerio.load(html);
  const result = { at: null, fSid: null, bl: null, aliases: {} };
  const normalizedNames = new Map([
    ['at', 'at'],
    ['snlm0e', 'at'],
    ['f.sid', 'fSid'],
    ['f_sid', 'fSid'],
    ['fdrfje', 'fSid'],
    ['bl', 'bl'],
    ['cfb2h', 'bl'],
  ]);

  $('input, meta, [data-at], [data-f-sid], [data-bl]').each((_, element) => {
    for (const [attribute, rawValue] of Object.entries(element.attribs ?? {})) {
      const field = normalizedNames.get(attribute.toLowerCase())
        ?? normalizedNames.get(attribute.toLowerCase().replace(/^data-/, ''));
      if (!field || !hasValue(rawValue) || result[field]) {
        continue;
      }
      result[field] = String(rawValue);
      result.aliases[field] = attribute;
    }

    const name = String(element.attribs?.name ?? '').toLowerCase();
    const value = element.attribs?.value;
    const field = normalizedNames.get(name);
    if (field && hasValue(value) && !result[field]) {
      result[field] = String(value);
      result.aliases[field] = name;
    }
  });

  return result.at && result.fSid && result.bl ? result : null;
}

function scriptTextsFromHtml(html) {
  const $ = cheerio.load(html);
  return $('script').map((_, element) => $(element).html() ?? '').get();
}

export function extractClassroomBootstrap(html) {
  if (typeof html !== 'string' || !html.trim()) {
    throw new ClassroomBootstrapError();
  }

  const scripts = scriptTextsFromHtml(html);
  const segments = [html, ...scripts];
  const markers = ['WIZ_global_data', '_docs_flag_initialData', 'bootstrap'];

  for (const segment of segments) {
    for (const marker of markers) {
      let searchFrom = 0;
      while (searchFrom < segment.length) {
        const markerIndex = segment.indexOf(marker, searchFrom);
        if (markerIndex < 0) {
          break;
        }
        const jsonStart = findJsonStart(segment, markerIndex + marker.length);
        if (jsonStart >= 0) {
          const parsed = parseBalancedJson(segment, jsonStart);
          const values = parsed ? extractBootstrapFromObject(parsed.value) : null;
          if (values) {
            return {
              at: values.at,
              fSid: values.fSid,
              bl: values.bl,
              source: `${marker} (${values.aliases.at}/${values.aliases.fSid}/${values.aliases.bl})`,
            };
          }
        }
        searchFrom = markerIndex + marker.length;
      }
    }
  }

  for (const segment of segments) {
    const values = extractBootstrapKeyPairs(segment) ?? extractBootstrapFromDom(segment);
    if (values) {
      return {
        at: values.at,
        fSid: values.fSid,
        bl: values.bl,
        source: `bootstrap script (${values.aliases.at}/${values.aliases.fSid}/${values.aliases.bl})`,
      };
    }
  }

  throw new ClassroomBootstrapError();
}

function normalizeDisplayStates(displayStates) {
  if (!Array.isArray(displayStates) || displayStates.length === 0) {
    throw new ConfigError('Classroom display states are required for pONvgf');
  }

  const normalized = [];
  const seen = new Set();
  for (const state of displayStates) {
    const numericState = typeof state === 'number' ? state : Number(state);
    if (!Number.isSafeInteger(numericState) || numericState < 0) {
      throw new ConfigError('Classroom display states must be safe integers');
    }
    if (!seen.has(numericState)) {
      seen.add(numericState);
      normalized.push(numericState);
    }
  }
  return normalized;
}

function sameNumberArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sourcePathForDisplayStates(displayStates) {
  return sameNumberArray(displayStates, CLASSROOM_NOT_TURNED_IN_STATES)
    ? CLASSROOM_HOME_PATH
    : CLASSROOM_TURNED_IN_PATH;
}

export function createCourseWorkRpcPayload(
  courseId,
  options = {},
) {
  const normalizedCourseId = String(courseId ?? '').trim();
  if (!normalizedCourseId) {
    throw new ConfigError('Classroom course id is required for pONvgf');
  }
  const displayStates = Array.isArray(options)
    ? options
    : options?.displayStates ?? CLASSROOM_NOT_TURNED_IN_STATES;
  const normalizedDisplayStates = normalizeDisplayStates(displayStates);

  const numericCourseId = /^\d+$/.test(normalizedCourseId) && Number.isSafeInteger(Number(normalizedCourseId))
    ? Number(normalizedCourseId)
    : normalizedCourseId;

  return [
    [COURSE_WORK_REQUEST_FIRST_VALUE, null, 1, 0],
    [
      [
        [...COURSE_WORK_FLAGS_A],
        [...COURSE_WORK_FLAGS_B],
        [null, 1],
        null,
        [1, 1],
      ],
      [[...COURSE_WORK_FLAGS_A]],
      [[...COURSE_WORK_FLAGS_A], [...COURSE_WORK_FLAGS_B], [1]],
      null,
      null,
      [[...COURSE_WORK_FLAGS_A]],
    ],
    [
      [
        null,
        [[numericCourseId]],
        [2, 5],
        [2],
        ...Array(10).fill(null),
        normalizedDisplayStates,
      ],
    ],
  ];
}

export function createCourseListRpcPayload() {
  // structuredClone prevents callers from mutating the shared opaque mask.
  return structuredClone(COURSE_LIST_REQUEST_PAYLOAD);
}

function scalarString(value) {
  return hasValue(value) && (typeof value === 'string' || typeof value === 'number')
    ? String(value).trim()
    : null;
}

function courseRecordId(record) {
  return scalarString(record?.[0]?.[0]);
}

function courseRecordName(record) {
  return typeof record?.[5] === 'string' && record[5].trim()
    ? normalizeDescription(record[5])
    : null;
}

/*
 * gXtzob returns a 54-field course record. The current home page response
 * contains all visible and archived records in payload[2]. A live comparison
 * with the sidebar's O1Xqee response confirmed that records with the
 * protocol discriminator at index 20 equal to 1 are exactly the visible
 * "Мої курси" set. The discriminator is intentionally not given a semantic
 * name here; only the observed set membership is used.
 */
export function decodeCourseListPayload(payload) {
  const decoded = decodeNestedJson(payload);
  const records = Array.isArray(decoded?.[2]) ? decoded[2] : null;
  if (!records) {
    throw new ClassroomWebError('Classroom course list response did not contain course records', {
      code: 'CLASSROOM_COURSE_LIST_RESPONSE_ERROR',
    });
  }

  const courses = [];
  const seenCourseIds = new Set();
  for (const record of records) {
    if (!Array.isArray(record) || record[20] !== 1) {
      continue;
    }

    const courseId = courseRecordId(record);
    const name = courseRecordName(record);
    if (!courseId || !name || seenCourseIds.has(courseId)) {
      continue;
    }

    seenCourseIds.add(courseId);
    courses.push({
      courseId,
      name,
      teacherName: null,
    });
  }

  return courses;
}

function createRequestIdFactory() {
  let requestId = 1000 + Math.floor(Math.random() * 9000);
  return () => {
    const current = requestId;
    requestId += 100_000;
    return String(current);
  };
}

function parseJsonDocumentAt(text, startIndex) {
  const start = Number(startIndex);
  if (text[start] === '{' || text[start] === '[') {
    return parseBalancedJson(text, start);
  }
  return null;
}

function firstJsonIndex(text) {
  const match = String(text ?? '').search(/\S/);
  return match < 0 ? null : match;
}

function parseBatchexecuteDocumentsDetailed(text) {
  const rawText = String(text ?? '');
  let remaining = rawText.trimStart();
  const hasXssiPrefix = remaining.startsWith(")]}'");
  if (hasXssiPrefix) {
    remaining = remaining.slice(4).replace(/^\s+/, '');
  }

  const documents = [];
  const chunks = [];
  let offset = 0;
  while (offset < remaining.length) {
    while (/\s/.test(remaining[offset] ?? '')) {
      offset += 1;
    }
    if (offset >= remaining.length) {
      break;
    }

    const lengthStart = offset;
    while (/\d/.test(remaining[offset] ?? '')) {
      offset += 1;
    }
    if (offset > lengthStart && (remaining[offset] === '\n' || remaining[offset] === '\r')) {
      const declaredLength = Number(remaining.slice(lengthStart, offset));
      while (remaining[offset] === '\n' || remaining[offset] === '\r') {
        offset += 1;
      }
      const parsed = parseJsonDocumentAt(remaining, offset + (firstJsonIndex(remaining.slice(offset)) ?? 0));
      const actualFrame = parsed ? remaining.slice(offset, parsed.endIndex) : '';
      const codeUnitLength = actualFrame.length;
      const utf8ByteLength = Buffer.byteLength(actualFrame, 'utf8');
      const codeUnitDelta = declaredLength - codeUnitLength;
      const utf8ByteDelta = declaredLength - utf8ByteLength;
      const matchesCodeUnits = Number.isFinite(codeUnitDelta)
        && codeUnitDelta >= 0
        && codeUnitDelta <= 2;
      const matchesUtf8Bytes = Number.isFinite(utf8ByteDelta)
        && utf8ByteDelta >= 0
        && utf8ByteDelta <= 2;
      // Batchexecute responses observed from Classroom use a small separator
      // allowance and may count either string code units or UTF-8 bytes.
      // Parse the balanced JSON itself and leave the following length prefix
      // for the next loop iteration instead of consuming it.
      const lengthCompatible = parsed && (matchesCodeUnits || matchesUtf8Bytes);
      if (parsed && lengthCompatible) {
        documents.push(parsed.value);
        chunks.push({
          declaredLength,
          actualLength: matchesCodeUnits ? codeUnitLength : utf8ByteLength,
          lengthMode: matchesCodeUnits ? 'code-units' : 'utf8-bytes',
          value: parsed.value,
          prefix: structuralFramePrefix(parsed.value),
        });
        offset = parsed.endIndex;
        continue;
      }
      // If the length is not a valid frame, fall through and try the next
      // balanced JSON document rather than treating the response as valid.
      offset = lengthStart;
    } else {
      offset = lengthStart;
    }

    const parsed = parseJsonDocumentAt(remaining, offset);
    if (!parsed) {
      break;
    }
    documents.push(parsed.value);
    chunks.push({
      declaredLength: null,
      actualLength: Buffer.byteLength(remaining.slice(offset, parsed.endIndex), 'utf8'),
      lengthMode: 'utf8-bytes',
      value: parsed.value,
      prefix: structuralFramePrefix(parsed.value),
    });
    offset = parsed.endIndex;
  }

  return {
    rawResponseLength: Buffer.byteLength(rawText, 'utf8'),
    hasXssiPrefix,
    documents,
    chunks,
  };
}

function parseBatchexecuteDocuments(text) {
  return parseBatchexecuteDocumentsDetailed(text).documents;
}

function parseNestedJsonString(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || !['{', '[', '"'].includes(trimmed[0])) {
    return null;
  }
  try {
    return { value: JSON.parse(trimmed) };
  } catch {
    return null;
  }
}

function decodeNestedJson(value, depth = 0) {
  if (depth > 8 || typeof value !== 'string') {
    return value;
  }
  const parsed = parseNestedJsonString(value);
  return parsed === null ? value : decodeNestedJson(parsed.value, depth + 1);
}

function classroomJsonPath(path) {
  return '$' + path.map((part) => (
    typeof part === 'number' ? `[${part}]` : `[${JSON.stringify(part)}]`
  )).join('');
}

function classroomValueType(value) {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

function classroomScalarMatches(value, target) {
  return hasValue(target)
    && (typeof value === 'string' || typeof value === 'number')
    && String(value) === String(target);
}

function inspectDecodedClassroomPayload(value, {
  assignmentId,
  courseId,
  titleFragment,
  maxPaths = 1000,
} = {}) {
  const matches = {
    assignmentId: [],
    courseId: [],
    titleFragment: [],
  };
  const contexts = [];
  const stats = {
    arrays: 0,
    objects: 0,
    strings: 0,
    numbers: 0,
    booleans: 0,
    nulls: 0,
    nestedJsonStrings: 0,
    maxDepth: 0,
  };
  const seenObjects = new WeakSet();
  const activeNestedStrings = new Set();

  function addMatch(kind, path) {
    const formattedPath = classroomJsonPath(path);
    if (!matches[kind].includes(formattedPath) && matches[kind].length < maxPaths) {
      matches[kind].push(formattedPath);
    }
  }

  function addAssignmentContext(path, arrayAncestors) {
    const nearestArray = [...arrayAncestors].reverse().find(({ value: ancestor }) => Array.isArray(ancestor));
    if (!nearestArray || !Number.isInteger(nearestArray.index)) {
      return;
    }

    const { value: parent, path: parentPath, index } = nearestArray;
    const neighbours = [index - 1, index + 1]
      .filter((neighbourIndex) => neighbourIndex >= 0 && neighbourIndex < parent.length)
      .map((neighbourIndex) => ({
        index: neighbourIndex,
        type: classroomValueType(parent[neighbourIndex]),
      }));
    const key = `${classroomJsonPath(parentPath)}:${parent.length}:${index}`;
    if (contexts.some((context) => context.key === key)) {
      return;
    }
    contexts.push({
      key,
      parentPath: classroomJsonPath(parentPath),
      parentLength: parent.length,
      matchedIndex: index,
      neighbours,
      matchedPath: classroomJsonPath(path),
    });
  }

  function visit(node, path = [], arrayAncestors = [], depth = 0) {
    stats.maxDepth = Math.max(stats.maxDepth, depth);

    if (node === null) {
      stats.nulls += 1;
      return;
    }

    if (typeof node === 'string') {
      stats.strings += 1;
      if (classroomScalarMatches(node, assignmentId)) {
        addMatch('assignmentId', path);
        addAssignmentContext(path, arrayAncestors);
      }
      if (classroomScalarMatches(node, courseId)) {
        addMatch('courseId', path);
      }
      if (hasValue(titleFragment) && node.includes(String(titleFragment))) {
        addMatch('titleFragment', path);
      }

      if (depth >= 40 || node.length > 200_000 || activeNestedStrings.has(node)) {
        return;
      }
      const parsed = parseNestedJsonString(node);
      if (parsed === null) {
        return;
      }
      activeNestedStrings.add(node);
      stats.nestedJsonStrings += 1;
      try {
        visit(parsed.value, [...path, '<nested-json>'], arrayAncestors, depth + 1);
      } finally {
        activeNestedStrings.delete(node);
      }
      return;
    }

    if (typeof node === 'number') {
      stats.numbers += 1;
      if (classroomScalarMatches(node, assignmentId)) {
        addMatch('assignmentId', path);
        addAssignmentContext(path, arrayAncestors);
      }
      if (classroomScalarMatches(node, courseId)) {
        addMatch('courseId', path);
      }
      return;
    }

    if (typeof node === 'boolean') {
      stats.booleans += 1;
      return;
    }

    if (typeof node !== 'object' || seenObjects.has(node)) {
      return;
    }
    seenObjects.add(node);

    if (Array.isArray(node)) {
      stats.arrays += 1;
      node.forEach((child, index) => visit(
        child,
        [...path, index],
        [...arrayAncestors, { value: node, path, index }],
        depth + 1,
      ));
      return;
    }

    stats.objects += 1;
    Object.entries(node).forEach(([key, child]) => visit(
      child,
      [...path, key],
      arrayAncestors,
      depth + 1,
    ));
  }

  visit(value);
  return {
    matches: Object.fromEntries(Object.entries(matches).map(([kind, paths]) => [kind, {
      found: paths.length > 0,
      paths,
    }])),
    contexts: contexts.map(({ key, ...context }) => context),
    stats,
  };
}

export function inspectClassroomPayload(payload, options = {}) {
  return inspectDecodedClassroomPayload(decodeNestedJson(payload), options);
}

export function inspectClassroomRawResponse(text, {
  assignmentId,
  courseId,
  titleFragment,
} = {}) {
  const rawText = String(text ?? '');
  return {
    assignmentId: hasValue(assignmentId) && rawText.includes(String(assignmentId)),
    courseId: hasValue(courseId) && rawText.includes(String(courseId)),
    titleFragment: hasValue(titleFragment) && rawText.includes(String(titleFragment)),
  };
}

function collectWrbFrFrames(value, frames = [], seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) {
    return frames;
  }
  seen.add(value);

  if (Array.isArray(value) && value[0] === 'wrb.fr') {
    frames.push(value);
  }

  if (Array.isArray(value)) {
    value.forEach((child) => collectWrbFrFrames(child, frames, seen));
  } else {
    Object.values(value).forEach((child) => collectWrbFrFrames(child, frames, seen));
  }
  return frames;
}

function rawPayloadFieldType(frame) {
  if (!frame) {
    return 'not-found';
  }
  if (frame[2] === null) {
    return 'null';
  }
  if (Array.isArray(frame[2])) {
    return 'array';
  }
  if (typeof frame[2] === 'string') {
    return 'string';
  }
  return 'other';
}

function structuralFramePrefix(value) {
  const frame = collectWrbFrFrames(value)[0];
  if (frame) {
    const responseRpcId = hasValue(frame[1]) ? String(frame[1]) : 'unknown';
    return `wrb.fr/${responseRpcId}`;
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  if (value && typeof value === 'object') {
    return 'object';
  }
  return typeof value;
}

export function inspectBatchexecuteResponse(text, rpcid) {
  const parsed = parseBatchexecuteDocumentsDetailed(text);
  const wrbFrFrames = parsed.documents.flatMap((document) => collectWrbFrFrames(document));
  const rpcIds = [...new Set(
    wrbFrFrames
      .map((frame) => frame[1])
      .filter((value) => hasValue(value))
      .map((value) => String(value)),
  )];
  const targetFrame = wrbFrFrames.find((frame) => String(frame[1] ?? '') === String(rpcid));
  const firstChunk = parsed.chunks[0] ?? null;

  return {
    rawResponseLength: Buffer.byteLength(String(text ?? ''), 'utf8'),
    hasXssiPrefix: parsed.hasXssiPrefix,
    firstFrameLength: firstChunk?.declaredLength ?? null,
    firstFrameActualLength: firstChunk?.actualLength ?? null,
    firstFrameLengthMode: firstChunk?.lengthMode ?? 'unknown',
    firstFramePrefix: firstChunk?.prefix ?? 'none',
    wrbFrFramesCount: wrbFrFrames.length,
    rpcIds,
    payloadFieldType: rawPayloadFieldType(targetFrame),
  };
}

function findRpcFrame(value, rpcid) {
  if (!Array.isArray(value)) {
    return null;
  }
  if (value[0] === 'wrb.fr' && String(value[1] ?? '') === String(rpcid)) {
    return value;
  }
  for (const child of value) {
    const frame = findRpcFrame(child, rpcid);
    if (frame) {
      return frame;
    }
  }
  return null;
}

function findRpcErrorFrame(value, rpcid) {
  if (!Array.isArray(value)) {
    return null;
  }
  if (value[0] === 'er' && (value[1] === undefined || String(value[1]) === String(rpcid))) {
    return value;
  }
  for (const child of value) {
    const frame = findRpcErrorFrame(child, rpcid);
    if (frame) {
      return frame;
    }
  }
  return null;
}

export function decodeBatchexecuteResponse(text, rpcid, { includeRaw = false } = {}) {
  const documents = parseBatchexecuteDocuments(text);
  const errorFrame = documents.map((document) => findRpcErrorFrame(document, rpcid)).find(Boolean);
  if (errorFrame) {
    throw new ClassroomWebError(`Classroom RPC ${rpcid} returned an error`, {
      code: 'CLASSROOM_RPC_RESPONSE_ERROR',
    });
  }
  const frame = documents.map((document) => findRpcFrame(document, rpcid)).find(Boolean);

  if (frame) {
    if (frame[0] === 'er') {
      throw new ClassroomWebError(`Classroom RPC ${rpcid} returned an error`, {
        code: 'CLASSROOM_RPC_RESPONSE_ERROR',
      });
    }
    const payload = decodeNestedJson(frame[2]);
    return includeRaw ? { payload, raw: documents } : payload;
  }

  if (documents.length === 1) {
    const payload = decodeNestedJson(documents[0]);
    return includeRaw ? { payload, raw: documents } : payload;
  }

  throw new ClassroomWebError(`Classroom RPC ${rpcid} response did not contain a decodable payload`, {
    code: 'CLASSROOM_RPC_RESPONSE_ERROR',
  });
}

function normalizeTimestamp(value) {
  if (!hasValue(value)) {
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
  }
  if (typeof value === 'object' && value) {
    if (hasValue(value.seconds)) {
      return normalizeTimestamp(Number(value.seconds) * 1000);
    }
    const year = Number(value.year);
    const month = Number(value.month);
    const day = Number(value.day);
    if ([year, month, day].every(Number.isInteger)) {
      const date = new Date(Date.UTC(year, month - 1, day));
      return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
    }
    return null;
  }
  const stringValue = String(value).trim();
  const date = new Date(stringValue);
  return Number.isNaN(date.getTime()) ? stringValue : date.toISOString();
}

function normalizeAttachment(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const link = value.url
    ?? value.alternateLink
    ?? value.link?.url
    ?? value.driveFile?.driveFile?.alternateLink
    ?? value.driveFile?.alternateLink
    ?? value.youtubeVideo?.alternateLink
    ?? null;
  const name = value.name
    ?? value.title
    ?? value.driveFile?.driveFile?.title
    ?? value.driveFile?.title
    ?? null;
  if (!hasValue(link) && !hasValue(name)) {
    return null;
  }
  return {
    ...(hasValue(name) ? { name: String(name) } : {}),
    ...(hasValue(link) ? { url: String(link) } : {}),
  };
}

function normalizeAttachments(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(normalizeAttachment).filter(Boolean);
}

function candidateId(object, isCourseWorkContext) {
  const explicitId = object.assignmentId ?? object.courseWorkId;
  if (hasValue(explicitId)) {
    return String(explicitId).trim();
  }
  if (isCourseWorkContext && hasValue(object.id)) {
    return String(object.id).trim();
  }
  return null;
}

function normalizeCourseWorkObject(object, courseId, isCourseWorkContext) {
  const assignmentId = candidateId(object, isCourseWorkContext);
  const title = object.title;
  if (!assignmentId || !hasValue(title)) {
    return null;
  }

  const objectCourseId = object.courseId ?? object.course?.id;
  if (hasValue(objectCourseId) && String(objectCourseId) !== String(courseId)) {
    return null;
  }

  const description = object.description
    ?? object.descriptionText
    ?? object.plainText
    ?? object.htmlDescription
    ?? '';
  const dueAt = normalizeTimestamp(
    object.dueAt
      ?? object.dueTimestamp
      ?? object.dueTime
      ?? object.dueDate,
  );
  const updatedAt = normalizeTimestamp(
    object.updatedAt
      ?? object.updateTime
      ?? object.updateTimestamp,
  );
  const attachments = normalizeAttachments(object.attachments ?? object.materials);

  return {
    source: 'classroom',
    courseId: String(objectCourseId ?? courseId),
    assignmentId,
    title: normalizeDescription(title),
    description: normalizeDescription(description),
    dueAt,
    updatedAt,
    attachments,
  };
}

/*
 * The current pONvgf response is an array-only wire format. These are the
 * only response positions used by the array decoder, all confirmed in the
 * captured live response: identity[0], identity[1][0], record[5], the plain
 * description at record[27][0][6][1], and the optional due tuple at
 * record[9][4]. Unknown numeric positions are deliberately ignored.
 */
function normalizeCourseWorkArray(record, courseId) {
  if (!Array.isArray(record) || record.length < 28 || !Array.isArray(record[0])) {
    return null;
  }

  const identity = record[0];
  const assignmentId = identity[0];
  const courseIds = identity[1];
  const title = record[5];
  if (!hasValue(assignmentId) || !Array.isArray(courseIds) || !hasValue(courseIds[0]) || !hasValue(title)) {
    return null;
  }
  if (String(courseIds[0]) !== String(courseId)) {
    return null;
  }

  const details = Array.isArray(record[27]) ? record[27][0] : null;
  const plainDescription = details?.[6]?.[1];
  const htmlDescription = details?.[6]?.[4]?.[1];
  const description = typeof plainDescription === 'string'
    ? plainDescription
    : typeof htmlDescription === 'string'
      ? cheerio.load(htmlDescription).text()
      : '';
  const dueMetadata = Array.isArray(record[9]) ? record[9] : null;

  return {
    source: 'classroom',
    courseId: String(courseIds[0]),
    assignmentId: String(assignmentId),
    title: normalizeDescription(title),
    description: normalizeDescription(description),
    dueAt: normalizeTimestamp(dueMetadata?.[4]),
    updatedAt: normalizeTimestamp(record[2]),
    // The current list response exposes material-shaped arrays but does not
    // identify their fields reliably enough to turn them into links here.
    attachments: [],
  };
}

function collectCourseWorkObjects(value, courseId, debug = false) {
  const assignments = [];
  const seenIds = new Set();
  const rawCandidates = [];

  function addCandidate(candidate, value, path) {
    rawCandidates.push({ path, value });
    const identity = `${candidate.courseId}:${candidate.assignmentId}`;
    if (!seenIds.has(identity)) {
      seenIds.add(identity);
      assignments.push(debug ? { ...candidate, raw: value } : candidate);
    }
  }

  function visit(node, context = {}, path = [], seen = new Set(), activeNestedStrings = new Set()) {
    if (typeof node === 'string') {
      if (activeNestedStrings.has(node) || node.length > 200_000) {
        return;
      }
      const parsed = parseNestedJsonString(node);
      if (parsed === null) {
        return;
      }
      activeNestedStrings.add(node);
      try {
        visit(parsed.value, context, [...path, '<nested-json>'], seen, activeNestedStrings);
      } finally {
        activeNestedStrings.delete(node);
      }
      return;
    }

    if (node === null || typeof node !== 'object' || seen.has(node)) {
      return;
    }
    seen.add(node);

    if (Array.isArray(node)) {
      const arrayCandidate = normalizeCourseWorkArray(node, courseId);
      if (arrayCandidate) {
        addCandidate(arrayCandidate, node, path);
      }
      node.forEach((child, index) => visit(
        child,
        context,
        [...path, index],
        seen,
        activeNestedStrings,
      ));
      return;
    }

    const keys = Object.keys(node);
    const isCourseWork = context.isCourseWork
      || keys.some((key) => ['courseWork', 'coursework', 'assignment'].includes(key.toLowerCase()));
    const candidate = normalizeCourseWorkObject(node, courseId, isCourseWork);
    if (candidate) {
      addCandidate(candidate, node, path);
    }

    for (const [key, child] of Object.entries(node)) {
      const childContext = {
        isCourseWork: isCourseWork
          || ['courseWork', 'coursework', 'assignment', 'assignments', 'items'].includes(key),
      };
      visit(child, childContext, [...path, key], seen, activeNestedStrings);
    }
  }

  visit(value);
  return { assignments, rawCandidates };
}

function hasRecognizedCourseWorkCollection(value, courseId, seen = new Set(), depth = 0) {
  if (depth > 8 || value === null || value === undefined) {
    return false;
  }
  if (typeof value === 'string') {
    const parsed = parseNestedJsonString(value);
    return parsed === null
      ? false
      : hasRecognizedCourseWorkCollection(parsed.value, courseId, seen, depth + 1);
  }
  if (typeof value !== 'object' || seen.has(value)) {
    return false;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    if (value[0] === 'hrq.cus' && Array.isArray(value[2])) {
      return value[2].length === 0
        || value[2].some((record) => normalizeCourseWorkArray(record, courseId));
    }
    if (value.length > 0 && value.every((record) => normalizeCourseWorkArray(record, courseId))) {
      return true;
    }
    return value.some((child) => hasRecognizedCourseWorkCollection(child, courseId, seen, depth + 1));
  }

  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    if (['coursework', 'assignments', 'items'].includes(normalizedKey)
      && Array.isArray(child)) {
      return child.length === 0 || child.some((item) => (
        normalizeCourseWorkObject(item, courseId, true)
        || normalizeCourseWorkArray(item, courseId)
      ));
    }
    if (normalizedKey === 'assignment'
      && child && typeof child === 'object'
      && normalizeCourseWorkObject(child, courseId, true)) {
      return true;
    }
  }

  return Object.values(value).some((child) => (
    hasRecognizedCourseWorkCollection(child, courseId, seen, depth + 1)
  ));
}

export function decodeCourseWorkPayload(payload, {
  courseId,
  debug = false,
  includeMetadata = false,
  debugTargets,
} = {}) {
  const normalizedCourseId = String(courseId ?? '').trim();
  if (!normalizedCourseId) {
    throw new ConfigError('Classroom course id is required to decode coursework');
  }
  const decoded = decodeNestedJson(payload);
  const { assignments, rawCandidates } = collectCourseWorkObjects(decoded, normalizedCourseId, debug);
  const recognized = hasRecognizedCourseWorkCollection(decoded, normalizedCourseId);
  if (debug) {
    return {
      assignments,
      recognized,
      raw: decoded,
      rawCandidates,
      decodeDiagnostics: inspectDecodedClassroomPayload(decoded, {
        courseId: normalizedCourseId,
        ...debugTargets,
      }),
    };
  }
  return includeMetadata ? { assignments, recognized } : assignments;
}

/*
 * The live pONvgf response uses payload[1][1][0] for an opaque continuation
 * value when the current page is truncated. A missing value means that the
 * response ended the current result set. The token is copied byte-for-byte
 * into the next request; its contents are intentionally not interpreted.
 */
export function extractCourseWorkContinuationToken(payload) {
  if (!Array.isArray(payload) || !Array.isArray(payload[1]) || payload[1].length < 2) {
    return null;
  }

  const tokenContainer = payload[1][1];
  if (tokenContainer === null || tokenContainer === undefined) {
    return null;
  }
  if (!Array.isArray(tokenContainer)) {
    throw new ClassroomWebError('Classroom coursework continuation field has an unexpected shape', {
      code: 'CLASSROOM_PAGINATION_RESPONSE_ERROR',
    });
  }

  const token = tokenContainer[0];
  if (token === null || token === undefined || token === '') {
    return null;
  }
  if (typeof token !== 'string') {
    throw new ClassroomWebError('Classroom coursework continuation value has an unexpected type', {
      code: 'CLASSROOM_PAGINATION_RESPONSE_ERROR',
    });
  }
  return token;
}

function pageDebugArtifactPath(filePath, pageNumber) {
  if (pageNumber === 1) {
    return filePath;
  }
  const basePath = String(filePath ?? DEFAULT_CLASSROOM_RPC_DEBUG_ARTIFACT_PATH);
  return basePath.replace(/\.debug\.txt$/i, `.page-${pageNumber}.debug.txt`);
}

function createRequestDeadline(externalSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  let externallyAborted = false;
  let abortListener;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timeout.unref?.();

  if (externalSignal) {
    abortListener = () => {
      externallyAborted = true;
      controller.abort(externalSignal.reason);
    };
    if (externalSignal.aborted) {
      abortListener();
    } else {
      externalSignal.addEventListener('abort', abortListener, { once: true });
    }
  }

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    wasExternallyAborted: () => externallyAborted,
    cleanup() {
      clearTimeout(timeout);
      if (abortListener && externalSignal) {
        externalSignal.removeEventListener('abort', abortListener);
      }
    },
  };
}

function errorForClassroomRequest(deadline, timeoutMs) {
  if (deadline.didTimeout()) {
    return new ClassroomWebError(`Classroom request timed out after ${timeoutMs} ms`, {
      code: 'CLASSROOM_TIMEOUT',
    });
  }
  if (deadline.wasExternallyAborted()) {
    return new ClassroomWebError('Classroom request was cancelled.', {
      code: 'CLASSROOM_ABORTED',
    });
  }
  return new ClassroomWebError('Classroom request failed due to a network error.', {
    code: 'CLASSROOM_NETWORK_ERROR',
  });
}

function attachBodyDeadline(response, deadline, timeoutMs) {
  if (!response || typeof response.text !== 'function') {
    deadline.cleanup();
    return response;
  }

  const originalText = response.text.bind(response);
  response.text = async (...args) => {
    try {
      const text = await originalText(...args);
      if (deadline.didTimeout() || deadline.wasExternallyAborted()) {
        throw errorForClassroomRequest(deadline, timeoutMs);
      }
      return text;
    } catch {
      throw errorForClassroomRequest(deadline, timeoutMs);
    } finally {
      deadline.cleanup();
    }
  };
  return response;
}

async function fetchWithTimeout(fetchFn, url, init, timeoutMs) {
  const deadline = createRequestDeadline(init.signal, timeoutMs);
  let responseReturned = false;
  try {
    const response = await fetchFn(url, { ...init, signal: deadline.signal });
    responseReturned = true;
    return attachBodyDeadline(response, deadline, timeoutMs);
  } catch {
    throw errorForClassroomRequest(deadline, timeoutMs);
  } finally {
    if (!responseReturned) {
      deadline.cleanup();
    }
  }
}

function headersWithRawCookie(init, url, cookieHeader) {
  parseClassroomCookieHeader(cookieHeader);
  const headers = new Headers(init.headers ?? {});
  const parsedUrl = parseUrl(url);
  if (parsedUrl?.hostname === 'classroom.google.com') {
    // Keep the operator-provided header byte-for-byte intact for the first
    // Classroom request. The jar is populated only after that request.
    headers.set('Cookie', cookieHeader);
  } else {
    headers.delete('Cookie');
  }
  return headers;
}

async function fetchWithRawCookieHeader({ fetchImpl, url, init, cookieHeader, timeoutMs, onRequest }) {
  let currentUrl = String(url);
  const redirectChain = [safeUrl(currentUrl)];

  for (let redirectCount = 0; redirectCount <= MAX_CLASSROOM_REDIRECTS; redirectCount += 1) {
    const requestHeaders = headersWithRawCookie(init, currentUrl, cookieHeader);
    onRequest?.({
      url: currentUrl,
      method: init.method ?? 'GET',
      headers: requestHeaders,
    });
    const response = await fetchWithTimeout(
      fetchImpl,
      currentUrl,
      {
        ...init,
        headers: requestHeaders,
        redirect: 'manual',
      },
      timeoutMs,
    );

    if (!isRedirectStatus(response.status)) {
      return { response, finalUrl: currentUrl, redirectChain };
    }

    const location = response.headers?.get?.('location');
    if (!location) {
      return { response, finalUrl: currentUrl, redirectChain };
    }

    let nextUrl;
    try {
      nextUrl = parseUrl(new URL(location, currentUrl).toString());
    } catch {
      throw new ClassroomWebError('Classroom redirect returned an invalid location');
    }
    if (!nextUrl) {
      throw new ClassroomWebError('Classroom redirect location is invalid', {
        code: 'CLASSROOM_REDIRECT_ERROR',
      });
    }
    currentUrl = nextUrl.toString();
    redirectChain.push(safeUrl(currentUrl));
  }

  throw new ClassroomWebError(`Classroom redirect limit exceeded (${MAX_CLASSROOM_REDIRECTS})`, {
    code: 'CLASSROOM_REDIRECT_ERROR',
  });
}

function isRedirectStatus(status) {
  return [301, 302, 303, 307, 308].includes(Number(status));
}

function safeUrl(value) {
  try {
    const url = new URL(value, CLASSROOM_ORIGIN);
    return `${url.hostname}${url.pathname || '/'}`;
  } catch {
    return '[invalid-url]';
  }
}

function parseUrl(value) {
  try {
    return new URL(value, CLASSROOM_ORIGIN);
  } catch {
    return null;
  }
}

function pageSignals(response, html, finalUrl) {
  const parsedUrl = parseUrl(finalUrl ?? response?.url ?? CLASSROOM_HOME_URL);
  const titleLooksLikeLogin = /<title[^>]*>[\s\S]*?(?:sign\s*in|вхід|увійти|войти)[\s\S]*?<\/title>/i.test(html);
  const hasGoogleLoginForm = /id=["']identifierId["']/i.test(html)
    || /name=["']identifier["']/i.test(html)
    || /<form[^>]+action=["'][^"']*accounts\.google\.com/i.test(html);
  const onGoogleLoginHost = parsedUrl?.hostname === 'accounts.google.com';
  const loginSignals = [onGoogleLoginHost, titleLooksLikeLogin, hasGoogleLoginForm]
    .filter(Boolean).length;
  const classroomMarkers = [
    /WIZ_global_data/i.test(html),
    /(?:SNlM0e|FdrFJe|cfb2h)/i.test(html),
    /classroom\.google\.com/i.test(html),
    /(?:ClassroomUi|not-turned-in|coursework)/i.test(html),
    /<title[^>]*>[\s\S]*classroom[\s\S]*<\/title>/i.test(html),
  ].filter(Boolean).length;
  const onClassroomHost = parsedUrl?.hostname === 'classroom.google.com';

  return {
    titleLooksLikeLogin,
    hasGoogleLoginForm,
    onGoogleLoginHost,
    loginSignals,
    onClassroomHost,
    classroomMarkers,
    looksLikeGoogleLogin: onGoogleLoginHost || hasGoogleLoginForm || (titleLooksLikeLogin && loginSignals >= 2),
    looksLikeClassroom: onClassroomHost && classroomMarkers >= 2,
  };
}

function assertAuthenticatedPageAtUrl(response, html, finalUrl) {
  const signals = pageSignals(response, html, finalUrl);

  if (response?.status === 401 || response?.status === 403
    || signals.onGoogleLoginHost
    || (signals.hasGoogleLoginForm && !signals.looksLikeClassroom)
    || (signals.titleLooksLikeLogin && signals.loginSignals >= 2)) {
    throw new ClassroomSessionError();
  }
  if (!response?.ok) {
    throw new ClassroomWebError(`Classroom page request failed (HTTP ${response?.status ?? 'unknown'})`, {
      code: 'CLASSROOM_HTTP_ERROR',
      status: response?.status,
    });
  }

  if (parseUrl(finalUrl)?.hostname && !signals.onClassroomHost && !signals.looksLikeGoogleLogin) {
    throw new ClassroomWebError('Classroom page ended on an unexpected host', {
      code: 'CLASSROOM_UNEXPECTED_REDIRECT',
    });
  }
}

async function writeClassroomRpcDebugArtifact(filePath, responseText) {
  const targetPath = resolve(filePath || DEFAULT_CLASSROOM_RPC_DEBUG_ARTIFACT_PATH);
  const temporaryPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;

  try {
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(temporaryPath, responseText, 'utf8');
    await rename(temporaryPath, targetPath);
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch {
      // Preserve the original artifact error without exposing response data.
    }
    throw new ClassroomWebError('Could not write Classroom RPC debug artifact', {
      code: 'CLASSROOM_DEBUG_ARTIFACT_ERROR',
      cause: error,
    });
  }
}

export async function callClassroomRpc({
  client,
  rpcid,
  sourcePath = CLASSROOM_SOURCE_PATH,
  referer = CLASSROOM_HOME_URL,
  payload,
  bootstrap,
  debug = false,
  debugArtifactPath = DEFAULT_CLASSROOM_RPC_DEBUG_ARTIFACT_PATH,
  debugRunId,
  debugTargets,
  expectedCourseId,
  bootstrapFromAuthenticatedPage = false,
  signal,
} = {}) {
  if (!client?.request) {
    throw new ConfigError('Classroom web client is required for RPC calls');
  }
  if (!hasValue(rpcid)) {
    throw new ConfigError('Classroom RPC id is required');
  }
  if (payload === undefined) {
    throw new ConfigError(`Classroom RPC ${rpcid} payload is required`);
  }

  const session = bootstrap ?? (await client.getAuthenticatedPage({ signal })).bootstrap;
  if (!session?.at || !session?.fSid || !session?.bl) {
    throw new ClassroomBootstrapError();
  }

  const requestUrl = new URL(CLASSROOM_RPC_PATH, CLASSROOM_ORIGIN);
  const query = {
    rpcids: String(rpcid),
    'source-path': sourcePath,
    'f.sid': session.fSid,
    bl: session.bl,
    hl: 'uk',
    'soc-app': '1',
    'soc-platform': '1',
    'soc-device': '2',
    _reqid: client.requestIdFactory(),
    rt: 'c',
  };
  for (const [key, value] of Object.entries(query)) {
    requestUrl.searchParams.set(key, String(value));
  }

  const fReq = JSON.stringify([[
    [String(rpcid), JSON.stringify(payload), null, 'generic'],
  ]]);
  const body = new URLSearchParams([
    ['f.req', fReq],
    ['at', session.at],
  ]);

  const requestHeaders = {
    Accept: '*/*',
    'Content-Type': CLASSROOM_RPC_CONTENT_TYPE,
    'X-Same-Domain': '1',
    Origin: CLASSROOM_ORIGIN,
    Referer: referer,
    'User-Agent': CLASSROOM_BROWSER_USER_AGENT,
  };
  const serializedBody = body.toString();
  let fReqWrapperMatches = false;
  try {
    const parsedFReq = JSON.parse(fReq);
    const call = parsedFReq?.[0]?.[0];
    fReqWrapperMatches = call?.[0] === String(rpcid)
      && typeof call?.[1] === 'string'
      && call?.[2] === null
      && call?.[3] === 'generic'
      && JSON.stringify(JSON.parse(call[1])) === JSON.stringify(payload);
  } catch {
    fReqWrapperMatches = false;
  }

  const requestDiagnostics = {
    rpcid: String(rpcid),
    sourcePath: String(sourcePath),
    fReqLength: fReq.length,
    fReqContainsCourseId: hasValue(expectedCourseId)
      ? fReq.includes(String(expectedCourseId))
      : null,
    formBodyLength: Buffer.byteLength(serializedBody, 'utf8'),
    atConfigured: hasValue(session.at),
    fSidConfigured: hasValue(session.fSid),
    blConfigured: hasValue(session.bl),
    bootstrapFromAuthenticatedPage: Boolean(bootstrapFromAuthenticatedPage),
    query: {
      rpcids: { browser: String(rpcid), node: String(rpcid), matches: true },
      sourcePath: {
        browser: String(sourcePath),
        node: String(sourcePath),
        matches: true,
      },
      fSid: { browser: 'current authenticated bootstrap', node: 'configured', matches: Boolean(bootstrapFromAuthenticatedPage && hasValue(session.fSid)) },
      bl: { browser: 'current Classroom bootstrap', node: 'configured', matches: Boolean(bootstrapFromAuthenticatedPage && hasValue(session.bl)) },
      hl: { browser: 'uk', node: query.hl, matches: query.hl === 'uk' },
      socApp: { browser: '1', node: query['soc-app'], matches: query['soc-app'] === '1' },
      socPlatform: { browser: '1', node: query['soc-platform'], matches: query['soc-platform'] === '1' },
      socDevice: { browser: '2', node: query['soc-device'], matches: query['soc-device'] === '2' },
      reqid: { browser: 'generated per request', node: 'generated', matches: hasValue(query._reqid) },
      rt: { browser: 'c', node: query.rt, matches: query.rt === 'c' },
    },
    headers: {
      originExact: requestHeaders.Origin === CLASSROOM_ORIGIN,
      refererExact: requestHeaders.Referer === referer,
      contentTypeExact: requestHeaders['Content-Type'] === CLASSROOM_RPC_CONTENT_TYPE,
      sameDomain: requestHeaders['X-Same-Domain'] === '1',
      acceptConfigured: hasValue(requestHeaders.Accept),
      userAgentConfigured: hasValue(requestHeaders['User-Agent']),
    },
    body: {
      fReqWrapperMatches: fReqWrapperMatches,
      fReqEncodedOnce: serializedBody.includes('f.req=%5B') && !serializedBody.includes('%255B'),
      contentTypeExact: requestHeaders['Content-Type'] === CLASSROOM_RPC_CONTENT_TYPE,
    },
  };

  const response = await client.request(requestUrl.toString(), {
    method: 'POST',
    headers: requestHeaders,
    body,
    signal,
  });

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new ClassroomSessionError();
    }
    if (response.status === 429) {
      throw new ClassroomWebError('Classroom RPC rate limited (HTTP 429)', {
        code: 'CLASSROOM_RATE_LIMIT',
        status: response.status,
      });
    }
    throw new ClassroomWebError(`Classroom RPC ${rpcid} failed (HTTP ${response.status})`, {
      code: 'CLASSROOM_RPC_HTTP_ERROR',
      status: response.status,
    });
  }

  const responseText = await response.text();
  const responseDiagnostics = debug
    ? {
      status: response.status,
      contentType: response.headers?.get?.('content-type') || 'unknown',
      ...inspectBatchexecuteResponse(responseText, rpcid),
      rawMatches: debugTargets ? inspectClassroomRawResponse(responseText, debugTargets) : null,
      request: requestDiagnostics,
      cookies: client.getCookieRequestDiagnostics?.() ?? null,
      debugRunId: debugRunId ?? null,
      debugArtifactPath: debug ? resolve(debugArtifactPath || DEFAULT_CLASSROOM_RPC_DEBUG_ARTIFACT_PATH) : null,
    }
    : null;

  if (debug && typeof client.setLastRpcDiagnostics === 'function') {
    client.setLastRpcDiagnostics(responseDiagnostics);
  }

  if (debug) {
    await writeClassroomRpcDebugArtifact(debugArtifactPath, responseText);
  }

  const decoded = decodeBatchexecuteResponse(responseText, rpcid, { includeRaw: debug });
  if (!debug) {
    return decoded;
  }

  return {
    ...decoded,
    diagnostics: responseDiagnostics,
  };
}

export async function getCourseWorkForCourse(
  client,
  courseId,
  {
    debug = false,
    debugArtifactPath,
    debugRunId,
    debugTargets,
    includePagination = false,
    signal,
    displayStates = CLASSROOM_NOT_TURNED_IN_STATES,
    sourcePath = null,
    referer = null,
  } = {},
) {
  const normalizedCourseId = String(courseId ?? '').trim();
  if (!normalizedCourseId) {
    throw new ConfigError('Classroom course id is required');
  }
  const normalizedDisplayStates = normalizeDisplayStates(displayStates);
  const requestSourcePath = String(sourcePath || sourcePathForDisplayStates(normalizedDisplayStates));
  const requestReferer = String(
    referer || new URL(requestSourcePath, CLASSROOM_ORIGIN).toString(),
  );

  const refreshable = (error) => error?.code === 'CLASSROOM_SESSION_EXPIRED'
    || error?.code === 'CLASSROOM_BOOTSTRAP_ERROR';
  const refreshSession = async () => {
    client.invalidateSession?.();
    return client.getAuthenticatedPage({ force: true, signal });
  };
  let refreshed = false;
  let page;
  try {
    page = await client.getAuthenticatedPage({ signal });
  } catch (error) {
    if (!refreshable(error)) {
      throw error;
    }
    refreshed = true;
    page = await refreshSession();
  }

  const assignments = [];
  const seenAssignmentIds = new Set();
  const seenContinuationTokens = new Set();
  const pageCounts = [];
  const debugRawCandidates = [];
  const debugRawMatches = debug
    ? { assignmentId: false, courseId: false, titleFragment: false }
    : null;
  let continuationToken = null;
  let lastDebugPage = null;
  let reachedEnd = false;

  for (let pageNumber = 1; pageNumber <= MAX_CLASSROOM_COURSEWORK_PAGES; pageNumber += 1) {
    const payload = createCourseWorkRpcPayload(normalizedCourseId, {
      displayStates: normalizedDisplayStates,
    });
    if (continuationToken !== null) {
      payload[0][1] = continuationToken;
    }

    const rpcOptions = {
      client,
      rpcid: CLASSROOM_RPC_ID,
      sourcePath: requestSourcePath,
      referer: requestReferer,
      payload,
      bootstrap: page.bootstrap,
      debug,
      debugArtifactPath: debug
        ? pageDebugArtifactPath(debugArtifactPath, pageNumber)
        : debugArtifactPath,
      debugRunId: debugRunId
        ? `${debugRunId}-page-${pageNumber}`
        : debugRunId,
      debugTargets,
      expectedCourseId: normalizedCourseId,
      bootstrapFromAuthenticatedPage: true,
      signal,
    };
    let rpcResult;
    try {
      rpcResult = await callClassroomRpc(rpcOptions);
    } catch (error) {
      if (refreshed || !refreshable(error)) {
        throw error;
      }
      refreshed = true;
      page = await refreshSession();
      rpcOptions.bootstrap = page.bootstrap;
      rpcResult = await callClassroomRpc(rpcOptions);
    }
    const rpcPayload = debug ? rpcResult.payload : rpcResult;
    const decoded = decodeCourseWorkPayload(rpcPayload, {
      courseId: normalizedCourseId,
      debug,
      includeMetadata: true,
      debugTargets,
    });
    if (!decoded.recognized) {
      throw new ClassroomWebError('Classroom coursework response schema is unknown', {
        code: 'CLASSROOM_RESPONSE_SCHEMA_UNKNOWN',
      });
    }
    const pageAssignments = decoded.assignments;

    for (const assignment of pageAssignments) {
      const identity = `${assignment.courseId}:${assignment.assignmentId}`;
      if (seenAssignmentIds.has(identity)) {
        continue;
      }
      seenAssignmentIds.add(identity);
      assignments.push(assignment);
    }
    pageCounts.push(pageAssignments.length);

    if (debug) {
      debugRawCandidates.push(...decoded.rawCandidates);
      lastDebugPage = {
        payload: decoded.raw,
        raw: rpcResult.raw,
        decodeDiagnostics: decoded.decodeDiagnostics,
        rpcDiagnostics: rpcResult.diagnostics,
      };
      for (const key of Object.keys(debugRawMatches)) {
        debugRawMatches[key] = debugRawMatches[key] || Boolean(rpcResult.diagnostics?.rawMatches?.[key]);
      }
    }

    const nextContinuationToken = extractCourseWorkContinuationToken(rpcPayload);
    if (nextContinuationToken === null) {
      reachedEnd = true;
      break;
    }
    if (seenContinuationTokens.has(nextContinuationToken)) {
      throw new ClassroomWebError('Classroom coursework pagination returned a repeated continuation value', {
        code: 'CLASSROOM_PAGINATION_LOOP',
      });
    }
    seenContinuationTokens.add(nextContinuationToken);
    continuationToken = nextContinuationToken;
  }

  if (!reachedEnd) {
    throw new ClassroomWebError(
      `Classroom coursework pagination exceeded ${MAX_CLASSROOM_COURSEWORK_PAGES} pages`,
      { code: 'CLASSROOM_PAGINATION_LIMIT' },
    );
  }

  const pagination = {
    pagesFetched: pageCounts.length,
    pageCounts,
  };

  if (debug) {
    return {
      assignments,
      payload: lastDebugPage?.payload ?? null,
      raw: lastDebugPage?.raw ?? [],
      rawCandidates: debugRawCandidates,
      decodeDiagnostics: lastDebugPage?.decodeDiagnostics ?? null,
      rawMatches: debugRawMatches,
      rpcDiagnostics: lastDebugPage?.rpcDiagnostics ?? null,
      pagination,
      recognized: true,
      complete: true,
    };
  }
  return includePagination
    ? {
      assignments,
      ...pagination,
      recognized: true,
      complete: true,
    }
    : assignments;
}

export async function getCourses(client, { signal } = {}) {
  if (!client?.getAuthenticatedHomePage) {
    throw new ConfigError('Classroom web client is required to list courses');
  }

  const refreshable = (error) => error?.code === 'CLASSROOM_SESSION_EXPIRED'
    || error?.code === 'CLASSROOM_BOOTSTRAP_ERROR';
  const refreshSession = async () => {
    client.invalidateSession?.();
    return client.getAuthenticatedHomePage({ force: true, signal });
  };
  let refreshed = false;
  let page;
  try {
    page = await client.getAuthenticatedHomePage({ signal });
  } catch (error) {
    if (!refreshable(error)) {
      throw error;
    }
    refreshed = true;
    page = await refreshSession();
  }

  let payload;
  const rpcOptions = {
    client,
    rpcid: CLASSROOM_COURSES_RPC_ID,
    sourcePath: CLASSROOM_COURSES_PATH,
    referer: CLASSROOM_COURSES_URL,
    payload: createCourseListRpcPayload(),
    bootstrap: page.bootstrap,
    bootstrapFromAuthenticatedPage: true,
    signal,
  };
  try {
    payload = await callClassroomRpc(rpcOptions);
  } catch (error) {
    if (refreshed || !refreshable(error)) {
      throw error;
    }
    refreshed = true;
    page = await refreshSession();
    rpcOptions.bootstrap = page.bootstrap;
    payload = await callClassroomRpc(rpcOptions);
  }

  return decodeCourseListPayload(payload);
}

export function createClassroomWebClient({
  env = process.env,
  cookies,
  cookieHeader,
  cookiesJson,
  cookiesPath,
  defaultCookiesPath = DEFAULT_CLASSROOM_COOKIES_PATH,
  cookieJar,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_CLASSROOM_TIMEOUT_MS,
  requestIdFactory = createRequestIdFactory(),
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new ConfigError('Classroom web client requires a fetch implementation');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ConfigError('Classroom HTTP timeout must be a positive number');
  }

  const configuredCookieHeader = cookieHeader !== undefined
    ? cookieHeader
    : env?.CLASSROOM_COOKIE_HEADER;
  const rawCookieHeader = hasValue(configuredCookieHeader)
    ? String(configuredCookieHeader)
    : null;
  if (rawCookieHeader) {
    parseClassroomCookieHeader(rawCookieHeader);
  }

  const state = {
    cookieJar,
    fetchWithCookies: null,
    page: null,
    homePage: null,
    rawCookieHeaderImported: false,
    lastDiagnostics: null,
    lastRpcDiagnostics: null,
    cookieRequests: { get: null, post: null },
  };

  function recordCookieRequest({ url, method, headers }) {
    const parsedUrl = parseUrl(url);
    const normalizedMethod = String(method ?? 'GET').toUpperCase();
    if (parsedUrl?.hostname !== 'classroom.google.com') {
      return;
    }

    const cookieHeader = new Headers(headers ?? {}).get('cookie') ?? '';
    if (normalizedMethod === 'GET' && parsedUrl.pathname === CLASSROOM_HOME_PATH) {
      state.cookieRequests.get = summarizeCookieHeader(cookieHeader);
    }
    if (normalizedMethod === 'POST' && parsedUrl.pathname === CLASSROOM_RPC_PATH) {
      state.cookieRequests.post = summarizeCookieHeader(cookieHeader);
    }
  }

  const client = {
    timeoutMs,
    requestIdFactory,
    supportsStateFilters: true,
    async initialize() {
      if (!state.cookieJar) {
        state.cookieJar = rawCookieHeader
          ? new CookieJar()
          : await createClassroomCookieJar({
            cookies,
            cookieHeader,
            cookiesJson,
            env,
            cookiesPath,
            defaultPath: defaultCookiesPath,
          });
      }
      if (!state.fetchWithCookies) {
        const fetchWithCookieObservation = async (url, init = {}) => {
          recordCookieRequest({
            url,
            method: init.method,
            headers: init.headers,
          });
          return fetchImpl(url, init);
        };
        state.fetchWithCookies = makeFetchCookie(fetchWithCookieObservation, state.cookieJar);
      }
      return client;
    },
    async request(url, init = {}) {
      await client.initialize();
      return fetchWithTimeout(state.fetchWithCookies, url, init, timeoutMs);
    },
    getCookieHeaderDiagnostics() {
      return {
        configured: Boolean(rawCookieHeader),
        length: rawCookieHeader?.length ?? 0,
      };
    },
    invalidateSession() {
      state.page = null;
      state.homePage = null;
      state.lastDiagnostics = null;
      state.lastRpcDiagnostics = null;
    },
    getLastDiagnostics() {
      if (!state.lastDiagnostics) {
        return null;
      }
      return {
        ...state.lastDiagnostics,
        redirectChain: [...state.lastDiagnostics.redirectChain],
      };
    },
    getLastRpcDiagnostics() {
      if (!state.lastRpcDiagnostics) {
        return null;
      }
      return {
        ...state.lastRpcDiagnostics,
        request: { ...state.lastRpcDiagnostics.request },
        rpcIds: [...state.lastRpcDiagnostics.rpcIds],
        cookies: state.lastRpcDiagnostics.cookies
          ? {
            get: state.lastRpcDiagnostics.cookies.get
              ? { ...state.lastRpcDiagnostics.cookies.get }
              : null,
            post: state.lastRpcDiagnostics.cookies.post
              ? { ...state.lastRpcDiagnostics.cookies.post }
              : null,
            sameNames: state.lastRpcDiagnostics.cookies.sameNames,
            sameHeader: state.lastRpcDiagnostics.cookies.sameHeader,
          }
          : null,
      };
    },
    getCookieRequestDiagnostics() {
      return publicCookieRequestDiagnostics(state.cookieRequests);
    },
    setLastRpcDiagnostics(value) {
      state.lastRpcDiagnostics = value;
    },
    async getAuthenticatedPage({ force = false, signal } = {}) {
      if (!force && state.page) {
        return state.page;
      }

      // Create the jar before the raw-header request so the post-auth import
      // populates the same jar used by subsequent RPC requests.
      await client.initialize();

      const requestInit = {
        signal,
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'uk-UA,uk;q=0.9,en-US;q=0.8,en;q=0.7',
          'User-Agent': CLASSROOM_BROWSER_USER_AGENT,
        },
      };
      let response;
      let finalUrl = CLASSROOM_HOME_URL;
      let redirectChain = [safeUrl(CLASSROOM_HOME_URL)];
      if (rawCookieHeader && !state.rawCookieHeaderImported) {
        const rawResult = await fetchWithRawCookieHeader({
          fetchImpl,
          url: CLASSROOM_HOME_URL,
          init: requestInit,
          cookieHeader: rawCookieHeader,
          timeoutMs,
          onRequest: recordCookieRequest,
        });
        response = rawResult.response;
        finalUrl = rawResult.finalUrl;
        redirectChain = rawResult.redirectChain;
      } else {
        response = await client.request(CLASSROOM_HOME_URL, requestInit);
        finalUrl = response?.url || CLASSROOM_HOME_URL;
        const safeFinalUrl = safeUrl(finalUrl);
        if (safeFinalUrl !== redirectChain[0]) {
          redirectChain.push(safeFinalUrl);
        }
      }
      const html = await response.text();
      const signals = pageSignals(response, html, finalUrl);
      state.lastDiagnostics = {
        cookieHeaderConfigured: Boolean(rawCookieHeader),
        cookieHeaderLength: rawCookieHeader?.length ?? 0,
        status: response?.status ?? null,
          finalUrl: safeUrl(finalUrl),
        contentType: response?.headers?.get?.('content-type') || 'unknown',
        responseLength: html.length,
        looksLikeGoogleLogin: signals.looksLikeGoogleLogin,
        looksLikeClassroom: signals.looksLikeClassroom,
          redirectChain,
      };
      assertAuthenticatedPageAtUrl(response, html, finalUrl);
      if (rawCookieHeader && !state.rawCookieHeaderImported) {
        await createClassroomCookieJar({
          cookieHeader: rawCookieHeader,
          cookieJar: state.cookieJar,
        });
        state.rawCookieHeaderImported = true;
      }
      const bootstrap = extractClassroomBootstrap(html);
      state.page = { html, response, bootstrap, diagnostics: client.getLastDiagnostics() };
      return state.page;
    },
    async getAuthenticatedHomePage({ force = false, signal } = {}) {
      if (!force && state.homePage) {
        return state.homePage;
      }

      // Reuse the existing session/bootstrap initialization first. This keeps
      // the raw Cookie-header import and its jar semantics in one place.
      await client.getAuthenticatedPage({ signal });

      const response = await client.request(CLASSROOM_COURSES_URL, {
        signal,
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'uk-UA,uk;q=0.9,en-US;q=0.8,en;q=0.7',
          'User-Agent': CLASSROOM_BROWSER_USER_AGENT,
        },
      });
      const finalUrl = response?.url || CLASSROOM_COURSES_URL;
      const html = await response.text();
      assertAuthenticatedPageAtUrl(response, html, finalUrl);
      const bootstrap = extractClassroomBootstrap(html);
      state.homePage = { html, response, bootstrap };
      return state.homePage;
    },
    async callClassroomRpc(options) {
      return callClassroomRpc({ client, ...options });
    },
    async getCourseWorkForCourse(courseId, options) {
      return getCourseWorkForCourse(client, courseId, options);
    },
    async getCourses(options = {}) {
      return getCourses(client, options);
    },
  };

  return client;
}
