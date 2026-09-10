# Google Classroom Integration Design

- Date: 2026-09-09
- Status: Approved direction, awaiting written-spec review
- Scope: add Google Classroom as a second homework provider
- Non-goal: change the existing eSchool authentication or Telegram UX without a compatibility need

## 1. Context

HomeworkParser already reads the current week's homework from Єдина школа, stores task state in SQLite, and exposes one Telegram interface with current and completed lists.

The new provider must fit into that interface. A Classroom task is another normalized homework task with a source-specific identity and link, not a separate Telegram object.

The current bot is intentionally stopped while this change is built. It must not run during the database migration or the first Classroom baseline setup.

## 2. Goals

The implementation must:

- use the official Google Classroom API through googleapis;
- use only read-only Classroom scopes;
- support one-time local OAuth through npm run classroom:auth;
- support Render runtime configuration through GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN;
- use google-token.json only as a local runtime fallback;
- read active courses and visible course work;
- normalize Classroom tasks into the same internal task shape used by eSchool;
- store both providers in the existing SQLite database;
- preserve current/completed state for existing eSchool rows;
- use a stable Classroom key based on course id and courseWork id;
- baseline old Classroom tasks without sending one message per old task;
- send one Telegram notification per new or changed task after the baseline;
- keep the existing Telegram menu, list layout, pagination, completion flow, and source link behavior;
- let one provider fail without stopping the other provider;
- leave announcements out of this change.

## 3. Non-goals

This change will not:

- add Google Classroom write scopes;
- create or edit Classroom coursework;
- add Classroom announcements;
- scrape Classroom with Playwright, Puppeteer, or HTML parsing;
- create a second Telegram menu or a second database;
- deploy to Render;
- change the eSchool fingerprint rule;
- remove the current npm start smoke-test;
- redesign the current or completed Telegram screens.

## 4. Design options

### Option A: provider adapters with one shared task store

Each provider has its own API client and normalization code. Both produce the same internal task shape, and a provider-aware sync layer writes to one SQLite table.

Pros:

- small change to the existing Telegram layer;
- one completion/history model;
- one database and one pagination path;
- provider failures can be isolated;
- future providers can use the same adapter boundary.

Cost:

- the database needs a safe source-aware migration;
- sync logic must distinguish provider identity and change rules.

### Option B: separate SQLite tables with a union query

eSchool and Classroom would have separate tables, and the Telegram layer would read a SQL union.

Pros:

- provider schemas can differ freely;
- source-specific fields are easy to keep apart.

Cost:

- current/completed operations need two writes or a union layer;
- callback ids need provider routing;
- migrations and list queries become harder to follow;
- future providers add more table-specific code.

### Option C: independent provider databases and an event layer

Each provider would own its database and emit events into a notification outbox.

Pros:

- good isolation for multiple accounts or separate workers;
- a later server deployment would have a clear delivery boundary.

Cost:

- too much machinery for one local process;
- completion state would need a cross-provider identity layer;
- the current bot would be changed more than the feature needs.

### Decision

Use Option A. It keeps the existing UI and task lifecycle intact while giving each source a clear API and identity boundary.

## 5. Module boundaries

### classroom-auth.js

Responsibilities:

- resolve local credentials from google-credentials.json;
- resolve production credentials from environment variables;
- resolve a local fallback token from google-token.json;
- create an OAuth2 client;
- perform the one-time browser authorization;
- save the local token with restrictive file permissions;
- avoid logging client secrets and tokens.

The auth module exposes a configured Google auth client, not raw access tokens.

### classroom.js

Responsibilities:

- create the official Classroom API client;
- list active courses for the authorized student;
- list visible published course work for each active course;
- paginate API responses;
- normalize course work to common tasks;
- build the Classroom fingerprint;
- count known materials;
- preserve alternateLink when Google returns it.

The provider does not know about Telegram or SQLite.

### homework-db.js

Responsibilities after the migration:

- store a task source and external id;
- find a task within its source;
- mark only one source's rows as not current;
- keep current and completed queries combined across sources;
- retain existing eSchool rows and their statuses;
- retain notification-pending state.

### bot-sync.js

Responsibilities after the refactor:

- sync one normalized provider result at a time;
- keep provider baselines separate;
- apply provider-specific change rules;
- send and record notifications using the existing delivery contract;
- expose syncAllHomeworks() with independent eSchool and Classroom error handling.

### messages.js

Responsibilities after the extension:

- render both sources using the current list and notification layouts;
- use the existing eSchool diary URL for eSchool;
- use Classroom alternateLink for Classroom;
- display (Єдина школа) or (Classroom) in the source position;
- keep HTML escaping and current keyboard dimensions.

### Entry points

- classroom-auth-cli.js backs npm run classroom:auth;
- sync-cli.js creates both providers and runs syncAllHomeworks();
- bot-cli.js creates both providers and passes them to the bot;
- index.js remains the eSchool smoke-test.

The auth helper may be kept inside classroom.js if the boundary stays clear. The command-line auth entry point remains separate.

## 6. Common normalized task

Both providers produce a task with this shape:

```js
{
  source: 'eschool' | 'classroom',
  externalId: string,
  fingerprint: string,
  subject: string,
  title: string,
  description: string,
  topics: string[],
  targetDate: string | null,
  targetTime: string | null,
  assignedDate: string | null,
  lessonNumber: number | null,
  startTime: string | null,
  url: string | null,
  filesCount: number,
  updatedAt: string | null,
  homeworkIds: string[]
}
```

The persisted snapshot must contain every value needed for display, identity, change detection, and completion.

### eSchool mapping

The current eSchool extraction and dedupe behavior stays in place:

- source is eschool;
- externalId is derived from the existing eSchool identity;
- fingerprint remains based on targetAppointmentId plus normalized description;
- the diary homework URL remains the link;
- the current visible text and notification layout stay compatible;
- existing homeworkId and grouped homeworkIds remain available.

### Classroom mapping

For each published visible course work:

- source is classroom;
- externalId is courseId:courseWorkId;
- fingerprint is classroom:courseId:courseWorkId;
- subject is the course name;
- title is courseWork.title;
- description is courseWork.description, or the title when the description is empty;
- topics is an empty array for now;
- targetDate comes from dueDate;
- targetTime comes from dueTime;
- url is courseWork.alternateLink, when present;
- updatedAt is courseWork.updateTime;
- filesCount is the count of material entries that can be identified.

The title and description remain separate in the normalized shape even when the current eSchool UI has no separate title field. The formatter avoids printing the same value twice for eSchool.

### Date and time

Google due dates are converted to a stable calendar date, not a JavaScript timestamp that can shift the day through local timezone conversion. A due time is formatted as a local HH:mm value from the Google fields.

When dueDate is absent, targetDate stays null. The Telegram formatter shows Термін не вказано in the existing date position rather than inventing a deadline.

## 7. Google OAuth

### Scopes

Request only:

```text
https://www.googleapis.com/auth/classroom.courses.readonly
https://www.googleapis.com/auth/classroom.coursework.me.readonly
```

No write scope is allowed.

### Local authorization

npm run classroom:auth will:

1. read the desktop client file google-credentials.json;
2. open the local browser consent flow;
3. request offline access with consent so a refresh token can be issued;
4. let the user choose the school Google account;
5. save the token to google-token.json;
6. print safe next-step instructions for Render.

The token file is written with restrictive permissions and through a temporary file plus rename. The command does not print a full refresh token during normal output. It states where the token was saved and explains that its value must be copied into the Render secret store by the operator.

The output names the required Render variables:

```env
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REFRESH_TOKEN=
```

The client id and client secret can be taken from the desktop credentials file. The refresh token is stored in google-token.json. If Google does not issue one, the command explains that offline access and an explicit consent prompt are required, then returns a clear error.

### Production authorization

Normal npm run bot and npm run sync do not require either local Google JSON file when all three environment variables are present.

The production path creates an OAuth2 client with client id and client secret and sets the refresh token. The Google library obtains access tokens when needed.

The local path may use google-token.json when environment credentials are absent. A missing Classroom configuration is reported as a disabled provider, not as a reason to break the eSchool provider. Once OAuth is configured, each full sync runs both providers.

### Credential files

The following files are local-only:

- google-credentials.json;
- google-token.json.

Both must be added to .gitignore. The implementation must never print their contents.

## 8. Classroom API behavior

The provider will:

1. list only active courses;
2. list course work for each course;
3. keep published work that the authorized student can see;
4. ignore draft and deleted work;
5. follow pagination for courses and course work;
6. return an empty task list when there is no visible course work.

The provider will not fetch announcements or mutate Classroom.

The provider keeps the course name with each course-work item because it is the user-facing subject.

A temporary Google API failure, such as HTTP 500, is returned as a provider error with a safe message. It must not prevent eSchool from being synced in the same cycle.

## 9. Identity, deduplication, and updates

### eSchool

The existing eSchool rule remains:

```text
JSON.stringify([
  String(targetAppointmentId),
  normalizeDescription(description)
])
```

Different eSchool homework ids that describe one real task still become one row and one notification.

### Classroom

Classroom is never deduplicated by text. The stable key is:

```text
classroom:courseId:courseWorkId
```

Two courses with the same courseWorkId therefore remain separate tasks.

A change to updateTime or to stored Classroom content is an update to the same row. It must not create a new row. The Classroom comparison includes at least:

- title;
- description;
- due date;
- due time;
- alternate link;
- material count;
- update time.

The source is part of every lookup, so an eSchool row and a Classroom row cannot match by accident.

## 10. SQLite migration

### Schema changes

Add these fields to homework_tasks:

- source TEXT NOT NULL;
- external_id TEXT.

The existing fingerprint unique constraint remains. New source-aware indexes support lookup by source and external id.

Existing rows are migrated with source = eschool. Their status, is_current, completion timestamp, notification state, snapshot, and timestamps remain unchanged. Existing rows may have a null external id until the next eSchool observation fills it.

The database version increases. Database initialization inspects the current columns before applying additive ALTER TABLE statements. The migration must be safe to run more than once.

### Provider-aware metadata

The existing eSchool baseline metadata remains readable. New provider-specific baseline keys are used:

```text
baseline_initialized_at:eschool
baseline_initialized_at:classroom
```

For compatibility, the old unscoped eSchool baseline key is treated as the eSchool baseline during migration.

### Provider-aware current state

A sync cycle marks only the rows belonging to the provider being processed as not current. Classroom processing must never hide eSchool rows, and eSchool processing must never hide Classroom rows.

The existing combined currentTasks() and completedTasks() methods remain the source for Telegram lists. They return tasks from both sources with the same status rules.

## 11. Sync design

### One provider cycle

A provider cycle will:

1. fetch and normalize that provider's tasks;
2. check the provider baseline metadata;
3. if there is no baseline, write all fetched tasks as baseline and send nothing;
4. otherwise mark only that provider's old rows as not current;
5. match by source and stable identity;
6. update the snapshot;
7. classify the task as new, changed, or unchanged;
8. write the row with notification-pending state before delivery;
9. send one message for a new or changed task;
10. clear notification-pending only after Telegram succeeds.

A failed delivery keeps the pending state, so a later cycle can try again.

### Combined sync

syncAllHomeworks() processes eSchool and Classroom as separate provider operations. A failure is caught at the provider boundary, logged with the provider name, and recorded in the result. The other provider still runs.

The result includes per-provider status, counts, and failures so:

- the long-running bot can log a partial failure and continue;
- the one-shot CLI can report a non-zero result to a scheduler if a provider failed;
- a skipped, unconfigured Classroom provider can be distinguished from an API failure.

The order is eSchool first, Classroom second. This keeps the current eSchool path familiar and makes shared SQLite writes sequential.

Overlapping bot sync cycles remain blocked by the existing syncInProgress guard.

### First Classroom sync

The first successful Classroom fetch sets only the Classroom baseline. Existing Classroom course work is stored as pending/current rows, but no old task notifications are sent.

Tasks discovered on later successful Classroom syncs are eligible for one new-task notification. Updates to those rows use the update notification.

If Classroom fails before its baseline is written, no Classroom baseline is recorded. The next successful fetch can initialize it.

## 12. Telegram rendering

No separate Classroom UI is added.

### Lists

The existing list formatter remains responsible for:

- date grouping;
- pagination;
- two-column completion buttons;
- current/completed views;
- same-page refresh after completion changes.

The source label is added to the linked task title:

- eSchool: (Єдина школа);
- Classroom: (Classroom).

For Classroom, the linked title points to alternateLink. If the link is absent, the title is plain text. Existing eSchool links continue to point to the diary homework page.

### Notifications and task screens

The current message structure remains. Classroom messages use the course name as subject, the title and description as task content, the due date/time when available, and the source label (Classroom).

The source label must not replace or hide the existing eSchool label. Empty sections remain omitted.

If materials can be counted, the existing attachment-count line is used. The layout is not expanded into a second menu or a new interaction model.

### Completion

The same SQLite completion operations apply to both sources:

- complete moves a task to completed history;
- uncomplete clears completed_at and returns the task to pending;
- the completed list stays open after the restore action;
- retention removes completed rows after 14 days by completed_at;
- pending rows are not age-pruned.

## 13. Error handling and security

- Use HTTP timeouts for Google API calls.
- Do not add endless retry. Let the Google client handle token refresh, and let the sync layer report provider failures.
- Do not log client secrets, access tokens, refresh tokens, authorization codes, or credential file contents.
- Never include a token in an error URL or error message.
- Keep google-credentials.json and google-token.json out of Git.
- Keep the existing Telegram chat allowlist and message escaping.
- Preserve eSchool session recovery unchanged unless an integration test shows a direct conflict.
- A Classroom error must be visible in logs and must not be mistaken for a successful baseline.
- A database migration failure must stop before the bot starts polling.

## 14. Testing plan

Add tests for:

- reading desktop credential shapes without logging secrets;
- production OAuth configuration from environment variables;
- Classroom course-work normalization;
- due date and due time conversion;
- missing due date rendering;
- material count;
- active-course and published-course-work filtering;
- pagination of courses and course work;
- distinct fingerprints for equal course-work ids in different courses;
- repeat Classroom sync with no duplicate notification;
- updateTime or content change updating the same row;
- first Classroom sync creating a baseline with no mass delivery;
- provider failure isolation, proving eSchool still syncs when Classroom fails;
- SQLite migration preserving an existing eSchool completed row and current row;
- source-specific current flags;
- Classroom and eSchool links and source labels in the existing Telegram list;
- current eSchool tests and all existing tests.

The normal local check remains:

```powershell
npm test
```

## 15. Acceptance and real validation

After implementation:

1. run npm test;
2. run npm run classroom:auth;
3. complete OAuth in the browser with the school Google account;
4. call the real Classroom API;
5. print only safe counts and a few non-secret task fields:

```text
[Classroom]
Courses: N
CourseWork: N
```

6. run the combined sync;
7. confirm that the first successful Classroom sync created a baseline without a mass Telegram delivery;
8. confirm that Classroom tasks appear in the existing current list with (Classroom) links;
9. confirm that a later new or changed task produces one Telegram notification;
10. start the bot only after the migration and real checks are complete.

The current workspace does not contain google-credentials.json, so the OAuth and real Classroom checks are blocked until the user places that file in the project root.

## 16. Render preparation

Do not deploy yet.

After local validation:

- add the three Google variables to .env.example;
- document that Render needs only the environment variables, not either local JSON file;
- keep the local credential files ignored;
- verify that the bot can start without local Google files when the Render variables are set.

## 17. Rollback and operational notes

The migration is additive and must preserve existing rows. Before applying it to a non-test database, stop the bot and make a copy of data/homeworks.sqlite.

If the Classroom provider fails, the bot can continue with eSchool. If the database migration fails, do not delete the database as a workaround. Restore the backup, fix the migration, and rerun tests.

Announcements, write scopes, multi-account support, and Render deployment remain separate follow-up work.



