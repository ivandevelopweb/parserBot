import test from 'node:test';
import assert from 'node:assert/strict';

import { createEmptyState } from '../src/state.js';
import { syncBotHomeworks } from '../src/bot-sync.js';
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

test('Telegram failure leaves the homework pending for a later retry', async () => {
  const context = createTestContext();
  const newTask = homework({ targetAppointmentId: 185142, description: 'Нове завдання' });

  try {
    await syncBotHomeworks(options(context, [homework()], async () => {}));
    await assert.rejects(
      () => syncBotHomeworks(options(context, [homework(), newTask], async () => {
        throw new Error('network down');
      })),
      /Telegram delivery failed/,
    );

    const pending = context.database.currentTasks().find(
      (task) => task.targetAppointmentId === '185142',
    );
    assert.ok(pending);
    assert.equal(pending.notificationPending, true);
    assert.equal(pending.lastNotifiedAt, null);
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
