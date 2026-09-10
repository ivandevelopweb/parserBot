import test from 'node:test';
import assert from 'node:assert/strict';

import { createEmptyState } from '../src/state.js';
import { syncBotHomeworks, syncProviderHomeworks } from '../src/bot-sync.js';
import { createHomeworkDatabase } from '../src/homework-db.js';
import { toSyncTask } from '../src/sync.js';

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

function createTestContext(initialState = createEmptyState()) {
  const database = createHomeworkDatabase({ filePath: ':memory:' });
  return {
    database,
    legacyStateStore: { load: async () => structuredClone(initialState) },
    close: () => database.close(),
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

test('bot first sync creates baseline and sends no existing homework', async () => {
  const context = createTestContext();
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
    assert.equal(context.database.currentTasks().length, 1);
  } finally {
    context.close();
  }
});

test('different homework for one appointment stays separate and keeps stable rows', async () => {
  const context = createTestContext();
  const messages = [];
  const first = homework({ homeworkId: 201, description: 'Варіант A' });
  const second = homework({ homeworkId: 202, description: 'Варіант B' });

  try {
    await syncBotHomeworks(options(
      context,
      [first, second],
      async (...args) => messages.push(args),
    ));

    const baselineRows = context.database.currentTasks();
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
      context.database.currentTasks().map((task) => [task.snapshot.description, task.id]),
      [['Варіант A', baselineIds.get('Варіант A')], ['Варіант B', baselineIds.get('Варіант B')]],
    );
  } finally {
    context.close();
  }
});

test('changing one of two homework items for an appointment preserves both row ids', async () => {
  const context = createTestContext();
  const messages = [];
  const first = homework({ homeworkId: 301, description: 'Початкове A' });
  const second = homework({ homeworkId: 302, description: 'Початкове B' });

  try {
    await syncBotHomeworks(options(context, [first, second], async (...args) => messages.push(args)));
    const baselineRows = context.database.currentTasks();
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
    const currentRows = context.database.currentTasks();
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
    context.close();
  }
});

test('ambiguous changes for one appointment do not reuse one old row twice', async () => {
  const context = createTestContext();
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
    const baselineIds = new Set(context.database.currentTasks().map((task) => task.id));

    await syncBotHomeworks(options(
      context,
      [
        homework({ homeworkId: 351, description: 'Нове A' }),
        homework({ homeworkId: 352, description: 'Нове B' }),
      ],
      async (...args) => messages.push(args),
    ));

    const currentRows = context.database.currentTasks();
    assert.equal(currentRows.length, 2);
    assert.equal(messages.length, 2);
    assert.equal(currentRows.some((task) => baselineIds.has(task.id)), false);
    assert.deepEqual(
      currentRows.map((task) => task.snapshot.description).sort(),
      ['Нове A', 'Нове B'],
    );
  } finally {
    context.close();
  }
});

test('duplicate normalized fingerprints are stored once', async () => {
  const context = createTestContext();

  try {
    await syncBotHomeworks(options(
      context,
      [
        homework({ homeworkId: 401, description: '  Однакова робота  ' }),
        homework({ homeworkId: 402, description: 'Однакова робота' }),
      ],
      async () => {},
    ));

    assert.equal(context.database.currentTasks().length, 1);
  } finally {
    context.close();
  }
});

test('bot sends one message for a new homework and does not duplicate it', async () => {
  const context = createTestContext();
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
    context.close();
  }
});

test('long notification keeps the full snapshot and does not block the next delivery', async () => {
  const context = createTestContext();
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
      context.database.currentTasks().find((task) => task.targetAppointmentId === '185160')
        .snapshot.description,
      longDescription,
    );
  } finally {
    context.close();
  }
});

test('bot sends an update for a changed description', async () => {
  const context = createTestContext();
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
    assert.equal(context.database.currentTasks().length, 1);
  } finally {
    context.close();
  }
});

test('Telegram failure leaves one task pending without hiding the saved snapshot', async () => {
  const context = createTestContext();
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

    const pending = context.database.currentTasks().find(
      (task) => task.targetAppointmentId === '185142',
    );
    assert.ok(pending);
    assert.equal(pending.notificationPending, true);
    assert.equal(pending.lastNotifiedAt, null);
    assert.deepEqual(delivered, ['Наступне завдання']);
    assert.equal(context.database.currentTasks().length, 3);
    assert.equal(result.sentTasks, 1);
    assert.equal(result.deliveryErrors, 1);
  } finally {
    context.close();
  }
});

test('pending notification is retried after the task disappears from the provider response', async () => {
  const context = createTestContext();
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
      context.database.pendingNotifications('eschool').some(
        (task) => task.targetAppointmentId === '185144',
      ),
      false,
    );
  } finally {
    context.close();
  }
});

test('provider fetch failure still attempts the previously saved notification queue', async () => {
  const context = createTestContext();
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
      context.database.currentTasks().find((task) => task.targetAppointmentId === '185145').notificationPending,
      false,
    );
  } finally {
    context.close();
  }
});

test('one Telegram 429 stops the current queue without a retry storm', async () => {
  const context = createTestContext();
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
      context.database.currentTasks().find((task) => task.targetAppointmentId === '185146').notificationPending,
      true,
    );
    assert.equal(
      context.database.currentTasks().find((task) => task.targetAppointmentId === '185147').notificationPending,
      true,
    );
  } finally {
    context.close();
  }
});

test('snapshot transaction rolls back all source changes on a mid-write failure', () => {
  const context = createTestContext();
  const circularHomeworkIds = [];
  circularHomeworkIds.push(circularHomeworkIds);
  const first = toSyncTask(homework({ targetAppointmentId: 185148, description: 'До ошибки' }));
  const invalid = {
    ...toSyncTask(homework({ targetAppointmentId: 185149, description: 'Сломанная запись' })),
    homeworkIds: circularHomeworkIds,
  };

  try {
    context.database.saveBaseline([first], FIXED_NOW.toISOString(), { source: 'eschool' });
    assert.throws(
      () => context.database.applyProviderSnapshot(
        [
          { task: first, previous: context.database.findMatch(first), notificationKind: null },
          { task: invalid, previous: null, notificationKind: 'new' },
        ],
        FIXED_NOW.toISOString(),
        { source: 'eschool' },
      ),
      /Could not save homework task/,
    );
    assert.deepEqual(
      context.database.currentTasks().map((task) => task.snapshot.description),
      ['До ошибки'],
    );
    assert.equal(context.database.findByFingerprint(invalid.fingerprint), null);
  } finally {
    context.close();
  }
});

test('bot deduplicates multiple homework ids into one notification', async () => {
  const context = createTestContext();
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
    assert.equal(context.database.currentTasks()[0].homeworkIds.length, 2);
    assert.equal(messages.length, 0);
  } finally {
    context.close();
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
  const context = createTestContext(state);
  const messages = [];

  try {
    await syncBotHomeworks(options(context, [homework({ description: 'Вивчити конспект' })], async (...args) => {
      messages.push(args);
    }));
    assert.equal(messages.length, 0);
    assert.equal(context.database.currentTasks().length, 1);
  } finally {
    context.close();
  }
});

test('bot sync removes only completed tasks older than fourteen days', async () => {
  const context = createTestContext();
  const pending = toSyncTask(homework());
  const oldCompleted = toSyncTask(homework({
    targetAppointmentId: 185142,
    description: 'Старе виконане завдання',
  }));
  context.database.saveBaseline(
    [pending, oldCompleted],
    '2026-08-01T12:00:00.000Z',
  );
  const oldRow = context.database.findByFingerprint(oldCompleted.fingerprint);
  context.database.completeTask(oldRow.id, '2026-08-01T12:00:00.000Z');

  try {
    await syncBotHomeworks(options(
      context,
      [homework()],
      async () => {
        throw new Error('existing tasks must not be notified');
      },
    ));

    assert.equal(context.database.findByFingerprint(oldCompleted.fingerprint), null);
    assert.ok(context.database.findByFingerprint(pending.fingerprint));
  } finally {
    context.close();
  }
});
