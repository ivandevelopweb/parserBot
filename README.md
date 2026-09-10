# HomeworkParser

A small Node.js client that can:

1. log in through a Next.js Server Action;
2. keep cookies between requests;
3. refresh `session_token` through `GET /portal`;
4. load and deduplicate homework through Appointment API;
5. provide isolated local smoke-tests for the authenticated Google Classroom web client;
6. import eligible Google Classroom coursework into the same task store as Єдина школа;
7. sync new and changed homework from both sources to Telegram;
8. provide current and completed homework screens in one Telegram interface;
9. run an automatic sync every 10 minutes.

Developer documentation:

- [Architecture and trade-offs](docs/ARCHITECTURE.md)
- [Rules for agents and developers](AGENTS.md)

Read the architecture document before a large change. It describes layer boundaries, fingerprint and snapshot rules, the SQLite lifecycle, Telegram callbacks, and current project limits.

## Requirements

- Node.js 22.5 or newer, for built-in `node:sqlite`;
- a working Єдина школа username and password;
- a Telegram bot token and chat id;
- an authenticated Google Classroom browser cookie export for the Classroom web provider and local smoke-tests;
- Google OAuth variables remain supported by the legacy Classroom API adapter, but are not used by the web smoke-test.

## Setup and run

Install dependencies:

```powershell
npm install
```

Create `.env` next to `package.json`. This file is not committed:

```env
ESCHOOL_USERNAME=your_username
ESCHOOL_PASSWORD=your_password
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REFRESH_TOKEN=
CLASSROOM_COOKIE_HEADER=
CLASSROOM_COOKIES_JSON=
CLASSROOM_COOKIES_FILE=classroom-cookies.json
CLASSROOM_COURSE_ID=544644036115  # only for the single-course smoke-test
```

Google Classroom can also be configured locally through the OAuth flow. Put the
desktop client file in the project root as `google-credentials.json` and run:

```powershell
npm run classroom:auth
```

The command opens a browser, requests the read-only Classroom scopes with
offline consent, and saves the refresh token to `google-token.json`. The token
file is local-only. A deployed process should use the three `GOOGLE_*`
environment variables instead of relying on local files.

For the local Classroom web smoke-test, export cookies from an already
authenticated classroom.google.com browser session and either set
CLASSROOM_COOKIE_HEADER to its Cookie header value, set CLASSROOM_COOKIES_JSON,
or save the JSON export as classroom-cookies.json. The header is treated as a
local secret and is never logged.
The cookie file is local-only and must never be committed.

The production Classroom path uses the web smoke-test client through the common
provider adapter instead of this OAuth flow because the Google Workspace
administrator may block OAuth access. It does not log in with a username or
password and does not use Playwright. The official API adapter remains a
fallback when no web cookie source is configured.

Run the smoke-test:

```powershell
npm start
```

Run one production sync. The first run parses the current homework immediately:

```powershell
npm run sync
```

Run the isolated Classroom web/RPC smoke-test for the configured course:

```powershell
npm run classroom:smoke
```

This command only verifies the authenticated web session and the internal
coursework list RPC. It prints safe request/response framing diagnostics in
debug mode and saves only the raw `pONvgf` response body to
`data/classroom-pONvgf-response.<timestamp>-<run>.debug.txt`. That artifact is
ignored by Git and contains no request headers or cookies. The decoder
recursively inspects arrays, objects, and nested JSON strings, then extracts
only the coursework fields confirmed in the live array response. The command
follows the confirmed opaque continuation value until the current response set
ends, with a bounded page limit. It is deliberately not connected to Telegram,
SQLite, or the production sync.

Run the dynamic course discovery smoke-test. It loads the visible course list
from the authenticated Classroom home page and calls the existing coursework
RPC once for every discovered course; it does not use `CLASSROOM_COURSE_ID`:

```powershell
npm run classroom:courses:smoke
```

Its output is limited to the course count and the table
`course name | assignments fetched | pages fetched | newest assignment`.
The newest assignment is selected by the greatest verified `updatedAt` value.
The web response does not expose a verified teacher field, so `teacherName` is
normalized as `null`; course active/archived status is also not reported until
an explicit status field is verified.

Run the long-lived Telegram bot and scheduler:

```powershell
npm run bot
```

`npm run bot` runs one sync immediately, repeats it every 10 minutes, and handles Telegram commands in parallel. It syncs Єдину школу and, when a Classroom cookie source is configured, dynamically discovered Classroom coursework. Web assignments with `updatedAt` on or after September 1, 2026 are imported; older or missing-update records are ignored. Each new or changed task is sent as a separate message with an inline `Позначити виконаним` button.

### Render deployment

The repository includes [`render.yaml`](render.yaml) for one Render Background
Worker. It runs `npm run bot`, needs no public HTTP port, and stores SQLite on a
1 GB Persistent Disk mounted at `/var/data`. The worker sets
`HOMEWORK_DATABASE_PATH=/var/data/homeworks.sqlite`; local runs keep using
`data/homeworks.sqlite` unless `HOMEWORK_DATABASE_PATH` is set.

After applying the Blueprint, configure these Render environment variables in
the dashboard: `ESCHOOL_USERNAME`, `ESCHOOL_PASSWORD`, `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_CHAT_ID`, and the already authenticated Classroom
`CLASSROOM_COOKIE_HEADER`. Keep the cookie header and all credentials in the
Render secret store; do not upload `.env`, cookie files, or Google credential
files. A Classroom browser session can expire and then needs a fresh local
export. Render's default filesystem is ephemeral, so the disk is required for
SQLite state to survive deploys and restarts. See the [Render Blueprint
reference](https://render.com/docs/blueprint-spec) and [Persistent Disk
documentation](https://render.com/docs/disks).

The worker is intentionally single-instance: Telegram long polling and SQLite
are both process-local. Render must not scale this service horizontally. On
SIGTERM/SIGINT the bot stops polling, waits for an active sync to finish, and
only then closes SQLite.

On the first run, the existing archive is not sent. It becomes the baseline. If an older `data/state.json` already exists, its baseline is imported into SQLite without sending duplicate notifications.

Telegram supports `/start`, `/menu`, `/current`, `/completed`, and `/help`. The main menu also has:

- `📚 Поточні завдання`, which shows pending homework grouped by date;
- `✅ Все виконані завдання`, which shows completed homework.

Homework lists are grouped by date. Each homework title is an inline link to
the source task: Єдина школа uses the diary URL and Classroom uses its direct
details URL (or an explicit `alternateLink` when available). The source label
is shown as `(Єдина школа)` or `(Classroom)`.
Current tasks use `✅` callback buttons in a two-column grid, with no more than
six tasks per page and pagination. For readability, the visible assignment
title/description in list links and task buttons is limited to 50 characters
with an ellipsis; the link, date, subject, and source label remain intact.
Completed tasks use `❌`, which returns a task to the pending state while
keeping the completed list open. The menu also has `ℹ️ Довідка` with the
command list.

The bot UI state and completed tasks are stored in `data/homeworks.sqlite`. Pending tasks are not removed by age. Completed tasks are removed after 14 days from `completedAt` during a later sync.

The database stores only deduplicated tasks and compact snapshots, not full API
responses. `data/state.json` is kept as a compatible legacy E-school baseline
for the transition from the previous JSON sync. Classroom has its own baseline
marker and never sends all existing coursework on its first sync.

To check the Telegram Bot API separately:

```powershell
npm run telegram:test
```

This sends one diagnostic message to the configured chat.

Run local logic tests:

```powershell
npm test
```

## What the smoke-test checks

The client fetches `/login` each time, extracts the dynamic `$ACTION_REF_1`, `$ACTION_1:0`, `$ACTION_1:1`, `$ACTION_KEY`, and `from` fields, then sends a multipart request with the expected Server Action structure. `Content-Type` is not set by hand; the built-in `FormData` adds the boundary.

The smoke-test removes only `session_token`, then calls `/portal`. A new `session_token` confirms the refresh flow.

The current diary also needs a regular HTTP bootstrap: `GET` and `POST /api/v1/seplogin` on `diary.eschool-ua.com`. The client selects school binding `8276`, sends it back, and checks the returned `application_token` cookie. This is the same step used by the browser client, but the project does not use Playwright or Puppeteer.

Appointment API is queried for Monday through Sunday of the current week in `Europe/Kyiv`. On `401`, `403`, or signs of an expired session, the client first tries a refresh through `/portal`. If that fails, it performs one full login. There is no endless retry.

The existing optional Classroom provider uses the official Google Classroom API
with read-only course and coursework scopes. That adapter is retained for
compatibility, but production entry points prefer the authenticated web cookie
provider when cookie configuration is present. `npm run classroom:smoke` does
not use OAuth or modify Telegram/SQLite.
The web smoke-test loads an already authenticated browser cookie jar, verifies
`/a/not-turned-in/all`, extracts dynamic batchexecute bootstrap values, calls
`pONvgf`, follows its confirmed continuation field, and decodes only explicitly
identifiable coursework fields. The first numeric request field remains the
observed opaque value `100`: controlled live requests showed that it changes the
maximum returned record count, but the client does not assign it a documented
protocol name. Smaller experimental values are not used because their chained
totals varied between requests. The course smoke-test additionally loads `/h` and decodes the
home-page `gXtzob` response; it selects the visible sidebar records dynamically
and does not hardcode the account's course ids. The web provider now merges
eligible normalized coursework into the existing SQLite task table and Telegram
UI. The first successful Classroom sync creates a provider-specific baseline
without sending the existing tasks as new. Classroom due timestamps are
converted to `Europe/Kyiv`; tasks without a due date sort last and are labeled
`Дата здачі не вказана`. Its debug inspector
examines the raw `wrb.fr` frames before nested JSON decoding and recursively
walks every decoded array, object, and nested JSON string, so a raw JSON
`null` payload is distinguished from a decoder failure and validation values
can be reported with their JSON paths. The smoke CLI does not log cookies,
bootstrap/session values, or request headers.

The client accepts an Appointment array at the response root or in the `Appointment` field, as well as the current diary response with an array in `Items`.

A Єдина школа fingerprint contains `targetAppointmentId` and the normalized
description. Several `homeworkId` values for one real task become one stored
task and one notification. Classroom uses the stable course/coursework id
instead. SQLite stores a source-specific snapshot so the next sync can detect
changes to description, title, due date/time, topics, links, files, or the
Classroom `updateTime`. A Telegram failure does not mark the task as sent, so
the next iteration can try again.

The old `data/state.json` is still validated and written atomically by the compatible JSON sync module. A damaged file is not silently replaced. `.env`, Google credential/token files, `data/state.json`, and `data/homeworks.sqlite*` are not committed.

Logs do not show passwords, cookies, or full tokens. If a Server Action id or token identifier needs to be shown, only the first 8 and last 6 characters are printed.
