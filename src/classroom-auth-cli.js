import 'dotenv/config';

import {
  authorizeClassroom,
  DEFAULT_GOOGLE_TOKEN_PATH,
  resolveGoogleCredentialsPath,
} from './classroom-auth.js';
import { errorMessage } from './utils.js';

async function main() {
  const credentialsPath = resolveGoogleCredentialsPath();
  if (!credentialsPath) {
    throw new Error(
      'Google OAuth credentials file was not found. Add google-credentials.json to the project root and run this command again.',
    );
  }

  console.log('[classroom-auth] Opening the Google consent flow in your browser...');
  const result = await authorizeClassroom({
    credentialsPath,
    tokenPath: DEFAULT_GOOGLE_TOKEN_PATH,
  });

  console.log(`[classroom-auth] OAuth completed; token saved to ${result.tokenPath}`);
  console.log('[classroom-auth] For Render, set these secrets without printing them:');
  console.log('GOOGLE_CLIENT_ID=');
  console.log('GOOGLE_CLIENT_SECRET=');
  console.log('GOOGLE_REFRESH_TOKEN=');
  console.log('[classroom-auth] The refresh token is stored in google-token.json.');
}

main().catch((error) => {
  console.error(`[fatal] ${errorMessage(error)}`);
  process.exitCode = 1;
});
