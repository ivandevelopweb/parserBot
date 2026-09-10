# Luna remediation results

Статус на 2026-09-10: исправления по `docs/luna-remediation-plan.md`
завершены локально. Offline-проверки ниже не являются живой
проверкой готовности к production: реальные аккаунты, Telegram, Render и
Classroom smoke/auth не запускались.

## Исходная точка

- Локальный runtime: Node.js `v24.12.0`, npm `11.6.2`.
- До исправлений: `npm test` — 102/102; `npm audit --omit=dev` — 0 известных
  уязвимостей.
- Личная БД, `.env`, Google credentials, cookie-файлы и работающий бот не
  открывались для исправлений и не вошли в Git snapshot.
- По прямой просьбе пользователя создан безопасный Git snapshot и отправлен в
  `origin/main`: commit `b44739e` (`chore: capture pre-remediation snapshot`).
  Это единственное отклонение от пункта плана, запрещавшего автоматическую
  инициализацию Git; локального репозитория до этого не было.
- После этого snapshot новые изменения в GitHub не отправлялись.

## Таблица findings

| Finding | Регрессионное доказательство | Исправление | Проверка | Ограничение |
| --- | --- | --- | --- | --- |
| F1 | `test/runtime.test.js` проверяет Node 24.21+ и `node:sqlite` без флага | `package.json`, lockfile и `render.yaml` согласованы на Node `24.21.0`; Render build запускает тесты | Target Node `v24.21.0`: runtime smoke и полный прогон 138/138; clean `npm ci --omit=dev` и target-node `npm test` 138/138 в отдельной копии | Render deploy сам не запускался |
| F2 | `test/classroom-web.test.js`: malformed JSON, CRLF raw header, network error; `test/classroom-auth.test.js`: credential/token JSON; `test/classroom-provider.test.js`: полный sync logger; `test/telegram.test.js`: token-bearing network cause | Стабильные ошибки без parser/error text, raw Cookie validation до `Headers.set`, безопасный network status, без sensitive `cause` | Security/Classroom profile: 54/54; Telegram network regression; полный прогон 138/138 | Live-логи и уже опубликованные секреты не проверялись; при реальной утечке нужна ротация |
| F3 | `test/bot-sync.test.js`: two tasks per appointment, one changed task, ambiguous two-task change, normalized duplicate | Full-set `findMatches()` reserves exact identities first and allows appointment fallback only for one unused old + one unused new; provider input deduplicates identities before writes | F3 pattern profile: 5/5; full прогон 138/138; both current rows and stable ids verified | Already-merged data from an older version cannot be reconstructed automatically |
| F4 | `test/bot-sync.test.js`: first delivery failure with 3 current tasks, disappeared pending task, provider fetch failure, 429 pacing, mid-write rollback; `test/homework-db.test.js`: reopen queue | `applyProviderSnapshot()` commits source snapshot and notification flags atomically; separate DB queue delivery continues after commit and retries pending rows independently | F4 pattern profile: 6/6; full прогон 138/138; queue, rollback, reopen, delivery counts and 429 call count checked | At-least-once remains: crash after Bot API success and before DB acknowledgement can duplicate |
| F5 | `test/homework-db.test.js`: ISO writes, v2→v3 migration, invalid-value preservation, future-version rejection; `test/telegram-bot.test.js`: callback Date | Schema version 3; all new timestamps normalize to ISO; valid legacy values migrate, invalid values remain diagnosable, newer schemas fail closed | F5 pattern profile: 5/5; full прогон 138/138 | Existing invalid legacy timestamp values remain unchanged; this is offline migration evidence, not a live database upgrade |
| F6 | `test/telegram.test.js` and `test/classroom-web.test.js`: body-read deadlines and cancellation; `test/telegram-bot.test.js`: startup/active-sync stop; `test/auth.test.js`: default E-school deadline | Internal request deadline remains through response-body read and composes with caller signal; safe timeout/abort codes; active bot sync receives the shutdown signal | F6/F8 lifecycle profile: 12/12; full прогон 138/138 | Google SDK request timeout remains outside this wrapper by design; no live network check |
| F7 | `test/messages.test.js`: long escaped fields and long/unsafe links; `test/bot-sync.test.js`: long E-school description plus next delivery | Telegram formatter keeps output ≤4096, never cuts HTML links/tags, omits unsafe/too-long URLs, and preserves the full DB snapshot | F7 pattern profile: 3/3; full прогон 138/138 | Compact formatting is a bounded fallback; rendering in the Telegram client was not exercised |
| F8 | `test/telegram-bot.test.js`: stop during startup and active sync | One shared AbortSignal stops polling/provider/delivery work; startup checks prevent late `deleteWebhook`, sync, or scheduler actions; Render sets a 120-second shutdown budget | F6/F8 lifecycle profile: 12/12; full прогон 138/138 | No deploy or live SIGTERM was run; process-manager behavior remains an operational limit |
| F9 | `test/classroom-web.test.js`: recognized empty payload, unknown payload, one refresh, no refresh loop; `test/classroom.test.js`: response failure keeps SQLite snapshot | Unknown decoded structures fail closed; session/bootstrap refresh is bounded to one retry; provider failure leaves the prior committed snapshot intact | F9 pattern profile: 5/5; full прогон 138/138 | Internal Google RPC is undocumented and was not exercised during this remediation |
| F10 | `test/classroom-web.test.js`: invalid cookie domain must report indexed ConfigError | `records.entries()` and sanitized indexed error | Security/Classroom profile: 54/54 | Cookie jar использует только искусственные fixtures |

## Выполненные этапы

### 1. Утечки и cookie-конфигурация — F2, F10

Изменены `src/classroom-web.js`, `src/classroom-auth.js`, `src/telegram.js` и
профильные тесты.

- Ошибки разбора cookie/credential/token JSON больше не включают исходный текст
  парсера, путь с искусственным маркером или sensitive input.
- Raw `Cookie` header проверяет control characters, имена и значения до
  создания/установки `Headers`; корректные пары и значения с `=` сохранены.
- Ошибки HTTP fetch получают безопасное сообщение и не сохраняют исходный
  network error как `cause`.
- Ошибка cookie jar использует корректный индекс записи и не содержит имени или
  значения cookie.
- Проверен полный текст логов `syncAllHomeworks`, а не только исходный error.

Проверено локально:

```text
node --disable-warning=ExperimentalWarning --test \
  test/classroom-web.test.js test/classroom-auth.test.js
46 passed, 0 failed

node --disable-warning=ExperimentalWarning --test test/classroom-provider.test.js
8 passed, 0 failed
```

### 3. Однозначное сопоставление E-school — F3

Изменены `src/homework-db.js`, `src/bot-sync.js` и `test/bot-sync.test.js`.

- Сопоставление теперь строится для всего нормализованного набора до
  `markSourceNotCurrent` и любых upsert-записей.
- Сначала резервируются точные fingerprint/external-id совпадения.
- Fallback по appointment id выполняется только при ровно одном свободном
  старом кандидате и ровно одном свободном новом задании.
- Два разных задания одного урока сохраняются отдельными строками; повторный
  неизменный набор не создаёт уведомлений; изменение одного задания сохраняет
  id обеих строк.
- Одинаковый нормализованный fingerprint в одном ответе провайдера хранится
  один раз; Classroom остаётся course-qualified.

Проверено локально: F3 pattern profile — 5/5; полный целевой прогон —
138/138.

### 4. Транзакционный снимок и очередь доставки — F4

Изменены `src/homework-db.js`, `src/bot-sync.js` и профильные тесты.

- До записи провайдера строится полный match plan; затем
  `applyProviderSnapshot` выполняет mark-current, upsert задач и постановку
  notification queue в одной SQLite-транзакции без сетевых `await` внутри.
- Telegram вызывается только после commit и читает `pendingNotifications` из
  БД, поэтому задача, исчезнувшая из следующего provider response, всё равно
  получает повторную попытку.
- Ошибка одной доставки оставляет только её `notification_pending` и не
  скрывает остальные задачи; 429 останавливает дальнейшие попытки текущего
  цикла, не создавая burst запросов.
- Ошибка fetch/decode сначала пытается доставить ранее committed queue и не
  меняет последний снимок; исходная ошибка провайдера всё равно возвращается
  вызывающему слою.
- Transaction rollback и reopen SQLite проверены на искусственной ошибке и
  временном файле; личная БД не использовалась.

Проверено локально: F4 pattern profile — 6/6; полный целевой прогон —
138/138.

### 5. Даты и миграция SQLite — F5

Изменён `src/homework-db.js` и добавлены проверки в `test/homework-db.test.js` и
`test/telegram-bot.test.js`.

- Новые и изменяемые timestamps записываются как ISO 8601.
- Версия схемы повышена до 3. При открытии v1/v2 parseable legacy dates
  конвертируются в ISO в транзакции; непонятные значения не угадываются и
  сохраняются для диагностики.
- База с версией новее поддерживаемой не открывается молча.
- Cleanup и Telegram callback используют одинаковый безопасный формат даты.

Проверено локально: F5 pattern profile — 5/5; полный целевой прогон —
138/138. Тесты используют
временные SQLite-файлы; личная БД не открывалась.

### 6. Лимит Telegram-сообщения — F7

Изменены `src/messages.js`, профильные тесты и тест bot-sync.

- Полный HTML сначала строится с экранированием, затем при необходимости
  заменяется компактным вариантом не длиннее 4096 символов.
- Обрезание не разрывает HTML-теги или `<a>` и не оставляет одинокую ссылку.
- Небезопасная или слишком длинная ссылка пропускается; полный snapshot не
  сокращается в БД.
- После длинного E-school сообщения следующий pending task всё равно получает
  отдельную попытку доставки.

Проверено локально: F7 pattern profile — 3/3; полный целевой прогон —
138/138.

### 7. Таймауты и остановка — F6, F8

Изменены `src/telegram.js`, `src/classroom-web.js`, `src/eschool.js`,
`src/auth.js`, `src/classroom-provider.js`, `src/bot-sync.js`,
`src/telegram-bot.js`, CLI entry points и `render.yaml`.

- Deadline остаётся активным не только для `fetch`, но и при чтении response
  body.
- Внешняя отмена комбинируется с внутренним таймером без аборта сигнала
  вызывающего кода; timeout и cancellation получают стабильные коды.
- Один AbortSignal проходит от остановки бота до polling, provider HTTP и
  Telegram delivery.
- Stop до завершения startup не запускает поздние webhook/sync/scheduler
  действия; stop во время sync прерывает активную работу перед закрытием БД.
- Render-конфигурация задаёт `maxShutdownDelaySeconds: 120`.

Проверено локально: F6/F8 lifecycle pattern profile — 12/12; полный целевой
прогон — 138/138. Профиль пересекается с другими файлами намеренно, чтобы
проверить сквозное распространение сигнала.
Официальный Google SDK timeout специально не подменялся: утверждённый план
оставляет его отдельным ограничением. Live SIGTERM, Render и реальные HTTP не
запускались.

### 8. Защита Classroom decoder и bounded refresh — F9

Изменены `src/classroom-web.js`, `src/classroom.test.js` и профильные тесты.

- Валидный пустой список assignments принимается, но неизвестная структура
  ответа не превращается в успешный пустой snapshot.
- После `CLASSROOM_SESSION_EXPIRED` или bootstrap failure разрешён один forced
  reload и повтор того же RPC. Второй сбой не запускает новый цикл.
- Ошибка Classroom до commit сохраняет прежний SQLite snapshot; E-school
  ветка не теряет независимую попытку.
- OAuth/API fallback, hardcoded course ids и live Classroom requests в рамках
  remediation не добавлялись.

Проверено локально: F9 pattern profile — 5/5; полный целевой прогон —
138/138.

## Финальные offline-проверки

Команды запускаются с отдельным Node.js `v24.21.0` и искусственными/temp
fixtures. Они не читают личную БД, не авторизуются, не вызывают реальный
Telegram/Classroom/E-school, не выполняют deploy и не отправляют push:

```text
target Node.js v24.21.0 / npm 11.19.0: npm test       -> 138 passed, 0 failed
target npm audit --omit=dev                           -> found 0 vulnerabilities
clean copy: npm ci --omit=dev + target npm test       -> 138 passed, 0 failed
```

These offline checks are regression evidence for the changed contracts, not a
live production-readiness check. Remaining limits are: no live provider
contract check, no Render deploy/shutdown observation, no Telegram client
rendering check, no credential rotation or secret-history audit, and no
automatic repair of invalid legacy timestamp values.

## Render Blueprint compatibility follow-up

При предварительной проверке Blueprint Render отклонил конфигурацию с ошибкой
`maxShutdownDelaySeconds` вместе с Persistent Disk. Для сохранения диска
`maxShutdownDelaySeconds` удалён из `render.yaml`; build/start-команды,
`HOMEWORK_DATABASE_PATH=/var/data/homeworks.sqlite` и сам диск сохранены.
Это изменение проверено только по локальной конфигурации и ещё не является
результатом deploy или live production-проверки.
