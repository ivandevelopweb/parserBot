import { google } from 'googleapis';

import { createClassroomAuth, CLASSROOM_SCOPES } from './classroom-auth.js';
import { createClassroomFingerprint, toSyncTask } from './sync.js';
import { ConfigError, SmokeTestError, errorMessage, normalizeDescription } from './utils.js';

export const CLASSROOM_SOURCE = 'classroom';
export const DEFAULT_CLASSROOM_TIMEOUT_MS = 30000;
export { CLASSROOM_SCOPES };

function resolveClassroomApi(client) {
  if (client?.courses?.list && client?.courses?.courseWork?.list) {
    return client;
  }
  if (client?.api?.courses?.list && client?.api?.courses?.courseWork?.list) {
    return client.api;
  }
  throw new ConfigError('Google Classroom API client is not available');
}

function getItems(response, property, label) {
  const items = response?.data?.[property];
  if (items === undefined) {
    return [];
  }
  return Array.isArray(items) ? items : [];
}

async function listAllPages(listPage, initialParams, property, label) {
  const items = [];
  let pageToken;

  do {
    const response = await listPage({
      ...initialParams,
      ...(pageToken ? { pageToken } : {}),
    });
    items.push(...getItems(response, property, label));
    pageToken = response?.data?.nextPageToken || null;
  } while (pageToken);

  return items;
}

function pad(number) {
  return String(number).padStart(2, '0');
}

export function parseClassroomDueDate(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const year = Number(value.year);
  const month = Number(value.month);
  const day = Number(value.day);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }

  return `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`;
}

export function parseClassroomDueTime(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const hours = Number(value.hours ?? 0);
  const minutes = Number(value.minutes ?? 0);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)
    || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null;
  }

  return `${pad(hours)}:${pad(minutes)}`;
}

export function normalizeClassroomHomework(course, courseWork) {
  const courseId = String(course?.id ?? '').trim();
  const courseWorkId = String(courseWork?.id ?? '').trim();
  if (!courseId || !courseWorkId) {
    throw new SmokeTestError(
      'Google Classroom coursework is missing course or coursework id',
      { code: 'CLASSROOM_RESPONSE_ERROR' },
    );
  }

  const externalId = `${courseId}:${courseWorkId}`;
  const title = normalizeDescription(courseWork.title);
  const description = normalizeDescription(courseWork.description || title);
  const materials = Array.isArray(courseWork.materials) ? courseWork.materials : [];

  return {
    source: CLASSROOM_SOURCE,
    externalId,
    fingerprint: createClassroomFingerprint({ externalId }),
    courseId,
    courseWorkId,
    id: courseWorkId,
    subject: normalizeDescription(course?.name) || 'Classroom',
    title,
    description,
    topics: [],
    state: courseWork.state ?? null,
    creationTime: courseWork.creationTime ?? null,
    updateTime: courseWork.updateTime ?? null,
    dueDate: courseWork.dueDate ?? null,
    dueTime: courseWork.dueTime ?? null,
    targetDate: parseClassroomDueDate(courseWork.dueDate),
    targetTime: parseClassroomDueTime(courseWork.dueTime),
    url: courseWork.alternateLink ?? null,
    alternateLink: courseWork.alternateLink ?? null,
    materials,
    filesCount: materials.length,
    updatedAt: courseWork.updateTime ?? null,
  };
}

export async function getClassroomCourses(client, {
  pageSize = 100,
  timeoutMs = DEFAULT_CLASSROOM_TIMEOUT_MS,
} = {}) {
  const api = resolveClassroomApi(client);
  return listAllPages(
    (params) => api.courses.list(params),
    {
      courseStates: ['ACTIVE'],
      pageSize,
      timeout: timeoutMs,
    },
    'courses',
    'courses',
  );
}

export async function getClassroomCourseWork(client, courseId, {
  pageSize = 100,
  timeoutMs = DEFAULT_CLASSROOM_TIMEOUT_MS,
} = {}) {
  const api = resolveClassroomApi(client);
  const normalizedCourseId = String(courseId ?? '').trim();
  if (!normalizedCourseId) {
    throw new ConfigError('Google Classroom coursework requires a course id');
  }

  return listAllPages(
    (params) => api.courses.courseWork.list(params),
    {
      courseId: normalizedCourseId,
      courseWorkStates: ['PUBLISHED'],
      pageSize,
      orderBy: 'updateTime desc',
      timeout: timeoutMs,
    },
    'courseWork',
    'coursework',
  );
}

export async function getClassroomHomeworks(client, options = {}) {
  const courses = await getClassroomCourses(client, options);
  const homeworks = [];

  for (const course of courses) {
    const courseWork = await getClassroomCourseWork(client, course.id, options);
    for (const work of courseWork) {
      if (work?.state !== undefined && work.state !== 'PUBLISHED') {
        continue;
      }
      homeworks.push(normalizeClassroomHomework(course, work));
    }
  }

  return homeworks.map(toSyncTask);
}

export function createClassroomClient({
  authClient,
  apiClient,
  authOptions = {},
  logger = console.log,
} = {}) {
  let auth = authClient;
  if (!auth) {
    try {
      auth = createClassroomAuth(authOptions);
    } catch (error) {
      logger(`[classroom] Provider disabled: ${errorMessage(error)}`);
      return null;
    }
  }
  if (!auth) {
    return null;
  }

  const api = apiClient ?? google.classroom({ version: 'v1', auth });
  const client = {
    api,
    auth,
    source: CLASSROOM_SOURCE,
    configured: true,
    async getClassroomCourses(options) {
      return getClassroomCourses(api, options);
    },
    async getClassroomCourseWork(courseId, options) {
      return getClassroomCourseWork(api, courseId, options);
    },
    async getClassroomHomeworks(options) {
      const courses = await getClassroomCourses(api, options);
      logger(`[classroom] Loaded ${courses.length} active courses`);
      const homeworks = [];

      for (const course of courses) {
        const courseWork = await getClassroomCourseWork(api, course.id, options);
        for (const work of courseWork) {
          if (work?.state !== undefined && work.state !== 'PUBLISHED') {
            continue;
          }
          homeworks.push(normalizeClassroomHomework(course, work));
        }
      }

      logger(`[classroom] Found ${homeworks.length} published coursework tasks`);
      return homeworks.map(toSyncTask);
    },
  };

  return client;
}

export function classroomErrorMessage(error) {
  return errorMessage(error);
}
