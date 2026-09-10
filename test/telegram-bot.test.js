import test from 'node:test';
import assert from 'node:assert/strict';

import { createHomeworkDatabase } from '../src/homework-db.js';
import { createTelegramBot } from '../src/telegram-bot.js';

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

function createBotContext() {
  const database = createHomeworkDatabase({ filePath: ':memory:' });
  database.saveBaseline([{
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
  const context = createBotContext();

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

    assert.equal(context.database.currentTasks().length, 0);
    assert.equal(context.database.completedTasks().length, 1);
    const refreshedCall = context.telegram.calls.at(-1);
    assert.match(refreshedCall.args[0], /Наразі немає невиконаних завдань/);
    assert.equal(refreshedCall.args[1].replyMarkup.inline_keyboard[0][0].callback_data, 'menu:main');
  } finally {
    context.database.close();
  }
});

test('Telegram bot keeps the current list page when marking a task completed', async () => {
  const database = createHomeworkDatabase({ filePath: ':memory:' });
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
  database.saveBaseline(tasks, '2026-09-09T12:00:00.000Z');
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
    assert.equal(database.currentTasks().length, 7);
    assert.equal(database.completedTasks().length, 1);
  } finally {
    database.close();
  }
});

test('completed list uses a cross to restore a task and refreshes the same list', async () => {
  const context = createBotContext();
  context.database.completeTask(1, '2026-09-09T12:00:00.000Z');

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

    assert.equal(context.database.completedTasks().length, 0);
    assert.equal(context.database.currentTasks().length, 1);
    const refreshedCall = context.telegram.calls.at(-1);
    assert.match(refreshedCall.args[0], /Виконані домашні завдання/);
    assert.match(refreshedCall.args[0], /Поки що немає виконаних завдань/);
    assert.doesNotMatch(refreshedCall.args[0], /Виконане завдання/);
  } finally {
    context.database.close();
  }
});

test('Telegram bot ignores updates from a different chat', async () => {
  const context = createBotContext();

  try {
    await context.bot.handleUpdate({
      message: { chat: { id: 999 }, text: '/start' },
    });
    assert.equal(context.telegram.calls.length, 0);
  } finally {
    context.database.close();
  }
});

test('Telegram bot exposes a help command and help menu button', async () => {
  const context = createBotContext();

  try {
    await context.bot.handleUpdate({
      message: { chat: { id: 123 }, text: '/help' },
    });
    const helpCall = context.telegram.calls[0];
    assert.equal(helpCall.method, 'send');
    assert.match(helpCall.args[0], /\/current/);
    assert.match(helpCall.args[0], /\/completed/);
    assert.equal(helpCall.args[1].replyMarkup.inline_keyboard.at(-1)[0].callback_data, 'menu:help');
  } finally {
    context.database.close();
  }
});

test('expired callback queries do not fail update processing', async () => {
  const context = createBotContext();
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
    context.database.close();
  }
});

test('bot startup registers commands and enables the Telegram Menu button', async () => {
  const database = createHomeworkDatabase({ filePath: ':memory:' });
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
    assert.deepEqual(
      calls.find((call) => call.method === 'setChatMenuButton').options,
      { menuButton: { type: 'commands' } },
    );
  } finally {
    database.close();
  }
});

test('bot waits for an active background sync before start resolves', async () => {
  const database = createHomeworkDatabase({ filePath: ':memory:' });
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
    database.close();
  }
});
