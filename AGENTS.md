# Rules for Agents and Developers

## The main rule

Before a large change, read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), then inspect the affected modules and their tests. The architecture document records layer boundaries, the task lifecycle, and the reasons behind the current choices. Do not change behavior based only on a file name or an old UI screenshot.

A change is large when it affects any of these areas:

- the SQLite schema, fingerprint, snapshot, or deduplication rules;
- login, cookies, diary bootstrap, or Appointment API;
- Telegram message formats, callback data, commands, or chat access;
- notification delivery and persistence order;
- scheduler, polling, retry, or retention;
- a new integration, homework source, or run mode.

For such a change, write a short plan that names the affected layers and trade-offs. For a new feature or behavior change, use the `brainstorming` skill first and wait for the user's design approval.

## Project invariants

1. Do not rewrite the working E-school auth/API code without a clear reason. Check its contracts and tests first.
2. Do not store a full provider API response. Pass a normalized task and a compact snapshot through sync.
3. E-school fingerprints include `targetAppointmentId` and normalized description. Classroom fingerprints use `classroom:${courseId}:${courseWorkId}` and never deduplicate by text. Duplicate provider records must not produce two Telegram messages.
4. Detect content changes through the snapshot. For E-school, use the appointment-id fallback only when there is exactly one safe match. For Classroom, match by the course-qualified external id.
5. Do not mark a Telegram delivery successful until the Bot API returns success.
6. If Telegram delivery fails, leave the task pending for the next sync.
7. Do not add endless retry to one HTTP request. Keep a timeout and bounded recovery. Polling may use capped backoff while the process is alive.
8. Delete completed tasks only when `completed_at` is older than 14 days. Never delete pending tasks in age-based cleanup.
9. When changing callback data, keep compatibility with old buttons or handle stale callbacks explicitly.
10. Escape external links and user text before placing them in HTML output.
11. A failure in one homework provider must not prevent the other provider from being attempted.

## Secrets and data

- Do not read the contents of `.env` into output, documentation, test snapshots, or a commit.
- Never log `TELEGRAM_BOT_TOKEN`, passwords, cookies, or a URL containing the token.
- Never log Google client secrets, refresh tokens, or OAuth authorization URLs containing sensitive values.
- For local checks, pass values through the environment without printing them.
- `google-credentials.json`, `googlecredentials.json`, and `google-token.json` contain credentials and must not be committed.
- `data/homeworks.sqlite` and `data/state.json` contain personal homework data and must not be committed.
- Do not delete the database, state, or project directory for a “clean test” without an explicit request and a prior target check.
- Do not send a test message to Telegram without the user's direct permission.

## Change workflow

1. Read `docs/ARCHITECTURE.md`, `package.json`, `README.md`, and the relevant source files.
2. Find the existing tests for the contract being changed.
3. Identify whether the change affects an external side effect: Telegram, login, SQLite writes, or real user data.
4. For a large change, describe the plan and get design approval.
5. Make the smallest change in the correct layer. Do not duplicate auth, API parsing, or Telegram transport.
6. Add or update tests next to the changed contract.
7. Run `npm test`.
8. Run real `npm run sync`, `npm run bot`, or `npm run telegram:test` only when the request includes it and the external effects are understood.
9. If behavior, schema, or a start command changes, update `README.md` and `docs/ARCHITECTURE.md`.
10. Report changed files, test results, real external actions, and remaining limits.

## SQLite

The schema and database operations live in `src/homework-db.js`. When changing tables:

- update `DATABASE_VERSION` and add a clear migration plan;
- preserve existing data or document the incompatible change;
- test reopening the database;
- add a test for the new status, field, or query;
- never treat manual deletion of `data/homeworks.sqlite` as a migration.

Do not mix the baseline and legacy JSON paths without explaining why. `bot-sync` uses SQLite. `data/state.json` is used only for the first import of old state.

## Telegram

Only one long-polling bot process may run. Before restarting it, stop the old instance and check that no `npm run bot` / `src/bot-cli.js` process chain remains. Otherwise Telegram will return `409 Conflict`.

When adding a callback, check all four points:

- it is accepted only for the configured chat;
- stale buttons are handled;
- `answerCallbackQuery` is called;
- the correct screen and page are redrawn.

Prefer editing the existing message through `editMessageText` when an action belongs to the current list. Send a new message only when that is part of the UX or the sync contract.

## Check commands

```powershell
npm test
npm start
npm run sync
npm run bot
npm run telegram:test
npm run classroom:smoke
```

`npm start` and `npm run sync` contact Єдина школа. `npm run sync` may send real Telegram notifications when the database has already been initialized and new or changed tasks exist. `npm run telegram:test` always sends a message.
`npm run classroom:smoke` uses only the local authenticated Classroom cookie
session and does not change Telegram, SQLite, or the E-school integration.

## Change style

- Follow the project's ESM style and existing field names.
- Use `apply_patch` for manual file edits.
- Do not make broad mechanical replacements in auth/API code for a small UI change.
- Keep useful error classes (`ConfigError`, `HttpError`, `TelegramError`, `HomeworkDatabaseError`, `StateFileError`) and do not expose secrets.
- Add comments where they explain a reason, not where they repeat the code.
- Keep Classroom in its own auth/API adapters. The cookie-based web/RPC smoke-test remains isolated until its response schema is validated; only then may normalized tasks be considered for the common sync/UI layer.
