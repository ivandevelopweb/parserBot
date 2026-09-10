import test from 'node:test';
import assert from 'node:assert/strict';

import { createEmptyState } from '../src/state.js';
import { syncBotHomeworks, syncProviderHomeworks } from '../src/bot-sync.js';
import { createPostgresHomeworkDatabase } from '../src/postgres-homework-db.js';
import { toSyncTask } from '../src/sync.js';
import { createTestDatabase } from '../test-support/postgres-test-database.js';

const FIXED_NOW = new Date('2026-09-09T12:00:00.000Z');

function homework(overrides = {}) {
  return {
    targetAppointmentId: 185141,
    homeworkId: 101171,
    subject: 'Алгебра і початок аналізу',
    topic: 'Числові множини',
    description: 'Вивчити конспект, №11',
    assignedDate: '2026-09-09',
    targetDate: '2026-09-11',
    lessonNumber: 4,
    startTime: '11:25',
    filesCount: 0,
    ...overrides,
  };
}

function classroomHomework(overrides = {}) {
  const courseId = overrides.courseId ?? 'course-1';
  const courseWorkId = overrides.courseWorkId ?? 'work-1';
  return toSyncTask({
    source: 'classroom',
    externalId: overrides.externalId ?? `${courseId}:${courseWorkId}`,
    courseId,
    courseWorkId,
    subject: 'Алгебра',
    title: 'Повторити тему',
    description: 'Опрацювати параграф',
    targetDate: '2026-09-11',
    targetTime: '11:25',
    url: `https://classroom.google.com/c/${courseId}/a/${courseWorkId}/details`,
    updatedAt: '2026-09-09T10:00:00.000Z',
    filesCount: 0,
    ...overrides,
  });
}

function classroomResult(entries, {
  snapshotComplete = true,
  statusReconciliationComplete = true,
  statusSyncEnabled = true,
} = {}) {
  const normalizedEntries = entries.map((entry) => ({
    task: entry.task ?? entry,
    status: entry.status ?? 'pending',
    allowInsert: entry.allowInsert !== false,
    includeTask: entry.includeTask ?? (entry.status !== 'unknown'),
  }));
  const tasks = normalizedEntries
    .filter(({ includeTask }) => includeTask)
    .map(({ task, status }) => ({ ...task, classroomStatus: status }));
  Object.defineProperties(tasks, {
    statusUpdates: {
      value: normalizedEntries.map(({ task, status, allowInsert }) => ({
        task: { ...task, classroomStatus: status },
        status,
        allowInsert,
      })),
    },
    currentExternalIds: {
      value: [...new Set(normalizedEntries.map(({ task }) => task.externalId))],
    },
    snapshotComplete: { value: snapshotComplete },
    statusReconciliationComplete: { value: statusReconciliationComplete },
    statusSyncEnabled: { value: statusSyncEnabled },
  });
  return tasks;
}

async function createTestContext(initialState = createEmptyState()) {
  const { database, memory } = await createTestDatabase();
  return {
    database,
    memory,
    legacyStateStore: { load: async () => structuredClone(initialState) },
    close: async () => database.close(),
  };
}

function options(context, currentTasks, sendMessageFn) {
  return {
    auth: {},
    database: context.database,
    legacyStateStore: context.legacyStateStore,
    getAppointmentsFn: async () => ({ homeworkTasks: currentTasks }),
    sendMessageFn,
    logger: () => {},
    now: FIXED_NOW,
  };
}

function classroomSyncOptions(context, providerResult, sendMessageFn, extra = {}) {
  return {
    source: 'classroom',
    fetchTasksFn: async () => providerResult,
    database: context.database,
    sendMessageFn,
    logger: () => {},
    now: FIXED_NOW,
    ...extra,
  };
}

test('bot first sync creates baseline and sends no existing homework', async () => {
  const context = await createTestContext();
  const messages = [];

  try {
    const result = await syncBotHomeworks(options(
      context,
      [homework()],
      async (...args) => messages.push(args),
    ));

    assert.equal(result.baselineInitialized, true);
    assert.equal(result.taskCount, 1);
    assert.equal(messages.length, 0);
    assert.equal((await context.database.currentTasks()).length, 1);
  } finally {
    await context.close();
  }
});

test('different homework for one appointment stays separate and keeps stable rows', async () => {
  const context = await createTestContext();
  const messages = [];
  const first = homework({ homeworkId: 201, description: 'Варіант A' });
  const second = homework({ homeworkId: 202, description: 'Варіант B' });

  try {
    await syncBotHomeworks(options(
      context,
      [first, second],
      async (...args) => messages.push(args),
    ));

    const baselineRows = await context.database.currentTasks();
    assert.equal(baselineRows.length, 2);
    assert.deepEqual(
      baselineRows.map((task) => task.snapshot.description).sort(),
      ['Варіант A', 'Варіант B'],
    );
    const baselineIds = new Map(
      baselineRows.map((task) => [task.snapshot.description, task.id]),
    );

    await syncBotHomeworks(options(
      context,
      [first, second],
      async (...args) => messages.push(args),
    ));

    assert.equal(messages.length, 0);
    assert.deepEqual(
      (await context.database.currentTasks()).map((task) => [task.snapshot.description, task.id]),
      [['Варіант A', baselineIds.get('Варіант A')], ['Варіант B', baselineIds.get('Варіант B')]],
    );
  } finally {
    await context.close();
  }
});

test('changing one of two homework items for an appointment preserves both row ids', async () => {
  const context = await createTestContext();
  const messages = [];
  const first = homework({ homeworkId: 301, description: 'Початкове A' });
  const second = homework({ homeworkId: 302, description: 'Початкове B' });

  try {
    await syncBotHomeworks(options(context, [first, second], async (...args) => messages.push(args)));
    const baselineRows = await context.database.currentTasks();
    const baselineIds = new Map(
      baselineRows.map((task) => [task.snapshot.description, task.id]),
    );

    await syncBotHomeworks(options(
      context,
      [
        { ...first, description: 'Изменене A' },
        second,
      ],
      async (...args) => messages.push(args),
    ));

    assert.equal(messages.length, 1);
    assert.match(messages[0][0], /Изменене A/);
    const currentRows = await context.database.currentTasks();
    assert.equal(currentRows.length, 2);
    assert.equal(
      currentRows.find((task) => task.snapshot.description === 'Изменене A').id,
      baselineIds.get('Початкове A'),
    );
    assert.equal(
      currentRows.find((task) => task.snapshot.description === 'Початкове B').id,
      baselineIds.get('Початкове B'),
    );
  } finally {
    await context.close();
  }
});

test('ambiguous changes for one appointment do not reuse one old row twice', async () => {
  const context = await createTestContext();
  const messages = [];

  try {
    await syncBotHomeworks(options(
      context,
      [
        homework({ homeworkId: 351, description: 'Старе A' }),
        homework({ homeworkId: 352, description: 'Старе B' }),
      ],
      async (...args) => messages.push(args),
    ));
    const baselineIds = new Set((await context.database.currentTasks()).map((task) => task.id));

    await syncBotHomeworks(options(
      context,
      [
        homework({ homeworkId: 351, description: 'Нове A' }),
        homework({ homeworkId: 352, description: 'Нове B' }),
      ],
      async (...args) => messages.push(args),
    ));

    const currentRows = await context.database.currentTasks();
    assert.equal(currentRows.length, 2);
    assert.equal(messages.length, 2);
    assert.equal(currentRows.some((task) => baselineIds.has(task.id)), false);
    assert.deepEqual(
      currentRows.map((task) => task.snapshot.description).sort(),
      ['Нове A', 'Нове B'],
    );
  } finally {
    await context.close();
  }
});

test('duplicate normalized fingerprints are stored once', async () => {
  const context = await createTestContext();

  try {
    await syncBotHomeworks(options(
      context,
      [
        homework({ homeworkId: 401, description: '  Однакова робота  ' }),
        homework({ homeworkId: 402, description: 'Однакова робота' }),
      ],
      async () => {},
    ));

    assert.equal((await context.database.currentTasks()).length, 1);
  } finally {
    await context.close();
  }
});

test('bot sends one message for a new homework and does not duplicate it', async () => {
  const context = await createTestContext();
  const messages = [];
  let currentTasks = [homework()];

  try {
    await syncBotHomeworks(options(context, currentTasks, async (...args) => messages.push(args)));
    currentTasks = [
      homework(),
      homework({
        targetAppointmentId: 185142,
        homeworkId: 101172,
        subject: 'Геометрія',
        description: 'Розв’язати вправу 4',
      }),
    ];
    const result = await syncBotHomeworks(options(context, currentTasks, async (...args) => messages.push(args)));
    await syncBotHomeworks(options(context, currentTasks, async (...args) => messages.push(args)));

    assert.equal(result.newTasks, 1);
    assert.equal(messages.length, 1);
    assert.match(messages[0][0], /📚 Нове завдання/);
    assert.equal(messages[0][1].replyMarkup.inline_keyboard[0][0].text, '✅ Позначити виконаним');
    assert.match(messages[0][1].replyMarkup.inline_keyboard[0][0].callback_data, /^complete:\d+$/);
  } finally {
    await context.close();
  }
});

test('long notification keeps the full snapshot and does not block the next delivery', async () => {
  const context = await createTestContext();
  const messages = [];
  const longDescription = '&<>😀'.repeat(1400);
  const longTask = homework({
    targetAppointmentId: 185160,
    homeworkId: 101190,
    description: longDescription,
    topic: longDescription,
  });
  const followingTask = homework({
    targetAppointmentId: 185161,
    homeworkId: 101191,
    description: 'Наступне завдання після скороченого повідомлення',
  });

  try {
    await syncBotHomeworks(options(context, [homework()], async () => {}));
    await syncBotHomeworks(options(
      context,
      [homework(), longTask, followingTask],
      async (...args) => messages.push(args),
    ));

    assert.equal(messages.length, 2);
    assert.ok(messages.every(([message]) => message.length <= 4096));
    assert.match(messages[0][0], /скорочено/i);
    assert.match(messages[1][0], /Наступне завдання/);
    assert.equal(
      (await context.database.currentTasks()).find((task) => task.targetAppointmentId === '185160')
        .snapshot.description,
      longDescription,
    );
  } finally {
    await context.close();
  }
});

test('bot sends an update for a changed description', async () => {
  const context = await createTestContext();
  const messages = [];
  let current = homework();

  try {
    await syncBotHomeworks(options(context, [current], async (...args) => messages.push(args)));
    current = homework({ description: 'Вивчити оновлений конспект, №12' });
    const result = await syncBotHomeworks(options(context, [current], async (...args) => messages.push(args)));

    assert.equal(result.updatedTasks, 1);
    assert.equal(messages.length, 1);
    assert.match(messages[0][0], /✏️ Завдання змінено/);
    assert.match(messages[0][0], /оновлений конспект/);
    assert.equal((await context.database.currentTasks()).length, 1);
  } finally {
    await context.close();
  }
});

test('Telegram failure leaves one task pending without hiding the saved snapshot', async () => {
  const context = await createTestContext();
  const newTask = homework({ targetAppointmentId: 185142, description: 'Нове завдання' });
  const followingTask = homework({ targetAppointmentId: 185143, description: 'Наступне завдання' });
  const delivered = [];

  try {
    await syncBotHomeworks(options(context, [homework()], async () => {}));
    const result = await syncBotHomeworks(options(
      context,
      [homework(), newTask, followingTask],
      async (_message, sendOptions) => {
        if (sendOptions.task.snapshot.description === 'Нове завдання') {
          throw new Error('network down');
        }
        delivered.push(sendOptions.task.snapshot.description);
      },
    ));

    const pending = (await context.database.currentTasks()).find(
      (task) => task.targetAppointmentId === '185142',
    );
    assert.ok(pending);
    assert.equal(pending.notificationPending, true);
    assert.equal(pending.lastNotifiedAt, null);
    assert.deepEqual(delivered, ['Наступне завдання']);
    assert.equal((await context.database.currentTasks()).length, 3);
    assert.equal(result.sentTasks, 1);
    assert.equal(result.deliveryErrors, 1);
  } finally {
    await context.close();
  }
});

test('pending notification is retried after the task disappears from the provider response', async () => {
  const context = await createTestContext();
  const missingTask = homework({ targetAppointmentId: 185144, description: 'Зникла з відповіді' });
  let shouldFail = true;
  let deliveryAttempts = 0;

  try {
    await syncBotHomeworks(options(context, [homework()], async () => {}));
    await syncBotHomeworks(options(
      context,
      [homework(), missingTask],
      async () => {
        deliveryAttempts += 1;
        if (shouldFail) {
          shouldFail = false;
          throw new Error('temporary failure');
        }
      },
    ));

    await syncBotHomeworks(options(
      context,
      [homework()],
      async (_message, sendOptions) => {
        assert.equal(sendOptions.task.snapshot.description, 'Зникла з відповіді');
        deliveryAttempts += 1;
      },
    ));

    assert.equal(deliveryAttempts, 2);
    assert.equal(
      (await context.database.pendingNotifications('eschool')).some(
        (task) => task.targetAppointmentId === '185144',
      ),
      false,
    );
  } finally {
    await context.close();
  }
});

test('provider fetch failure still attempts the previously saved notification queue', async () => {
  const context = await createTestContext();
  const queuedTask = homework({ targetAppointmentId: 185145, description: 'Очікує доставку' });
  let sends = 0;

  try {
    await syncBotHomeworks(options(context, [homework()], async () => {}));
    await syncBotHomeworks(options(
      context,
      [homework(), queuedTask],
      async () => {
        throw new Error('delivery unavailable');
      },
    ));

    await assert.rejects(
      () => syncBotHomeworks({
        ...options(context, [], async (_message, sendOptions) => {
          assert.equal(sendOptions.task.snapshot.description, 'Очікує доставку');
          sends += 1;
        }),
        getAppointmentsFn: async () => {
          throw new Error('provider unavailable');
        },
      }),
      /provider unavailable/,
    );

    assert.equal(sends, 1);
    assert.equal(
      (await context.database.currentTasks()).find((task) => task.targetAppointmentId === '185145').notificationPending,
      false,
    );
  } finally {
    await context.close();
  }
});

test('one Telegram 429 stops the current queue without a retry storm', async () => {
  const context = await createTestContext();
  const first = homework({ targetAppointmentId: 185146, description: '429 A' });
  const second = homework({ targetAppointmentId: 185147, description: '429 B' });
  let sends = 0;

  try {
    await syncBotHomeworks(options(context, [homework()], async () => {}));
    await syncBotHomeworks(options(
      context,
      [homework(), first, second],
      async () => {
        sends += 1;
        throw { code: 'TELEGRAM_RATE_LIMIT', retryAfter: 30 };
      },
    ));

    assert.equal(sends, 1);
    assert.equal(
      (await context.database.currentTasks()).find((task) => task.targetAppointmentId === '185146').notificationPending,
      true,
    );
    assert.equal(
      (await context.database.currentTasks()).find((task) => task.targetAppointmentId === '185147').notificationPending,
      true,
    );
  } finally {
    await context.close();
  }
});

test('snapshot transaction rolls back all source changes on a mid-write failure', async () => {
  const context = await createTestContext();
  const circularHomeworkIds = [];
  circularHomeworkIds.push(circularHomeworkIds);
  const first = toSyncTask(homework({ targetAppointmentId: 185148, description: 'До ошибки' }));
  const invalid = {
    ...toSyncTask(homework({ targetAppointmentId: 185149, description: 'Сломанная запись' })),
    homeworkIds: circularHomeworkIds,
  };

  try {
    await context.database.saveBaseline([first], FIXED_NOW.toISOString(), { source: 'eschool' });
    const previous = await context.database.findMatch(first);
    await assert.rejects(
      () => context.database.applyProviderSnapshot(
        [
          { task: first, previous, notificationKind: null },
          { task: invalid, previous: null, notificationKind: 'new' },
        ],
        FIXED_NOW.toISOString(),
        { source: 'eschool' },
      ),
      /Could not save eschool PostgreSQL snapshot/,
    );
    assert.deepEqual(
      (await context.database.currentTasks()).map((task) => task.snapshot.description),
      ['До ошибки'],
    );
    assert.equal(await context.database.findByFingerprint(invalid.fingerprint), null);
  } finally {
    await context.close();
  }
});

test('bot deduplicates multiple homework ids into one notification', async () => {
  const context = await createTestContext();
  const messages = [];
  const duplicateA = homework({ homeworkId: 1, topic: 'Тема A' });
  const duplicateB = homework({
    homeworkId: 2,
    topic: 'Тема B',
    description: '  Вивчити конспект, №11  ',
    filesCount: 1,
  });

  try {
    const result = await syncBotHomeworks({
      ...options(context, [], async (...args) => messages.push(args)),
      getAppointmentsFn: async () => ({ rawHomeworks: [duplicateA, duplicateB] }),
    });

    assert.equal(result.baselineInitialized, true);
    assert.equal(result.taskCount, 1);
    assert.equal((await context.database.currentTasks())[0].homeworkIds.length, 2);
    assert.equal(messages.length, 0);
  } finally {
    await context.close();
  }
});

test('bot imports the existing JSON baseline without notifying old tasks', async () => {
  const state = createEmptyState();
  state.initializedAt = '2026-09-08T12:00:00.000Z';
  state.tasks.old = {
    fingerprint: 'old',
    targetAppointmentId: 185141,
    homeworkIds: [101171],
    snapshot: {
      subject: 'Алгебра',
      description: 'Вивчити конспект',
      targetDate: '2026-09-11',
      topics: ['Числові множини'],
    },
  };
  const context = await createTestContext(state);
  const messages = [];

  try {
    await syncBotHomeworks(options(context, [homework({ description: 'Вивчити конспект' })], async (...args) => {
      messages.push(args);
    }));
    assert.equal(messages.length, 0);
    assert.equal((await context.database.currentTasks()).length, 1);
  } finally {
    await context.close();
  }
});

test('bot sync removes only completed tasks older than fourteen days', async () => {
  const context = await createTestContext();
  const pending = toSyncTask(homework());
  const oldCompleted = toSyncTask(homework({
    targetAppointmentId: 185142,
    description: 'Старе виконане завдання',
  }));
  await context.database.saveBaseline(
    [pending, oldCompleted],
    '2026-08-01T12:00:00.000Z',
  );
  const oldRow = await context.database.findByFingerprint(oldCompleted.fingerprint);
  await context.database.completeTask(oldRow.id, '2026-08-01T12:00:00.000Z');

  try {
    await syncBotHomeworks(options(
      context,
      [homework()],
      async () => {
        throw new Error('existing tasks must not be notified');
      },
    ));

    assert.equal(await context.database.findByFingerprint(oldCompleted.fingerprint), null);
    assert.ok(await context.database.findByFingerprint(pending.fingerprint));
  } finally {
    await context.close();
  }
});

test('Classroom submission changes one stable row to completed without a duplicate notification', async () => {
  const context = await createTestContext();
  const messages = [];
  const task = classroomHomework();

  try {
    await syncProviderHomeworks(classroomSyncOptions(
      context,
      classroomResult([{ task, status: 'pending' }]),
      async (...args) => messages.push(args),
    ));
    const firstRow = await context.database.findByExternalId('course-1:work-1', 'classroom');

    await syncProviderHomeworks(classroomSyncOptions(
      context,
      classroomResult([{ task, status: 'completed', includeTask: false }]),
      async (...args) => messages.push(args),
      { now: new Date('2026-09-09T13:00:00.000Z') },
    ));
    const completed = await context.database.findByExternalId('course-1:work-1', 'classroom');
    const completedAt = completed.completedAt;

    await syncProviderHomeworks(classroomSyncOptions(
      context,
      classroomResult([{ task, status: 'completed', includeTask: false }]),
      async (...args) => messages.push(args),
      { now: new Date('2026-09-09T14:00:00.000Z') },
    ));

    assert.equal(await context.database.countBySource('classroom'), 1);
    assert.equal(completed.id, firstRow.id);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.completionOrigin, 'classroom');
    assert.equal(completed.completedAt, '2026-09-09T13:00:00.000Z');
    assert.equal(completedAt, completed.completedAt);
    assert.equal((await context.database.completedTasks()).length, 1);
    assert.equal(messages.length, 0);
  } finally {
    await context.close();
  }
});

test('a first-seen old Classroom assignment already completed is stored quietly', async () => {
  const context = await createTestContext();
  const messages = [];
  const oldTask = classroomHomework({
    updatedAt: '2026-08-20T10:00:00.000Z',
  });

  try {
    await syncProviderHomeworks(classroomSyncOptions(
      context,
      classroomResult([{ task: oldTask, status: 'completed', includeTask: false }]),
      async (...args) => messages.push(args),
    ));

    const stored = await context.database.findByExternalId('course-1:work-1', 'classroom');
    assert.equal(stored.status, 'completed');
    assert.equal(stored.completionOrigin, 'classroom');
    assert.equal(messages.length, 0);
  } finally {
    await context.close();
  }
});

test('manual Classroom completion and restoration take priority over provider status', async () => {
  const context = await createTestContext();
  const task = classroomHomework();

  try {
    await syncProviderHomeworks(classroomSyncOptions(
      context,
      classroomResult([{ task, status: 'pending' }]),
      async () => {},
    ));
    await context.database.completeTask(1, '2026-09-09T13:00:00.000Z');
    await syncProviderHomeworks(classroomSyncOptions(
      context,
      classroomResult([{ task, status: 'pending', includeTask: false }]),
      async () => {},
      { now: new Date('2026-09-09T14:00:00.000Z') },
    ));
    let stored = await context.database.findByExternalId('course-1:work-1', 'classroom');
    assert.equal(stored.status, 'completed');
    assert.equal(stored.completionOrigin, 'manual');
    assert.equal(stored.completedAt, '2026-09-09T13:00:00.000Z');

    await context.database.uncompleteTask(1, '2026-09-09T15:00:00.000Z');
    await syncProviderHomeworks(classroomSyncOptions(
      context,
      classroomResult([{ task, status: 'completed', includeTask: false }]),
      async () => {},
      { now: new Date('2026-09-09T16:00:00.000Z') },
    ));
    stored = await context.database.findByExternalId('course-1:work-1', 'classroom');
    assert.equal(stored.status, 'pending');
    assert.equal(stored.completionOrigin, 'manual');
  } finally {
    await context.close();
  }
});

test('Classroom ignores updatedAt-only changes, notifies content changes, and sends a new pending task once', async () => {
  const context = await createTestContext();
  const messages = [];
  const original = classroomHomework();

  try {
    await syncProviderHomeworks(classroomSyncOptions(
      context,
      classroomResult([{ task: original, status: 'pending' }]),
      async (...args) => messages.push(args),
    ));
    const timestampOnly = classroomHomework({
      updatedAt: '2026-09-09T11:00:00.000Z',
    });
    const unchanged = await syncProviderHomeworks(classroomSyncOptions(
      context,
      classroomResult([{ task: timestampOnly, status: 'pending' }]),
      async (...args) => messages.push(args),
      { now: new Date('2026-09-09T13:00:00.000Z') },
    ));
    assert.equal(unchanged.updatedTasks, 0);
    assert.equal(messages.length, 0);

    const contentChanged = classroomHomework({
      description: 'Опрацювати оновлений параграф',
      updatedAt: '2026-09-09T12:00:00.000Z',
    });
    const changed = await syncProviderHomeworks(classroomSyncOptions(
      context,
      classroomResult([{ task: contentChanged, status: 'pending' }]),
      async (...args) => messages.push(args),
      { now: new Date('2026-09-09T14:00:00.000Z') },
    ));
    assert.equal(changed.updatedTasks, 1);
    assert.equal(messages.length, 1);
    assert.match(messages[0][0], /Завдання змінено/);

    const newTask = classroomHomework({
      courseWorkId: 'work-2',
      externalId: 'course-1:work-2',
      title: 'Нове завдання',
      description: 'Виконати вправу',
      updatedAt: '2026-09-09T13:00:00.000Z',
      url: 'https://classroom.google.com/c/course-1/a/work-2/details',
    });
    const added = await syncProviderHomeworks(classroomSyncOptions(
      context,
      classroomResult([
        { task: contentChanged, status: 'pending' },
        { task: newTask, status: 'pending' },
      ]),
      async (...args) => messages.push(args),
      { now: new Date('2026-09-09T15:00:00.000Z') },
    ));
    assert.equal(added.newTasks, 1);
    assert.equal(messages.length, 2);
    assert.equal(await context.database.countBySource('classroom'), 2);
  } finally {
    await context.close();
  }
});

test('Classroom URL-format migration updates the snapshot without a false notification', async () => {
  const context = await createTestContext();
  const messages = [];
  const legacyTask = classroomHomework({
    courseId: '876750472074',
    courseWorkId: '878258754750',
    externalId: '876750472074:878258754750',
    url: 'https://classroom.google.com/c/876750472074/a/878258754750/details',
  });
  const correctedTask = classroomHomework({
    courseId: '876750472074',
    courseWorkId: '878258754750',
    externalId: '876750472074:878258754750',
    url: 'https://classroom.google.com/c/ODc2NzUwNDcyMDc0/a/ODc4MjU4NzU0NzUw/details',
  });

  try {
    await syncProviderHomeworks(classroomSyncOptions(
      context,
      classroomResult([{ task: legacyTask, status: 'pending' }]),
      async (...args) => messages.push(args),
    ));
    const result = await syncProviderHomeworks(classroomSyncOptions(
      context,
      classroomResult([{ task: correctedTask, status: 'pending' }]),
      async (...args) => messages.push(args),
      { now: new Date('2026-09-09T13:00:00.000Z') },
    ));

    assert.equal(result.updatedTasks, 0);
    assert.equal(messages.length, 0);
    const stored = await context.database.findByExternalId(
      '876750472074:878258754750',
      'classroom',
    );
    assert.equal(stored.snapshot.url, correctedTask.snapshot.url);
  } finally {
    await context.close();
  }
});

test('Classroom deduplicates provider ids but keeps equal titles in different courses separate', async () => {
  const context = await createTestContext();
  const first = classroomHomework({ title: 'Однакова назва', description: 'Однакова назва' });
  const duplicate = classroomHomework({ title: 'Інший текст', description: 'Інший текст' });
  const otherCourse = classroomHomework({
    courseId: 'course-2',
    courseWorkId: 'work-1',
    externalId: 'course-2:work-1',
    title: 'Однакова назва',
    description: 'Однакова назва',
    url: 'https://classroom.google.com/c/course-2/a/work-1/details',
  });

  try {
    await syncProviderHomeworks(classroomSyncOptions(
      context,
      classroomResult([
        { task: first, status: 'pending' },
        { task: duplicate, status: 'pending' },
        { task: otherCourse, status: 'pending' },
      ]),
      async () => {},
    ));
    assert.equal(await context.database.countBySource('classroom'), 2);
    assert.ok(await context.database.findByExternalId('course-1:work-1', 'classroom'));
    assert.ok(await context.database.findByExternalId('course-2:work-1', 'classroom'));
  } finally {
    await context.close();
  }
});

test('unknown Classroom status preserves the existing row and does not trigger a notification', async () => {
  const context = await createTestContext();
  const task = classroomHomework();
  const messages = [];

  try {
    await syncProviderHomeworks(classroomSyncOptions(
      context,
      classroomResult([{ task, status: 'pending' }]),
      async (...args) => messages.push(args),
    ));
    const before = await context.database.findByExternalId('course-1:work-1', 'classroom');
    await syncProviderHomeworks(classroomSyncOptions(
      context,
      classroomResult([{ task, status: 'unknown', includeTask: false }]),
      async (...args) => messages.push(args),
      { now: new Date('2026-09-09T13:00:00.000Z') },
    ));
    const after = await context.database.findByExternalId('course-1:work-1', 'classroom');
    assert.equal(after.status, 'pending');
    assert.equal(after.id, before.id);
    assert.equal(messages.length, 0);
  } finally {
    await context.close();
  }
});

test('partial Classroom status snapshots fail before changing stored rows', async () => {
  const context = await createTestContext();
  const task = classroomHomework();

  try {
    await syncProviderHomeworks(classroomSyncOptions(
      context,
      classroomResult([{ task, status: 'pending' }]),
      async () => {},
    ));
    const before = await context.database.findByExternalId('course-1:work-1', 'classroom');
    await assert.rejects(
      syncProviderHomeworks(classroomSyncOptions(
        context,
        classroomResult([{ task, status: 'completed', includeTask: false }], {
          snapshotComplete: false,
          statusReconciliationComplete: false,
        }),
        async () => {},
        { now: new Date('2026-09-09T13:00:00.000Z') },
      )),
      (error) => error.code === 'SYNC_DATA_ERROR',
    );
    const after = await context.database.findByExternalId('course-1:work-1', 'classroom');
    assert.equal(after.status, before.status);
    assert.equal(after.lastSeenAt, before.lastSeenAt);
  } finally {
    await context.close();
  }
});

test('Classroom status reconciliation stays quiet, retries after interruption, and survives restart', async () => {
  const context = await createTestContext();
  const task = classroomHomework();
  const messages = [];

  try {
    await assert.rejects(
      syncProviderHomeworks(classroomSyncOptions(
        context,
        classroomResult([{ task, status: 'completed', includeTask: false }], {
          snapshotComplete: false,
          statusReconciliationComplete: false,
        }),
        async (...args) => messages.push(args),
      )),
      (error) => error.code === 'SYNC_DATA_ERROR',
    );
    assert.equal(await context.database.getMeta('classroom_status_reconciled_at'), null);
    assert.equal(await context.database.countBySource('classroom'), 0);

    await syncProviderHomeworks(classroomSyncOptions(
      context,
      classroomResult([{ task, status: 'pending' }]),
      async (...args) => messages.push(args),
    ));
    const marker = await context.database.getMeta('classroom_status_reconciled_at');
    assert.equal(marker, FIXED_NOW.toISOString());
    assert.equal(messages.length, 0);

    await context.database.close();
    const { Pool } = context.memory.adapters.createPg();
    const reopened = await createPostgresHomeworkDatabase({
      connectionString: 'postgresql://test/test',
      pool: new Pool(),
    });
    try {
      assert.equal(await reopened.getMeta('classroom_status_reconciled_at'), marker);
      await syncProviderHomeworks({
        source: 'classroom',
        fetchTasksFn: async () => classroomResult([{ task, status: 'pending' }]),
        database: reopened,
        sendMessageFn: async (...args) => messages.push(args),
        logger: () => {},
        now: new Date('2026-09-09T13:00:00.000Z'),
      });
      assert.equal(messages.length, 0);
    } finally {
      await reopened.close();
    }
  } finally {
    if (!context.database.closed) {
      await context.database.close();
    }
  }
});

test('completed Classroom status removes only its stale notification while a failed neighboring notification stays queued', async () => {
  const context = await createTestContext();
  const first = classroomHomework({ courseWorkId: 'work-2', externalId: 'course-1:work-2' });
  const second = classroomHomework({ courseWorkId: 'work-3', externalId: 'course-1:work-3' });
  let sends = 0;

  try {
    await syncProviderHomeworks(classroomSyncOptions(
      context,
      classroomResult([{ task: classroomHomework(), status: 'pending' }]),
      async () => {},
    ));
    await syncProviderHomeworks(classroomSyncOptions(
      context,
      classroomResult([
        { task: classroomHomework(), status: 'pending' },
        { task: first, status: 'pending' },
        { task: second, status: 'pending' },
      ]),
      async () => {
        sends += 1;
        throw new Error('Telegram unavailable');
      },
      { now: new Date('2026-09-09T13:00:00.000Z') },
    ));

    await syncProviderHomeworks(classroomSyncOptions(
      context,
      classroomResult([
        { task: first, status: 'completed' },
        { task: second, status: 'pending', includeTask: false },
      ]),
      async () => {
        sends += 1;
        throw new Error('Telegram still unavailable');
      },
      { now: new Date('2026-09-09T14:00:00.000Z') },
    ));

    assert.equal(sends, 3);
    assert.equal(
      (await context.database.findByExternalId('course-1:work-2', 'classroom')).status,
      'completed',
    );
    assert.equal(
      (await context.database.findByExternalId('course-1:work-2', 'classroom')).notificationPending,
      false,
    );
    assert.equal(
      (await context.database.findByExternalId('course-1:work-3', 'classroom')).notificationPending,
      true,
    );
  } finally {
    await context.close();
  }
});
