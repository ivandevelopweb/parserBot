import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createTelegramBot,
  getSyncStaleAfterMs,
  HOMEWORK_SYNC_INTERVAL_MS,
  parseHomeworkSyncIntervalMinutes,
  DEFAULT_HOMEWORK_SYNC_INTERVAL_MINUTES,
} from '../src/telegram-bot.js';
import { syncAllHomeworks } from '../src/bot-sync.js';
import { CLASSROOM_AUTHUSER_META_KEY } from '../src/classroom-url.js';
import { createTestDatabase } from '../test-support/postgres-test-database.js';

function createTelegramMock() {
  const calls = [];
  return {
    calls,
    async sendTelegramMessage(...args) {
      calls.push({ method: 'send', args });
      return { message_id: 100 };
    },
    async editTelegramMessage(...args) {
      calls.push({ method: 'edit', args });
      return { message_id: 100 };
    },
    async answerCallbackQuery(...args) {
      calls.push({ method: 'answer', args });
      return true;
    },
  };
}

test('sync interval configuration is bounded and diagnostics are kept in memory', async () => {
  assert.equal(DEFAULT_HOMEWORK_SYNC_INTERVAL_MINUTES, 10);
  assert.equal(HOMEWORK_SYNC_INTERVAL_MS, 10 * 60 * 1000);
  assert.equal(parseHomeworkSyncIntervalMinutes(null), 10);
  assert.equal(
    parseHomeworkSyncIntervalMinutes(),
    parseHomeworkSyncIntervalMinutes(process.env.HOMEWORK_SYNC_INTERVAL_MINUTES ?? null),
  );
  assert.equal(parseHomeworkSyncIntervalMinutes(''), 10);
  assert.equal(parseHomeworkSyncIntervalMinutes('  '), 10);
  assert.equal(parseHomeworkSyncIntervalMinutes('5'), 5);
  assert.equal(parseHomeworkSyncIntervalMinutes('10'), 10);
  assert.equal(parseHomeworkSyncIntervalMinutes('20'), 20);
  assert.equal(parseHomeworkSyncIntervalMinutes('60'), 60);
  assert.throws(() => parseHomeworkSyncIntervalMinutes('4'), /from 5 to 60/);
  assert.throws(() => parseHomeworkSyncIntervalMinutes('10.5'), /integer/);
  assert.equal(getSyncStaleAfterMs(20 * 60 * 1000), 45 * 60 * 1000);

  let databaseReads = 0;
  const bot = createTelegramBot({
    auth: {},
    telegram: createTelegramMock(),
    database: {
      async getMeta() {
        databaseReads += 1;
        throw new Error('health must not query the database');
      },
    },
    allowedChatId: '123',
    syncFn: async () => ({
      providers: [
        {
          source: 'eschool',
          status: 'ok',
          attemptedAt: new Date().toISOString(),
          lastSuccessAt: new Date().toISOString(),
          taskCount: 2,
          metrics: { observed: 2 },
        },
      ],
    }),
    logger: () => {},
  });
  await bot.runSync();
  assert.equal(databaseReads, 0);
  assert.equal(bot.getDiagnostics().eschool.status, 'ok');
  assert.equal(bot.getDiagnostics().eschool.stale, false);
});

test('a rejected sync releases the running guard so the next cycle can start', async () => {
  let calls = 0;
  const bot = createTelegramBot({
    auth: {},
    telegram: createTelegramMock(),
    database: {},
    allowedChatId: '123',
    syncFn: async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error('synthetic PostgreSQL failure');
      }
      return {
        providers: [{
          source: 'eschool',
          status: 'ok',
          attemptedAt: new Date().toISOString(),
          lastSuccessAt: new Date().toISOString(),
          taskCount: 0,
        }],
      };
    },
    logger: () => {},
  });

  await assert.rejects(
    () => bot.runSync({ throwOnError: true }),
    /synthetic PostgreSQL failure/,
  );
  const nextResult = await bot.runSync();

  assert.equal(calls, 2);
  assert.equal(nextResult.providers[0].status, 'ok');
});

test('health diagnostics expose E-school failure stages and clear them after recovery', async () => {
  const { database } = await createTestDatabase();
  let loginFailure = true;
  let appointmentsFailure = false;
  let deliveryFailure = false;
  let currentTask = {
    targetAppointmentId: 185190,
    homeworkId: 101220,
    subject: 'Алгебра',
    description: 'Перше завдання',
    targetDate: '2026-09-14',
  };
  const now = new Date('2026-09-12T10:00:00.000Z');
  const bot = createTelegramBot({
    auth: {
      async fullLogin() {
        if (loginFailure) throw new Error('synthetic login outage');
      },
    },
    telegram: {},
    database,
    allowedChatId: '123',
    now: () => now,
    syncFn: (options) => syncAllHomeworks({
      ...options,
      legacyStateStore: null,
      getAppointmentsFn: async () => {
        if (appointmentsFailure) throw new Error('synthetic appointment outage');
        return { homeworkTasks: [currentTask] };
      },
      sendMessageFn: async () => {
        if (deliveryFailure) throw new Error('synthetic Telegram outage');
      },
    }),
    logger: () => {},
  });

  try {
    await bot.runSync();
    assert.equal(bot.getDiagnostics().eschool.status, 'error');
    assert.equal(bot.getDiagnostics().eschool.stage, 'login');

    loginFailure = false;
    await bot.runSync();
    assert.equal(bot.getDiagnostics().eschool.status, 'ok');
    assert.equal(bot.getDiagnostics().eschool.stage, null);

    appointmentsFailure = true;
    await bot.runSync();
    assert.equal(bot.getDiagnostics().eschool.status, 'error');
    assert.equal(bot.getDiagnostics().eschool.stage, 'appointments');
    assert.equal(bot.getDiagnostics().eschool.lastSuccessAt, now.toISOString());

    appointmentsFailure = false;
    await bot.runSync();
    assert.equal(bot.getDiagnostics().eschool.status, 'ok');
    assert.equal(bot.getDiagnostics().eschool.stage, null);

    currentTask = { ...currentTask, description: 'Оновлене завдання' };
    deliveryFailure = true;
    await bot.runSync();
    assert.equal(bot.getDiagnostics().eschool.status, 'delivery_error');
    assert.equal(bot.getDiagnostics().eschool.stage, 'delivery');
    assert.equal(bot.getDiagnostics().eschool.lastSuccessAt, now.toISOString());

    deliveryFailure = false;
    await bot.runSync();
    assert.equal(bot.getDiagnostics().eschool.status, 'ok');
    assert.equal(bot.getDiagnostics().eschool.stage, null);
  } finally {
    await database.close();
  }
});

async function createBotContext() {
  const { database } = await createTestDatabase();
  await database.saveBaseline([{
    fingerprint: 'homework-one',
    targetAppointmentId: 185141,
    homeworkIds: [101171],
    snapshot: {
      subject: 'Алгебра',
      description: 'Вивчити конспект',
      targetDate: '2026-09-11',
      assignedDate: '2026-09-09',
      topics: ['Числові множини'],
      lessonNumber: 4,
      startTime: '11:25',
      filesCount: 1,
    },
  }], '2026-09-09T12:00:00.000Z');
  const telegram = createTelegramMock();
  const bot = createTelegramBot({
    auth: {},
    telegram,
    database,
    allowedChatId: '123',
    logger: () => {},
    now: () => new Date('2026-09-09T12:00:00.000Z'),
  });
  return { database, telegram, bot };
}

test('Telegram menu lists current tasks and completion moves one to history', async () => {
  const context = await createBotContext();

  try {
    await context.bot.handleUpdate({
      callback_query: {
        id: 'callback-1',
        data: 'menu:current',
        message: { message_id: 50, chat: { id: 123 } },
      },
    });

    const listCall = context.telegram.calls.find((call) => call.method === 'edit');
    assert.match(listCall.args[0], /11\.09\.2026/);
    assert.match(
      listCall.args[0],
      /<a href="https:\/\/diary\.eschool-ua\.com\/homework\/101171">Вивчити конспект \(Єдина школа\)<\/a>/,
    );
    assert.equal(listCall.args[1].parseMode, 'HTML');
    assert.equal(listCall.args[1].replyMarkup.inline_keyboard[0][0].text, '✅ Алгебра · 11.09 · Вивчити конспект');
    assert.equal(listCall.args[1].replyMarkup.inline_keyboard[0][0].callback_data, 'complete:list:1:0');

    await context.bot.handleUpdate({
      callback_query: {
        id: 'callback-2',
        data: 'complete:list:1:0',
        message: { message_id: 50, chat: { id: 123 } },
      },
    });

    assert.equal((await context.database.currentTasks()).length, 0);
    assert.equal((await context.database.completedTasks()).length, 1);
    assert.equal(
      (await context.database.completedTasks())[0].completedAt,
      '2026-09-09T12:00:00.000Z',
    );
    const refreshedCall = context.telegram.calls.at(-1);
    assert.match(refreshedCall.args[0], /Наразі немає невиконаних завдань/);
    assert.equal(refreshedCall.args[1].replyMarkup.inline_keyboard[0][0].callback_data, 'menu:main');
  } finally {
    await context.database.close();
  }
});

test('Telegram completion callback stores a UTC date that cleanup can expire', async () => {
  const context = await createBotContext();

  try {
    await context.bot.handleUpdate({
      callback_query: {
        id: 'callback-date-cleanup',
        data: 'complete:1',
        message: { message_id: 50, chat: { id: 123 } },
      },
    });

    assert.equal(
      (await context.database.completedTasks())[0].completedAt,
      '2026-09-09T12:00:00.000Z',
    );
    assert.equal(
      await context.database.deleteCompletedBefore(new Date('2026-09-23T12:00:00.000Z')),
      1,
    );
    assert.equal((await context.database.completedTasks()).length, 0);
  } finally {
    await context.database.close();
  }
});

test('Telegram bot keeps the current list page when marking a task completed', async () => {
  const { database } = await createTestDatabase();
  const tasks = Array.from({ length: 8 }, (_, index) => ({
    fingerprint: `homework-${index + 1}`,
    targetAppointmentId: 185141 + index,
    homeworkIds: [101171 + index],
    snapshot: {
      subject: `Предмет ${index + 1}`,
      description: `Завдання ${index + 1}`,
      targetDate: '2026-09-11',
    },
  }));
  await database.saveBaseline(tasks, '2026-09-09T12:00:00.000Z');
  const telegram = createTelegramMock();
  const bot = createTelegramBot({
    auth: {},
    telegram,
    database,
    allowedChatId: '123',
    logger: () => {},
    now: () => new Date('2026-09-09T12:00:00.000Z'),
  });

  try {
    await bot.handleUpdate({
      callback_query: {
        id: 'callback-page',
        data: 'current:page:1',
        message: { message_id: 50, chat: { id: 123 } },
      },
    });
    await bot.handleUpdate({
      callback_query: {
        id: 'callback-complete-page',
        data: 'complete:list:8:1',
        message: { message_id: 50, chat: { id: 123 } },
      },
    });

    const refreshed = telegram.calls.at(-1);
    assert.equal(refreshed.method, 'edit');
    assert.match(refreshed.args[0], /Завдання 7/);
    assert.deepEqual(refreshed.args[1].replyMarkup.inline_keyboard.at(-2), [
      { text: '◀️', callback_data: 'current:page:0' },
      { text: '2/2', callback_data: 'noop' },
    ]);
    assert.equal((await database.currentTasks()).length, 7);
    assert.equal((await database.completedTasks()).length, 1);
  } finally {
    await database.close();
  }
});

test('completed list uses a cross to restore a task and refreshes the same list', async () => {
  const context = await createBotContext();
  await context.database.completeTask(1, '2026-09-09T12:00:00.000Z');

  try {
    await context.bot.handleUpdate({
      callback_query: {
        id: 'callback-completed-list',
        data: 'menu:completed',
        message: { message_id: 50, chat: { id: 123 } },
      },
    });

    const listCall = context.telegram.calls.find((call) => call.method === 'edit');
    assert.equal(listCall.args[1].replyMarkup.inline_keyboard[0][0].text, '❌ Алгебра · 11.09 · Вивчити конспект');
    assert.equal(
      listCall.args[1].replyMarkup.inline_keyboard[0][0].callback_data,
      'uncomplete:list:1:0',
    );

    await context.bot.handleUpdate({
      callback_query: {
        id: 'callback-uncomplete',
        data: 'uncomplete:list:1:0',
        message: { message_id: 50, chat: { id: 123 } },
      },
    });

    assert.equal((await context.database.completedTasks()).length, 0);
    assert.equal((await context.database.currentTasks()).length, 1);
    const refreshedCall = context.telegram.calls.at(-1);
    assert.match(refreshedCall.args[0], /Виконані домашні завдання/);
    assert.match(refreshedCall.args[0], /Поки що немає виконаних завдань/);
    assert.doesNotMatch(refreshedCall.args[0], /Виконане завдання/);
  } finally {
    await context.database.close();
  }
});

test('Telegram bot ignores updates from a different chat', async () => {
  const context = await createBotContext();

  try {
    await context.bot.handleUpdate({
      message: { chat: { id: 999 }, text: '/start' },
    });
    assert.equal(context.telegram.calls.length, 0);
  } finally {
    await context.database.close();
  }
});

test('Telegram help shows both providers and a button back to the menu', async () => {
  const context = await createBotContext();

  try {
    await context.bot.handleUpdate({
      message: { chat: { id: 123 }, text: '/help' },
    });
    const helpCall = context.telegram.calls[0];
    assert.equal(helpCall.method, 'send');
    assert.match(helpCall.args[0], /\/current/);
    assert.match(helpCall.args[0], /\/completed/);
    assert.match(helpCall.args[0], /Єдиній школі або Google Classroom/);
    assert.doesNotMatch(helpCall.args[0], /У картці завдання/);
    assert.equal(helpCall.args[1].replyMarkup.inline_keyboard[0][0].text, '↩️ До меню');
    assert.equal(helpCall.args[1].replyMarkup.inline_keyboard[0][0].callback_data, 'menu:main');

    await context.bot.handleUpdate({
      callback_query: {
        id: 'callback-help',
        data: 'menu:help',
        message: { message_id: 50, chat: { id: 123 } },
      },
    });
    const helpEditCall = context.telegram.calls.at(-1);
    assert.equal(helpEditCall.method, 'edit');
    assert.equal(helpEditCall.args[1].replyMarkup.inline_keyboard[0][0].callback_data, 'menu:main');
  } finally {
    await context.database.close();
  }
});

test('Telegram menu stores a validated Classroom account order and reflects it in the menu', async () => {
  const context = await createBotContext();

  try {
    await context.bot.handleUpdate({
      message: { chat: { id: 123 }, text: '/start' },
    });
    const initialMenu = context.telegram.calls.at(-1);
    assert.equal(
      initialMenu.args[0],
      '📚 HomeworkParser\n\nОберіть розділ або скористайтеся командами нижче:',
    );
    assert.equal(
      initialMenu.args[1].replyMarkup.inline_keyboard[2][0].text,
      '🔗 Акаунт Classroom: не задано',
    );

    await context.bot.handleUpdate({
      callback_query: {
        id: 'callback-classroom-authuser',
        data: 'menu:classroom-authuser',
        message: { message_id: 50, chat: { id: 123 } },
      },
    });
    const prompt = context.telegram.calls.at(-1);
    assert.equal(prompt.method, 'edit');
    assert.match(prompt.args[0], /число від 0 до 10/);
    assert.equal(await context.database.getMeta(CLASSROOM_AUTHUSER_META_KEY), null);

    await context.bot.handleUpdate({
      message: { chat: { id: 123 }, text: '11' },
    });
    assert.match(context.telegram.calls.at(-1).args[0], /від 0 до 10/);
    assert.equal(await context.database.getMeta(CLASSROOM_AUTHUSER_META_KEY), null);

    await context.bot.handleUpdate({
      message: { chat: { id: 123 }, text: '10' },
    });
    assert.equal(await context.database.getMeta(CLASSROOM_AUTHUSER_META_KEY), '10');
    const confirmation = context.telegram.calls.at(-1);
    assert.equal(confirmation.method, 'send');
    assert.match(confirmation.args[0], /збережено: 10/);
    assert.equal(
      confirmation.args[1].replyMarkup.inline_keyboard[2][0].text,
      '🔗 Акаунт Classroom: 10',
    );
  } finally {
    await context.database.close();
  }
});

test('expired callback queries do not fail update processing', async () => {
  const context = await createBotContext();
  context.telegram.answerCallbackQuery = async () => {
    const error = new Error('Telegram answerCallbackQuery failed: query is too old');
    error.status = 400;
    throw error;
  };

  try {
    await context.bot.handleUpdate({
      callback_query: {
        id: 'expired-callback',
        data: 'menu:current',
        message: { message_id: 50, chat: { id: 123 } },
      },
    });
    assert.equal(context.telegram.calls.some((call) => call.method === 'edit'), true);
  } finally {
    await context.database.close();
  }
});

test('bot startup registers commands and enables the Telegram Menu button', async () => {
  const { database } = await createTestDatabase();
  const calls = [];
  let bot;
  const telegram = {
    async getMe() {
      calls.push('getMe');
      return { username: 'homeworkparserbot' };
    },
    async deleteWebhook() {
      calls.push('deleteWebhook');
      return true;
    },
    async setMyCommands(commands) {
      calls.push({ method: 'setMyCommands', commands });
      return true;
    },
    async setChatMenuButton(options) {
      calls.push({ method: 'setChatMenuButton', options });
      return true;
    },
    async getUpdates() {
      bot.stop();
      return [];
    },
  };

  bot = createTelegramBot({
    auth: {},
    telegram,
    database,
    allowedChatId: '123',
    syncFn: async () => ({ baselineInitialized: true }),
    logger: () => {},
  });

  try {
    await bot.start();
    assert.deepEqual(calls.slice(0, 2), ['getMe', 'deleteWebhook']);
    assert.equal(calls.some((call) => call.method === 'setMyCommands'), true);
    const menuCall = calls.find((call) => call.method === 'setChatMenuButton');
    assert.deepEqual(menuCall.options.menuButton, { type: 'commands' });
    assert.ok(menuCall.options.signal instanceof AbortSignal);
  } finally {
    await database.close();
  }
});

test('stop requested during startup prevents later setup and initial sync', async () => {
  const { database } = await createTestDatabase();
  const calls = [];
  let releaseGetMe;
  let getMeStarted;
  const getMeGate = new Promise((resolve) => {
    releaseGetMe = resolve;
  });
  const getMeStartedGate = new Promise((resolve) => {
    getMeStarted = resolve;
  });
  let syncCalls = 0;
  const telegram = {
    async getMe() {
      calls.push('getMe');
      getMeStarted();
      await getMeGate;
      return {};
    },
    async deleteWebhook() {
      calls.push('deleteWebhook');
      return true;
    },
    async getUpdates() {
      calls.push('getUpdates');
      return [];
    },
  };
  const bot = createTelegramBot({
    auth: {},
    telegram,
    database,
    allowedChatId: '123',
    syncFn: async () => {
      syncCalls += 1;
      return {};
    },
    logger: () => {},
  });

  try {
    const startPromise = bot.start();
    await getMeStartedGate;
    bot.stop();
    releaseGetMe();
    await startPromise;
    assert.deepEqual(calls, ['getMe']);
    assert.equal(syncCalls, 0);
    assert.equal(bot.isRunning(), false);
  } finally {
    releaseGetMe();
    bot.stop();
    await database.close();
  }
});

test('startup request cancellation is treated as a graceful stop', async () => {
  const { database } = await createTestDatabase();
  let getMeStarted;
  const started = new Promise((resolve) => {
    getMeStarted = resolve;
  });
  const telegram = {
    async getMe({ signal }) {
      getMeStarted();
      await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('request aborted');
          error.code = 'TELEGRAM_ABORTED';
          reject(error);
        }, { once: true });
      });
    },
    async deleteWebhook() {
      throw new Error('deleteWebhook should not run after cancellation');
    },
  };
  const bot = createTelegramBot({
    auth: {},
    telegram,
    database,
    allowedChatId: '123',
    syncFn: async () => {
      throw new Error('sync should not run after cancellation');
    },
    logger: () => {},
  });

  try {
    const startPromise = bot.start();
    await started;
    bot.stop();
    await assert.doesNotReject(startPromise);
    assert.equal(bot.isRunning(), false);
  } finally {
    bot.stop();
    await database.close();
  }
});

test('stop during startup setup prevents later menu and sync actions', async () => {
  const { database } = await createTestDatabase();
  const calls = [];
  let bot;
  const telegram = {
    async getMe() {
      calls.push('getMe');
      return {};
    },
    async deleteWebhook() {
      calls.push('deleteWebhook');
      return true;
    },
    async setMyCommands() {
      calls.push('setMyCommands');
      bot.stop();
      return true;
    },
    async setChatMenuButton() {
      throw new Error('menu setup should not run after stop');
    },
  };
  bot = createTelegramBot({
    auth: {},
    telegram,
    database,
    allowedChatId: '123',
    syncFn: async () => {
      throw new Error('sync should not run after stop');
    },
    logger: () => {},
  });

  try {
    await bot.start();
    assert.deepEqual(calls, ['getMe', 'deleteWebhook', 'setMyCommands']);
    assert.equal(bot.isRunning(), false);
  } finally {
    bot.stop();
    await database.close();
  }
});

test('bot stop aborts the active sync before closing its lifecycle', async () => {
  const { database } = await createTestDatabase();
  let bot;
  let syncStarted;
  const syncStartedGate = new Promise((resolve) => {
    syncStarted = resolve;
  });
  let signalSeen;
  let releaseSync;
  const telegram = {
    async getMe() {
      return {};
    },
    async deleteWebhook() {
      return true;
    },
    async getUpdates({ signal }) {
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      return [];
    },
  };

  bot = createTelegramBot({
    auth: {},
    telegram,
    database,
    allowedChatId: '123',
    syncFn: async ({ signal }) => {
      signalSeen = signal;
      syncStarted();
      await new Promise((resolve) => {
        releaseSync = resolve;
        signal.addEventListener('abort', resolve, { once: true });
      });
      return {};
    },
    logger: () => {},
  });

  try {
    const startPromise = bot.start();
    await syncStartedGate;
    bot.stop();
    await startPromise;
    assert.ok(signalSeen instanceof AbortSignal);
    assert.equal(signalSeen.aborted, true);
  } finally {
    releaseSync?.();
    bot.stop();
    await database.close();
  }
});

test('bot waits for an active background sync before start resolves', async () => {
  const { database } = await createTestDatabase();
  let bot;
  let syncCalls = 0;
  let resolveSecondSyncStarted;
  const secondSyncStarted = new Promise((resolve) => {
    resolveSecondSyncStarted = resolve;
  });
  let releaseSecondSync;
  const secondSyncGate = new Promise((resolve) => {
    releaseSecondSync = resolve;
  });
  const telegram = {
    async getMe() {
      return {};
    },
    async deleteWebhook() {
      return true;
    },
    async getUpdates({ signal }) {
      return new Promise((resolve) => {
        if (signal?.aborted) {
          resolve([]);
          return;
        }
        signal?.addEventListener('abort', () => resolve([]), { once: true });
      });
    },
  };

  bot = createTelegramBot({
    auth: {},
    telegram,
    database,
    allowedChatId: '123',
    syncIntervalMs: 1,
    syncFn: async () => {
      syncCalls += 1;
      if (syncCalls === 2) {
        resolveSecondSyncStarted();
        bot.stop();
        await secondSyncGate;
      }
      return { baselineInitialized: syncCalls === 1 };
    },
    logger: () => {},
  });

  try {
    const startPromise = bot.start();
    await secondSyncStarted;

    let settled = false;
    startPromise.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);

    releaseSecondSync();
    await startPromise;
  } finally {
    releaseSecondSync();
    bot.stop();
    await database.close();
  }
});
