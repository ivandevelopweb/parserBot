import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CLASSROOM_IMPORT_CUTOFF,
  buildClassroomAssignmentUrl,
  createConfiguredClassroomClient,
  createClassroomWebProvider,
  getClassroomWebHomeworks,
  isClassroomAssignmentAfterCutoff,
  normalizeClassroomWebAssignment,
} from '../src/classroom-provider.js';
import { createClassroomWebClient } from '../src/classroom-web.js';
import { createEmptyState } from '../src/state.js';
import { createHomeworkDatabase } from '../src/homework-db.js';
import { syncAllHomeworks } from '../src/bot-sync.js';

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
    'https://classroom.google.com/c/course-1/a/work-1/details',
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
  assert.equal(buildClassroomAssignmentUrl('course-1', 'work-1'), 'https://classroom.google.com/c/course-1/a/work-1/details');
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

test('web Classroom configuration takes precedence over the official fallback', () => {
  let officialCalls = 0;
  const client = createConfiguredClassroomClient({
    env: { CLASSROOM_COOKIE_HEADER: 'x=y' },
    logger: () => {},
    officialClientFactory: () => {
      officialCalls += 1;
      return { mode: 'official' };
    },
  });

  assert.equal(client.mode, 'web');
  assert.equal(officialCalls, 0);
});

test('official Classroom fallback remains available without web cookie configuration', () => {
  let officialCalls = 0;
  const client = createConfiguredClassroomClient({
    env: {},
    webClientOptions: { defaultCookiesPath: 'missing-classroom-cookies.json' },
    logger: () => {},
    officialClientFactory: () => {
      officialCalls += 1;
      return { mode: 'official' };
    },
  });

  assert.equal(client.mode, 'official');
  assert.equal(officialCalls, 1);
});

test('web Classroom tasks enter the same combined sync and database as E-school tasks', async () => {
  const database = createHomeworkDatabase({ filePath: ':memory:' });
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
    assert.equal(database.countBySource('eschool'), 1);
    assert.equal(database.countBySource('classroom'), 1);
    assert.deepEqual(
      database.currentTasks().map((task) => task.source).sort(),
      ['classroom', 'eschool'],
    );
  } finally {
    database.close();
  }
});

test('combined sync logger does not expose sensitive Classroom network error text', async () => {
  const database = createHomeworkDatabase({ filePath: ':memory:' });
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
    database.close();
  }
});
