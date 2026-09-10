# HomeworkParser Architecture

## 1. Purpose and scope

HomeworkParser reads homework from Єдина школа and, when configured, Google Classroom; compares it with local state; and sends new or changed assignments to Telegram. Classroom production sync uses the validated web/RPC adapter when an authenticated browser cookie source is configured, while the low-level web client remains isolated behind that adapter.

The project is built for one local process, one Єдина школа account, one optional Google Classroom browser session, and one configured Telegram chat. The Telegram UI can store the browser's Google account order used when opening Classroom links.

The E-school login, diary access, Classroom API/web calls, and Telegram calls use HTTP clients. The Classroom web path reuses cookies from an already authenticated browser session; it does not implement Google username/password login.

## 2. Data flow

```text
           ┌───────────────────────┐       ┌─────────────────────────┐
           │ Єдина школа auth/API  │       │ Classroom web/RPC        │
           └───────────┬───────────┘       └────────────┬────────────┘
                       │ E-school tasks                 │ Classroom tasks
                       └──────────────┬─────────────────┘
                                      ▼
                         ┌────────────────────────┐
                         │ normalize + source key │
                         │ + compact snapshot     │
                         └───────────┬────────────┘
                                     │ common tasks
                                     ▼
                         ┌────────────────────────┐
                         │ bot-sync                │
                         │ compare + PostgreSQL    │
                         └───────┬────────┬────────┘
                                 │        │
                      successful │        │ new/changed task
                      delivery   │        ▼
                                 │  ┌───────────────┐
                                 └─►│ Telegram API  │
                                    └───────────────┘

Telegram update → telegram-bot → callback/command → PostgreSQL → edit message
```

In `npm run bot` mode this flow starts once at process startup and then runs every 10 minutes. Telegram long polling runs in the same process. A provider failure is logged and does not prevent the other provider from running.

## 3. Layers and files

| Layer | Files | Responsibility |
| --- | --- | --- |
| Entry points | `src/index.js`, `src/sync-cli.js`, `src/bot-cli.js`, `src/telegram-check.js`, `src/classroom-smoke-cli.js`, `src/classroom-courses-smoke-cli.js` | Load `.env`, assemble dependencies, and start the selected mode. |
| Authentication | `src/auth.js`, `src/classroom-web.js` | Perform E-school login through the dynamic Next.js Server Action; keep E-school cookies in memory; and load the already authenticated Classroom browser cookie source. |
| Diary client | `src/eschool.js` | Bootstrap `seplogin`, fetch the current week from Appointment API, extract homework, and deduplicate it. |
| Classroom web client and provider | `src/classroom-web.js`, `src/classroom-provider.js`, `src/classroom-smoke-cli.js`, `src/classroom-courses-smoke-cli.js` | Load an authenticated browser cookie jar, discover dynamic web bootstrap values and courses from the home-page RPC, call the internal `pONvgf` RPC with explicit state filters, validate the confirmed wire shapes, classify coursework status conservatively, and adapt eligible coursework to the common task model. The low-level transport remains isolated from sync and Telegram. |
| Domain normalization | `src/sync.js`, `src/utils.js` | Build source-aware fingerprints, snapshots, and normalized fields. `sync.js` also contains the original JSON sync path. |
| Bot sync | `src/bot-sync.js` | Run each provider independently, compare the latest API snapshot with PostgreSQL, send new or changed tasks, and remove old completed history. |
| Storage | `src/homework-db.js`, `src/postgres-homework-db.js`, `src/homework-db-shared.js` | Require `HOMEWORK_DATABASE_URL`, initialize the PostgreSQL schema version 4, migrate v3 rows without deleting data, normalize timestamps to ISO, and store source-aware tasks, status origins, notifications, and the Telegram offset through an async pool contract. |
| Legacy storage | `src/state.js` | Read and atomically write compatible `data/state.json`. Bot sync uses this only when importing an old baseline. |
| Telegram transport | `src/telegram.js` | Small Telegram Bot API client built on `fetch`, with no bot framework. |
| Telegram UI | `src/messages.js`, `src/telegram-bot.js` | Format messages, commands, inline keyboards, callbacks, Classroom account-order input, long polling, and the scheduler. |

### Two sync implementations

`src/bot-sync.js` is the active sync path for the Telegram bot and `npm run sync`. `syncAllHomeworks()` runs E-school first and Classroom second when configured, using the same PostgreSQL and Telegram contracts.

`src/sync.js` contains the original JSON-based sync and tests for that contract. Do not use it for new bot features without a separate migration decision. It remains in the project so the original smoke-test and the transition from `data/state.json` keep working.

## 4. External systems

### Єдина школа

`src/auth.js` follows these steps:

1. Send `GET /login` and parse the hidden form fields.
2. Read the dynamic fields `$ACTION_REF_1`, `$ACTION_1:0`, `$ACTION_1:1`, `$ACTION_KEY`, `from`, and the Server Action id.
3. Send `POST /login` with `FormData` containing the username and password.
4. Check for the `refresh_token` and `session_token` cookies.
5. If needed, send `GET /portal` to receive a new `session_token`.

Cookies are not written to disk. They live in the current process's `tough-cookie` jar.

`src/eschool.js` then bootstraps the diary API:

1. Send `GET /api/v1/seplogin`.
2. Select the school binding from the response.
3. Send `POST /api/v1/seplogin` with that binding.
4. Check for the `application_token` cookie on `diary.eschool-ua.com`.
5. Request Appointment API for Monday through Sunday of the current week in `Europe/Kyiv`.

The school and student ids are currently constants in `src/eschool.js`. That works for one account, but it is not a multi-user configuration.

When the API returns `401`, `403`, or a message that points to an expired session, the client tries one refresh through `/portal`. If that does not work, it performs a full login. There is no endless retry for one request.

### Google Classroom

The supported Classroom path is the authenticated browser-cookie web/RPC
client and provider. The bot does not fall back to OAuth or the official
Google Classroom API. If no cookie source is configured, Classroom is skipped
with a safe configuration log and the E-school provider can continue.

#### Classroom web/RPC client and provider

`src/classroom-web.js` accepts a JSON cookie export through
`CLASSROOM_COOKIES_JSON`, `CLASSROOM_COOKIES_FILE`, or the ignored local
`classroom-cookies.json` file. It also accepts a plain HTTP Cookie header in
`CLASSROOM_COOKIE_HEADER`; when present, that source takes precedence over the
JSON/file sources. Header pairs are imported for `classroom.google.com` into a
`tough-cookie` jar only after the initial page request; that first request sends
the configured header as the exact HTTP `Cookie` header to preserve browser
semantics. Cookie values and auth-cookie names are never logged. Redirects are
followed manually for that first request so only sanitized host/path values can
appear in diagnostics.

The client first requests `/a/not-turned-in/all` and treats a Google login page,
401, or 403 as an expired browser session. It extracts `at`, `f.sid`, and `bl`
from structured bootstrap data when available, with a direct DOM/script fallback
for compatible pages. `_reqid` is generated per request. The RPC helper sends
the form-encoded `f.req` and `at`, handles XSSI and length-prefixed
batchexecute frames, and recursively decodes nested JSON.

`getCourseWorkForCourse(courseId)` uses only `pONvgf`. The opaque numeric
request mask is kept in one template, the supplied course id is substituted at
runtime, and the state filter is written to the confirmed protobuf position
`payload[2][0][14]`. It defaults to `[1,2]` for `/a/not-turned-in/all`; callers
can explicitly request the turned-in route and another verified state set. The
decoder supports both explicit coursework object fields and the array-only
shape confirmed in the live response: the course-qualified identity pair,
title, plain description, and optional due tuple. It does not guess the meaning
of other numeric positions or material arrays. When the decoded response
contains the confirmed opaque continuation field at `payload[1][1][0]`, the
client sends another request with that value and stops when the field is
absent. The loop has a bounded page limit and rejects a repeated token. A
session-expired or bootstrap failure permits one forced page/bootstrap refresh
and one retry of the same RPC; a second such failure is returned without
another refresh. A response without a recognized coursework collection is
rejected by the provider, so an unknown schema cannot look like an empty
successful snapshot. The live `hrsi.qr` (QueryStreamItem) envelope is validated
with coursework nested at `payload[2][i][1][0]`; its terminal empty response
`["hrsi.qr", [false]]` is accepted even though it omits the collection.
Malformed or unrecognized items reject the page instead of producing a partial
successful snapshot. A controlled live experiment showed that the first
numeric request field (`100`) changes the maximum returned record count, but
its undocumented protocol meaning is not renamed to `pageSize`.
Debug callers inspect the raw response framing and `wrb.fr` payload field before nested JSON
decoding, recursively report validation paths, and save only the response body
to a timestamped ignored debug artifact. The validated client is connected to
production sync through `src/classroom-provider.js`. That adapter applies the
fixed import cutoff using `updatedAt` as the accepted publication proxy, maps
due timestamps to the Kyiv calendar, and returns common tasks. Raw responses
remain isolated and are never stored in PostgreSQL.

When the array response does not provide an explicit `alternateLink`, the
provider builds `/c/{courseId}/a/{courseWorkId}/details` with Classroom's
URL-safe route-id codec (the raw ids are encoded before entering the path).
The message formatter also normalizes older raw-id snapshots, and change
detection compares the normalized route so this compatibility repair cannot
create a false Classroom notification.

The Telegram UI optionally appends `authuser={N}` to Classroom links, where `N`
is a validated integer from `0` through `10` stored in `database_meta`. This is
only a browser account-order preference: it does not authenticate an account or
store Google credentials. The preference is applied at render/delivery time,
not to the stored snapshot, so changing it cannot create a content-change
notification.

`getCourses()` loads `/h` through the same authenticated cookie jar and calls
the home-page `gXtzob` RPC with its observed opaque mask. In the live response,
the metadata array contained 37 course records; the protocol discriminator at
record index 20 selected 22 records, exactly matching the visible sidebar set
returned by the browser's `O1Xqee` response. The course id is at record
`[0][0]` and the displayed course name is at `[5]`. No independently verified
teacher-name field was present, so normalized courses use `teacherName: null`.
The implementation does not contain the account's current course ids.

The course smoke-test first obtains this dynamic list and then calls the
paginated `getCourseWorkForCourse()` once per course. Its table reports the
number of decoded assignments, fetched pages, and the newest title selected by
verified `updatedAt`. Live probes found a one-assignment course, a 32-assignment
course, and 86 assignments for the observed course in one page. Two courses
that returned exactly 100 records also returned a continuation; one completed
with 120 unique assignments across two pages. This proves the continuation
mechanism is needed and implemented, but not that the selected route is a
complete published-coursework catalog: the `/a/not-turned-in/all` context
returned 86 records for the observed course, while the course stream context
returned a different six-record slice and the UI exposed an assignment absent
from the not-turned-in response. The web client therefore treats these
responses as provider slices, not as proof that every published coursework
item has been fetched.

Production sync uses `src/classroom-provider.js` to call these operations. For
each course it reads `[1,2]` (not turned in), the confirmed turned-in set
`[3,4,8,10,5,7,9,6,11]` for coverage, and the safe completed/returned set
`[3,4,5,6,7,9,11]`. Membership in either positive set is treated as completed;
that evidence wins over an overlapping `[1,2]` observation, while an
assignment seen only in `[1,2]` is pending. Records absent from all scans are
not inferred to be completed and preserve the previous local status. The
adapter merges non-empty fields from observations with equal `updatedAt`
before status reconciliation, so a sparse provider slice cannot erase a due
date or link from a richer slice. This remains deliberately bounded because
the live investigation found a repeatable gap between the separate filtered
result sets. The adapter filters only newly imported pending/content tasks by
`updatedAt >= 2026-09-01T00:00:00+03:00`, while status refreshes still search
for known older rows and may insert a newly seen completed row without a
notification. It converts `dueAt` to a `targetDate` and `targetTime` in
`Europe/Kyiv`; missing due dates sort after dated tasks and are labeled `Дата
здачі не вказана` in the Telegram list.

### Telegram Bot API

`src/telegram.js` calls these regular Bot API methods:

- `getMe`;
- `sendMessage`;
- `editMessageText`;
- `answerCallbackQuery`;
- `getUpdates`;
- `deleteWebhook`;
- `setMyCommands`;
- `setChatMenuButton`.

The token is used only while building the request URL and is never written to the log. Network errors do not expose the URL that contains the token.

Regular Telegram requests have a 10-second deadline. The bot CLI raises the
client timeout to 35 seconds so it covers Telegram long polling with a
25-second poll timeout and some response overhead. The deadline remains active
through response-body reading, composes with caller cancellation, and reports
timeout/cancellation separately without aborting the caller's external signal.

HTTP 429 is logged with `retry_after` when Telegram returns it. The request does not start an endless retry. Long polling reconnects after temporary failures with a backoff from 1 second to 30 seconds while the process is alive.

## 5. Homework model

### Extraction and deduplication

Each appointment contributes records from `Embed.TargetHomeworks`. The task model keeps only fields needed for comparison, display, and the diary link:

- `targetAppointmentId`;
- `homeworkId` or an array of `homeworkIds`;
- subject;
- description;
- topics;
- assigned date and target date;
- lesson number and start time;
- file count.

A real task is identified by:

```text
fingerprint = JSON.stringify([
  String(targetAppointmentId),
  normalizeDescription(description)
])
```

`normalizeDescription` removes extra spaces and line breaks. As a result, several API records with different `homeworkId` values but the same `targetAppointmentId` and description become one task and one notification.

Classroom uses a different identity because coursework ids are only unique inside
their course:

```text
source = "classroom"
externalId = `${courseId}:${courseWorkId}`
fingerprint = `classroom:${externalId}`
```

Classroom tasks are never deduplicated by title or description. Two courses can
therefore have identical text and still remain two tasks.

### Snapshot and change detection

PostgreSQL stores a compact `snapshot_json`, not the full API response:

```text
source
externalId
subject
topics[]
description
assignedDate
targetDate
targetTime
lessonNumber
startTime
url
updatedAt
filesCount
```

E-school change notifications compare the description, target date, topics, and
other display fields. Classroom change notifications also compare title, due
time, link, and file count; `updatedAt` alone is not a content change. A change
to an E-school technical `homeworkId` alone does not create a notification.

When the description changes, the fingerprint changes too. `findMatch()` first looks for the new fingerprint, then may find exactly one older row with the same `targetAppointmentId`. This keeps the local task id and avoids creating an extra row. If there is more than one candidate, the code does not merge them automatically.

## 6. PostgreSQL and task lifecycle

The active database is a PostgreSQL database addressed by the required
`HOMEWORK_DATABASE_URL`. Neon is the intended hosted instance. The application
uses the pooled Neon connection string and a small `pg.Pool`; no local database
file, Render Persistent Disk, or SQLite fallback is opened by the bot or
`npm run sync`.

`src/homework-db.js` is the public factory and
`src/postgres-homework-db.js` owns the schema and async repository contract.
`src/homework-db-shared.js` contains task validation, JSON conversion, row
mapping, and identity helpers shared by the adapter and tests. Database startup
creates the schema if needed and records schema version 4 in `database_meta`.
It migrates a v3 PostgreSQL schema in place: existing completed rows receive a
conservative `manual` completion origin, while pending rows keep a null origin.
An unsupported future version is rejected. There is intentionally no SQLite
data migration: the move to PostgreSQL starts with a clean PostgreSQL schema,
and the old local SQLite file is neither read nor deleted.

### Tables

`database_meta` stores small process values:

- `database_version` (current PostgreSQL schema version 4);
- `baseline_initialized_at` for E-school and `baseline_initialized_at:classroom` for Classroom;
- `classroom_status_reconciled_at`, written only after a complete, committed Classroom status pass;
- `classroom_authuser_index`, the optional Google account order for rendered Classroom links;
- `telegram_update_offset`.

`homework_tasks` stores:

- `source`, provider-specific `external_id`, and stable `fingerprint`;
- `target_appointment_id` for E-school (empty for Classroom);
- JSON text columns `homework_ids_json` and `snapshot_json`;
- `is_current`, meaning whether the task appeared in the latest API snapshot;
- `status`, either `pending` or `completed`;
- `completion_origin`, either `manual`, `classroom`, or null for an uncompleted task;
- first-seen and last-seen timestamps;
- the last successful Telegram notification timestamp;
- `notification_pending` and `notification_kind` for retrying a failed delivery;
- `completed_at` for history and retention.

All timestamps crossing the database boundary are normalized to UTC ISO 8601
strings. A database declaring a newer unsupported PostgreSQL schema version is
rejected instead of being opened with an incomplete contract.

`status` and `is_current` answer different questions:

- `status = pending` means the task is locally uncompleted;
- `status = completed` means the task is locally completed;
- `completion_origin = manual` means a Telegram decision wins over later Classroom observations;
- `completion_origin = classroom` means the state came from a confirmed Classroom scan;
- `is_current = 1` means the task appeared in the latest complete provider snapshot
  where that provider uses an absence sweep; Classroom deliberately does not use
  absence for this flag because its filtered result sets have a known completeness
  gap.

The current list selects only `is_current = 1 AND status = 'pending'`. The completed history selects every row with `status = 'completed'`, even when that task later disappears from the API.

When an E-school task disappears from the API, sync does not send a deletion
notification. Its row stays in PostgreSQL, but a pending row with
`is_current = 0` is not shown in the current list until the task appears again.
Classroom deliberately does not sweep `is_current` from absence: the live
state-filtered result sets have a known completeness gap, so an absent record is
unknown rather than completed or deleted. Confirmed Classroom completion is
represented by `status = completed`, which removes the task from the current
list without relying on `is_current`.

### First run

On a clean database, the current tasks are stored as the baseline. No Telegram messages are sent for them.

If an old `data/state.json` exists, `bot-sync` validates it, imports its tasks
into PostgreSQL, and also skips notifications for those old tasks. The JSON
file is only a one-time compatibility source; PostgreSQL is the bot's primary
data source.

A damaged JSON file is not silently replaced. `state.js` raises an error with the file path and the reason.

### Regular sync

One provider cycle works like this:

1. Load current tasks from that provider. The Classroom adapter also returns
   confirmed status observations and a completeness marker.
2. Normalize them using the provider identity rules.
3. On the provider's first sync, store a baseline and send nothing. The first
   complete Classroom status reconciliation is also quiet and records
   `classroom_status_reconciled_at` in the same transaction.
4. Build the full match plan before mutating PostgreSQL.
5. In one PostgreSQL transaction, mark only E-school's previous rows
   `is_current = 0`, upsert the new snapshot, apply known Classroom status
   transitions by course-qualified external id, and set `notification_pending`
   when a notification is needed. Classroom absence never sweeps rows.
6. After commit, recheck each pending queue row and send one Telegram message
   for each still-pending task. A completed row's stale notification is cleared
   without being counted as a delivery.
7. Only after Telegram returns success, clear `notification_pending` and write
   `last_notified_at`.

The repository methods are asynchronous because every read and write goes
through PostgreSQL. The production path supplies all match results to the
transaction, so the transaction contains database work only and never waits on
provider or Telegram HTTP.

`syncAllHomeworks()` runs the E-school cycle and then the Classroom cycle. A
provider fetch or delivery error is recorded in the result and logged, while
the other provider still runs. Completed-task cleanup runs once after both
cycles.

Pending tasks are not removed by age. The 14-day rule applies only to completed tasks and uses `completed_at`, not the lesson date or publication date.

### Telegram failure

The task row and notification decision are committed before delivery. If
Telegram returns an error, `notification_pending` remains set; the current
cycle records the delivery failure and the next cycle can try it again. A
provider fetch failure does not overwrite its last committed snapshot, but the
already committed queue is still given a delivery attempt. Before sending, the
queue is rechecked against PostgreSQL; if Classroom has completed that task,
the stale queue flag is cleared without claiming Telegram delivery succeeded.

This gives the system an at-least-once delivery model, not an exactly-once model. If the process stops after Telegram accepts the message but before `last_notified_at` is written, the next cycle may send a duplicate. Telegram and PostgreSQL cannot share one transaction, and this project chooses not to lose a homework notification silently.

## 7. Telegram UI

### Messages

New tasks are sent as separate messages. The formatter includes only non-empty sections: subject, description, topics, target date, lesson/time, and file count. It escapes external text and links, enforces Telegram's 4096-character limit, and falls back to a compact field-preserving message when the full formatted task is too long; the stored snapshot is not truncated.

In lists, the homework title is an HTML link to the source task. E-school uses
`/homework/{homeworkId}` in the diary; Classroom uses an explicit `alternateLink`
when decoded or its direct details URL from the course-qualified ids. Text is
escaped before it is inserted into HTML, and the source label is `(Єдина школа)`
or `(Classroom)`.

### Commands and menu

The bot registers these commands:

```text
/start     open the main menu
/menu      open the main menu
/current   show current homework
/completed show completed homework
/help      show help
```

The standard Telegram Menu button is also enabled with these commands. The
in-chat menu has sections for current tasks, completed tasks, Classroom
account-order settings, and help. The account-order flow accepts only integer
values from `0` through `10` from the configured chat, persists the canonical
number in `database_meta`, and uses `↩️ До меню` to cancel. The help screen uses
a `↩️ До меню` button instead of repeating the main menu.

### Lists and callbacks

Lists are sorted by `targetDate` or `assignedDate`. A page has no more than six tasks, with buttons arranged in two columns.

A current-list button looks like `✅ subject · date · description`. The visible
assignment title/description in list links and task buttons is limited to 50
characters with an ellipsis; the source URL, subject, date, and source label
remain intact. It calls `complete:list:{id}:{page}`, changes the task to
completed, and redraws the current list on the same page.

A completed-list button looks like `❌ subject · date · description`. It calls `uncomplete:list:{id}:{page}`, clears `completed_at`, restores the pending status, and redraws the completed list on the same page. It does not navigate to the current list.

The button in a notification uses `complete:{id}`. It marks the task complete and changes the notification into a completed-task screen with a button back to the menu.

Every callback checks the configured `TELEGRAM_CHAT_ID`. Updates from another chat are ignored. The long-polling offset is stored in PostgreSQL, so already processed update ids are not read again after a restart.

## 8. Entry points

| Command | Behavior |
| --- | --- |
| `npm start` | Smoke-test: login, force a refresh check through `/portal`, fetch the current week, and print tasks to the console. |
| `npm run sync` | One production sync: authenticate the E-school provider as needed, fetch E-school and configured Classroom data, compare with PostgreSQL, deliver queued new/changed tasks, and exit. |
| `npm run bot` | Configure Telegram, run an immediate sync, then poll Telegram and sync every 10 minutes. E-school authentication is protected inside the provider branch, so a Classroom failure does not prevent an independent E-school attempt. The process stays alive. |
| `npm run classroom:smoke` | Load the local authenticated Classroom cookies, verify the web session and bootstrap, call `pONvgf` for `CLASSROOM_COURSE_ID` (default `544644036115`), inspect/save the response in debug mode, decode it, and exit. It does not touch Telegram or PostgreSQL. |
| `npm run classroom:courses:smoke` | Load `/h`, discover the visible courses from `gXtzob` without hardcoded course ids, fetch all available `pONvgf` pages for every course, print `course name | assignments fetched | pages fetched | newest assignment`, and exit. It does not touch Telegram or PostgreSQL. |
| `npm run telegram:test` | Send one diagnostic message to the configured chat. This has an external side effect and should not be run by accident. |
| `npm test` | Run the built-in Node test runner without contacting the real services. |

Only one `npm run bot` instance should run at a time. A second instance receives `409 Conflict` from Telegram because long polling allows one owner for the update stream.

### Render deployment

`render.yaml` defines one free Render Web Service with `npm run bot` as its
start command. `src/health-server.js` answers `GET /healthz` and `HEAD /healthz`
on Render's `PORT`, but stores no application data. Both methods use the same
readiness check and return 200 or 503; HEAD returns headers without a body so
default UptimeRobot HTTP checks work. Other paths and methods return 404.
Readiness reflects the process shutdown state, not provider or Telegram health.
All durable state is in the PostgreSQL
database configured by `HOMEWORK_DATABASE_URL`; no Render Persistent Disk or
local SQLite file is used.

The service is deliberately single-instance because Telegram long polling has
one owner. PostgreSQL is remote and can handle the small pool used by this
process, but horizontal bot replicas are still unsupported. Deployment secrets
are entered in Render rather than committed files: the E-school credentials,
Telegram credentials, the Neon PostgreSQL URL, and the authenticated
`CLASSROOM_COOKIE_HEADER`.

When shutdown is requested, the bot marks `/healthz` unavailable, aborts
Telegram polling and the shared provider/delivery HTTP work, clears the
interval, then waits for a currently running sync promise to drain before its
caller closes the PostgreSQL pool. The local lifecycle tests verify signal
propagation and close ordering; they are not a live Render shutdown check.

The Render Blueprint pins Node.js `24.21.0` and uses
`npm ci && npm test && npm prune --omit=dev` as its build command. The package
engine range is `>=24.21.0 <25`. The build test suite uses only
temporary/in-memory PostgreSQL fixtures and does not authorize providers or
send Telegram messages. An external monitor such as UptimeRobot may request
`/healthz` to reduce free-service sleeping; configuring it is an operator task,
not an application-side integration.

## 9. Security and privacy

- `.env` is not committed and must not appear in command output.
- The Telegram token, password, and cookies are not logged.
- Google client secrets, refresh tokens, and Classroom cookie values are not logged. Local Google credential, token, and cookie files are ignored by Git.
- Invalid Classroom cookie errors identify only a record number; they do not echo cookie names or values. Telegram delivery errors do not include the E-school fingerprint, because it contains homework text.
- The Server Action id is shown only in shortened form.
- `data/state.json` and any old `data/homeworks.sqlite*` files are excluded from Git. PostgreSQL contains homework text, so protect `HOMEWORK_DATABASE_URL` and database access as private.
- Telegram HTML links accept only explicit `http:` or `https:` URLs without embedded credentials; unsafe provider URLs are omitted or replaced with the known E-school diary URL.
- HTTP requests have timeouts.
- Callbacks are accepted only for the configured chat.
- Neon/PostgreSQL transport must use the provider's TLS connection string. Database backups, retention, and access policy remain deployment responsibilities.

## 10. Trade-offs and limitations

### Direct HTTP instead of a browser

The upside is a small dependency set, quick startup, and low memory use for the
E-school, Classroom web, and Telegram paths. The cost is a tight dependency on
hidden Next.js fields, the current diary API, and Classroom bootstrap/RPC
details. A form or private endpoint change will require client changes. The
configured web provider uses an already authenticated cookie session and does
not open a browser during sync. If that session is not configured, the bot
skips Classroom instead of attempting the unavailable official API.

The Classroom web provider depends on an undocumented internal RPC and dynamic
page bootstrap values. It avoids browser automation and administrator-blocked
OAuth approval, but a copied browser cookie session expires and must be
exported again. The provider is isolated at the sync boundary, so a Classroom
failure does not prevent the E-school branch from running.

### Internal Classroom RPC instead of the official API

The upside is that it follows the same data path as the already authenticated
Classroom web interface and does not require administrator-approved OAuth. The
cost is that the RPC is undocumented, its opaque mask and response schema can
change without notice, and a valid HTTP 200 is not sufficient evidence of a
working decoder. The current production policy also uses `updatedAt` as a
publication proxy, so an older assignment edited after the cutoff can be
imported until a verified publication field is available.

### Provider adapters with one task model

Keeping E-school and Classroom as separate provider clients, then mapping both
to one task shape, preserves one Telegram UI and one completion database. The
cost is that identity, date semantics, links, and error handling remain
provider-aware. A single text-based deduplication rule would incorrectly merge
identical Classroom assignments from different courses, so Classroom uses its
course-qualified id.

### Neon PostgreSQL instead of a local database file

PostgreSQL keeps the bot state across Render deploys and free-service restarts
without a paid Persistent Disk, and it gives the service one durable remote
store. The cost is a required external database secret, network availability,
provider limits, and an explicit schema version. The current adapter uses a
small `pg` pool rather than an ORM; test fixtures use `pg-mem` and do not touch
the user's Neon project.

The migration is intentionally a clean PostgreSQL schema rather than an
in-place SQLite migration. The bot does not read or delete the old local
SQLite file. An optional validated `data/state.json` import preserves the
previous JSON baseline without making a file the active store.

### Long polling instead of a webhook

The Web Service exposes only a small `/healthz` endpoint for Render and
optional external monitoring; Telegram still uses long polling. The cost is
that the free service can sleep and two bot instances still cause `409 Conflict`.

### One process for polling and scheduling

One command starts the local bot, and the sync guard prevents overlapping cycles. The cost is that stopping or crashing the process stops both Telegram UI and scheduled parsing. A 24/7 setup needs a process manager or a separate scheduler.

Render supplies the process manager, but it does not solve secret rotation,
Classroom cookie renewal, or Neon database backups/retention. Those remain
operational tasks.

### At-least-once delivery

A Telegram error does not mark the task as delivered, so the next sync can try again. The cost is a possible duplicate after a crash between `sendMessage` and the database update. Telegram and PostgreSQL have no shared transaction.

### Current week instead of the full E-school API history

This keeps API requests and the UI smaller. The cost is that old pending tasks that disappear from the weekly response are not shown in the current list, although their rows stay in PostgreSQL. A full history would need a different API range and a separate archive rule.

### One chat configuration

A single chat keeps access rules simple for the local MVP. The cost is that one database cannot safely serve several students or chats without a user/chat key in the data model.

## 11. Next steps

Before a large change, decide how to handle these items:

- move school id, student id, and API range into configuration;
- add explicit PostgreSQL migrations when schema version 3 needs to change;
- split the scheduler and Telegram worker if several processes are needed;
- add database backup and restore;
- decide whether access should be per user or per chat;
- add an idempotent outbox or Telegram message id if duplicates become a problem;
- add fixture tests for changes in the diary response;
- add a per-provider health/status view for operations;
- move the Classroom home/course-list wire decoder behind a versioned adapter if
  Google changes the internal RPC;
- investigate the route-dependent pONvgf/detail RPCs and compare all relevant
  UI sections before claiming that the paginated response is a complete
  published-coursework catalog;
- decide whether the web client should eventually expose a supported
  reauthentication flow when the browser cookie session expires;
- verify a stable publication timestamp if Google exposes one in a future web
  response;
- add operational refresh/health handling for the browser cookie session.

For the current project, one process, Neon PostgreSQL, and the existing bounded
authentication recovery are enough for the selected free Render deployment
shape. This statement describes the chosen architecture, not live production
readiness.
