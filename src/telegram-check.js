import 'dotenv/config';

import { createTelegramClient } from './telegram.js';
import { errorMessage } from './utils.js';

async function main() {
  const telegram = createTelegramClient();
  const bot = await telegram.getMe();
  const message = await telegram.sendTelegramMessage(
    'HomeworkParser test: Telegram Bot API connection OK ✅',
  );

  console.log(
    `[telegram-check] Message sent successfully (bot @${bot.username ?? 'unknown'}, message_id ${message?.message_id ?? 'unknown'})`,
  );
}

main().catch((error) => {
  console.error(`[fatal] ${errorMessage(error)}`);
  process.exitCode = 1;
});
