import {
  createBackToMenuKeyboard,
  createCompleteKeyboard,
  formatHomeworkDetails,
  formatHomeworkList,
  createMainMenuKeyboard,
  TELEGRAM_BOT_COMMANDS,
} from './messages.js';
import { syncAllHomeworks } from './bot-sync.js';
import {
  CLASSROOM_AUTHUSER_META_KEY,
  parseClassroomAuthuserIndex,
} from './classroom-url.js';
import { ConfigError, errorMessage } from './utils.js';

export const HOMEWORK_SYNC_INTERVAL_MS = 10 * 60 * 1000;
export const DEFAULT_HOMEWORK_SYNC_INTERVAL_MINUTES = 10;
export const RENDER_HOMEWORK_SYNC_INTERVAL_MINUTES = 20;
export const MIN_HOMEWORK_SYNC_INTERVAL_MINUTES = 5;
export const MAX_HOMEWORK_SYNC_INTERVAL_MINUTES = 60;
export const TELEGRAM_POLL_TIMEOUT_SECONDS = 25;
const MAX_POLL_BACKOFF_MS = 30 * 1000;

const MENU_TEXT = '📚 HomeworkParser\n\nОберіть розділ або скористайтеся командами нижче:';

export const HELP_TEXT = `ℹ️ Довідка

/start або /menu — відкрити головне меню
/current — показати поточні завдання
/completed — показати виконані завдання
/help — показати цю довідку

У списку назва кожного завдання є посиланням на нього в Єдиній школі або Google Classroom.
Кнопка ✅ під списком позначає відповідне завдання виконаним.
У списку виконаних завдань кнопка ❌ повертає завдання до поточних.`;

function sleep(milliseconds, signal) {
  return new Promise((resolveSleep) => {
    const timer = setTimeout(resolveSleep, milliseconds);
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolveSleep();
      }, { once: true });
    }
  });
}

function parseInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function parseHomeworkSyncIntervalMinutes(
  value = process.env.HOMEWORK_SYNC_INTERVAL_MINUTES,
) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return DEFAULT_HOMEWORK_SYNC_INTERVAL_MINUTES;
  }
  const text = String(value).trim();
  if (!/^\d+$/u.test(text)) {
    throw new ConfigError(
      `HOMEWORK_SYNC_INTERVAL_MINUTES must be an integer from ${MIN_HOMEWORK_SYNC_INTERVAL_MINUTES} to ${MAX_HOMEWORK_SYNC_INTERVAL_MINUTES}`,
    );
  }
  const minutes = Number(text);
  if (!Number.isSafeInteger(minutes)
    || minutes < MIN_HOMEWORK_SYNC_INTERVAL_MINUTES
    || minutes > MAX_HOMEWORK_SYNC_INTERVAL_MINUTES) {
    throw new ConfigError(
      `HOMEWORK_SYNC_INTERVAL_MINUTES must be an integer from ${MIN_HOMEWORK_SYNC_INTERVAL_MINUTES} to ${MAX_HOMEWORK_SYNC_INTERVAL_MINUTES}`,
    );
  }
  return minutes;
}

export function getSyncStaleAfterMs(syncIntervalMs) {
  return Math.max(30 * 60 * 1000, Number(syncIntervalMs) * 2 + 5 * 60 * 1000);
}

function isConfiguredChat(chatId, allowedChatId) {
  return chatId !== undefined
    && chatId !== null
    && String(chatId) === String(allowedChatId);
}

function getMessageChatId(message) {
  return message?.chat?.id ?? null;
}

function getCallbackMessage(callbackQuery) {
  return callbackQuery?.message ?? null;
}

function isStaleCallbackError(error) {
  return Number(error?.status) === 400
    && /query is too old|query id is invalid/i.test(errorMessage(error));
}

function isPermanentTelegramUpdateError(error) {
  const status = Number(error?.status);
  return status >= 400 && status < 500 && status !== 429;
}

function isCancellationError(error) {
  return error?.name === 'AbortError'
    || error?.code === 'TELEGRAM_ABORTED'
    || error?.code === 'CLASSROOM_ABORTED';
}

export function createTelegramBot({
  auth,
  telegram,
  database,
  classroom = null,
  allowedChatId = process.env.TELEGRAM_CHAT_ID,
  syncFn = syncAllHomeworks,
  logger = console.log,
  syncIntervalMs = undefined,
  pollTimeoutSeconds = TELEGRAM_POLL_TIMEOUT_SECONDS,
  now = () => new Date(),
} = {}) {
  if (!auth) {
    throw new ConfigError('Telegram bot requires an e-school auth client');
  }
  if (!telegram) {
    throw new ConfigError('Telegram bot requires a Telegram client');
  }
  if (!database) {
    throw new ConfigError('Telegram bot requires a homework database');
  }
  if (!allowedChatId) {
    throw new ConfigError('Telegram bot requires TELEGRAM_CHAT_ID');
  }
  if (typeof syncFn !== 'function') {
    throw new ConfigError('Telegram bot requires a sync function');
  }

  const nowProvider = typeof now === 'function' ? now : () => new Date(now);
  const effectiveSyncIntervalMs = syncIntervalMs === undefined
    ? parseHomeworkSyncIntervalMinutes() * 60 * 1000
    : syncIntervalMs;
  const syncStaleAfterMs = getSyncStaleAfterMs(effectiveSyncIntervalMs);
  let stopped = true;
  let running = false;
  let syncInProgress = false;
  let syncTimer = null;
  let pollAbortController = null;
  let activeSyncPromise = null;
  let stopRequested = false;
  let awaitingClassroomAuthuser = false;
  const syncDiagnostics = new Map();

  function refreshSyncDiagnostics(result) {
    const providers = Array.isArray(result?.providers)
      ? result.providers
      : result?.source
        ? [result]
        : [];
    for (const provider of providers) {
      if (!provider?.source) continue;
      const current = syncDiagnostics.get(provider.source) ?? {};
      syncDiagnostics.set(provider.source, {
        ...current,
        status: provider.status ?? current.status ?? 'unknown',
        stage: provider.stage ?? current.stage ?? null,
        attemptedAt: provider.attemptedAt ?? current.attemptedAt ?? null,
        lastSuccessAt: provider.lastSuccessAt ?? current.lastSuccessAt ?? null,
        taskCount: provider.taskCount ?? current.taskCount ?? null,
        metrics: provider.metrics ?? current.metrics ?? null,
      });
    }
  }

  function getSyncDiagnostics() {
    const result = {};
    for (const source of ['eschool', 'classroom']) {
      const state = syncDiagnostics.get(source) ?? {
        status: 'unknown',
        stage: null,
        attemptedAt: null,
        lastSuccessAt: null,
        taskCount: null,
        metrics: null,
      };
      const lastSuccessTime = state.lastSuccessAt
        ? Date.parse(state.lastSuccessAt)
        : Number.NaN;
      const stale = state.status === 'skipped'
        ? false
        : !Number.isFinite(lastSuccessTime)
          || Date.now() - lastSuccessTime > syncStaleAfterMs;
      result[source] = { ...state, stale };
    }
    return result;
  }

  async function runSync({ throwOnError = false } = {}) {
    if (stopRequested) {
      logger('[bot] Sync is stopped; skipping cycle');
      return null;
    }
    if (syncInProgress) {
      logger('[bot] Sync is already running; skipping overlapping cycle');
      return null;
    }

    syncInProgress = true;
    const syncPromise = (async () => {
      try {
        const result = await syncFn({
          auth,
          database,
          telegram,
          classroom,
          logger,
          now: nowProvider(),
          signal: pollAbortController?.signal,
        });
        refreshSyncDiagnostics(result);
        return result;
      } catch (error) {
        if (stopRequested && isCancellationError(error)) {
          return null;
        }
        logger(`[bot] Sync failed: ${errorMessage(error)}`);
        if (throwOnError) {
          throw error;
        }
        return null;
      } finally {
        syncInProgress = false;
      }
    })();
    activeSyncPromise = syncPromise;
    try {
      return await syncPromise;
    } finally {
      if (activeSyncPromise === syncPromise) {
        activeSyncPromise = null;
      }
    }
  }

  async function getClassroomAuthuserIndex() {
    if (typeof database.getMeta !== 'function') {
      return null;
    }
    return parseClassroomAuthuserIndex(
      await database.getMeta(CLASSROOM_AUTHUSER_META_KEY),
    );
  }

  async function getMainMenuKeyboard() {
    return createMainMenuKeyboard({
      classroomAuthuserIndex: await getClassroomAuthuserIndex(),
    });
  }

  async function sendMenu() {
    return telegram.sendTelegramMessage(MENU_TEXT, {
      replyMarkup: await getMainMenuKeyboard(),
    });
  }

  async function showList({ completed = false, page = 0, messageId = null } = {}) {
    const tasks = completed ? await database.completedTasks() : await database.currentTasks();
    const view = formatHomeworkList(tasks, {
      completed,
      page,
      classroomAuthuserIndex: await getClassroomAuthuserIndex(),
    });
    const options = {};

    if (view.parseMode !== undefined) {
      options.parseMode = view.parseMode;
    }

    if (messageId !== null && messageId !== undefined) {
      // Explicitly clear the menu/task keyboard when replacing it with the
      // link-only list. Omitting reply_markup can leave an old keyboard visible.
      options.replyMarkup = view.keyboard ?? { inline_keyboard: [] };
      return telegram.editTelegramMessage(view.text, {
        messageId,
        ...options,
      });
    }

    if (view.keyboard !== null && view.keyboard !== undefined) {
      options.replyMarkup = view.keyboard;
    }
    return telegram.sendTelegramMessage(view.text, options);
  }

  async function showClassroomAuthuserPrompt({ messageId = null } = {}) {
    const currentIndex = await getClassroomAuthuserIndex();
    const currentLabel = currentIndex === null ? 'не задано' : String(currentIndex);
    const text = [
      '🔗 Порядок акаунта Google Classroom',
      '',
      `Поточне значення: ${currentLabel}`,
      '',
      'Надішліть одним повідомленням число від 0 до 10.',
      '0 — перший акаунт Google, 1 — другий і так далі.',
    ].join('\n');
    const options = { replyMarkup: createBackToMenuKeyboard() };

    if (messageId !== null && messageId !== undefined) {
      await telegram.editTelegramMessage(text, {
        messageId,
        ...options,
      });
    } else {
      await telegram.sendTelegramMessage(text, options);
    }
    awaitingClassroomAuthuser = true;
  }

  async function handleClassroomAuthuserInput(message) {
    const index = parseClassroomAuthuserIndex(message.text);
    if (index === null) {
      await telegram.sendTelegramMessage(
        'Введіть ціле число від 0 до 10. Або натисніть «До меню», щоб скасувати.',
        { replyMarkup: createBackToMenuKeyboard() },
      );
      return;
    }

    await database.setMeta(CLASSROOM_AUTHUSER_META_KEY, index);
    awaitingClassroomAuthuser = false;
    await telegram.sendTelegramMessage(
      `✅ Порядок акаунта Classroom збережено: ${index}`,
      { replyMarkup: await getMainMenuKeyboard() },
    );
  }

  async function handleMessage(message) {
    if (!isConfiguredChat(getMessageChatId(message), allowedChatId)) {
      return;
    }

    const command = String(message.text ?? '')
      .trim()
      .split(/\s+/, 1)[0]
      .toLowerCase()
      .replace(/@[^@]+$/, '');
    if (['/start', '/menu'].includes(command)) {
      awaitingClassroomAuthuser = false;
      await sendMenu();
    } else if (command === '/current') {
      awaitingClassroomAuthuser = false;
      await showList();
    } else if (command === '/completed') {
      awaitingClassroomAuthuser = false;
      await showList({ completed: true });
    } else if (command === '/help') {
      awaitingClassroomAuthuser = false;
      await telegram.sendTelegramMessage(HELP_TEXT, {
        replyMarkup: createBackToMenuKeyboard(),
      });
    } else if (awaitingClassroomAuthuser) {
      await handleClassroomAuthuserInput(message);
    }
  }

  async function answerCallback(callbackQuery, options = {}) {
    if (callbackQuery?.id) {
      try {
        await telegram.answerCallbackQuery(callbackQuery.id, options);
      } catch (error) {
        if (isStaleCallbackError(error)) {
          logger('[bot] Ignoring an expired Telegram callback query');
          return;
        }
        throw error;
      }
    }
  }

  async function handleCallback(callbackQuery) {
    const message = getCallbackMessage(callbackQuery);
    if (!message || !isConfiguredChat(getMessageChatId(message), allowedChatId)) {
      return;
    }

    const data = String(callbackQuery.data ?? '');
    const messageId = message.message_id;

    if (data === 'noop') {
      await answerCallback(callbackQuery);
      return;
    }

    try {
      if (data === 'menu:main') {
        awaitingClassroomAuthuser = false;
        await answerCallback(callbackQuery);
        await telegram.editTelegramMessage(MENU_TEXT, {
          messageId,
          replyMarkup: await getMainMenuKeyboard(),
        });
        return;
      }

      if (data === 'menu:classroom-authuser') {
        await answerCallback(callbackQuery);
        await showClassroomAuthuserPrompt({ messageId });
        return;
      }

      if (data === 'menu:current') {
        await answerCallback(callbackQuery);
        await showList({ messageId });
        return;
      }

      if (data === 'menu:completed') {
        await answerCallback(callbackQuery);
        await showList({ completed: true, messageId });
        return;
      }

      if (data === 'menu:help') {
        await answerCallback(callbackQuery);
        await telegram.editTelegramMessage(HELP_TEXT, {
          messageId,
          replyMarkup: createBackToMenuKeyboard(),
        });
        return;
      }

      const currentPage = /^task:page:(\d+)$/.exec(data);
      if (currentPage) {
        await answerCallback(callbackQuery);
        await showList({ page: parseInteger(currentPage[1]), messageId });
        return;
      }

      const currentListPage = /^current:page:(\d+)$/.exec(data);
      if (currentListPage) {
        await answerCallback(callbackQuery);
        await showList({ page: parseInteger(currentListPage[1]), messageId });
        return;
      }

      const completedPage = /^completed:page:(\d+)$/.exec(data);
      if (completedPage) {
        await answerCallback(callbackQuery);
        await showList({
          completed: true,
          page: parseInteger(completedPage[1]),
          messageId,
        });
        return;
      }

      const complete = /^complete:(\d+)$/.exec(data);
      if (complete) {
        const completed = await database.completeTask(parseInteger(complete[1]), nowProvider());
        if (!completed) {
          await answerCallback(callbackQuery, {
            text: 'Завдання вже недоступне.',
            showAlert: true,
          });
          return;
        }

        await answerCallback(callbackQuery, { text: 'Завдання позначено виконаним.' });
        const detailOptions = {
          messageId,
          replyMarkup: createBackToMenuKeyboard(),
          classroomAuthuserIndex: await getClassroomAuthuserIndex(),
        };
        if (completed.source === 'classroom' || completed.snapshot?.source === 'classroom') {
          detailOptions.parseMode = 'HTML';
        }
        await telegram.editTelegramMessage(
          formatHomeworkDetails(completed, detailOptions),
          detailOptions,
        );
        return;
      }

      const listUncomplete = /^uncomplete:list:(\d+):(\d+)$/.exec(data);
      if (listUncomplete) {
        const restored = await database.uncompleteTask(
          parseInteger(listUncomplete[1]),
          nowProvider(),
        );
        if (!restored) {
          await answerCallback(callbackQuery, {
            text: 'Завдання вже недоступне.',
            showAlert: true,
          });
          return;
        }

        await answerCallback(callbackQuery, { text: 'Завдання повернуто до поточних.' });
        await showList({
          completed: true,
          page: parseInteger(listUncomplete[2]),
          messageId,
        });
        return;
      }

      // Old completed-list buttons used this callback to open a detail card.
      // Treat them as restore actions so the removed detail interface cannot
      // be reached from stale Telegram messages.
      const legacyCompleted = /^completed:(\d+)$/.exec(data);
      if (legacyCompleted) {
        const restored = await database.uncompleteTask(
          parseInteger(legacyCompleted[1]),
          nowProvider(),
        );
        if (!restored) {
          await answerCallback(callbackQuery, {
            text: 'Завдання вже недоступне.',
            showAlert: true,
          });
          return;
        }

        await answerCallback(callbackQuery, { text: 'Завдання повернуто до поточних.' });
        await showList({ completed: true, page: 0, messageId });
      }

      const listComplete = /^complete:list:(\d+):(\d+)$/.exec(data);
      if (listComplete) {
        const completed = await database.completeTask(parseInteger(listComplete[1]), nowProvider());
        if (!completed) {
          await answerCallback(callbackQuery, {
            text: 'Завдання вже недоступне.',
            showAlert: true,
          });
          return;
        }

        await answerCallback(callbackQuery, { text: 'Завдання позначено виконаним.' });
        await showList({
          page: parseInteger(listComplete[2]),
          messageId,
        });
      }
    } catch (error) {
      logger(`[bot] Callback failed: ${errorMessage(error)}`);
      await answerCallback(callbackQuery, {
        text: 'Не вдалося виконати дію. Спробуйте ще раз.',
        showAlert: true,
      });
    }
  }

  async function handleUpdate(update) {
    if (update?.message) {
      await handleMessage(update.message);
      return;
    }
    if (update?.callback_query) {
      await handleCallback(update.callback_query);
    }
  }

  async function pollLoop() {
    let offset = parseInteger(await database.getMeta('telegram_update_offset'));
    let backoffMs = 1000;

    while (!stopped) {
      try {
        const updates = await telegram.getUpdates({
          offset: offset ?? undefined,
          timeoutSeconds: pollTimeoutSeconds,
          signal: pollAbortController.signal,
        });

        backoffMs = 1000;
        for (const update of Array.isArray(updates) ? updates : []) {
          if (stopped) {
            break;
          }

          try {
            await handleUpdate(update);
          } catch (error) {
            if (!isPermanentTelegramUpdateError(error)) {
              throw error;
            }
            logger(`[bot] Ignoring an invalid Telegram update: ${errorMessage(error)}`);
          }
          if (Number.isInteger(update?.update_id)) {
            offset = update.update_id + 1;
            await database.setMeta('telegram_update_offset', offset);
          }
        }
      } catch (error) {
        if (stopped || error?.name === 'AbortError') {
          break;
        }

        const retryAfter = Number(error?.retryAfter);
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(MAX_POLL_BACKOFF_MS, retryAfter * 1000)
          : backoffMs;
        logger(`[bot] Telegram polling failed: ${errorMessage(error)}; retrying in ${waitMs}ms`);
        await sleep(waitMs, pollAbortController.signal);
        backoffMs = Math.min(MAX_POLL_BACKOFF_MS, backoffMs * 2);
      }
    }
  }

  async function start() {
    if (running) {
      throw new Error('Telegram bot is already running');
    }
    if (stopRequested) {
      return;
    }

    running = true;
    stopRequested = false;
    stopped = false;
    pollAbortController = new AbortController();

    try {
      const signal = pollAbortController.signal;
      const botUser = await telegram.getMe({ signal });
      if (stopRequested) {
        return;
      }
      if (botUser?.username) {
        logger(`[bot] Connected as @${botUser.username}`);
      } else {
        logger('[bot] Telegram connection established');
      }
      await telegram.deleteWebhook({ dropPendingUpdates: false, signal });
      if (stopRequested) {
        return;
      }
      if (typeof telegram.setMyCommands === 'function') {
        try {
          await telegram.setMyCommands(TELEGRAM_BOT_COMMANDS, { signal });
          logger('[bot] Telegram commands registered');
        } catch (error) {
          logger(`[bot] Could not register Telegram commands: ${errorMessage(error)}`);
        }
      }
      if (stopRequested) {
        return;
      }
      if (typeof telegram.setChatMenuButton === 'function') {
        try {
          await telegram.setChatMenuButton({ menuButton: { type: 'commands' }, signal });
          logger('[bot] Telegram Menu button enabled');
        } catch (error) {
          logger(`[bot] Could not enable the Telegram command menu: ${errorMessage(error)}`);
        }
      }
      if (stopRequested) {
        return;
      }

      // The first parse happens immediately after auth and Bot API setup.
      await runSync({ throwOnError: true });
      if (stopRequested) {
        return;
      }
      syncTimer = setInterval(() => {
        void runSync();
      }, effectiveSyncIntervalMs);

      logger(`[bot] Homework sync interval: ${Math.round(effectiveSyncIntervalMs / 60000)} minutes`);
      await pollLoop();
    } catch (error) {
      if (stopRequested && isCancellationError(error)) {
        return;
      }
      throw error;
    } finally {
      if (syncTimer) {
        clearInterval(syncTimer);
        syncTimer = null;
      }
      const syncToDrain = activeSyncPromise;
      if (syncToDrain) {
        try {
          await syncToDrain;
        } catch {
          // The sync already logged and, for foreground runs, propagated its error.
        }
      }
      pollAbortController = null;
      running = false;
      stopped = true;
      stopRequested = false;
    }
  }

  function stop() {
    stopRequested = true;
    stopped = true;
    if (pollAbortController) {
      pollAbortController.abort();
    }
    if (syncTimer) {
      clearInterval(syncTimer);
      syncTimer = null;
    }
  }

  return {
    handleUpdate,
    runSync,
    start,
    stop,
    isRunning: () => running,
    getDiagnostics: getSyncDiagnostics,
  };
}
