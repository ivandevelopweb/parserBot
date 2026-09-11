import 'dotenv/config';

import { createAuthClient } from './auth.js';
import { createConfiguredClassroomClient } from './classroom-provider.js';
import { createHomeworkDatabase } from './homework-db.js';
import { startHealthServer } from './health-server.js';
import { createTelegramBot } from './telegram-bot.js';
import { createTelegramClient, DEFAULT_TELEGRAM_TIMEOUT_MS } from './telegram.js';
import { errorMessage } from './utils.js';
import { ESCHOOL_SYNC_META_KEY } from './bot-sync.js';

async function main() {
  const auth = createAuthClient();
  let database;
  let healthServer;
  let bot;
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log('[bot] Shutdown requested');
    bot?.stop();
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  try {
    database = await createHomeworkDatabase();
    const classroom = createConfiguredClassroomClient({ logger: console.log });
    const telegram = createTelegramClient({
      timeoutMs: Math.max(DEFAULT_TELEGRAM_TIMEOUT_MS, 35000),
    });
    bot = createTelegramBot({
      auth,
      telegram,
      database,
      classroom,
    });
    healthServer = process.env.PORT
      ? await startHealthServer({
        readiness: () => !shuttingDown,
        diagnostics: async () => {
          const state = JSON.parse(await database.getMeta(ESCHOOL_SYNC_META_KEY) || 'null');
          return { eschool: state ? {
            status: state.status,
            stage: state.stage,
            attemptedAt: state.attemptedAt,
            lastSuccessAt: state.lastSuccessAt,
            taskCount: state.taskCount,
            stale: !state.lastSuccessAt
              || Date.now() - Date.parse(state.lastSuccessAt) > 30 * 60 * 1000,
          } : { status: 'unknown', stale: true } };
        },
      })
      : null;
    await bot.start();
  } finally {
    bot?.stop();
    await healthServer?.close();
    await database?.close();
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
  }
}

main().catch((error) => {
  console.error(`[fatal] ${errorMessage(error)}`);
  process.exitCode = 1;
});
