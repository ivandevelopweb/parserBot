import 'dotenv/config';

import { createAuthClient } from './auth.js';
import { formatHomework, getAppointments } from './eschool.js';
import { errorMessage } from './utils.js';

async function main() {
  const auth = createAuthClient();

  await auth.fullLogin();

  console.log('\n[auth-test] Removing session_token...');
  const removed = await auth.removeSessionToken();
  if (removed === 0) {
    throw new Error('Could not remove session_token from the cookie jar');
  }

  console.log('[auth-test] Refreshing through /portal...');
  await auth.refreshSession({ logOutput: false });
  const refreshedCookies = await auth.getCookiePresence();
  console.log(
    `[auth-test] New session_token received: ${refreshedCookies.sessionToken ? 'OK' : 'FAILED'}`,
  );

  if (!refreshedCookies.sessionToken) {
    throw new Error('Refresh test failed: session_token is still absent');
  }

  console.log('');
  const result = await getAppointments(auth);

  if (result.homeworks.length === 0) {
    console.log('\nNo homework found for the current or next week.');
    return;
  }

  console.log('');
  for (const homework of result.homeworks) {
    console.log(formatHomework(homework));
  }
}

main().catch((error) => {
  console.error(`[fatal] ${errorMessage(error)}`);
  process.exitCode = 1;
});
