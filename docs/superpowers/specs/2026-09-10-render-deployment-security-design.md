# Render Deployment and Security Hardening Design

## Status

Approved for implementation on 2026-09-10.

## Goal

Prepare HomeworkParser for a private Render Background Worker deployment while
preserving the existing E-school, validated Classroom web provider, SQLite
task lifecycle, and Telegram interface.

## Deployment shape

Use one Render Background Worker running `npm run bot`. The worker keeps the
existing long-polling Telegram process and ten-minute sync interval. A Render
Persistent Disk is mounted at `/var/data`, and the database path is supplied
through `HOMEWORK_DATABASE_PATH` so task state and the Telegram update offset
survive worker restarts.

The deployment manifest must declare secret environment variables without
values. Required secrets are the E-school credentials and Telegram token/chat
id. Classroom uses `CLASSROOM_COOKIE_HEADER` as the preferred production
secret; the existing JSON/file and official OAuth fallback paths remain
available but are not required by the web deployment. The local `.env`, Google
credential files, cookie exports, SQLite database, state file, and raw debug
responses are never copied into deployment configuration.

A Persistent Disk requires a Render plan that supports disks. A diskless/free
worker is not an acceptable production option because SQLite state would be
lost after a restart.

## Cleanup scope

Remove only generated local artifacts already identified by inspection:

- `data/classroom-pONvgf-response*.debug.txt`;
- `data/test-debug.tmp`;
- empty `output/playwright` directories.

Keep `.env`, `google-credentials.json`, `data/homeworks.sqlite`,
`data/state.json`, `data/.gitkeep`, and all source/test/documentation files.
The existing database currently contains zero completed tasks and seventeen
current tasks, so no database rows need to be removed. The existing retention
rule remains: only completed tasks older than fourteen days are deleted; no
pending task is deleted by age.

## Security hardening

Make the following focused changes:

1. Do not include Classroom cookie names in cookie-import errors.
2. Do not include the E-school fingerprint in legacy Telegram delivery errors,
   because that fingerprint contains normalized homework text.
3. Accept only `http` and `https` explicit homework links before rendering
   them as Telegram HTML anchors; keep HTML escaping in place.
4. Make shutdown wait for an active sync before the SQLite connection is
   closed, preventing a SIGTERM during network delivery from racing database
   cleanup.
5. Add ignore rules for deployment/debug temporary files and document the
   secret, persistent-disk, and cookie-session requirements.

No credentials, cookie values or names, task contents, auth URLs, or database
rows are printed or placed in deployment files.

## Verification

Add regression coverage for the new URL/error/shutdown contracts where the
existing test seams allow it. Run:

- `npm test`;
- `npm audit --omit=dev`;
- a deployment-package inspection that confirms local secrets and private data
  are excluded.

Do not run `npm run sync`, `npm run bot`, or `npm run telegram:test` as part of
this change. Those commands have live external effects; the already running
local bot is not restarted automatically.

## Trade-offs

The single worker and local SQLite remain the smallest operational model and
fit one student and one Telegram chat. Persistent Disk adds a paid Render
requirement and does not provide replication or backup. The Classroom browser
cookie remains a high-value, expiring secret that must be rotated manually;
the deployment will fail clearly when it expires rather than attempting a
Google password login. The hardening changes intentionally avoid a broad
rewrite of the working provider clients.
