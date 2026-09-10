const CLASSROOM_ORIGIN = 'https://classroom.google.com';
const CLASSROOM_DETAILS_PATH = /^\/c\/([^/]+)\/a\/([^/]+)\/details\/?$/u;
const CLASSROOM_ROUTE_ID = /^[A-Za-z0-9_-]+$/u;
export const CLASSROOM_AUTHUSER_META_KEY = 'classroom_authuser_index';

function normalizeId(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

/*
 * Classroom's client encodes route ids with its URL-safe base64 codec. It
 * pads the raw id with Z characters before encoding so the decoder can strip
 * the padding without a separate length field.
 */
export function encodeClassroomPathId(value) {
  const normalized = normalizeId(value);
  if (!normalized) {
    return null;
  }

  let padded = normalized;
  while (padded.length % 3 !== 0) {
    padded += 'Z';
  }
  return Buffer.from(padded, 'utf8').toString('base64url');
}

function decodeClassroomPathId(value) {
  const normalized = normalizeId(value);
  if (!normalized || !CLASSROOM_ROUTE_ID.test(normalized)) {
    return null;
  }

  try {
    const bytes = Buffer.from(normalized, 'base64url');
    const decoded = bytes.toString('utf8');
    if (Buffer.from(decoded, 'utf8').compare(bytes) !== 0) {
      return null;
    }

    const withoutCodecPadding = decoded.split('Z', 1)[0];
    if (!withoutCodecPadding || !CLASSROOM_ROUTE_ID.test(withoutCodecPadding)) {
      return null;
    }
    return withoutCodecPadding;
  } catch {
    return null;
  }
}

function canonicalRouteId(value) {
  const normalized = normalizeId(value);
  if (!normalized) {
    return null;
  }

  const decoded = decodeClassroomPathId(normalized);
  if (decoded && encodeClassroomPathId(decoded) === normalized) {
    return normalized;
  }
  return encodeClassroomPathId(normalized);
}

export function buildClassroomAssignmentUrl(courseId, assignmentId) {
  const encodedCourseId = canonicalRouteId(courseId);
  const encodedAssignmentId = canonicalRouteId(assignmentId);
  if (!encodedCourseId || !encodedAssignmentId) {
    return null;
  }

  return `${CLASSROOM_ORIGIN}/c/${encodedCourseId}/a/${encodedAssignmentId}/details`;
}

/*
 * Existing database snapshots can contain the old raw-id route. Normalize
 * only Classroom's direct assignment route and leave explicit custom links
 * untouched.
 */
export function normalizeClassroomAssignmentUrl(value) {
  const normalized = normalizeId(value);
  if (!normalized) {
    return null;
  }

  let url;
  try {
    url = new URL(normalized);
  } catch {
    return normalized;
  }

  if (url.hostname !== 'classroom.google.com') {
    return normalized;
  }

  const match = url.pathname.match(CLASSROOM_DETAILS_PATH);
  if (!match) {
    return normalized;
  }

  const encodedCourseId = canonicalRouteId(match[1]);
  const encodedAssignmentId = canonicalRouteId(match[2]);
  if (!encodedCourseId || !encodedAssignmentId) {
    return normalized;
  }

  url.pathname = `/c/${encodedCourseId}/a/${encodedAssignmentId}/details`;
  return url.toString();
}

export function parseClassroomAuthuserIndex(value) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/u.test(normalized)) {
    return null;
  }

  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 10
    ? parsed
    : null;
}

/*
 * Google chooses a signed-in account from the authuser query parameter. Keep
 * this preference out of stored snapshots so changing it cannot look like a
 * Classroom content change or create a notification.
 */
export function addClassroomAuthuserParam(value, authuserIndex) {
  const normalized = normalizeClassroomAssignmentUrl(value);
  const parsedIndex = parseClassroomAuthuserIndex(authuserIndex);
  if (!normalized || parsedIndex === null) {
    return normalized;
  }

  let url;
  try {
    url = new URL(normalized);
  } catch {
    return normalized;
  }

  if (url.hostname !== 'classroom.google.com') {
    return normalized;
  }

  url.searchParams.set('authuser', String(parsedIndex));
  return url.toString();
}
