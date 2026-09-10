import { existsSync } from 'node:fs';

import {
  createClassroomClient,
} from './classroom.js';
import {
  CLASSROOM_ORIGIN,
  DEFAULT_CLASSROOM_COOKIES_PATH,
  createClassroomWebClient,
} from './classroom-web.js';
import {
  createClassroomFingerprint,
  toSyncTask,
} from './sync.js';
import {
  ConfigError,
  SmokeTestError,
  normalizeDescription,
} from './utils.js';

export const CLASSROOM_IMPORT_TIME_ZONE = 'Europe/Kyiv';
export const CLASSROOM_IMPORT_CUTOFF = '2026-09-01T00:00:00+03:00';

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function timestampMilliseconds(value) {
  if (!hasValue(value)) {
    return null;
  }

  if (value instanceof Date) {
    const milliseconds = value.getTime();
    return Number.isFinite(milliseconds) ? milliseconds : null;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
    return Number.isFinite(milliseconds) ? milliseconds : null;
  }

  const milliseconds = Date.parse(String(value).trim());
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

export function isClassroomWebConfigured({
  env = process.env,
  defaultCookiesPath = DEFAULT_CLASSROOM_COOKIES_PATH,
} = {}) {
  if (hasValue(env?.CLASSROOM_COOKIE_HEADER) || hasValue(env?.CLASSROOM_COOKIES_JSON)) {
    return true;
  }

  const configuredPath = hasValue(env?.CLASSROOM_COOKIES_FILE)
    ? String(env.CLASSROOM_COOKIES_FILE).trim()
    : null;
  if (configuredPath) {
    return existsSync(configuredPath);
  }

  return Boolean(defaultCookiesPath && existsSync(defaultCookiesPath));
}

export function isClassroomAssignmentAfterCutoff(
  assignment,
  { cutoff = CLASSROOM_IMPORT_CUTOFF } = {},
) {
  const updatedAt = timestampMilliseconds(assignment?.updatedAt);
  const cutoffMilliseconds = timestampMilliseconds(cutoff);
  return Number.isFinite(updatedAt)
    && Number.isFinite(cutoffMilliseconds)
    && updatedAt >= cutoffMilliseconds;
}

function formatDueAtInKyiv(dueAt) {
  if (!hasValue(dueAt)) {
    return { targetDate: null, targetTime: null };
  }

  const dateOnly = /^(\d{4}-\d{2}-\d{2})$/.exec(String(dueAt).trim());
  if (dateOnly) {
    return { targetDate: dateOnly[1], targetTime: null };
  }

  const milliseconds = timestampMilliseconds(dueAt);
  if (!Number.isFinite(milliseconds)) {
    return { targetDate: null, targetTime: null };
  }

  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: CLASSROOM_IMPORT_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(milliseconds))
      .filter(({ type }) => type !== 'literal')
      .map(({ type, value }) => [type, value]),
  );

  if (!parts.year || !parts.month || !parts.day) {
    return { targetDate: null, targetTime: null };
  }

  return {
    targetDate: [parts.year, parts.month, parts.day].join('-'),
    targetTime: parts.hour && parts.minute
      ? [parts.hour, parts.minute].join(':')
      : null,
  };
}

export function buildClassroomAssignmentUrl(courseId, assignmentId) {
  const normalizedCourseId = String(courseId ?? '').trim();
  const normalizedAssignmentId = String(assignmentId ?? '').trim();
  if (!normalizedCourseId || !normalizedAssignmentId) {
    return null;
  }

  return [
    CLASSROOM_ORIGIN,
    'c',
    encodeURIComponent(normalizedCourseId),
    'a',
    encodeURIComponent(normalizedAssignmentId),
    'details',
  ].join('/');
}

export function normalizeClassroomWebAssignment(course, assignment) {
  const courseId = String(course?.courseId ?? assignment?.courseId ?? '').trim();
  const assignmentId = String(assignment?.assignmentId ?? '').trim();
  const title = normalizeDescription(assignment?.title);
  if (!courseId || !assignmentId || !title) {
    throw new SmokeTestError(
      'Classroom web coursework is missing course id, assignment id, or title',
      { code: 'CLASSROOM_RESPONSE_ERROR' },
    );
  }

  const due = formatDueAtInKyiv(assignment.dueAt);
  const explicitUrl = assignment.url ?? assignment.alternateLink ?? null;
  const externalId = courseId + ':' + assignmentId;
  const attachments = Array.isArray(assignment.attachments)
    ? assignment.attachments
    : [];

  return toSyncTask({
    source: 'classroom',
    externalId,
    fingerprint: createClassroomFingerprint({ externalId }),
    courseId,
    courseWorkId: assignmentId,
    id: assignmentId,
    subject: normalizeDescription(course?.name) || 'Classroom',
    title,
    description: normalizeDescription(assignment.description || title),
    topics: [],
    targetDate: due.targetDate,
    targetTime: due.targetTime,
    assignedDate: null,
    lessonNumber: null,
    startTime: null,
    url: explicitUrl || buildClassroomAssignmentUrl(courseId, assignmentId),
    filesCount: attachments.length,
    updatedAt: assignment.updatedAt ?? null,
  });
}

export async function getClassroomWebHomeworks(
  client,
  {
    cutoff = CLASSROOM_IMPORT_CUTOFF,
    logger = () => {},
    signal,
  } = {},
) {
  if (!client || typeof client.getCourses !== 'function'
    || typeof client.getCourseWorkForCourse !== 'function') {
    throw new ConfigError('Classroom web client is required');
  }

  const courses = await client.getCourses({ signal });
  const tasks = [];
  const seenExternalIds = new Set();
  let fetchedAssignments = 0;
  let ignoredAssignments = 0;

  for (const course of courses) {
    const assignments = await client.getCourseWorkForCourse(course.courseId, { signal });
    for (const assignment of assignments) {
      fetchedAssignments += 1;
      if (!isClassroomAssignmentAfterCutoff(assignment, { cutoff })) {
        ignoredAssignments += 1;
        continue;
      }

      const task = normalizeClassroomWebAssignment(course, assignment);
      if (seenExternalIds.has(task.externalId)) {
        continue;
      }
      seenExternalIds.add(task.externalId);
      tasks.push(task);
    }
  }

  logger(
    '[classroom-web] Courses: ' + courses.length
      + ', coursework fetched: ' + fetchedAssignments
      + ', imported: ' + tasks.length
      + ', ignored by updatedAt cutoff: ' + ignoredAssignments,
  );
  return tasks;
}

export function createClassroomWebProvider({
  client,
  env = process.env,
  logger = console.log,
  webClientOptions = {},
} = {}) {
  const webClient = client ?? createClassroomWebClient({
    env,
    ...webClientOptions,
  });

  return {
    source: 'classroom',
    configured: true,
    mode: 'web',
    webClient,
    async getClassroomHomeworks(options = {}) {
      return getClassroomWebHomeworks(webClient, {
        ...options,
        logger: options.logger ?? logger,
      });
    },
  };
}

export function createConfiguredClassroomClient({
  env = process.env,
  logger = console.log,
  webClientOptions = {},
  officialClientFactory = createClassroomClient,
} = {}) {
  if (isClassroomWebConfigured({
    env,
    defaultCookiesPath: webClientOptions.defaultCookiesPath,
  })) {
    logger('[classroom] Using authenticated web session');
    return createClassroomWebProvider({
      env,
      logger,
      webClientOptions,
    });
  }

  return officialClientFactory({ logger });
}
