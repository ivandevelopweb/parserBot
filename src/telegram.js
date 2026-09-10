import { ConfigError, SmokeTestError, errorMessage } from './utils.js';

export const TELEGRAM_API_ORIGIN = 'https://api.telegram.org';
export const DEFAULT_TELEGRAM_TIMEOUT_MS = 10000;
export const MAX_TELEGRAM_MESSAGE_LENGTH = 4096;

export class TelegramError extends SmokeTestError {
  constructor(message, { status, retryAfter, code = 'TELEGRAM_ERROR', cause } = {}) {
    super(message, { code, cause });
    this.name = 'TelegramError';
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

function validateMessage(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new TelegramError('Telegram message must be a non-empty string', {
      code: 'TELEGRAM_MESSAGE_ERROR',
    });
  }

  if (text.length > MAX_TELEGRAM_MESSAGE_LENGTH) {
    throw new TelegramError(
      `Telegram message is too long (${text.length} characters; maximum is ${MAX_TELEGRAM_MESSAGE_LENGTH})`,
      { code: 'TELEGRAM_MESSAGE_ERROR' },
    );
  }
}

function getRequiredConfig(token, chatId) {
  if (!token || !chatId) {
    throw new ConfigError(
      'Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID. Put both values in the local .env file.',
    );
  }

  return { token, chatId };
}

function getNetworkErrorMessage(error) {
  // The endpoint URL contains the bot token, so never include the raw fetch
  // error message in user-visible output.
  return error?.cause?.code ?? error?.code ?? 'network error';
}

function createRequestDeadline(externalSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  let externallyAborted = false;
  let abortListener;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timeout.unref?.();

  if (externalSignal) {
    abortListener = () => {
      externallyAborted = true;
      controller.abort(externalSignal.reason);
    };
    if (externalSignal.aborted) {
      abortListener();
    } else {
      externalSignal.addEventListener('abort', abortListener, { once: true });
    }
  }

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    wasExternallyAborted: () => externallyAborted,
    cleanup() {
      clearTimeout(timeout);
      if (abortListener && externalSignal) {
        externalSignal.removeEventListener('abort', abortListener);
      }
    },
  };
}

export function createTelegramClient({
  token = process.env.TELEGRAM_BOT_TOKEN,
  chatId = process.env.TELEGRAM_CHAT_ID,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TELEGRAM_TIMEOUT_MS,
  logger = console.log,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new ConfigError('Node.js built-in fetch is not available for Telegram API');
  }

  async function call(method, payload = {}, { requestTimeoutMs = timeoutMs, signal } = {}) {
    const config = getRequiredConfig(token, chatId);
    const url = `${TELEGRAM_API_ORIGIN}/bot${config.token}/${method}`;
    const requestDeadline = createRequestDeadline(signal, requestTimeoutMs);

    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: requestDeadline.signal,
      });

      const responseText = await response.text();
      let responsePayload;
      try {
        responsePayload = responseText ? JSON.parse(responseText) : null;
      } catch (error) {
        throw new TelegramError(
          `Telegram ${method} returned invalid JSON (HTTP ${response.status})`,
          { status: response.status, code: 'TELEGRAM_RESPONSE_ERROR', cause: error },
        );
      }

      const description = responsePayload?.description;
      if (!response.ok || responsePayload?.ok !== true) {
        const retryAfter = responsePayload?.parameters?.retry_after;
        if (response.status === 429) {
          logger(
            `[telegram] HTTP 429 Too Many Requests${retryAfter ? `; retry_after=${retryAfter}s` : ''}`,
          );
        }

        const suffix = description ? `: ${description}` : '';
        throw new TelegramError(
          `Telegram ${method} failed with HTTP ${response.status} ${response.statusText}${suffix}`.trim(),
          {
            status: response.status,
            retryAfter,
            code: response.status === 429 ? 'TELEGRAM_RATE_LIMIT' : 'TELEGRAM_API_ERROR',
          },
        );
      }

      return responsePayload.result;
    } catch (error) {
      if (error instanceof TelegramError) {
        throw error;
      }
      if (requestDeadline.didTimeout()) {
        throw new TelegramError(
          `Telegram ${method} request timed out after ${requestTimeoutMs} ms`,
          { code: 'TELEGRAM_TIMEOUT' },
        );
      }
      if (requestDeadline.wasExternallyAborted()) {
        throw new TelegramError(
          `Telegram ${method} request was cancelled`,
          { code: 'TELEGRAM_ABORTED' },
        );
      }
      throw new TelegramError(
        `Telegram ${method} request failed: ${getNetworkErrorMessage(error)}`,
        { code: 'TELEGRAM_NETWORK_ERROR' },
      );
    } finally {
      requestDeadline.cleanup();
    }
  }

  async function getMe({ signal, requestTimeoutMs } = {}) {
    return call('getMe', {}, { signal, requestTimeoutMs });
  }

  async function sendTelegramMessage(text, {
    replyMarkup,
    disableWebPagePreview,
    parseMode,
    signal,
    requestTimeoutMs,
  } = {}) {
    validateMessage(text);
    const payload = { chat_id: chatId, text };
    if (replyMarkup !== undefined) {
      payload.reply_markup = replyMarkup;
    }
    if (disableWebPagePreview !== undefined) {
      payload.disable_web_page_preview = disableWebPagePreview;
    }
    if (parseMode !== undefined) {
      payload.parse_mode = parseMode;
    }
    return call('sendMessage', payload, { signal, requestTimeoutMs });
  }

  async function editTelegramMessage(text, {
    messageId,
    replyMarkup,
    targetChatId = chatId,
    parseMode,
    signal,
    requestTimeoutMs,
  } = {}) {
    validateMessage(text);
    if (messageId === undefined || messageId === null) {
      throw new TelegramError('Telegram editMessageText requires messageId', {
        code: 'TELEGRAM_MESSAGE_ERROR',
      });
    }

    const payload = {
      chat_id: targetChatId,
      message_id: messageId,
      text,
    };
    if (replyMarkup !== undefined) {
      payload.reply_markup = replyMarkup;
    }
    if (parseMode !== undefined) {
      payload.parse_mode = parseMode;
    }
    return call('editMessageText', payload, { signal, requestTimeoutMs });
  }

  async function answerCallbackQuery(callbackQueryId, {
    text,
    showAlert = false,
    signal,
    requestTimeoutMs,
  } = {}) {
    if (!callbackQueryId) {
      throw new TelegramError('Telegram answerCallbackQuery requires callbackQueryId', {
        code: 'TELEGRAM_CALLBACK_ERROR',
      });
    }

    const payload = { callback_query_id: callbackQueryId };
    if (text) {
      payload.text = text;
    }
    if (showAlert) {
      payload.show_alert = true;
    }
    return call('answerCallbackQuery', payload, { signal, requestTimeoutMs });
  }

  async function getUpdates({
    offset,
    timeoutSeconds = 25,
    allowedUpdates = ['message', 'callback_query'],
    signal,
    requestTimeoutMs,
  } = {}) {
    const payload = {
      timeout: timeoutSeconds,
      allowed_updates: allowedUpdates,
    };
    if (offset !== undefined && offset !== null) {
      payload.offset = offset;
    }

    return call('getUpdates', payload, {
      requestTimeoutMs: requestTimeoutMs ?? Math.max(timeoutMs, (Number(timeoutSeconds) + 5) * 1000),
      signal,
    });
  }

  async function deleteWebhook({ dropPendingUpdates = false, signal, requestTimeoutMs } = {}) {
    return call(
      'deleteWebhook',
      { drop_pending_updates: dropPendingUpdates },
      { signal, requestTimeoutMs },
    );
  }

  async function setMyCommands(commands, { signal, requestTimeoutMs } = {}) {
    if (!Array.isArray(commands) || commands.length === 0) {
      throw new TelegramError('Telegram setMyCommands requires a non-empty commands array', {
        code: 'TELEGRAM_COMMANDS_ERROR',
      });
    }

    return call('setMyCommands', { commands }, { signal, requestTimeoutMs });
  }

  async function setChatMenuButton({
    menuButton = { type: 'commands' },
    targetChatId = chatId,
    signal,
    requestTimeoutMs,
  } = {}) {
    const payload = { menu_button: menuButton };
    if (targetChatId !== undefined && targetChatId !== null && targetChatId !== '') {
      payload.chat_id = targetChatId;
    }
    return call('setChatMenuButton', payload, { signal, requestTimeoutMs });
  }

  return {
    getMe,
    sendTelegramMessage,
    editTelegramMessage,
    answerCallbackQuery,
    getUpdates,
    deleteWebhook,
    setMyCommands,
    setChatMenuButton,
  };
}

export async function sendTelegramMessage(text, options = {}) {
  return createTelegramClient(options).sendTelegramMessage(text, options);
}
