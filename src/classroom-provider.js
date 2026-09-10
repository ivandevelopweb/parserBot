import { existsSync } from 'node:fs';

import {
  CLASSROOM_COMPLETED_STATES,
  DEFAULT_CLASSROOM_COOKIES_PATH,
  CLASSROOM_NOT_TURNED_IN_STATES,
  CLASSROOM_TURNED_IN_STATES,
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
import { buildClassroomAssignmentUrl } from './classroom-url.js';

export { buildClassroomAssignmentUrl } from './classroom-url.js';

export const CLASSROOM_IMPORT_TIME_ZONE = 'Europe/Kyiv';
export const CLASSROOM_IMPORT_CUTOFF = '2026-09-01T00:00:00+03:00';
export const CLASSROOM_STATUS_PENDING = 'pending';
export const CLASSROOM_STATUS_COMPLETED = 'completed';
export const CLASSROOM_STATUS_UNKNOWN = 'unknown';

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

export function normalizeClassroomWebAssignment(course, assignment, { classroomStatus = null } = {}) {
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

  const task = toSyncTask({
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
  return classroomStatus
    ? { ...task, classroomStatus }
    : task;
}

function normalizeCourseWorkResult(result) {
  if (Array.isArray(result)) {
    return {
      assignments: result,
      complete: true,
      recognized: true,
    };
  }
  if (!Array.isArray(result?.assignments)) {
    throw new SmokeTestError(
      'Classroom coursework provider returned an invalid result',
      { code: 'CLASSROOM_RESPONSE_ERROR' },
    );
  }
  if (result.complete === false || result.recognized === false) {
    throw new SmokeTestError(
      'Classroom coursework response is incomplete or unrecognized',
      { code: 'CLASSROOM_PARTIAL_RESPONSE' },
    );
  }
  return result;
}

function attachClassroomSyncMetadata(tasks, metadata) {
  Object.defineProperties(tasks, {
    statusUpdates: {
      value: metadata.statusUpdates ?? [],
      enumerable: false,
      writable: false,
    },
    currentExternalIds: {
      value: metadata.currentExternalIds ?? [],
      enumerable: false,
      writable: false,
    },
    snapshotComplete: {
      value: metadata.snapshotComplete === true,
      enumerable: false,
      writable: false,
    },
    statusReconciliationComplete: {
      value: metadata.statusReconciliationComplete === true,
      enumerable: false,
      writable: false,
    },
    statusSyncEnabled: {
      value: metadata.statusSyncEnabled === true,
      enumerable: false,
      writable: false,
    },
  });
  return tasks;
}

function chooseObservationTask(previous, candidate) {
  if (!previous) {
    return candidate;
  }
  const previousTime = timestampMilliseconds(previous.snapshot?.updatedAt);
  const candidateTime = timestampMilliseconds(candidate.snapshot?.updatedAt);
  return Number.isFinite(candidateTime)
    && (!Number.isFinite(previousTime) || candidateTime >= previousTime)
    ? candidate
    : previous;
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
  if (!Array.isArray(courses)) {
    throw new SmokeTestError(
      'Classroom courses provider did not return an array',
      { code: 'CLASSROOM_RESPONSE_ERROR' },
    );
  }
  const tasks = [];
  const seenExternalIds = new Set();
  let fetchedAssignments = 0;
  let ignoredAssignments = 0;

  const supportsStateFilters = client.supportsStateFilters === true
    || client.getCourseWorkForCourse.length >= 2;

  if (!supportsStateFilters) {
    for (const course of courses) {
      const result = normalizeCourseWorkResult(
        await client.getCourseWorkForCourse(course.courseId, { signal }),
      );
      for (const assignment of result.assignments) {
        fetchedAssignments += 1;
        if (!isClassroomAssignmentAfterCutoff(assignment, { cutoff })) {
          ignoredAssignments += 1;
          continue;
        }

        const task = normalizeClassroomWebAssignment(course, assignment, {
          classroomStatus: CLASSROOM_STATUS_PENDING,
        });
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
    return attachClassroomSyncMetadata(tasks, {
      statusSyncEnabled: false,
      snapshotComplete: true,
      statusReconciliationComplete: false,
      currentExternalIds: tasks.map((task) => task.externalId),
    });
  }

  const observations = new Map();
  const ignoredExternalIds = new Set();

  const readScan = async (course, displayStates, scan) => {
    const result = normalizeCourseWorkResult(
      await client.getCourseWorkForCourse(course.courseId, {
        signal,
        displayStates,
        includePagination: true,
      }),
    );
    if (result.complete !== true || result.recognized !== true) {
      throw new SmokeTestError(
        `Classroom ${scan} coursework response is incomplete`,
        { code: 'CLASSROOM_PARTIAL_RESPONSE' },
      );
    }
    for (const assignment of result.assignments) {
      fetchedAssignments += 1;
      const task = normalizeClassroomWebAssignment(course, assignment);
      if (!isClassroomAssignmentAfterCutoff(assignment, { cutoff })) {
        ignoredExternalIds.add(task.externalId);
      }
      const observation = observations.get(task.externalId) ?? {
        task: null,
        pendingSeen: false,
        turnedInSeen: false,
        completedSeen: false,
      };
      observation.task = chooseObservationTask(observation.task, task);
      if (scan === 'not-turned-in') {
        observation.pendingSeen = true;
      } else if (scan === 'turned-in') {
        observation.turnedInSeen = true;
      } else if (scan === 'completed') {
        observation.completedSeen = true;
      }
      observations.set(task.externalId, observation);
    }
  };

  for (const course of courses) {
    await readScan(course, CLASSROOM_NOT_TURNED_IN_STATES, 'not-turned-in');
    await readScan(course, CLASSROOM_TURNED_IN_STATES, 'turned-in');
    await readScan(course, CLASSROOM_COMPLETED_STATES, 'completed');
  }

  const statusUpdates = [];
  const currentExternalIds = [];
  for (const [externalId, observation] of observations) {
    currentExternalIds.push(externalId);
    const status = observation.pendingSeen && !observation.completedSeen
      && !observation.turnedInSeen
      ? CLASSROOM_STATUS_PENDING
      : !observation.pendingSeen && observation.completedSeen
        ? CLASSROOM_STATUS_COMPLETED
        : CLASSROOM_STATUS_UNKNOWN;
    if (status === CLASSROOM_STATUS_UNKNOWN) {
      continue;
    }

    const statusTask = { ...observation.task, classroomStatus: status };
    statusUpdates.push({
      task: statusTask,
      status,
      allowInsert: status === CLASSROOM_STATUS_COMPLETED
        || isClassroomAssignmentAfterCutoff(observation.task.snapshot, { cutoff }),
    });

    if (isClassroomAssignmentAfterCutoff(observation.task.snapshot, { cutoff })) {
      if (!seenExternalIds.has(externalId)) {
        seenExternalIds.add(externalId);
        tasks.push(statusTask);
      }
    }
  }

  ignoredAssignments = ignoredExternalIds.size;

  logger(
    '[classroom-web] Courses: ' + courses.length
      + ', coursework fetched: ' + fetchedAssignments
      + ', imported: ' + tasks.length
      + ', ignored by updatedAt cutoff: ' + ignoredAssignments,
  );
  return attachClassroomSyncMetadata(tasks, {
    statusUpdates,
    currentExternalIds,
    snapshotComplete: true,
    statusReconciliationComplete: true,
    statusSyncEnabled: true,
  });
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
} = {}) {
  const webConfigured = isClassroomWebConfigured({
    env,
    defaultCookiesPath: webClientOptions.defaultCookiesPath,
  });
  if (!webConfigured) {
    logger('[classroom] Web session is not configured; skipping Classroom (official API disabled)');
    return null;
  }

  logger('[classroom] Using authenticated web session');
  return createClassroomWebProvider({
    env,
    logger,
    webClientOptions,
  });
}
