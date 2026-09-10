import test from 'node:test';
import assert from 'node:assert/strict';

import { createTelegramClient } from '../src/telegram.js';

test('sendTelegramMessage calls Telegram Bot API and returns result', async () => {
  const calls = [];
  const client = createTelegramClient({
    token: 'test-token-that-must-not-be-logged',
    chatId: '12345',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), {
        status: 200,
      });
    },
  });

  const result = await client.sendTelegramMessage('hello');
  assert.equal(result.message_id, 7);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/sendMessage$/);
  assert.deepEqual(JSON.parse(calls[0].options.body), { chat_id: '12345', text: 'hello' });
  assert.ok(calls[0].options.signal instanceof AbortSignal);
});

test('Telegram request combines caller cancellation with its own deadline', async () => {
  const externalController = new AbortController();
  let requestSignal;
  const client = createTelegramClient({
    token: 'test-token',
    chatId: '12345',
    timeoutMs: 20,
    fetchImpl: async (_url, { signal }) => {
      requestSignal = signal;
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
  });

  const request = client.getUpdates({
    offset: 1,
    timeoutSeconds: 1,
    requestTimeoutMs: 20,
    signal: externalController.signal,
  });
  try {
    await assert.rejects(
      Promise.race([
        request,
        new Promise((_, reject) => setTimeout(() => reject(new Error('deadline missing')), 80)),
      ]),
      (error) => error.code === 'TELEGRAM_TIMEOUT',
    );
    assert.notEqual(requestSignal, externalController.signal);
    assert.equal(requestSignal.aborted, true);
    assert.equal(externalController.signal.aborted, false);
  } finally {
    externalController.abort();
    await request.catch(() => {});
  }
});

test('Telegram network errors do not retain token-bearing URL causes', async () => {
  const marker = 'TELEGRAM_URL_SECRET_MARKER';
  const client = createTelegramClient({
    token: 'test-token',
    chatId: '12345',
    fetchImpl: async (url) => {
      throw new Error(`fetch failed for ${url}?marker=${marker}`);
    },
  });

  await assert.rejects(
    client.sendTelegramMessage('hello'),
    (error) => error.code === 'TELEGRAM_NETWORK_ERROR'
      && !error.message.includes(marker)
      && !error.cause,
  );
});

test('Telegram 429 is logged and returned as a bounded error', async () => {
  const logs = [];
  const client = createTelegramClient({
    token: 'secret-token',
    chatId: '12345',
    logger: (message) => logs.push(message),
    fetchImpl: async () => new Response(JSON.stringify({
      ok: false,
      description: 'Too Many Requests',
      parameters: { retry_after: 12 },
    }), { status: 429, statusText: 'Too Many Requests' }),
  });

  await assert.rejects(
    () => client.sendTelegramMessage('hello'),
    (error) => error.code === 'TELEGRAM_RATE_LIMIT' && error.retryAfter === 12,
  );
  assert.match(logs[0], /HTTP 429/);
  assert.match(logs[0], /retry_after=12s/);
  assert.doesNotMatch(logs.join('\n'), /secret-token/);
});

test('Telegram client sends inline keyboards and supports callback updates', async () => {
  const calls = [];
  const client = createTelegramClient({
    token: 'secret-token',
    chatId: '12345',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const method = String(url).split('/').at(-1);
      const result = method === 'getUpdates'
        ? [{ update_id: 9, message: { text: '/start' } }]
        : true;
      return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    },
  });

  await client.sendTelegramMessage('task', {
    replyMarkup: { inline_keyboard: [[{ text: 'done', callback_data: 'complete:1' }]] },
  });
  await client.answerCallbackQuery('callback-1', { text: 'ok' });
  await client.editTelegramMessage('updated', {
    messageId: 7,
    replyMarkup: { inline_keyboard: [] },
  });
  const updates = await client.getUpdates({ offset: 8, timeoutSeconds: 1 });

  assert.equal(updates[0].update_id, 9);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    chat_id: '12345',
    text: 'task',
    reply_markup: { inline_keyboard: [[{ text: 'done', callback_data: 'complete:1' }]] },
  });
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    callback_query_id: 'callback-1',
    text: 'ok',
  });
  assert.deepEqual(JSON.parse(calls[2].options.body), {
    chat_id: '12345',
    message_id: 7,
    text: 'updated',
    reply_markup: { inline_keyboard: [] },
  });
  assert.deepEqual(JSON.parse(calls[3].options.body), {
    timeout: 1,
    allowed_updates: ['message', 'callback_query'],
    offset: 8,
  });
});

test('Telegram client can register the bot command menu', async () => {
  let request;
  const client = createTelegramClient({
    token: 'secret-token',
    chatId: '12345',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    },
  });

  await client.setMyCommands([
    { command: 'help', description: 'Показати довідку' },
  ]);

  assert.match(request.url, /\/setMyCommands$/);
  assert.deepEqual(JSON.parse(request.options.body), {
    commands: [{ command: 'help', description: 'Показати довідку' }],
  });
});

test('Telegram client supports HTML inline links', async () => {
  let request;
  const client = createTelegramClient({
    token: 'secret-token',
    chatId: '12345',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    },
  });

  await client.sendTelegramMessage(
    '• Алгебра — <a href="https://diary.eschool-ua.com/homework/101166">Єдина школа</a>',
    { parseMode: 'HTML' },
  );

  assert.equal(JSON.parse(request.options.body).parse_mode, 'HTML');
});

test('Telegram client enables the standard commands menu for the configured chat', async () => {
  let request;
  const client = createTelegramClient({
    token: 'secret-token',
    chatId: '12345',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    },
  });

  await client.setChatMenuButton();

  assert.match(request.url, /\/setChatMenuButton$/);
  assert.deepEqual(JSON.parse(request.options.body), {
    chat_id: '12345',
    menu_button: { type: 'commands' },
  });
});
