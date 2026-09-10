# Єдина школа Node.js smoke-test client

## Goal

Create a small Node.js 20+ JavaScript client that proves the complete
browserless authentication flow for `eschool-ua.com`, can refresh an expired
session cookie through `/portal`, and can load and deduplicate homework from
the diary Appointment API. This project deliberately excludes Telegram and
Google Classroom integrations.

## Architecture

- `src/auth.js` owns one shared cookie-aware fetch client, login-page parsing,
  the Next.js Server Action multipart login request, cookie validation, and
  the `/portal` session refresh flow.
- `src/eschool.js` owns current-week date calculation, Appointment API access,
  the diary `seplogin` bootstrap required to obtain `application_token`,
  extraction of `Embed.TargetHomeworks`, deduplication, and bounded recovery
  (`/portal` refresh, then one full login).
- `src/utils.js` contains token masking, homework-description normalization,
  date/formatting helpers, and shared error helpers.
- `src/index.js` runs the smoke-test sequence and renders concise, readable
  homework output.

The implementation uses Node's built-in `fetch` and `FormData`, with
`fetch-cookie` and `tough-cookie` supplying a shared jar across both
`eschool-ua.com` and `diary.eschool-ua.com`. `cheerio` parses the login HTML,
and `dotenv` loads credentials from the local `.env` file at runtime.

## Authentication data flow

1. `GET https://eschool-ua.com/login` with redirects enabled.
2. Parse `$ACTION_REF_1`, `$ACTION_1:0`, `$ACTION_1:1`, `$ACTION_KEY`, and
   `from` from the form. Parse the JSON-encoded `$ACTION_1:0` value and use
   its dynamic `id` as `next-action`.
3. Submit multipart `POST /login` with the exact observed field names:
   `1_` prefixes for all form fields and a final unprefixed `0` field. Let
   `FormData` generate the `Content-Type` boundary.
4. Preserve cookies across redirects and verify `refresh_token` and
   `session_token` exist in the jar. Logs expose only masked token values.
5. `refreshSession()` calls `GET /portal`; success requires a
   `session_token` in the jar.

The current diary frontend also performs `GET` and `POST
/api/v1/seplogin` on `diary.eschool-ua.com` after the e-school login. The
client reproduces this HTTP-only binding step for school `8276`; the POST
sets the diary-scoped `application_token` cookie that the current Appointment
gateway requires in addition to the shared e-school cookies.

## Appointment and homework flow

The default range is Monday through Sunday of the current calendar week in
`Europe/Kyiv`. The client requests the fixed school and schoolboy IDs with
the specified `embed` and `fileRole` query parameters. The response parser
accepts both the requested Appointment-array shape and the current diary
shape, where the array is in `Items`.

Every appointment contributes `appointment.Embed?.TargetHomeworks ?? []`.
Each output record retains homework ID(s), subject, topic(s), description,
assigned date, target date, lesson number, start time, and file count.

Records are grouped by `TargetAppointmentId + normalized Description`, where
normalization trims text, converts line breaks to spaces, and collapses runs
of whitespace. A group contains unique `topics` and `homeworkIds` arrays.

## Error handling

The Appointment request is retried at most twice after the initial request:

1. On HTTP 401/403 or an expired-session response, call `/portal` and retry
   once.
2. If that refresh fails, perform one full login and retry once.
3. Any remaining HTTP or protocol failure becomes a clear error with status
   and endpoint context; no unbounded retry loop is allowed.

## Security and configuration

- Credentials are read only from `ESCHOOL_USERNAME` and `ESCHOOL_PASSWORD`.
- `.env` is ignored by Git and `.env.example` contains empty placeholders.
- Passwords, cookies, and full tokens are never logged.
- Token logs use the first 8 and last 6 characters, with a short placeholder
  for missing or unusually short values.

## Verification

The project will be validated with local deterministic checks for login-form
parsing, date calculation, token masking, homework normalization, and
deduplication. After those checks, the executable will be run against the
real service using the existing local `.env`; the final report will state
whether full login, session refresh, and Appointment API access succeeded,
including the number of raw and unique homework records.
