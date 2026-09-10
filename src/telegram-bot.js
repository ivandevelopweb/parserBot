import {
  createBackToMenuKeyboard,
  createCompleteKeyboard,
  formatHomeworkDetails,
  formatHomeworkList,
  MAIN_MENU_KEYBOARD,
  TELEGRAM_BOT_COMMANDS,
} from './messages.js';
import { syncAllHomeworks } from './bot-sync.js';
import { ConfigError, errorMessage } from './utils.js';

export const HOMEWORK_SYNC_INTERVAL_MS = 10 * 60 * 1000;
export const TELEGRAM_POLL_TIMEOUT_SECONDS = 25;
const MAX_POLL_BACKOFF_MS = 30 * 1000;

const MENU_TEXT = '📚 Єдина школа\n\nОберіть розділ або скористайтеся командами нижче:';

export const HELP_TEXT = `ℹ️ Довідка

/start або /menu — відкрити головне меню
/current — показати поточні завдання
/completed — показати виконані завдання
/help — показати цю довідку

У списку назва кожного завдання є посиланням на нього в Єдиній школі.
Кнопка ✅ під списком позначає відповідне завдання виконаним.
У списку виконаних завдань кнопка ❌ повертає завдання до поточних.
У картці завдання натисніть «✅ Позначити виконаним», коли завершите його.`;

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

export function createTelegramBot({
  auth,
  telegram,
  database,
  classroom = null,
  allowedChatId = process.env.TELEGRAM_CHAT_ID,
  syncFn = syncAllHomeworks,
  logger = console.log,
  syncIntervalMs = HOMEWORK_SYNC_INTERVAL_MS,
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
  let stopped = true;
  let running = false;
  let syncInProgress = false;
  let syncTimer = null;
  let pollAbortController = null;
  let activeSyncPromise = null;
  let stopRequested = false;

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
        return await syncFn({
          auth,
          database,
          telegram,
          classroom,
          logger,
          now: nowProvider(),
        });
      } catch (error) {
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

  async function sendMenu() {
    return telegram.sendTelegramMessage(MENU_TEXT, {
      replyMarkup: MAIN_MENU_KEYBOARD,
    });
  }

  async function showList({ completed = false, page = 0, messageId = null } = {}) {
    const tasks = completed ? database.completedTasks() : database.currentTasks();
    const view = formatHomeworkList(tasks, { completed, page });
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
      await sendMenu();
    } else if (command === '/current') {
      await showList();
    } else if (command === '/completed') {
      await showList({ completed: true });
    } else if (command === '/help') {
      await telegram.sendTelegramMessage(HELP_TEXT, {
        replyMarkup: MAIN_MENU_KEYBOARD,
      });
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
        await answerCallback(callbackQuery);
        await telegram.editTelegramMessage(MENU_TEXT, {
          messageId,
          replyMarkup: MAIN_MENU_KEYBOARD,
        });
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
          replyMarkup: MAIN_MENU_KEYBOARD,
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
        const completed = database.completeTask(parseInteger(complete[1]), nowProvider());
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
        };
        if (completed.source === 'classroom' || completed.snapshot?.source === 'classroom') {
          detailOptions.parseMode = 'HTML';
        }
        await telegram.editTelegramMessage(
          formatHomeworkDetails(completed, { completed: true }),
          detailOptions,
        );
        return;
      }

      const listUncomplete = /^uncomplete:list:(\d+):(\d+)$/.exec(data);
      if (listUncomplete) {
        const restored = database.uncompleteTask(
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
        const restored = database.uncompleteTask(
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
        const completed = database.completeTask(parseInteger(listComplete[1]), nowProvider());
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
    let offset = parseInteger(database.getMeta('telegram_update_offset'));
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
            database.setMeta('telegram_update_offset', offset);
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

    running = true;
    stopRequested = false;
    stopped = false;
    pollAbortController = new AbortController();

    try {
      const botUser = await telegram.getMe();
      if (botUser?.username) {
        logger(`[bot] Connected as @${botUser.username}`);
      } else {
        logger('[bot] Telegram connection established');
      }
      await telegram.deleteWebhook({ dropPendingUpdates: false });
      if (typeof telegram.setMyCommands === 'function') {
        try {
          await telegram.setMyCommands(TELEGRAM_BOT_COMMANDS);
          logger('[bot] Telegram commands registered');
        } catch (error) {
          logger(`[bot] Could not register Telegram commands: ${errorMessage(error)}`);
        }
      }
      if (typeof telegram.setChatMenuButton === 'function') {
        try {
          await telegram.setChatMenuButton({ menuButton: { type: 'commands' } });
          logger('[bot] Telegram Menu button enabled');
        } catch (error) {
          logger(`[bot] Could not enable the Telegram command menu: ${errorMessage(error)}`);
        }
      }

      // The first parse happens immediately after auth and Bot API setup.
      await runSync({ throwOnError: true });
      syncTimer = setInterval(() => {
        void runSync();
      }, syncIntervalMs);

      logger(`[bot] Homework sync interval: ${Math.round(syncIntervalMs / 60000)} minutes`);
      await pollLoop();
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
  };
}
