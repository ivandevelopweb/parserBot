import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getClassroomCourseWork,
  getClassroomCourses,
  getClassroomHomeworks,
  normalizeClassroomHomework,
} from '../src/classroom.js';
import { syncAllHomeworks } from '../src/bot-sync.js';
import { createEmptyState } from '../src/state.js';
import { createHomeworkDatabase } from '../src/homework-db.js';

const FIXED_NOW = new Date('2026-09-09T12:00:00.000Z');

function classroomHomework(overrides = {}) {
  return {
    source: 'classroom',
    courseId: 'course-1',
    courseWorkId: 'work-1',
    subject: 'Алгебра',
    title: 'Рціональні вирази №91-100',
    description: 'Розв’язати вправи №91-100',
    targetDate: '2026-09-11',
    targetTime: '11:25',
    url: 'https://classroom.google.com/c/course-1/a/work-1/details',
    updatedAt: '2026-09-09T10:00:00Z',
    materials: [],
    ...overrides,
  };
}

function createSyncContext() {
  const database = createHomeworkDatabase({ filePath: ':memory:' });
  return {
    database,
    legacyStateStore: {
      load: async () => createEmptyState(),
    },
    close: () => database.close(),
  };
}

function syncOptions(context, classroomTasks, sendMessageFn, extra = {}) {
  return {
    auth: {},
    database: context.database,
    legacyStateStore: context.legacyStateStore,
    getAppointmentsFn: async () => ({ homeworkTasks: [] }),
    getClassroomHomeworksFn: async () => classroomTasks,
    sendMessageFn,
    logger: () => {},
    now: FIXED_NOW,
    ...extra,
  };
}

test('Classroom normalization uses course-qualified identity and maps due fields', () => {
  const task = normalizeClassroomHomework(
    { id: 'course-9', name: 'Геометрія' },
    {
      id: 'work-7',
      title: 'Повторити тему',
      description: 'Повторити тему «Вектори»',
      state: 'PUBLISHED',
      creationTime: '2026-09-08T09:00:00Z',
      updateTime: '2026-09-09T09:30:00Z',
      dueDate: { year: 2026, month: 9, day: 11 },
      dueTime: { hours: 8, minutes: 30 },
      alternateLink: 'https://classroom.google.com/c/course-9/a/work-7/details',
      materials: [{ driveFile: { id: 'file-1' } }],
    },
  );

  assert.equal(task.source, 'classroom');
  assert.equal(task.externalId, 'course-9:work-7');
  assert.equal(task.fingerprint, 'classroom:course-9:work-7');
  assert.equal(task.subject, 'Геометрія');
  assert.equal(task.targetDate, '2026-09-11');
  assert.equal(task.targetTime, '08:30');
  assert.equal(task.filesCount, 1);
  assert.equal(task.url, 'https://classroom.google.com/c/course-9/a/work-7/details');
});

test('Classroom API helpers request active courses, published coursework, and follow pages', async () => {
  const courseCalls = [];
  const workCalls = [];
  const api = {
    courses: {
      list: async (params) => {
        courseCalls.push(params);
        if (params.pageToken) {
          return { data: { courses: [{ id: 'course-2', name: 'Фізика' }] } };
        }
        return {
          data: {
            courses: [{ id: 'course-1', name: 'Алгебра' }],
            nextPageToken: 'courses-page-2',
          },
        };
      },
      courseWork: {
        list: async (params) => {
          workCalls.push(params);
          return {
            data: {
              courseWork: [{
                id: `${params.courseId}-work`,
                title: `Завдання ${params.courseId}`,
                state: 'PUBLISHED',
              }],
            },
          };
        },
      },
    },
  };

  const courses = await getClassroomCourses(api);
  assert.equal(courses.length, 2);
  assert.deepEqual(courseCalls[0].courseStates, ['ACTIVE']);
  assert.equal(courseCalls[1].pageToken, 'courses-page-2');

  const work = await getClassroomCourseWork(api, 'course-1');
  assert.equal(work.length, 1);
  assert.deepEqual(workCalls[0].courseWorkStates, ['PUBLISHED']);
  assert.equal(workCalls[0].courseId, 'course-1');

  const tasks = await getClassroomHomeworks(api);
  assert.equal(tasks.length, 2);
  assert.deepEqual(
    tasks.map((task) => task.externalId),
    ['course-1:course-1-work', 'course-2:course-2-work'],
  );
});

test('first combined sync creates Classroom baseline without mass notifications', async () => {
  const context = createSyncContext();
  const messages = [];

  try {
    const result = await syncAllHomeworks(syncOptions(
      context,
      [classroomHomework()],
      async (...args) => messages.push(args),
    ));

    assert.equal(result.baselineInitialized, true);
    assert.equal(result.sentTasks, 0);
    assert.equal(messages.length, 0);
    assert.equal(context.database.currentTasks().length, 1);
    assert.equal(context.database.currentTasks()[0].source, 'classroom');
  } finally {
    context.close();
  }
});

test('Classroom new task is sent once and repeated sync does not duplicate it', async () => {
  const context = createSyncContext();
  const messages = [];

  try {
    await syncAllHomeworks(syncOptions(context, [classroomHomework()], async (...args) => {
      messages.push(args);
    }));

    const nextTasks = [
      classroomHomework(),
      classroomHomework({
        courseWorkId: 'work-2',
        title: 'Нове завдання',
        description: 'Опрацювати параграф',
        updatedAt: '2026-09-09T11:00:00Z',
        url: 'https://classroom.google.com/c/course-1/a/work-2/details',
      }),
    ];
    const result = await syncAllHomeworks(syncOptions(context, nextTasks, async (...args) => {
      messages.push(args);
    }));
    await syncAllHomeworks(syncOptions(context, nextTasks, async (...args) => {
      messages.push(args);
    }));

    assert.equal(result.newTasks, 1);
    assert.equal(messages.length, 1);
    assert.match(messages[0][0], /Classroom/);
    assert.equal(messages[0][1].parseMode, 'HTML');
    assert.equal(context.database.countBySource('classroom'), 2);
  } finally {
    context.close();
  }
});

test('Classroom updateTime or content change sends an update for the same database row', async () => {
  const context = createSyncContext();
  const messages = [];

  try {
    await syncAllHomeworks(syncOptions(context, [classroomHomework()], async (...args) => {
      messages.push(args);
    }));
    const changed = classroomHomework({
      description: 'Розв’язати вправи №91-110',
      updatedAt: '2026-09-09T12:30:00Z',
    });
    const result = await syncAllHomeworks(syncOptions(context, [changed], async (...args) => {
      messages.push(args);
    }));

    assert.equal(result.updatedTasks, 1);
    assert.equal(messages.length, 1);
    assert.match(messages[0][0], /Завдання змінено/);
    assert.equal(context.database.countBySource('classroom'), 1);
    assert.equal(context.database.currentTasks()[0].externalId, 'course-1:work-1');
  } finally {
    context.close();
  }
});

test('Classroom Telegram failure leaves the task pending for retry', async () => {
  const context = createSyncContext();

  try {
    await syncAllHomeworks(syncOptions(context, [classroomHomework()], async () => {}));
    await syncAllHomeworks(syncOptions(
      context,
      [classroomHomework(), classroomHomework({ courseWorkId: 'work-2' })],
      async () => {
        throw new Error('Telegram unavailable');
      },
    ));

    const pending = context.database.findByExternalId('course-1:work-2', 'classroom');
    assert.ok(pending);
    assert.equal(pending.notificationPending, true);
    assert.equal(pending.lastNotifiedAt, null);
  } finally {
    context.close();
  }
});

test('Classroom provider failure does not prevent E-school delivery', async () => {
  const context = createSyncContext();
  const messages = [];
  const eSchoolTask = {
    targetAppointmentId: 185141,
    homeworkId: 101171,
    subject: 'Алгебра',
    description: 'Вправа 1',
    targetDate: '2026-09-11',
  };

  try {
    await syncAllHomeworks({
      ...syncOptions(context, [classroomHomework()], async (...args) => messages.push(args)),
      getAppointmentsFn: async () => ({ homeworkTasks: [eSchoolTask] }),
    });
    const result = await syncAllHomeworks({
      ...syncOptions(context, [classroomHomework()], async (...args) => messages.push(args)),
      getAppointmentsFn: async () => ({
        homeworkTasks: [eSchoolTask, { ...eSchoolTask, targetAppointmentId: 185142, homeworkId: 101172 }],
      }),
      getClassroomHomeworksFn: async () => {
        throw new Error('Classroom unavailable');
      },
    });

    assert.equal(result.failedProviders.length, 1);
    assert.equal(result.failedProviders[0].source, 'classroom');
    assert.equal(messages.length, 1);
    assert.match(messages[0][0], /Нове завдання/);
    assert.equal(context.database.findByFingerprint('["185142","Вправа 1"]')?.source, 'eschool');
  } finally {
    context.close();
  }
});

test('E-school login failure does not prevent the independent Classroom provider', async () => {
  const context = createSyncContext();
  let loginCalls = 0;
  let classroomCalls = 0;

  try {
    const result = await syncAllHomeworks({
      ...syncOptions(context, [classroomHomework()], async () => {}, {
        auth: {
          async fullLogin() {
            loginCalls += 1;
            throw new Error('E-school login unavailable');
          },
        },
        getAppointmentsFn: async () => {
          throw new Error('E-school fetch should not run after login failure');
        },
        getClassroomHomeworksFn: async () => {
          classroomCalls += 1;
          return [classroomHomework()];
        },
      }),
    });

    assert.equal(loginCalls, 1);
    assert.equal(classroomCalls, 1);
    assert.equal(result.failedProviders.length, 1);
    assert.equal(result.failedProviders[0].source, 'eschool');
    assert.equal(result.providers.find((provider) => provider.source === 'classroom').status, 'ok');
    assert.equal(context.database.countBySource('classroom'), 1);
  } finally {
    context.close();
  }
});

test('Classroom response failure preserves its previous SQLite snapshot', async () => {
  const context = createSyncContext();

  try {
    await syncAllHomeworks(syncOptions(context, [classroomHomework()], async () => {}));
    const previous = context.database.currentTasks()[0];

    const result = await syncAllHomeworks({
      ...syncOptions(context, [], async () => {}, {
        getClassroomHomeworksFn: async () => {
          throw new Error('Classroom response shape is unknown');
        },
      }),
    });

    assert.equal(result.failedProviders[0].source, 'classroom');
    assert.deepEqual(context.database.currentTasks().map((task) => task.id), [previous.id]);
    assert.equal(context.database.currentTasks()[0].snapshot.title, previous.snapshot.title);
  } finally {
    context.close();
  }
});

test('Classroom tasks with the same coursework id in different courses stay separate', async () => {
  const context = createSyncContext();

  try {
    await syncAllHomeworks(syncOptions(context, [
      classroomHomework({ courseId: 'course-a', courseWorkId: 'same-id' }),
      classroomHomework({ courseId: 'course-b', courseWorkId: 'same-id' }),
    ], async () => {}));

    assert.equal(context.database.countBySource('classroom'), 2);
    assert.ok(context.database.findByExternalId('course-a:same-id', 'classroom'));
    assert.ok(context.database.findByExternalId('course-b:same-id', 'classroom'));
  } finally {
    context.close();
  }
});
