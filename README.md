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
9. run an automatic sync every 20 minutes by default (configurable from 5 to
   60 minutes).

Developer documentation:

- [Architecture and trade-offs](docs/ARCHITECTURE.md)
- [Rules for agents and developers](AGENTS.md)
- [Aiven PostgreSQL migration runbook](docs/aiven-migration-runbook.md)

Read the architecture document before a large change. It describes layer boundaries, fingerprint and snapshot rules, the PostgreSQL lifecycle, Telegram callbacks, and current project limits.

## Requirements

- Node.js `24.21.0` or a later `24.x` patch below `25`;
- a PostgreSQL database URL (Neon and Aiven are supported managed PostgreSQL providers);
- a working Єдина школа username and password;
- a Telegram bot token and chat id;
- an authenticated Google Classroom browser cookie export for the Classroom web provider and local smoke-tests;

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
CLASSROOM_COOKIE_HEADER=
CLASSROOM_COOKIES_JSON=
CLASSROOM_COOKIES_FILE=classroom-cookies.json
CLASSROOM_COURSE_ID=544644036115  # only for the single-course smoke-test
HOMEWORK_DATABASE_URL=postgresql://user:password@host/database?sslmode=require
HOMEWORK_SYNC_INTERVAL_MINUTES=20  # integer from 5 to 60; explicit values override the default
```

If PostgreSQL requires a custom CA certificate, use
`HOMEWORK_DATABASE_CA_CERT_BASE64` for a base64-encoded PEM when the deployment
platform flattens multiline environment values. If it is not set, the
application falls back to `HOMEWORK_DATABASE_CA_CERT`, then to
`HOMEWORK_DATABASE_CA_CERT_PATH`. TLS certificate verification remains enabled;
never commit certificate contents.

For the local Classroom web smoke-test, export cookies from an already
authenticated classroom.google.com browser session and either set
CLASSROOM_COOKIE_HEADER to its Cookie header value, set CLASSROOM_COOKIES_JSON,
or save the JSON export as classroom-cookies.json. The header is treated as a
local secret and is never logged.
The cookie file is local-only and must never be committed.

The production Classroom path uses the web smoke-test client through the common
provider adapter. It does not log in with a username or password, does not use
Playwright, and does not fall back to the official Google Classroom API. If no
authenticated cookie source is configured, Classroom is skipped and the bot
logs a safe configuration message.

Run the smoke-test:

```powershell
npm start
```

Run the isolated E-school browser-session diagnostic. First export the
verified E-school cookies into the local, ignored file
`secrets/eschool-cookies.json` using the shape below:

```json
{
  "version": 1,
  "cookies": [
    {
      "name": "refresh_token",
      "value": "PASTE_LOCALLY",
      "domain": ".eschool-ua.com",
      "path": "/",
      "expires": "2026-10-31T23:59:59.000Z",
      "secure": true,
      "httpOnly": true,
      "sameSite": "lax"
    }
  ]
}
```

Add the `session_token` and `application_token` records, preserving their
browser domains and paths. Diary-scoped duplicate token names are allowed;
`cf_clearance` is optional and is not required by the diagnostic. The command
never calls `fullLogin()`, sends no Telegram messages, and does not access
PostgreSQL. It reports one of `RESULT_A`, `RESULT_B`, `RESULT_C`, or
`RESULT_D` without printing cookie values:

```powershell
npm run eschool:session:diagnostic
```

Run one production sync. The first run parses the current and next week's homework immediately:

The command requires `HOMEWORK_DATABASE_URL`; it never falls back to a local
SQLite file.

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
PostgreSQL, or the production sync.

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

The coursework decoder accepts the verified `hrsi.qr` web/RPC envelope,
including empty lists with an omitted collection. Unknown or malformed
responses still fail the Classroom scan and preserve its previous database
snapshot. Authentication continues to use the existing browser cookies.

Run the long-lived Telegram bot and scheduler:

```powershell
npm run bot
```

`npm run bot` runs one sync immediately, repeats it every 20 minutes by default,
and handles Telegram commands in parallel. Set
`HOMEWORK_SYNC_INTERVAL_MINUTES` to an integer from `5` to `60` to change the
period; the prepared Render profile also uses `20`. An explicit server value of
`10` remains an override and must be changed to `20` during rollout. A longer
period reduces polling and database activity but can delay discovery and
notification retries by up to one interval plus the provider cycle duration.
At 20 minutes this is 72 planned runs per day instead of 144, excluding process
starts; that frequency change is not proof of a twofold provider cost reduction.
The first sync remains
immediate, overlapping cycles are skipped, and shutdown cancels and drains the
active cycle. The bot syncs Єдину школу and, when a Classroom cookie source is
configured, dynamically discovered Classroom coursework. Only assignments
published on or after September 1, 2026 (Kyiv midnight) are included, for both
pending and completed work. Neither edits nor due dates determine eligibility.
Existing rows without publication remain hidden until the next successful scan
fills their `publishedAt` snapshot field; data is not deleted. Classroom reads
explicit not-turned-in and turned-in state filters, updates the stable
course-qualified row, and treats only confirmed completed/returned states as
completed; ambiguous states preserve the previous status. The first Classroom
status reconciliation is quiet and recorded in PostgreSQL. Each new or changed
task is queued in PostgreSQL and sent as a separate message without an inline
completion button. Current and completed task lists still provide their
respective action buttons. Telegram messages stay within the 4096-character
limit; an oversized message gets a compact escaped version while the full
snapshot remains in PostgreSQL.

### Render deployment

The repository includes [`render.yaml`](render.yaml) for one free Render Web
Service. It runs `npm run bot`, exposes `/healthz`, and stores all durable bot
state in PostgreSQL. No Render Persistent Disk or local SQLite file is used.
The Blueprint pins Node.js `24.21.0`, installs dev dependencies for the build,
runs `npm test`, and removes them before the service starts.

After applying the Blueprint, configure these Render environment variables in
the dashboard: `ESCHOOL_USERNAME`, `ESCHOOL_PASSWORD`, `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_CHAT_ID`, `HOMEWORK_DATABASE_URL`, and, when used, the already
authenticated Classroom `CLASSROOM_COOKIE_HEADER`. The Blueprint also sets
`HOMEWORK_SYNC_INTERVAL_MINUTES=20`; change it only after reviewing the delay
and retry trade-off. Keep the database URL,
cookie header, and all credentials in the Render secret store; do not upload
`.env`, cookie files, or Google credential files. A Classroom browser session
can expire and then needs a fresh local export. Use the Neon pooled connection
string for `HOMEWORK_DATABASE_URL` when using Neon. Aiven Free has no provider
pooler; the application still uses its bounded two-connection `pg.Pool`, so use
the regular Aiven Service URI with TLS. See the
[Render Blueprint reference](https://render.com/docs/blueprint-spec) and
[free instance documentation](https://render.com/docs/free).

### PostgreSQL time limits and recovery

The application-created `pg.Pool` keeps its 10-second connection-acquisition
deadline and 30-second idle-client timeout. Every pool client also receives a
5-second PostgreSQL `lock_timeout`, a 20-second PostgreSQL
`statement_timeout`, and a 25-second `pg` `query_timeout`. These settings cover
ordinary repository queries, migration work, and commands on checked-out
transaction clients, including `BEGIN`, `COMMIT`, and `ROLLBACK`; no additional
environment variables are needed.

The pool has a fixed, sanitized idle-client error diagnostic. It never prints a
connection string, SQL, parameters, task text, or the received error object;
`pg` removes the failed idle connection itself. During shutdown the handler
stays installed until the pool has finished closing, then only that handler is
removed.

`query_timeout` is a client-side deadline, not a cancellation protocol for an
already active PostgreSQL statement. A timed-out, disconnected, or failed-
rollback transaction client is released with `release(true)` so `pg` discards
it rather than reusing a possibly busy connection. A normal SQL error receives
a bounded rollback first. The adapter never retries a write or `COMMIT`, and a
rollback/release cleanup error never replaces the original database error.

The service is intentionally single-instance: Telegram long polling has one
owner, even though PostgreSQL is remote. Render must not scale this service
horizontally. On SIGTERM/SIGINT the bot stops polling, aborts the active HTTP
work, waits for the sync promise to drain, and only then closes the PostgreSQL
pool. The local tests cover the abort/drain contract but do not constitute a
live Render shutdown check. The free Web Service may sleep when idle; an
external monitor such as UptimeRobot can request `HEAD /healthz` (its default
method) or `GET /healthz` if the operator wants to reduce sleeping. Set the
monitor URL to `https://<service>.onrender.com/healthz`, with no authentication;
the root path `/` returns 404. Both health methods return 200 when ready or
503 when unavailable; HEAD has no response body. This checks HTTP availability,
not the success of provider sync or Telegram polling. Configuring the monitor
is an operational step outside this repository.

The GET `/healthz` response also includes in-memory `sync.eschool` and
`sync.classroom` diagnostics: the latest attempt, last successful snapshot
time, task count, status, metrics, and (for E-school) the failure stage. Before
the first result a provider is `unknown` and `stale`. The stale threshold is
derived from the configured interval (at least 30 minutes), so a 20-minute
profile is not falsely stale after 30 minutes. Health GET and HEAD perform no
SQL; they only read the bot's in-memory state. A recovered E-school result
clears its previous failure stage. A Classroom provider failure is also written
to compact PostgreSQL diagnostics while retaining its last successful snapshot
time and task count. A provider error does not change readiness or trigger an
application-side restart. These diagnostics contain no
task text, SQL parameters, cookies, tokens, or connection strings. HEAD remains
a process/readiness check without a response body.

Safe rollout/rollback: run the full test suite on Node `24.21+`, review the
before/after synthetic benchmark, and deploy with the existing PostgreSQL schema
version 5; this change has no application-schema migration. For a provider
change, follow [the Aiven migration runbook](docs/aiven-migration-runbook.md).
Keep exactly one bot owner: stop the
old `npm run bot` instance, verify its process chain has exited, then start the
new instance. Confirm a GET `/healthz` returns ready, both provider diagnostics
move from `unknown`, and no queue growth or duplicate messages appears during
the first cycles. If the new process is unhealthy, stop it and restore the
previous application revision with the same environment and database; do not
delete or reset PostgreSQL state. After 24–72 hours, compare provider counters over
an exact window and sample missed/repeated notifications before changing the
interval again.

After an E-school login or appointment-read failure, the next scheduled cycle
performs a full login instead of trusting the previous session. The existing
bounded recovery within a request remains unchanged. Classroom authentication,
filters, status reconciliation, and delivery are unchanged. This prevents a
failed session from being reused indefinitely; deployment logs are still needed
to identify the original cause of a particular outage.

On the first run, the existing archive is not sent. It becomes the baseline. If
an older `data/state.json` already exists, its baseline is imported into
PostgreSQL without sending duplicate notifications. The JSON file is only a
one-time compatibility source; PostgreSQL is the active store.

Telegram supports `/start`, `/menu`, `/current`, `/completed`, and `/help`. The main menu also has:

- `📚 Поточні завдання`, which shows pending homework grouped by date;
- `✅ Все виконані завдання`, which shows completed homework;
- `🔗 Акаунт Classroom`, which accepts a Google account order from `0` to `10`.

Homework lists are grouped by date. Each homework title is an inline link to
the source task: Єдина школа uses the diary URL and Classroom uses its direct
details URL with Classroom's encoded route ids (or an explicit `alternateLink`
when available). When the Classroom account order is configured, the bot adds
or replaces the `authuser` query parameter on Classroom links at render time;
the default unset value leaves links unchanged. This parameter selects an
account only among the Google accounts already signed in to the browser, using
Google's current account order. The source label is shown as `(Єдина школа)` or
`(Classroom)`.
Current tasks use `✅` callback buttons in a two-column grid, with no more than
six tasks per page and pagination. For readability, the visible assignment
title/description in list links and task buttons is limited to 50 characters
with an ellipsis; the link, date, subject, and source label remain intact.
Completed tasks use `❌`, which returns a task to the pending state while
keeping the completed list open. The menu also has `ℹ️ Довідка` with the
command list; the help screen shows `↩️ До меню` to return to the main menu.

New and changed E-school notifications also link the assignment text directly
to its diary homework page, ending with `(Єдина школа)`. The message is sent as
escaped Telegram HTML. Compact notifications keep the linked shortened text
and source label when a usable URL fits; missing/unsafe URLs fall back to text.
Previously delivered messages are not rewritten by this formatting change.

The bot UI state, Classroom account-order preference, compact snapshots, Telegram
offset, and pending notification queue are stored in PostgreSQL. Manual completion
and restoration keep priority over automatic status changes, while a later
content change on a pending manually restored task still enters the notification
queue. Pending tasks are not removed by age. Completed
tasks are removed after 14 days from `completedAt` during a later sync. A
failed Telegram request leaves its queue entry pending for a later cycle.

For expired Classroom tasks, cleanup keeps only the course-qualified external
id in `classroom_task_tombstones`, in the same transaction that deletes the
task and its text/snapshot. Later completed or unknown observations cannot
reimport that id, including after a restart. A confirmed pending observation
clears the marker and allows the task to return only when its publication is
within the accounting period. These small markers have no
age-based expiry. Manual completion/restoration overrides remain in force while
the full task row exists; after cleanup only its identity is retained.

PostgreSQL schema version 5 adds this table automatically at startup, preserving
existing v4 tasks, metadata, and notification queues. Version 3 first receives
the existing completion-origin migration. No manual database cleanup is needed.
Tasks deleted before this migration have no retained id and cannot be recognized
retroactively; if reimported, their next expiry will save the marker.

The database stores only deduplicated tasks and compact snapshots, not full API
responses. `data/state.json` is kept only as a compatible legacy E-school
baseline importer. Classroom has its own baseline marker and a separate
`classroom_status_reconciled_at` marker; it never sends all existing coursework
on its first sync or during the first status migration. Manual Telegram
completion/restoration has priority over an automatic Classroom status, and an
already completed task's queued notification is discarded without being
reported as delivered.

To check the Telegram Bot API separately:

```powershell
npm run telegram:test
```

This sends one diagnostic message to the configured chat.

Run local logic tests:

```powershell
npm test
```

Run the repeatable local before/after benchmark on synthetic E-school and
Classroom data (it never contacts either provider, PostgreSQL, or Telegram):

```powershell
npm run benchmark:neon -- --label=before --output=output/benchmark-before.json
npm run benchmark:neon -- --label=after --output=output/benchmark-after.json --before=output/benchmark-before.json
```

The benchmark reports SQL calls, returned rows, changed rows, and UTF-8 sizes
of JSON-serialized result rows. The byte value is only an approximation of
returned data, not PostgreSQL wire traffic or a provider usage counter. The
generated JSON and Markdown reports can be kept under the ignored `output/`
directory.

## What the smoke-test checks

The client fetches `/login` each time, extracts the dynamic `$ACTION_REF_1`, `$ACTION_1:0`, `$ACTION_1:1`, `$ACTION_KEY`, and `from` fields, then sends a multipart request with the expected Server Action structure. `Content-Type` is not set by hand; the built-in `FormData` adds the boundary.

The smoke-test removes only `session_token`, then calls `/portal`. A new `session_token` confirms the refresh flow.

The current diary also needs a regular HTTP bootstrap: `GET` and `POST /api/v1/seplogin` on `diary.eschool-ua.com`. The client selects school binding `8276`, sends it back, and checks the returned `application_token` cookie. This is the same step used by the browser client, but the project does not use Playwright or Puppeteer.

Appointment API is queried for Monday through Sunday of the current and next week (14 days) in `Europe/Kyiv`. This lets the bot notify about next Monday's homework before the week changes. On `401`, `403`, or signs of an expired session, the client first tries a refresh through `/portal`. If that fails, it performs one full login. There is no endless retry.

The production Classroom provider uses only the authenticated browser-cookie
web/RPC path. `npm run classroom:smoke` does not use OAuth or modify
Telegram/PostgreSQL. The legacy official-API source files are not selected by
the bot and are outside the supported deployment path.
The web smoke-test loads an already authenticated browser cookie jar, verifies
`/a/not-turned-in/all`, extracts dynamic batchexecute bootstrap values, calls
`pONvgf`, follows its confirmed continuation field, and decodes only explicitly
identifiable coursework fields. The first numeric request field remains the
observed opaque value `100`: controlled live requests showed that it changes the
maximum returned record count, but the client does not assign it a documented
protocol name. Smaller experimental values are not used because their chained
totals varied between requests. The course smoke-test additionally loads `/h` and decodes the
home-page `gXtzob` response; it selects the visible sidebar records dynamically
and does not hardcode the account's course ids. The web provider now performs
three bounded state scans per course: `[1,2]` for not-turned-in work, the
confirmed turned-in set for coverage, and `[3,4,5,6,7,9,11]` for confirmed
completed/returned work. Membership in either positive set means that the
assignment is completed; this positive evidence wins if the provider slices
overlap with `[1,2]`. An assignment seen only in `[1,2]` remains pending, while
records absent from the scans are not inferred to be completed. Observations
with the same Classroom id and `updatedAt` are merged so a sparse scan cannot
erase a due date or link from a richer one. The first successful
Classroom sync creates a provider-specific baseline and status reconciliation
without sending existing tasks as new. Classroom due timestamps are converted
to `Europe/Kyiv`, while date-only due tuples are preserved as calendar dates;
For type-2 assignments, the decoder reads the due timestamp from the sibling
metadata in the existing web/RPC response, before extracting the base record.
No additional request is needed. After deploying this fix, the next successful
sync refreshes stored deadlines and may send changed-task notifications through
the existing queue; previously sent messages are not edited automatically.
Tasks without a due date sort last and are labeled `Дата
здачі не вказана`. Its debug inspector
examines the raw `wrb.fr` frames before nested JSON decoding and recursively
walks every decoded array, object, and nested JSON string, so a raw JSON
`null` payload is distinguished from a decoder failure and validation values
can be reported with their JSON paths. The smoke CLI does not log cookies,
bootstrap/session values, or request headers.

The client accepts an Appointment array at the response root or in the `Appointment` field, as well as the current diary response with an array in `Items`.

A Єдина школа fingerprint contains `targetAppointmentId` and the normalized
description. Several `homeworkId` values for one real task become one stored
task and one notification. Classroom uses the stable course/coursework id
instead. PostgreSQL stores a source-specific snapshot so the next sync can detect
changes to description, title, due date/time, topics, links, and files. Classroom
`updatedAt` alone is deliberately not a content change. A provider snapshot,
confirmed Classroom status updates, and their notification state are committed
in one PostgreSQL transaction before Telegram is called. A Telegram failure does
not mark the task as sent, so the pending queue can be retried by the next
iteration. The queue is rechecked before sending; a task that became completed
is removed from the queue without being reported as a successful delivery. This
is at-least-once delivery: a process crash after Telegram accepts a message but
before PostgreSQL acknowledges it can still produce a duplicate.

The old `data/state.json` is still validated and written atomically by the
standalone compatible JSON sync module; the production bot does not use it as
its primary store. A damaged file is not silently replaced. `.env`, Google
credential/token files, `data/state.json`, and any old `data/homeworks.sqlite*`
files are not committed.

Logs do not show passwords, cookies, or full tokens. If a Server Action id or token identifier needs to be shown, only the first 8 and last 6 characters are printed.
