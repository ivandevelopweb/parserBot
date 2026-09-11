# Результаты исправлений Luna F1–F4

Дата проверки: 12 сентября 2026 года. Основание: `docs/optimization-audit-2026-09-12.md` и согласованный объём `docs/luna-optimization-fixes-tasks.md`. Хранилище оставлено PostgreSQL v5; миграция схемы не нужна.

## F1 — уведомления после ручного восстановления

`completion_origin = manual` по-прежнему защищает итоговый статус от автоматического изменения. Эта защита отделена от очереди содержательных уведомлений: изменение snapshot у pending-задания после ручного восстановления теперь ставится в очередь для обоих источников. Для completed-задания очередь по-прежнему очищается и отправка не выполняется.

Добавлены регрессии для E-school и Classroom: baseline → ручное завершение → изменение в completed → восстановление → неизменный повтор → ошибка Telegram → успешный retry → неизменный повтор. Проверяются стабильный id, `pending/manual`, одна успешная доставка, сохранённая очередь при ошибке и отсутствие повторной отправки. Существующая проверка ручного действия между matching и persistence также прошла.

## F2 — восстановление E-school health stage

Результат E-school теперь явно содержит `stage`: `login`, `appointments`, `delivery` или `null` после успешного восстановления. In-memory health различает отсутствие поля и явный `null`, поэтому старая стадия не остаётся после recovery. `lastSuccessAt` сохраняется при отказе чтения и обновляется после сохранения snapshot, включая `delivery_error`.

Регрессия проверяет переходы `login → success`, `appointments → success` и `delivery_error → success`; health остаётся диагностическим и не меняет readiness.

## F3 — durable диагностика отказа Classroom

При отказе Classroom записывается компактный `classroom_sync_status` со статусом `error`, текущим `attemptedAt`, прежним `lastSuccessAt` и последним известным `taskCount`. Старые metrics не выдаются за результат неуспешного прохода; exception text, snapshots, cookies и credentials не сохраняются. Первый отказ использует `lastSuccessAt: null` и `taskCount: null`; следующий успех восстанавливает `status: ok`.

Чтение повреждённой/недоступной metadata и ошибка её записи не блокируют E-school и не заменяют исходную ошибку провайдера. Abort при shutdown не создаёт ложную запись outage и не стирает последнее успешное состояние.

## F4 — интервал 20 минут

- `DEFAULT_HOMEWORK_SYNC_INTERVAL_MINUTES = 20`.
- `HOMEWORK_SYNC_INTERVAL_MS = 20 * 60 * 1000`.
- Пустое/отсутствующее `HOMEWORK_SYNC_INTERVAL_MINUTES` даёт 20; явное целое от 5 до 60 имеет приоритет.
- `.env.example` содержит `HOMEWORK_SYNC_INTERVAL_MINUTES=20`; `render.yaml` проверен и уже содержит `value: "20"`.
- Немедленный первый sync, защита от перекрытия, отмена/drain и Telegram long polling не изменены.
- При 20 минутах получается 72 плановых запуска в сутки вместо 144, не считая стартов процесса. Новое задание и повтор доставки могут ждать до одного интервала плюс длительность sync; это не доказательство двукратного снижения расходов Neon.

При выкатывании нужно проверить фактическую переменную окружения и стартовый лог `Homework sync interval: 20 minutes`. Если на сервере явно осталось `HOMEWORK_SYNC_INTERVAL_MINUTES=10`, новый application default его не переопределит — значение нужно заменить на 20. Production этим изменением не считался переведённым автоматически.

## Изменённые файлы

- `.env.example`
- `README.md`
- `docs/ARCHITECTURE.md`
- `docs/luna-optimization-fixes-tasks.md`
- `src/bot-sync.js`
- `src/postgres-homework-db.js`
- `src/telegram-bot.js`
- `test/bot-sync.test.js`
- `test/classroom.test.js`
- `test/runtime.test.js`
- `test/telegram-bot.test.js`
- `docs/neon-benchmark-luna-fixes.json`
- `docs/neon-benchmark-luna-fixes.md`

`render.yaml` не потребовал правки: нужное значение 20 уже было установлено. Исторические audit-материалы и старые SQLite-планы не перезаписывались.

## Проверки

Все команды выполнялись из `C:\projects\HomeworkParser`.

| Команда | Результат |
| --- | --- |
| `npm exec --yes --package=node@24.21.0 -- npm test` | `197/197` passed |
| `npm exec --yes --package=node@24.21.0 -- node --test docs/optimization-audit-2026-09-12.mjs` | `8` passed, `0` failed, `3` skipped; skipped — real-PG cases без `HOMEWORK_AUDIT_REAL_PG` |
| `$env:HOMEWORK_AUDIT_REAL_PG='1'; npm exec --yes --package=node@24.21.0 -- node --test docs/optimization-audit-2026-09-12.mjs` | `11/11` passed на PostgreSQL 18.6 |
| `$env:HOMEWORK_AUDIT_REAL_PG='1'; npm exec --yes --package=node@24.21.0 -- node --import ./docs/audit-real-pg-loader-2026-09-12.mjs --test --test-skip-pattern='survives restart' test/bot-sync.test.js test/telegram-bot.test.js` | `50/50` passed на изолированном PostgreSQL |
| `npm exec --yes --package=node@24.21.0 -- node scripts/neon-optimization-benchmark.mjs --label=luna-fixes --output=docs/neon-benchmark-luna-fixes.json --before=docs/neon-benchmark-audit-2026-09-12.json` | успешно, synthetic pg-mem, Node `v24.21.0` |
| `git diff --check` | ошибок нет |

До исправлений тот же audit-скрипт воспроизводил 4 ожидаемых падения: F1 для обоих источников, F2 и F3. Системный Node `24.12.0` не соответствует `engines`; для проверок использовался только `24.21.0` через `npm exec`.

## Сравнение benchmark

Сравнивались одинаковые 120 E-school и 120 Classroom synthetic tasks с сохранённым post-optimization файлом `docs/neon-benchmark-audit-2026-09-12.json`. Исправления не изменили SQL-путь:

| Сценарий combined | SQL calls | Returned rows | Changed rows | Approx result bytes |
| --- | ---: | ---: | ---: | ---: |
| baseline | 21 → 21 | 240 → 240 | 244 → 244 | 20,749 → 20,749 |
| unchanged | 18 → 18 | 603 → 603 | 1 → 1 | 662,949 → 662,949 |
| single-change | 25 → 25 | 609 → 609 | 5 → 5 | 703,512 → 703,512 |
| missing-one | 25 → 25 | 604 → 604 | 6 → 6 | 698,544 → 698,544 |
| status-change | 14 → 14 | 365 → 365 | 2 → 2 | 394,939 → 394,939 |
| **все сценарии** | **103 → 103** | **2,421 → 2,421** | **258 → 258** | **2,480,693 → 2,480,693** |

Размеры — UTF-8 объём сериализованных returned rows, а не wire traffic и не счётчик Neon. Реальную экономию CU/GB можно подтвердить только наблюдением Neon после выкатывания.

## Внешние действия и ограничения

Создан только собственный временный PostgreSQL 18.6-кластер на loopback-порту `55439` с пользователем `audit` и искусственными данными; после проверок он остановлен, listener отсутствует. Пользовательская служба PostgreSQL, Neon, E-school, Classroom, Render и Telegram не вызывались. Не запускались `npm start`, `npm run sync`, `npm run bot`, `npm run telegram:test`, live provider smoke, деплой или историческая повторная рассылка. Реальная `.env`, cookies, схема и пользовательские данные не менялись. Уже сохранённые без уведомления изменения этим исправлением автоматически не восстанавливаются.

Остаются исходные ограничения проекта: полнота закрытого Classroom RPC не доказана, E-school работает в текущем двухнедельном окне, а at-least-once доставка допускает дубль при падении между успешным ответом Telegram и подтверждением PostgreSQL.
