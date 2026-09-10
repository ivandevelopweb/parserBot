import 'dotenv/config';

import { createAuthClient } from './auth.js';
import { createConfiguredClassroomClient } from './classroom-provider.js';
import { syncAllHomeworks } from './bot-sync.js';
import { createHomeworkDatabase } from './homework-db.js';
import { createTelegramClient } from './telegram.js';
import { errorMessage } from './utils.js';

async function main() {
  const auth = createAuthClient();
  const telegram = createTelegramClient();
  const database = await createHomeworkDatabase();
  const classroom = createConfiguredClassroomClient({ logger: console.log });

  try {
    const result = await syncAllHomeworks({
      auth,
      telegram,
      database,
      classroom,
    });
    if (result.failedProviders.length > 0) {
      throw new Error(
        `One or more providers failed: ${result.failedProviders.map((provider) => provider.source).join(', ')}`,
      );
    }
  } finally {
    await database.close();
  }
}

main().catch((error) => {
  console.error(`[fatal] ${errorMessage(error)}`);
  process.exitCode = 1;
});
