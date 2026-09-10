# Luna remediation results

Статус на 2026-09-10: исправления по `docs/luna-remediation-plan.md`
завершены локально; после этого по отдельному решению пользователя выполнен
переезд активного хранилища с SQLite на PostgreSQL/Neon и изменена бесплатная
форма Render-деплоя. Offline-проверки ниже не являются живой проверкой
готовности к production: реальные аккаунты, Telegram, Neon, Render и
Classroom smoke/auth не запускались.
По отдельной просьбе пользователя после отката декодера выполнен только
read-only Classroom web/RPC probe с уже настроенной cookie-сессией: без записи
в PostgreSQL, Telegram, запуска второго bot-процесса, деплоя и push. Это не
является живой проверкой готовности к production.

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
- Локальные изменения переезда на PostgreSQL не коммитились и не отправлялись
  в GitHub; пользователь отдельно запретил push и деплой для этой работы.

## Таблица findings

Примечание: числа `138/138` в исторических этапах ниже относятся к
предыдущему security-remediation прогону до смены хранилища. Актуальные
результаты после перехода на PostgreSQL приведены в разделе «Переезд» ниже.

| Finding | Регрессионное доказательство | Исправление | Проверка | Ограничение |
| --- | --- | --- | --- | --- |
| F1 | `test/runtime.test.js` проверяет Node 24.21+ и конфигурацию Render | `package.json`, lockfile и `render.yaml` согласованы на Node `24.21.0`; Render build запускает тесты; сервис переведён на free Web Service | Target Node `v24.21.0`: runtime contract и полный прогон 138/138; clean target install и `npm audit --omit=dev` также прошли | Render deploy не запускался |
| F2 | `test/classroom-web.test.js`: malformed JSON, CRLF raw header, network error; `test/classroom-auth.test.js`: credential/token JSON; `test/classroom-provider.test.js`: полный sync logger; `test/telegram.test.js`: token-bearing network cause | Стабильные ошибки без parser/error text, raw Cookie validation до `Headers.set`, безопасный network status, без sensitive `cause` | Security/Classroom profile: 54/54; Telegram network regression; полный прогон 138/138 | Live-логи и уже опубликованные секреты не проверялись; при реальной утечке нужна ротация |
| F3 | `test/bot-sync.test.js`: two tasks per appointment, one changed task, ambiguous two-task change, normalized duplicate | Full-set `findMatches()` reserves exact identities first and allows appointment fallback only for one unused old + one unused new; provider input deduplicates identities before writes | F3 pattern profile: 5/5; full прогон 138/138; both current rows and stable ids verified | Already-merged data from an older version cannot be reconstructed automatically |
| F4 | `test/bot-sync.test.js`: first delivery failure with 3 current tasks, disappeared pending task, provider fetch failure, 429 pacing, mid-write rollback; `test/postgres-homework-db.test.js`: PostgreSQL queue lifecycle | `applyProviderSnapshot()` commits source snapshot and notification flags atomically; separate DB queue delivery continues after commit and retries pending rows independently | F4 pattern profile: 6/6; PostgreSQL adapter and full sync tests pass on `pg-mem`; queue, rollback, delivery counts and 429 call count checked | At-least-once remains: crash after Bot API success and before DB acknowledgement can duplicate |
| F5 | `test/postgres-homework-db.test.js`: ISO writes, schema version guard, cleanup and reopen-style lifecycle; `test/telegram-bot.test.js`: callback Date | New PostgreSQL schema version 3; all timestamps normalize to ISO; future schema versions fail closed; no SQLite migration is attempted | PostgreSQL lifecycle profile passes; old local SQLite is neither read nor deleted | Existing SQLite rows are not migrated automatically; the selected migration starts with a clean Neon schema and optional JSON baseline import |
| F6 | `test/telegram.test.js` and `test/classroom-web.test.js`: body-read deadlines and cancellation; `test/telegram-bot.test.js`: startup/active-sync stop; `test/auth.test.js`: default E-school deadline | Internal request deadline remains through response-body read and composes with caller signal; safe timeout/abort codes; active bot sync receives the shutdown signal | F6/F8 lifecycle profile: 12/12; full прогон 138/138 | Google SDK request timeout remains outside this wrapper by design; no live network check |
| F7 | `test/messages.test.js`: long escaped fields and long/unsafe links; `test/bot-sync.test.js`: long E-school description plus next delivery | Telegram formatter keeps output ≤4096, never cuts HTML links/tags, omits unsafe/too-long URLs, and preserves the full DB snapshot | F7 pattern profile: 3/3; full прогон 138/138 | Compact formatting is a bounded fallback; rendering in the Telegram client was not exercised |
| F8 | `test/telegram-bot.test.js`: stop during startup and active sync | One shared AbortSignal stops polling/provider/delivery work; startup checks prevent late `deleteWebhook`, sync, or scheduler actions; free Render service reports `/healthz` unavailable during shutdown | F6/F8 lifecycle profile passes; health server has 200/503 regression tests | No deploy or live SIGTERM was run; process-manager behavior remains an operational limit |
| F9 | `test/classroom-web.test.js`: valid empty payload, legacy unknown-payload behavior, one refresh, no refresh loop; `test/classroom.test.js`: response failure keeps PostgreSQL snapshot | Classroom decoder restored to its legacy tolerant behavior; session/bootstrap refresh is bounded to one retry; provider failure leaves the prior committed snapshot intact | Classroom profile: 60/60; PostgreSQL snapshot regression passes; отдельный read-only live probe получил 22 курса и 847 записей, 9 прошло cutoff | Internal Google RPC is undocumented; unknown payloads intentionally produce an empty result instead of inventing fields |
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

Изменены `src/homework-db.js`, `src/postgres-homework-db.js`, `src/bot-sync.js`
и профильные тесты.

- До записи провайдера строится полный match plan; затем
  `applyProviderSnapshot` выполняет mark-current, upsert задач и постановку
  notification queue в одной PostgreSQL-транзакции без сетевых `await` внутри.
- Telegram вызывается только после commit и читает `pendingNotifications` из
  БД, поэтому задача, исчезнувшая из следующего provider response, всё равно
  получает повторную попытку.
- Ошибка одной доставки оставляет только её `notification_pending` и не
  скрывает остальные задачи; 429 останавливает дальнейшие попытки текущего
  цикла, не создавая burst запросов.
- Ошибка fetch/decode сначала пытается доставить ранее committed queue и не
  меняет последний снимок; исходная ошибка провайдера всё равно возвращается
  вызывающему слою.
- Transaction rollback и PostgreSQL lifecycle проверены на искусственной ошибке
  и `pg-mem`; Neon и личная БД не использовались.

Проверено локально: F4 pattern profile — 6/6; полный целевой прогон —
138/138.

### 5. Даты и PostgreSQL schema guard — F5

Изменены `src/homework-db.js`, `src/postgres-homework-db.js` и добавлены
проверки в `test/postgres-homework-db.test.js` и `test/telegram-bot.test.js`.

- Новые и изменяемые timestamps записываются как ISO 8601.
- PostgreSQL schema version зафиксирована на 3; база с версией новее
  поддерживаемой не открывается молча.
- Переезд намеренно не выполняет SQLite-to-PostgreSQL миграцию: старый файл не
  читается и не удаляется; для чистой Neon схемы доступен только проверенный
  one-time import старого `data/state.json`.
- Cleanup и Telegram callback используют одинаковый безопасный формат даты.

Проверено локально: PostgreSQL lifecycle profile проходит на `pg-mem`; тесты
используют искусственные базы, Neon и личная БД не открывались.

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
- Render-конфигурация задаёт бесплатный Web Service и `/healthz`; отдельный
  Persistent Disk не используется.

Проверено локально: F6/F8 lifecycle pattern profile — 12/12; полный целевой
прогон — 138/138. Профиль пересекается с другими файлами намеренно, чтобы
проверить сквозное распространение сигнала.
Официальный Google SDK timeout специально не подменялся: утверждённый план
оставляет его отдельным ограничением. Live SIGTERM, Render и реальные HTTP не
запускались.

### 8. Защита Classroom decoder и bounded refresh — F9

Изменены `src/classroom-web.js`, `src/classroom.test.js` и профильные тесты.

- Валидный пустой список assignments принимается. Строгая новая проверка
  `recognized collection` удалена: неизвестная структура снова обрабатывается
  как в старой рабочей версии и даёт пустой список без выдумывания полей.
- После `CLASSROOM_SESSION_EXPIRED` или bootstrap failure разрешён один forced
  reload и повтор того же RPC. Второй сбой не запускает новый цикл.
- Ошибка Classroom до commit сохраняет прежний PostgreSQL snapshot; E-school
  ветка не теряет независимую попытку.
- OAuth/API fallback, hardcoded course ids и live Classroom requests в рамках
  remediation не добавлялись.

Проверено локально: F9 pattern profile — 5/5; полный целевой прогон —
138/138.

## Переезд на Neon PostgreSQL и бесплатный Render

Это отдельное согласованное изменение после исходного remediation-плана:
пользователь отменил SQLite/Persistent Disk вариант и выбрал Neon PostgreSQL,
free Render Web Service и самостоятельную настройку UptimeRobot.

### Исправленные изменения

- `src/postgres-homework-db.js` содержит PostgreSQL-схему версии 3, пул `pg`,
  транзакционный snapshot/notification queue, async lifecycle, статусы,
  Telegram offset и 14-дневную очистку только completed-записей.
- `src/homework-db.js` оставлен как PostgreSQL-only публичная фабрика; старый
  SQLite adapter и `src/database.js` удалены из активного исходного контура.
- `src/bot-sync.js`, `src/telegram-bot.js`, `src/bot-cli.js` и `src/sync-cli.js`
  переведены на async database contract. `npm run bot` и `npm run sync` требуют
  `HOMEWORK_DATABASE_URL`; отсутствие URL завершается безопасной ошибкой.
- `src/health-server.js` добавляет тихий `GET /healthz`: 200 после инициализации
  процесса и 503 во время остановки. Он не возвращает секреты или данные задач.
- `render.yaml` теперь описывает бесплатный Web Service без disk/worker и
  передаёт `HOMEWORK_DATABASE_URL` как secret env var. Build выполняет тесты до
  `npm prune --omit=dev`.
- `pg-mem` используется только в тестах; тестовые fixtures не подключаются к
  Neon. Старый `data/homeworks.sqlite*` не читается и не удаляется. Проверенный
  one-time import из `data/state.json` сохранён как совместимость, но не как
  активное хранилище.
- `README.md` и `docs/ARCHITECTURE.md` описывают Neon/PostgreSQL и `/healthz`.
  UptimeRobot в код не добавлялся: оператор может мониторить URL сервиса с
  путём `/healthz` самостоятельно.
- `.env.example` и `AGENTS.md` больше не предлагают SQLite-переменную как
  рабочую конфигурацию и фиксируют PostgreSQL-only контракт.

### Follow-up: Classroom web/RPC only

По отдельному указанию пользователя production-провайдер Classroom теперь
использует только authenticated browser-cookie web/RPC путь. Официальный
Google Classroom API больше не вызывается из `bot`/`sync`: если cookie source
не настроен, провайдер возвращает `null`, пишет безопасный диагностический лог
и пропускается. Legacy API-файлы не являются частью рабочего deployment path.

Регрессионный тест проверяет, что отсутствие web-cookie конфигурации не
вызывает официальный API fallback; профиль Classroom и sync-тесты остаются
offline и не подтверждают работу живой cookie-сессии.

Проверено после изменения:

```text
node --test test/classroom-provider.test.js test/classroom.test.js -> 18 passed, 0 failed
local npm test (Node v24.12.0)                              -> 137 passed, 1 failed
```

Единственный сбой полного локального прогона — ожидаемая проверка runtime
`24.21+`; Classroom-тесты прошли. Это offline-проверка, а не проверка живой
готовности к production.

### Follow-up: точечный откат Classroom decoder

По просьбе пользователя из `src/classroom-web.js` удалены только новые
`hasRecognizedCourseWorkCollection()` и исключение `CLASSROOM_RESPONSE_ERROR`
для неизвестного payload. Регрессионный тест снова требует `[]` для старой
неизвестной числовой формы, как в pre-remediation snapshot `b44739e`.

Read-only probe текущей cookie-сессии после отката: 22 курса, 847 полученных
записей coursework, 9 записей после cutoff. Probe не запускал bot, не писал в
БД, не отправлял Telegram и не является живой проверкой production readiness.

### Актуальные регрессионные проверки

```text
test/bot-sync.test.js                         -> 16 passed, 0 failed
test/health-server.test.js                    -> 2 passed, 0 failed
test/postgres-homework-db.test.js             -> 5 passed, 0 failed
full npm test on target Node v24.21.0         -> 138 passed, 0 failed
clean target install + full target tests      -> 138 passed, 0 failed
target npm audit --omit=dev                   -> 0 vulnerabilities
```

Дополнительный локальный прогон системным Node `v24.12.0` дал 136 passed и
один ожидаемый failure runtime guard; это ограничение среды, а не изменение
контракта. Целевой Node `v24.21.0` был запущен из отдельной временной папки,
а clean install копировал только `package*.json`, `render.yaml`, `src/`,
`test/` и `test-support/`, без `.env`, `data/`, cookies и credentials.

## Render и production ограничения

Ниже перечисленное не выполнялось: подключение к Neon из приложения, миграция
личной SQLite/Neon БД, `npm run bot`, `npm run sync`, авторизация, реальные
E-school/Classroom HTTP-запросы, Telegram-отправка, Render deploy, Git push и
настройка UptimeRobot. Offline-тесты с `pg-mem` не являются живой проверкой
готовности к production.

Перед реальным запуском оператору нужно добавить тот же секретный Neon pooled
URL как `HOMEWORK_DATABASE_URL` в Render, проверить схему/доступ на отдельном
проекте, настроить остальные секреты и после развёртывания указать UptimeRobot
на `https://<render-service>/healthz`. В free Neon/Postgres и free Render есть
лимиты/засыпание/retention, которые должны быть проверены по актуальным тарифам
перед эксплуатацией.
