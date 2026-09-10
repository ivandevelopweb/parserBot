# HomeworkParser Architecture

## 1. Purpose and scope

HomeworkParser reads homework from Єдина школа and, when configured, Google Classroom; compares it with local state; and sends new or changed assignments to Telegram. Classroom production sync uses the validated web/RPC adapter when an authenticated browser cookie source is configured, while the low-level web client remains isolated behind that adapter.

The project is built for one local process, one Єдина школа account, one optional Google Classroom account, and one configured Telegram chat.

The E-school login, diary access, Classroom API/web calls, and Telegram calls use HTTP clients. The Classroom web path reuses cookies from an already authenticated browser session; it does not implement Google username/password login.

## 2. Data flow

```text
           ┌───────────────────────┐       ┌─────────────────────────┐
           │ Єдина школа auth/API  │       │ Classroom OAuth/API      │
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
                         │ compare + SQLite state  │
                         └───────┬────────┬────────┘
                                 │        │
                      successful │        │ new/changed task
                      delivery   │        ▼
                                 │  ┌───────────────┐
                                 └─►│ Telegram API  │
                                    └───────────────┘

Telegram update → telegram-bot → callback/command → SQLite → edit message
```

In `npm run bot` mode this flow starts once at process startup and then runs every 10 minutes. Telegram long polling runs in the same process. A provider failure is logged and does not prevent the other provider from running.

## 3. Layers and files

| Layer | Files | Responsibility |
| --- | --- | --- |
| Entry points | `src/index.js`, `src/sync-cli.js`, `src/bot-cli.js`, `src/telegram-check.js`, `src/classroom-smoke-cli.js`, `src/classroom-courses-smoke-cli.js` | Load `.env`, assemble dependencies, and start the selected mode. |
| Authentication | `src/auth.js`, `src/classroom-auth.js` | Perform E-school login through the dynamic Next.js Server Action; keep E-school cookies in memory; and create Google OAuth clients from production environment variables or a local token. |
| Diary client | `src/eschool.js` | Bootstrap `seplogin`, fetch the current week from Appointment API, extract homework, and deduplicate it. |
| Classroom client | `src/classroom.js` | List active courses and published coursework through the official read-only API and map it to the common task model. Announcements are not loaded. |
| Classroom web client and provider | `src/classroom-web.js`, `src/classroom-provider.js`, `src/classroom-smoke-cli.js`, `src/classroom-courses-smoke-cli.js` | Load an authenticated browser cookie jar, discover dynamic web bootstrap values and courses from the home-page RPC, call the internal `pONvgf` RPC, decode the confirmed wire shapes, and adapt eligible coursework to the common task model. The low-level transport remains isolated from sync and Telegram. |
| Domain normalization | `src/sync.js`, `src/utils.js` | Build source-aware fingerprints, snapshots, and normalized fields. `sync.js` also contains the original JSON sync path. |
| Bot sync | `src/bot-sync.js` | Run each provider independently, compare the latest API snapshot with SQLite, send new or changed tasks, and remove old completed history. |
| Storage | `src/homework-db.js` | Open SQLite, migrate the v1 table through schema version 3, normalize parseable legacy timestamps to ISO, and store source-aware tasks, statuses, notifications, and the Telegram offset. |
| Legacy storage | `src/state.js` | Read and atomically write compatible `data/state.json`. Bot sync uses this only when importing an old baseline. |
| Telegram transport | `src/telegram.js` | Small Telegram Bot API client built on `fetch`, with no bot framework. |
| Telegram UI | `src/messages.js`, `src/telegram-bot.js` | Format messages, commands, inline keyboards, callbacks, long polling, and the scheduler. |

### Two sync implementations

`src/bot-sync.js` is the active sync path for the Telegram bot and `npm run sync`. `syncAllHomeworks()` runs E-school first and Classroom second when configured, using the same SQLite and Telegram contracts.

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

#### Existing official API adapter

`src/classroom-auth.js` supports two modes:

1. local authorization through `npm run classroom:auth`, which opens a loopback callback in the browser and requests offline consent with the two read-only scopes;
2. production authorization from `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REFRESH_TOKEN`.

The local command reads `google-credentials.json` (with a compatibility fallback for the existing `googlecredentials.json` filename), saves `google-token.json` through a temporary file and rename, and never prints the refresh token. Render must use environment variables and does not require either local file.

`src/classroom.js` lists active courses and then published coursework for each course. It follows `nextPageToken`, ignores announcements, and maps the fields needed by the common task model. It remains available as a compatibility fallback when no web cookie source is configured.

#### Classroom web/RPC client and provider

`src/classroom-web.js` is a separate client for the current Workspace-blocked
OAuth investigation. It accepts a JSON cookie export through
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

`getCourseWorkForCourse(courseId)` currently uses only `pONvgf`. The opaque
numeric request mask is kept in one template, and the supplied course id is
substituted at runtime. The decoder supports both explicit coursework object
fields and the array-only shape confirmed in the live response: the
course-qualified identity pair, title, plain description, and optional due
tuple. It does not guess the meaning of other numeric positions or material
arrays. When the decoded response contains the confirmed opaque continuation
field at `payload[1][1][0]`, the client sends another request with that value
and stops when the field is absent. The loop has a bounded page limit and
rejects a repeated token. A session-expired or bootstrap failure permits one
forced page/bootstrap refresh and one retry of the same RPC; a second such
failure is returned without another refresh. A syntactically valid but
unrecognized coursework payload is also an error, rather than an empty
successful snapshot. A controlled live experiment showed that the first
numeric request field (`100`) changes the maximum returned record count, but
its undocumented protocol meaning is not renamed to `pageSize`. Debug callers
do not substitute smaller values as a discovery strategy: live chains with
`10`, `25`, `50`, and `75` produced different incomplete totals, while `100`
returned the full 86-record slice for the observed course. The implementation
therefore keeps the observed `100` and follows only server-issued continuation
values.
inspect the raw response framing and `wrb.fr` payload field before nested JSON
decoding, recursively report validation paths, and save only the response body
to a timestamped ignored debug artifact. The validated client is connected to
production sync through `src/classroom-provider.js`. That adapter applies the
fixed import cutoff using `updatedAt` as the accepted publication proxy, maps
due timestamps to the Kyiv calendar, and returns common tasks. Raw responses
remain isolated and are never stored in SQLite.

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

Production sync uses `src/classroom-provider.js` to call these two operations,
join each assignment with its dynamically discovered course name, and filter
by `updatedAt >= 2026-09-01T00:00:00+03:00`. Assignments without a valid
`updatedAt` are ignored. The adapter converts `dueAt` to a `targetDate` and
`targetTime` in `Europe/Kyiv`; missing due dates sort after dated tasks and
are labeled `Дата здачі не вказана` in the Telegram list.

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

SQLite stores a compact `snapshot_json`, not the full API response:

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
time, link, file count, and `updateTime`. A change to an E-school technical
`homeworkId` alone does not create a notification.

When the description changes, the fingerprint changes too. `findMatch()` first looks for the new fingerprint, then may find exactly one older row with the same `targetAppointmentId`. This keeps the local task id and avoids creating an extra row. If there is more than one candidate, the code does not merge them automatically.

## 6. SQLite and task lifecycle

The main database file is `data/homeworks.sqlite`. The `data/` directory is created automatically.

### Tables

`database_meta` stores small process values:

- `database_version` (current schema version 3; legacy parseable timestamps are normalized to ISO during migration);
- `baseline_initialized_at` for E-school and `baseline_initialized_at:classroom` for Classroom;
- `telegram_update_offset`.

`homework_tasks` stores:

- `source`, provider-specific `external_id`, and stable `fingerprint`;
- `target_appointment_id` for E-school (empty for Classroom);
- `homework_ids_json` and `snapshot_json`;
- `is_current`, meaning whether the task appeared in the latest API snapshot;
- `status`, either `pending` or `completed`;
- first-seen and last-seen timestamps;
- the last successful Telegram notification timestamp;
- `notification_pending` and `notification_kind` for retrying a failed delivery;
- `completed_at` for history and retention.

All newly written database timestamps are stored as ISO 8601 strings. Opening a
version 1 or 2 database runs the small in-place migration to version 3: valid
legacy date strings are converted, invalid legacy values are preserved rather
than guessed, and conversion counts are available through migration
diagnostics. A database declaring a newer unsupported schema version is
rejected instead of being opened with an incomplete contract.

`status` and `is_current` answer different questions:

- `status = pending` means the user has not marked the task complete;
- `status = completed` means the user pressed the complete button;
- `is_current = 1` means the task appeared in the latest Appointment API response.

The current list selects only `is_current = 1 AND status = 'pending'`. The completed history selects every row with `status = 'completed'`, even when that task later disappears from the API.

When a task disappears from the API, sync does not send a deletion notification. Its row stays in SQLite, but a pending row with `is_current = 0` is not shown in the current list until the task appears again.

### First run

On a clean database, the current tasks are stored as the baseline. No Telegram messages are sent for them.

If an old `data/state.json` exists, `bot-sync` validates it, imports its tasks into SQLite, and also skips notifications for those old tasks. SQLite becomes the bot's primary data source after that import.

A damaged JSON file is not silently replaced. `state.js` raises an error with the file path and the reason.

### Regular sync

One provider cycle works like this:

1. Load current tasks from that provider.
2. Normalize them using the provider identity rules.
3. On the provider's first sync, store a baseline and send nothing.
4. Build the full match plan before mutating SQLite.
5. In one SQLite transaction, mark only that provider's previous rows `is_current = 0`, upsert the new snapshot, and set `notification_pending` when a notification is needed.
6. After commit, read the pending queue and send one Telegram message for each eligible task.
7. Only after Telegram returns success, clear `notification_pending` and write `last_notified_at`.

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
already committed queue is still given a delivery attempt.

This gives the system an at-least-once delivery model, not an exactly-once model. If the process stops after Telegram accepts the message but before `last_notified_at` is written, the next cycle may send a duplicate. The Telegram API and SQLite cannot share one transaction, and this project chooses not to lose a homework notification silently.

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

The standard Telegram Menu button is also enabled with these commands. The in-chat menu has sections for current tasks, completed tasks, and help.

### Lists and callbacks

Lists are sorted by `targetDate` or `assignedDate`. A page has no more than six tasks, with buttons arranged in two columns.

A current-list button looks like `✅ subject · date · description`. The visible
assignment title/description in list links and task buttons is limited to 50
characters with an ellipsis; the source URL, subject, date, and source label
remain intact. It calls `complete:list:{id}:{page}`, changes the task to
completed, and redraws the current list on the same page.

A completed-list button looks like `❌ subject · date · description`. It calls `uncomplete:list:{id}:{page}`, clears `completed_at`, restores the pending status, and redraws the completed list on the same page. It does not navigate to the current list.

The button in a notification uses `complete:{id}`. It marks the task complete and changes the notification into a completed-task screen with a button back to the menu.

Every callback checks the configured `TELEGRAM_CHAT_ID`. Updates from another chat are ignored. The long-polling offset is stored in SQLite, so already processed update ids are not read again after a restart.

## 8. Entry points

| Command | Behavior |
| --- | --- |
| `npm start` | Smoke-test: login, force a refresh check through `/portal`, fetch the current week, and print tasks to the console. |
| `npm run sync` | One production sync: authenticate the E-school provider as needed, fetch E-school and configured Classroom data, compare with SQLite, deliver queued new/changed tasks, and exit. |
| `npm run bot` | Configure Telegram, run an immediate sync, then poll Telegram and sync every 10 minutes. E-school authentication is protected inside the provider branch, so a Classroom failure does not prevent an independent E-school attempt. The process stays alive. |
| `npm run classroom:auth` | Run the local Google OAuth consent flow and save `google-token.json`; do not use this on Render. |
| `npm run classroom:smoke` | Load the local authenticated Classroom cookies, verify the web session and bootstrap, call `pONvgf` for `CLASSROOM_COURSE_ID` (default `544644036115`), inspect/save the response in debug mode, decode it, and exit. It does not touch Telegram or SQLite. |
| `npm run classroom:courses:smoke` | Load `/h`, discover the visible courses from `gXtzob` without hardcoded course ids, fetch all available `pONvgf` pages for every course, print `course name | assignments fetched | pages fetched | newest assignment`, and exit. It does not touch Telegram or SQLite. |
| `npm run telegram:test` | Send one diagnostic message to the configured chat. This has an external side effect and should not be run by accident. |
| `npm test` | Run the built-in Node test runner without contacting the real services. |

Only one `npm run bot` instance should run at a time. A second instance receives `409 Conflict` from Telegram because long polling allows one owner for the update stream.

### Render deployment

`render.yaml` defines one Render Background Worker with `npm run bot` as its
start command. This is a long-lived process, not an HTTP service, so it does
not expose a public port or health endpoint. The deployment uses a Persistent
Disk mounted at `/var/data` and sets
`HOMEWORK_DATABASE_PATH=/var/data/homeworks.sqlite`; without that variable the
local default remains `data/homeworks.sqlite`.

The worker is deliberately single-instance. Telegram long polling has one
owner, and SQLite is not a multi-writer shared database. The Render plan must
support Persistent Disk, and horizontal scaling is not supported. Deployment
secrets are entered in Render rather than committed files: the E-school
credentials, Telegram credentials, and the authenticated
`CLASSROOM_COOKIE_HEADER`.

When shutdown is requested, the bot aborts Telegram polling and the shared
provider/delivery HTTP work, clears the interval, then waits for a currently
running sync promise to drain before its caller closes the database. The
Blueprint sets a 120-second Render shutdown budget. The local lifecycle tests
verify signal propagation and database-close ordering; they are not a live
Render shutdown check.

The Render Blueprint pins Node.js `24.21.0` and uses
`npm ci --omit=dev && npm test` as its build command. The package engine range
is `>=24.21.0 <25`; this keeps the worker on the tested Node.js 24 LTS line,
where `node:sqlite` is available without an experimental startup flag. The
build test suite uses only temporary/in-memory fixtures and does not authorize
providers or send Telegram messages.

## 9. Security and privacy

- `.env` is not committed and must not appear in command output.
- The Telegram token, password, and cookies are not logged.
- Google client secrets, refresh tokens, and Classroom cookie values are not logged. Local Google credential, token, and cookie files are ignored by Git.
- Invalid Classroom cookie errors identify only a record number; they do not echo cookie names or values. Telegram delivery errors do not include the E-school fingerprint, because it contains homework text.
- The Server Action id is shown only in shortened form.
- `data/homeworks.sqlite` and `data/state.json` are excluded from Git. The database contains homework text, so treat the file as private.
- Telegram HTML links accept only explicit `http:` or `https:` URLs without embedded credentials; unsafe provider URLs are omitted or replaced with the known E-school diary URL.
- HTTP requests have timeouts.
- Callbacks are accepted only for the configured chat.
- SQLite is not encrypted. File access on the host protects it.

## 10. Trade-offs and limitations

### Direct HTTP instead of a browser

The upside is a small dependency set, quick startup, and low memory use for the
E-school, Classroom web, and Telegram paths. The cost is a tight dependency on
hidden Next.js fields, the current diary API, and Classroom bootstrap/RPC
details. A form or private endpoint change will require client changes. The
official Classroom OAuth adapter remains available as a compatibility fallback,
while the configured web provider uses an already authenticated cookie session
and does not open a browser during sync.

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

### SQLite instead of an external database

SQLite keeps state across restarts, makes list queries simple, and needs no separate server. The cost is that the process is tied to one local disk. There is no replication, remote access, or automatic backup.

### Render Persistent Disk instead of ephemeral worker storage

The Persistent Disk keeps SQLite state across Render deploys and restarts with
minimal operational complexity. The cost is a paid, single-instance worker,
no horizontal scaling, and no built-in replication or backup. Only the mounted
`/var/data` path is durable; source files and other paths remain disposable.

### Built-in `node:sqlite` instead of an ORM

No ORM package is needed, and the schema stays visible in `homework-db.js`.
The worker is pinned to the tested Node.js 24 LTS range (`24.21.0` or later
24.x patch below 25). The schema version is recorded, and the v1-to-v3
source/timestamp migration is intentionally small; parseable legacy timestamp
values are converted to ISO while invalid values are preserved and counted for
diagnostics. A separate migration runner is still not needed for this
one-process MVP.

### Long polling instead of a webhook

No public HTTPS endpoint or reverse proxy is needed. The cost is that the process must stay alive, and two instances cause `409 Conflict`.

### One process for polling and scheduling

One command starts the local bot, and the sync guard prevents overlapping cycles. The cost is that stopping or crashing the process stops both Telegram UI and scheduled parsing. A 24/7 setup needs a process manager or a separate scheduler.

The Render worker supplies that process manager, but it does not solve secret
rotation, Classroom cookie renewal, or database backups. Those remain
operational tasks.

### At-least-once delivery

A Telegram error does not mark the task as delivered, so the next sync can try again. The cost is a possible duplicate after a crash between `sendMessage` and the database update. Telegram and SQLite have no shared transaction.

### Current week instead of the full E-school API history

This keeps API requests and the UI smaller. The cost is that old pending tasks that disappear from the weekly response are not shown in the current list, although their rows stay in SQLite. A full history would need a different API range and a separate archive rule.

### One chat configuration

A single chat keeps access rules simple for the local MVP. The cost is that one database cannot safely serve several students or chats without a user/chat key in the data model.

## 11. Next steps

Before a large change, decide how to handle these items:

- move school id, student id, and API range into configuration;
- add real SQLite migrations;
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
- decide whether the web client should eventually replace or supplement the
  official API fallback;
- verify a stable publication timestamp if Google exposes one in a future web
  response;
- add operational refresh/health handling for the browser cookie session.

For the current project, one process, SQLite, and the existing bounded authentication recovery are enough.
