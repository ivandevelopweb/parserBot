import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CLASSROOM_IMPORT_CUTOFF,
  CLASSROOM_STATUS_COMPLETED,
  CLASSROOM_STATUS_PENDING,
  buildClassroomAssignmentUrl,
  createConfiguredClassroomClient,
  createClassroomWebProvider,
  getClassroomWebHomeworks,
  isClassroomAssignmentAfterCutoff,
  normalizeClassroomWebAssignment,
} from '../src/classroom-provider.js';
import { createClassroomWebClient } from '../src/classroom-web.js';
import { createEmptyState } from '../src/state.js';
import { syncAllHomeworks } from '../src/bot-sync.js';
import { createTestDatabase } from '../test-support/postgres-test-database.js';

test('Classroom web assignment maps course, identity, canonical link, and Kyiv due fields', () => {
  const task = normalizeClassroomWebAssignment(
    { courseId: 'course-1', name: 'Геометрія' },
    {
      assignmentId: 'work-1',
      title: 'Повторити тему «Вектори»',
      description: 'Опрацювати параграф',
      dueAt: '2026-09-11T08:00:00.000Z',
      updatedAt: '2026-09-09T09:00:00.000Z',
      attachments: [{ url: 'https://example.test/file' }],
    },
  );

  assert.equal(task.source, 'classroom');
  assert.equal(task.externalId, 'course-1:work-1');
  assert.equal(task.fingerprint, 'classroom:course-1:work-1');
  assert.equal(task.snapshot.subject, 'Геометрія');
  assert.equal(task.snapshot.title, 'Повторити тему «Вектори»');
  assert.equal(task.snapshot.description, 'Опрацювати параграф');
  assert.equal(task.snapshot.targetDate, '2026-09-11');
  assert.equal(task.snapshot.targetTime, '11:00');
  assert.equal(task.snapshot.filesCount, 1);
  assert.equal(
    task.snapshot.url,
    'https://classroom.google.com/c/Y291cnNlLTFa/a/d29yay0x/details',
  );
});

test('Classroom assignment URL uses the same route tokens as the Classroom UI', () => {
  assert.equal(
    buildClassroomAssignmentUrl('876750472074', '878258754750'),
    'https://classroom.google.com/c/ODc2NzUwNDcyMDc0/a/ODc4MjU4NzU0NzUw/details',
  );
});

test('explicit Classroom link takes precedence over the canonical details route', () => {
  const task = normalizeClassroomWebAssignment(
    { courseId: 'course-1', name: 'Алгебра' },
    {
      assignmentId: 'work-1',
      title: 'Завдання',
      url: 'https://classroom.google.com/custom/task',
      updatedAt: '2026-09-09T09:00:00Z',
    },
  );

  assert.equal(task.snapshot.url, 'https://classroom.google.com/custom/task');
  assert.equal(
    buildClassroomAssignmentUrl('course-1', 'work-1'),
    'https://classroom.google.com/c/Y291cnNlLTFa/a/d29yay0x/details',
  );
});

test('Classroom cutoff uses inclusive September 1 midnight in Kyiv and rejects unknown timestamps', () => {
  assert.equal(
    isClassroomAssignmentAfterCutoff({ updatedAt: CLASSROOM_IMPORT_CUTOFF }),
    true,
  );
  assert.equal(
    isClassroomAssignmentAfterCutoff({ updatedAt: '2026-08-31T20:59:59.000Z' }),
    false,
  );
  assert.equal(
    isClassroomAssignmentAfterCutoff({ updatedAt: '2026-09-01T00:00:00.000Z' }),
    true,
  );
  assert.equal(isClassroomAssignmentAfterCutoff({ updatedAt: null }), false);
  assert.equal(isClassroomAssignmentAfterCutoff({ updatedAt: 'not-a-date' }), false);
});

test('Classroom web provider discovers courses, filters old work, and deduplicates ids', async () => {
  const logs = [];
  const client = {
    async getCourses() {
      return [
        { courseId: 'course-1', name: 'Алгебра' },
        { courseId: 'course-2', name: 'Геометрія' },
      ];
    },
    async getCourseWorkForCourse(courseId) {
      if (courseId === 'course-1') {
        return [
          {
            assignmentId: 'old',
            title: 'Старе завдання',
            updatedAt: '2026-08-31T20:59:59.000Z',
          },
          {
            assignmentId: 'work-1',
            title: 'Розв’язати вправу',
            description: '',
            dueAt: null,
            updatedAt: '2026-09-01T00:00:00.000Z',
          },
        ];
      }
      return [{
        assignmentId: 'work-2',
        title: 'Повторити тему',
        dueAt: '2026-09-12T08:00:00.000Z',
        updatedAt: '2026-09-09T00:00:00.000Z',
      }];
    },
  };

  const tasks = await getClassroomWebHomeworks(client, {
    logger: (message) => logs.push(message),
  });

  assert.deepEqual(
    tasks.map((task) => task.externalId),
    ['course-1:work-1', 'course-2:work-2'],
  );
  assert.equal(tasks[0].snapshot.subject, 'Алгебра');
  assert.equal(tasks[0].snapshot.description, 'Розв’язати вправу');
  assert.equal(tasks[0].snapshot.targetDate, '');
  assert.equal(tasks[1].snapshot.subject, 'Геометрія');
  assert.equal(tasks[1].snapshot.targetDate, '2026-09-12');
  assert.equal(tasks[1].snapshot.targetTime, '11:00');
  assert.match(logs[0], /fetched: 3/);
  assert.match(logs[0], /imported: 2/);
  assert.match(logs[0], /ignored by updatedAt cutoff: 1/);
});

test('Classroom web provider reads explicit state scans and leaves ambiguous states unknown', async () => {
  const stateRequests = [];
  const course = { courseId: 'course-1', name: 'Алгебра' };
  const assignment = (assignmentId, title, updatedAt = '2026-09-09T00:00:00.000Z') => ({
    assignmentId,
    title,
    description: title,
    updatedAt,
  });
  const client = {
    supportsStateFilters: true,
    async getCourses() {
      return [course];
    },
    async getCourseWorkForCourse(_courseId, options) {
      stateRequests.push(options.displayStates);
      const key = options.displayStates.join(',');
      const assignments = key === '1,2'
        ? [assignment('pending', 'Невиконане')]
        : key === '3,4,8,10,5,7,9,6,11'
          ? [assignment('done', 'Виконане'), assignment('ambiguous', 'Невідомий статус')]
          : [
            assignment('done', 'Виконане'),
            assignment('old-done', 'Старе виконане', '2026-08-20T00:00:00.000Z'),
          ];
      return { assignments, recognized: true, complete: true };
    },
  };

  const tasks = await getClassroomWebHomeworks(client, { logger: () => {} });

  assert.deepEqual(stateRequests, [
    [1, 2],
    [3, 4, 8, 10, 5, 7, 9, 6, 11],
    [3, 4, 5, 6, 7, 9, 11],
  ]);
  assert.deepEqual(
    tasks.map((task) => [task.externalId, task.classroomStatus]),
    [['course-1:pending', CLASSROOM_STATUS_PENDING], ['course-1:done', CLASSROOM_STATUS_COMPLETED]],
  );
  assert.deepEqual(
    tasks.statusUpdates.map(({ task, status }) => [task.externalId, status]),
    [
      ['course-1:pending', CLASSROOM_STATUS_PENDING],
      ['course-1:done', CLASSROOM_STATUS_COMPLETED],
      ['course-1:old-done', CLASSROOM_STATUS_COMPLETED],
    ],
  );
  assert.equal(tasks.statusSyncEnabled, true);
  assert.equal(tasks.statusReconciliationComplete, true);
  assert.equal(tasks.currentExternalIds.includes('course-1:ambiguous'), true);
});

test('web Classroom configuration selects the authenticated web provider', () => {
  const client = createConfiguredClassroomClient({
    env: { CLASSROOM_COOKIE_HEADER: 'x=y' },
    logger: () => {},
  });

  assert.equal(client.mode, 'web');
});

test('Classroom is disabled without web cookies and never falls back to the official API', () => {
  const logs = [];
  const client = createConfiguredClassroomClient({
    env: {},
    webClientOptions: { defaultCookiesPath: 'missing-classroom-cookies.json' },
    logger: (message) => logs.push(message),
  });

  assert.equal(client, null);
  assert.match(logs.join('\n'), /official API disabled/);
});

test('web Classroom tasks enter the same combined sync and database as E-school tasks', async () => {
  const { database } = await createTestDatabase();
  const classroom = createClassroomWebProvider({
    client: {
      async getCourses() {
        return [{ courseId: 'course-1', name: 'Геометрія' }];
      },
      async getCourseWorkForCourse() {
        return [{
          assignmentId: 'work-1',
          title: 'Повторити тему',
          description: 'Вектори',
          dueAt: '2026-09-11T08:00:00Z',
          updatedAt: '2026-09-09T09:00:00Z',
        }];
      },
    },
    logger: () => {},
  });
  const messages = [];

  try {
    const result = await syncAllHomeworks({
      auth: {},
      database,
      legacyStateStore: { load: async () => createEmptyState() },
      getAppointmentsFn: async () => ({
        homeworkTasks: [{
          targetAppointmentId: 1,
          homeworkId: 2,
          subject: 'Алгебра',
          description: 'Вправа',
          targetDate: '2026-09-10',
        }],
      }),
      classroom,
      sendMessageFn: async (...args) => messages.push(args),
      logger: () => {},
      now: new Date('2026-09-10T12:00:00Z'),
    });

    assert.equal(result.baselineInitialized, true);
    assert.equal(messages.length, 0);
    assert.equal(await database.countBySource('eschool'), 1);
    assert.equal(await database.countBySource('classroom'), 1);
    assert.deepEqual(
      (await database.currentTasks()).map((task) => task.source).sort(),
      ['classroom', 'eschool'],
    );
  } finally {
    await database.close();
  }
});

test('combined sync logger does not expose sensitive Classroom network error text', async () => {
  const { database } = await createTestDatabase();
  const logs = [];
  const marker = 'CLASSROOM_LOG_SECRET_MARKER';
  const classroomClient = createClassroomWebClient({
    env: { CLASSROOM_COOKIE_HEADER: 'SID=sid-value' },
    fetchImpl: async () => {
      throw new Error(`network failed for https://classroom.google.com/?at=${marker}`);
    },
  });

  try {
    const result = await syncAllHomeworks({
      auth: {},
      database,
      legacyStateStore: { load: async () => createEmptyState() },
      getAppointmentsFn: async () => ({ homeworkTasks: [] }),
      getClassroomHomeworksFn: async () => classroomClient.getAuthenticatedPage(),
      sendMessageFn: async () => {},
      logger: (message) => logs.push(message),
    });

    assert.equal(result.failedProviders.length, 1);
    assert.doesNotMatch(logs.join('\n'), new RegExp(marker));
    assert.match(logs.join('\n'), /Classroom request failed due to a network error/);
  } finally {
    await database.close();
  }
});
