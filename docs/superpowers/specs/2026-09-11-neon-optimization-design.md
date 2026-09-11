# Neon optimization design

Date: 2026-09-11  
Status: approved in chat before implementation

## Goal and boundaries

Reduce PostgreSQL result volume, SQL round trips, and unnecessary task writes in
the active `bot-sync` path. Preserve E-school and Classroom identity rules,
provider isolation, status precedence, retention/tombstones, initial
reconciliation, and at-least-once Telegram delivery.

The current E-school visibility contract remains unchanged: the current list is
based on the latest complete 14-day provider snapshot and `is_current`. This
work does not turn the list into a history of every pending task. No production
process, Telegram message, Neon setting, or Render service is changed by the
implementation or benchmark.

## Chosen approach

Use PostgreSQL as the only durable task/queue store, with bounded batch reads,
conditional writes, and an in-memory diagnostic view owned by the running bot.
Do not add a durable task cache, scan token column, or schema migration. A
scan-token design would make `last_seen_at` exact but would require more writes;
a memory task cache would make callbacks and restart recovery unsafe.

The implementation is split into these layers:

| Layer | Change |
| --- | --- |
| Provider boundary | Mark a successfully validated E-school response complete; reject malformed or explicitly partial snapshots before storage. Keep valid empty snapshots. |
| `bot-sync` | Build one match input set for content and Classroom status observations, compute storage and notification decisions separately, return provider metrics, and publish compact in-memory diagnostics through the bot. |
| PostgreSQL adapter | Resolve matches in bounded batches; merge Classroom content/status work into one row operation; update only changed data; sweep only absent E-school ids; select only source-specific pending queue rows. |
| Telegram scheduler | Parse `HOMEWORK_SYNC_INTERVAL_MINUTES`, retain immediate first sync/non-overlap/cancellation behavior, and expose diagnostics without database reads. |
| Health server/CLI | Serve the last in-memory diagnostic snapshot for GET; keep HEAD and readiness DB-free and preserve shutdown 503 behavior. |
| Tests/benchmark/docs | Add regression coverage, a repeatable pg-mem benchmark, before/after artifacts, checklist completion, and rollout/rollback instructions. |

## Data flow and transaction boundaries

Each provider cycle follows this sequence:

1. Fetch and validate the provider result outside a database transaction.
2. Normalize and deduplicate tasks using the existing source-specific rules.
   E-school identity remains `targetAppointmentId + normalized description`;
   Classroom identity remains the course-qualified external id.
3. Resolve all content tasks and status-only Classroom observations with
   bounded batch SELECTs. Preserve input order in the returned match list and
   reserve each database row id at most once.
4. Start one short PostgreSQL transaction. Lock or re-read the matched rows
   needed by the plan, calculate the final current state, insert/update only
   rows whose stored values differ, apply one combined Classroom content/status
   operation per external id, and update provider metadata at most once.
   Provider HTTP and Telegram calls never occur in this transaction.
5. For a complete E-school snapshot, mark only current E-school rows whose ids
   are absent from the complete plan. A complete empty snapshot therefore
   hides all previous current E-school rows. Classroom has no absence sweep.
6. Commit the snapshot and notification decisions.
7. Load the pending queue filtered by `source`, recheck each row immediately
   before delivery, send through Telegram, and clear the queue only after the
   Bot API call succeeds. A Telegram failure leaves the row pending.

The transaction uses current database status when applying a task. A callback
that completes a row while a plan is being prepared cannot be overwritten by a
content update, and a completed row cannot receive a newly queued notification
from a stale plan. Manual completion/restoration continues to take precedence
over automatic Classroom status observations.

## Matching

`findMatches()` deduplicates the input by the existing task identity, then
queries distinct keys in batches no larger than the implementation constant
and below PostgreSQL's parameter limit. It performs three source-aware lookup
phases:

1. `source + external_id` for Classroom and any external E-school identity;
2. `source + fingerprint`;
3. E-school `target_appointment_id` candidates for tasks still unmatched.

Each query returns the columns needed to reconstruct a task, not unrelated
rows. Appointment fallback is assigned only when exactly one current input
task has that appointment and exactly one unreserved database candidate exists
across the complete candidate set. Source isolation and reserved row ids are
preserved. Classroom never uses description/title matching.

Status-only Classroom entries are included in the same match input set as
content entries. The final database plan is keyed by the course-qualified
external id, so a row observed in both plans is written once.

## Storage and notification comparison

The storage comparator covers source, identity fields, normalized description,
homework ids, and the compact snapshot. It also treats a transition from
non-current to current as a required write. An unchanged current task does not
rewrite its JSON, identity, status, notification flags, `updated_at`, or
`last_seen_at`.

The notification comparator covers user-visible fields: source, subject/title,
description, assigned and target dates, target time, lesson number, start time,
topics, canonical URL, and file count. Provider technical `updatedAt` is stored
when it changes but does not by itself notify Classroom; E-school technical id
changes do not notify. A storage-only change is allowed to be quiet.

`last_seen_at` means the last observation that was durably persisted for that
row. It is intentionally not the exact time of every successful provider scan;
unchanged rows may retain an older value. `updated_at` means the last durable
task/status/queue mutation and is never presented as an observation timestamp.
The exact successful provider-sync time is kept in compact per-provider sync
status metadata and in the returned metrics. This removes the false implication
that an unchanged row was individually written during every scan.

## E-school snapshot safety

The Appointment response boundary accepts a JSON array in the already
supported locations. A valid empty array is complete. A present but malformed
`Embed.TargetHomeworks` collection, a malformed appointment/homework item, or
an E-school homework without a non-empty `TargetAppointmentId` is a provider
data error. It fails before baseline, matching, sweep, or task writes. The
existing fingerprint formula is not changed.

An explicit `snapshotComplete: false` is rejected for an active sync; absence of
the optional marker on the existing valid task-array contract remains complete.
Classroom retains its existing explicit complete/recognized validation. A
provider error preserves the previous snapshot and still permits the already
committed notification queue to be attempted.

## Diagnostics and schedule

The bot owns an in-memory status map for E-school and Classroom. It starts as
unknown, records attempt/result time, task count, provider status, metrics,
delivery errors, and last successful snapshot time, and returns a sanitized
copy to `/healthz` GET. Health diagnostics do not query PostgreSQL. HEAD returns
only readiness headers/body semantics as before. Readiness remains process
shutdown state, not provider health.

`HOMEWORK_SYNC_INTERVAL_MINUTES` accepts only an integer from 5 through 60;
missing means 10 minutes. `render.yaml` documents 20 minutes as the prepared
economy profile. Stale is based on the configured interval with a bounded grace
period and a minimum of 30 minutes, so a 60-minute schedule is not marked stale
after only 30 minutes. The first sync remains immediate, cycles cannot overlap,
and stop aborts polling/provider work and drains the active sync.

## Metrics

Every provider result contains compact aggregates:

- `observed`: unique eligible normalized tasks in the provider snapshot;
- `inserted`: new rows actually inserted;
- `changed`: existing rows whose stored snapshot/identity/current state changed;
- `unchanged`: observed rows with no storage change (status-only transitions
  are not counted as snapshot changes);
- `markedNotCurrent`: rows made non-current by the complete E-school sweep;
- `statusTransitions`: actual pending/completed transitions applied by the
  Classroom reconciliation;
- `notificationsQueued`: new/changed decisions committed;
- `notificationsSent`: successful Telegram deliveries;
- `durationMs`: elapsed provider cycle time.

An entry observed in both Classroom content and status inputs contributes once
to `observed`, `changed`, or `unchanged`; its status transition is a separate
counter, never a second content observation. Logs contain counts and durations
only, never task text, fingerprints, SQL parameters, cookies, tokens, or
connection strings.

## Verification and benchmark

Add tests for health GET/HEAD with a database object that would fail if read,
batch lookup query counts and ordering, source isolation, ambiguous fallback,
unchanged writes, silent storage changes, combined Classroom updates, callback
race protection, complete/partial/empty E-school snapshots, status/manual
precedence, queue retry, retention/tombstones, restart, and schedule parsing.

The benchmark uses artificial E-school and Classroom tasks, including a large
set and long descriptions, with a fresh pg-mem database per provider run. It
executes the same sequence for the current HEAD implementation and the
optimized implementation: baseline, unchanged repeat, one content change,
missing task, and Classroom status change. It records SQL calls, rows returned,
rows changed, and UTF-8 JSON result sizes as an approximation. It explicitly
labels those sizes as neither PostgreSQL wire bytes nor Neon counters. Results
are reported separately for E-school, Classroom, and combined totals.

The local Node 24.12.0 environment is below the repository's required
`>=24.21.0 <25` engine. The implementation must not weaken that contract; the
full `npm test` result will report this environment limitation unless a
supported Node 24.21+ runtime is available.

## Schema, rollout, and rollback

No schema version or migration is planned. Existing v5 data, metadata,
notification rows, and tombstones remain valid. No index is added unless the
benchmark proves a query-plan need; the benchmark itself is not treated as
production Neon telemetry.

Before rollout, run `npm test` on Node 24.21+, review benchmark artifacts, make a
database backup according to the operator's Neon policy, set
`HOMEWORK_SYNC_INTERVAL_MINUTES=20` in Render, and ensure exactly one bot
instance owns Telegram long polling. Observe the first sync logs and queue
state without sending a test message. For rollback, stop the new instance
before starting the old one, restore the previous application revision and
interval, and keep the v5 database; the old code is expected to understand the
unchanged schema. Never run two polling owners concurrently.

After a real rollout, compare Neon public network transfer and CU-hours for a
precisely recorded 24–72 hour window, including compute sleep time. Also verify
no missing current tasks, pending queue growth, duplicate notifications, or
provider failures. Thirty-day and 31-day projections are estimates until those
post-rollout measurements exist.
