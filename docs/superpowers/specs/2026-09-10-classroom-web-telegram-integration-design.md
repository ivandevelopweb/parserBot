# Classroom Web Integration with Telegram Design

- Date: 2026-09-10
- Status: Approved and implemented
- Scope: connect the validated Classroom web/RPC provider to the existing SQLite, sync, and Telegram layers
- Non-goal: change the existing Єдина школа auth/API or redesign the Telegram interface

## 1. Context

HomeworkParser already has a working Єдина школа provider, a source-aware SQLite
task table, a combined syncAllHomeworks() flow, and one Telegram interface for
current and completed homework. The Classroom web client has now been validated
against the authenticated browser session: it discovers courses dynamically,
fetches paginated pONvgf coursework, and decodes the current array response
shape.

The official Classroom OAuth adapter remains in the repository for compatibility,
but this integration uses the already authenticated Classroom web session because
the user's Google Workspace administrator blocks the official OAuth application.
The web/RPC transport remains isolated from the common domain and persistence
code.

## 2. Decisions

### Provider

Use the Classroom web/RPC client as the production Classroom source when a web
cookie secret is configured. Existing CLASSROOM_COOKIE_HEADER,
CLASSROOM_COOKIES_JSON, and CLASSROOM_COOKIES_FILE support remains intact.
If no web cookie source is configured, retain the existing official Classroom
adapter as a compatibility fallback. When both are configured, web cookies take
precedence.

### Import cutoff

The user selected updatedAt as the current proxy for publication time. The
cutoff is inclusive:

~~~
updatedAt >= 2026-09-01 00:00:00 Europe/Kyiv
~~~

The adapter compares instants, so the equivalent September 1 midnight offset is
used rather than comparing display strings. An assignment with a missing or
invalid updatedAt cannot be proven to meet the cutoff and is ignored. A known
limitation is that an older assignment edited after the cutoff will be included;
this is the accepted trade-off until a verified publication field is available
from the web response.

Assignments before the cutoff are filtered out before common sync. They are not
stored as pending tasks, do not appear in Telegram, and do not generate
notifications. This avoids adding an ignored database status solely for a
provider policy that can be applied deterministically on every fetch. Existing
rows from an earlier Classroom/API run are never deleted by this feature; the
normal source-current logic can leave such rows non-current.

### First import

The first successful Classroom sync uses the existing provider-specific baseline
behavior. All eligible post-cutoff tasks are inserted as current pending rows,
but no Telegram messages are sent for them. Subsequent syncs notify one new or
changed task at a time. This preserves the existing no-mass-notification
invariant while making all eligible tasks immediately visible through /current.

## 3. Alternatives

### A. Separate web provider adapter over the common task contract (selected)

Add a small adapter/factory around classroom-web.js. It discovers courses,
fetches all paginated coursework, applies the cutoff, enriches each assignment
with the course name, maps due data, and returns normalized common tasks. The
existing bot-sync, SQLite, and Telegram UI then handle the result exactly like
the official Classroom provider.

Benefits:

- keeps HTTP/RPC framing separate from business rules;
- changes the two CLI assembly points rather than the working E-school path;
- reuses existing source-aware identity, notification, and completion behavior;
- leaves the official adapter available as a fallback.

Cost:

- the web provider depends on an undocumented RPC and an expiring browser
  session;
- the adapter must maintain a small translation layer for due dates and links.

### B. Put sync policy inside classroom-web.js

This would be shorter initially, but would mix raw RPC transport, response
decoding, account configuration, and product rules. It would make future route or
schema changes harder to test independently.

### C. Run a separate Classroom importer process

The importer would write rows to SQLite and the normal bot would only render
them. This duplicates scheduling and error boundaries, makes first-run behavior
less obvious, and is unnecessary for the one-process local MVP.

## 4. Components and boundaries

### classroom-web.js

No auth, request, bootstrap, RPC, pagination, or decoder behavior is changed by
the integration. The existing public operations remain the source boundary:

- getCourses() returns dynamically discovered course ids and names;
- getCourseWorkForCourse(courseId) returns the decoded coursework slice for a
  course, including assignmentId, courseId, title, description, dueAt, and
  updatedAt.

### New Classroom web provider adapter

The adapter exposes the same high-level shape expected by syncAllHomeworks():

~~~
{
  async getClassroomHomeworks() {
    return normalizedTasks;
  }
}
~~~

For each dynamically discovered course it calls the existing paginated
coursework method, filters by the cutoff, and maps the result to toSyncTask().
The adapter does not know about SQLite or Telegram.

### Provider factory / entry points

bot-cli.js and sync-cli.js use one configuration helper. The helper selects the
web adapter when a cookie header, cookie JSON, or existing cookie file is
configured; otherwise it uses the existing official adapter. No credentials or
cookie values are printed while making this choice.

The injected classroom contract in createTelegramBot() and the provider
contract in syncAllHomeworks() stay unchanged. Existing tests can continue to
inject a fake Classroom provider.

### bot-sync.js and homework-db.js

No schema migration is required. The current source/external-id columns,
source-specific baseline key, source-specific current flags, snapshots, and
notification-pending state already support both sources.

The combined sync remains sequential: Єдина школа first, Classroom second. A
Classroom fetch or delivery failure is caught at its existing provider boundary
and cannot prevent an E-school attempt. The Classroom source is marked non-current
only after its fetch has succeeded, so a failed fetch does not erase the last
known current view.

## 5. Common task mapping

Each eligible web assignment is mapped as follows:

~~~
{
  source: 'classroom',
  externalId: 'courseId:assignmentId',
  fingerprint: 'classroom:courseId:assignmentId',
  courseId,
  courseWorkId: assignmentId,
  subject: course.name || 'Classroom',
  title,
  description,
  topics: [],
  targetDate,
  targetTime,
  assignedDate: null,
  lessonNumber: null,
  startTime: null,
  url,
  filesCount,
  updatedAt
}
~~~

The adapter passes this through the existing toSyncTask() function. Classroom
identity is never deduplicated by title or description. Equal text in two
courses remains two tasks.

### Assignment link

The current array-only pONvgf decoder does not expose a verified alternateLink
field. The adapter therefore uses the deterministic Classroom details route
based on the already identified ids, encoded with Classroom's URL-safe route
codec:

~~~
https://classroom.google.com/c/{encodedCourseId}/a/{encodedAssignmentId}/details
~~~

If a future decoder exposes an explicit link, that value takes precedence. The
existing Telegram formatter HTML-escapes this link and displays (Classroom);
Єдина школа links remain unchanged.

### Description and attachments

The adapter preserves the decoded title and description separately. It passes
through only attachments that the decoder has identified reliably. The current
array response intentionally returns an empty attachment list when the material
positions are ambiguous, so the adapter must not invent file counts.

## 6. Due-date behavior

dueAt is converted to targetDate and targetTime in Europe/Kyiv. The calendar date
is used for grouping and sorting, and the local time is used in the task/detail
notification when available. A missing dueAt produces:

~~~
targetDate: null
targetTime: null
~~~

The existing list sort places null-date tasks after all dated tasks. The common
list heading for that group is changed to:

~~~
📅 Дата здачі не вказана · N
~~~

Notifications and task cards use the same wording in the date position when no
deadline is available. This is presentation-only; no artificial date is stored.

## 7. Sync and persistence flow

One combined cycle is:

1. authenticate Єдину школу and fetch its current tasks;
2. fetch Classroom courses through the authenticated cookie client;
3. fetch paginated coursework for every discovered course;
4. apply the inclusive updatedAt cutoff;
5. map eligible assignments to common tasks;
6. run the existing Classroom provider baseline/compare logic;
7. write compact snapshots, not raw Classroom responses;
8. send one Telegram message for each new/changed task;
9. record delivery success only after the Bot API succeeds;
10. run the existing completed-task cleanup.

On Telegram failure, the SQLite row remains notification_pending with no
last_notified_at, so the next sync can retry. There is no infinite retry inside
one HTTP request.

The Classroom snapshot contains the fields needed for the current UI and change
detection: source, course-qualified external id, subject, title, description,
target date/time, link, update time, and file count. The raw batchexecute body is
not copied to SQLite.

## 8. Telegram behavior

No second menu, command set, or callback family is introduced. Classroom tasks
are rendered beside Єдина школа tasks in the existing combined lists.

- current tasks remain grouped by targetDate and paginated six per page;
- dated Classroom tasks are interleaved with E-school tasks by date;
- undated Classroom tasks are last under Дата здачі не вказана;
- Classroom links display (Classroom) and open the Classroom details page;
- the existing complete button and completed-list cross work for both sources;
- changed/new notifications continue to be one message per task.

The current Telegram HTML escaping and configured-chat callback checks remain in
place.

## 9. Error handling and secrets

- The web client keeps its existing timeout and bounded pagination limit.
- Expired Classroom cookies produce the existing clear session-expired error.
- A Classroom error is logged as a provider failure without exposing cookies,
  bootstrap values, or request headers.
- Missing/invalid updatedAt records are counted only in safe aggregate logs if
  diagnostics are useful; no task text or auth data is logged.
- CLASSROOM_COOKIE_HEADER, JSON cookies, token values, and Google OAuth values
  never appear in logs, tests, or documentation.
- The bot continues to use one long-polling process and its existing overlap
  guard.

## 10. Tests

Add or update unit tests for:

- web assignments being enriched with the dynamically returned course name;
- inclusive September 1 cutoff and exclusion of older/missing timestamps;
- course-qualified Classroom fingerprint and canonical details link;
- due timestamp conversion to Kyiv date/time;
- missing due date sorting/rendering as Дата здачі не вказана;
- combined E-school plus Classroom tasks in one SQLite-backed sync;
- first web-Classroom sync creating a baseline without notifications;
- later web-Classroom task producing one notification and no duplicate on repeat;
- changed Classroom content updating the same row;
- Classroom delivery failure leaving notification pending;
- web provider selection when cookie configuration is present, while official
  fallback remains available;
- existing E-school tests, callbacks, retention, and all Classroom RPC tests.

No unit test contacts Google or Telegram. The standard check is:

~~~
npm test
~~~

## 11. Acceptance and rollout

After implementation:

1. run npm test;
2. verify the web provider is selected without printing the cookie secret;
3. run the real one-shot sync only when the operator confirms the external side
   effect is acceptable;
4. confirm the first Classroom baseline stores eligible tasks without sending
   the existing archive as new messages;
5. confirm /current shows Classroom and Єдина школа tasks together, sorted by
   due date;
6. confirm an undated Classroom task is last and labeled Дата здачі не вказана;
7. confirm later new/changed Classroom tasks use one Telegram message each.

The web provider still has the known limitation that updatedAt is a proxy for
publication time, and that the current pONvgf slice has not proven a universal
published-coursework catalog beyond the dynamically fetched pages observed in
the live course smoke-test.
