# Telegram notifier для Єдиної школи

> Этот документ описывает предыдущий milestone. Долгоживущий Telegram-интерфейс
> и scheduler добавлены в `2026-09-09-telegram-homework-interface-design.md`.

## Цель и границы

Добавить к существующему browserless-клиенту production sync для Telegram.
Sync получает уже работающий результат `getAppointments()`, хранит только
deduplicated homework tasks и уведомляет указанный Telegram chat о новых или
изменённых заданиях. Google Classroom, Telegram user-account API и
долгоживущий scheduler в этот milestone не входят.

## Компоненты

- `src/telegram.js` — тонкий Telegram Bot API adapter на встроенном `fetch`.
  Он читает `TELEGRAM_BOT_TOKEN` и `TELEGRAM_CHAT_ID`, отправляет
  `sendMessage` с timeout, не раскрывает token и превращает HTTP/API ошибки в
  понятные ошибки. Ответ `429` логируется с `retry_after`; бесконечных retry
  нет.
- `src/state.js` — JSON persistence для `data/state.json`. Каталог создаётся
  автоматически, state валидируется при чтении, а запись выполняется через
  временный файл и `rename`. Повреждённый JSON не заменяется baseline-ом и
  приводит к явной ошибке.
- `src/sync.js` — orchestration одного запуска. Модуль получает
  deduplicated tasks через существующий `getAppointments()`, строит stable
  fingerprint и snapshot, различает baseline/new/changed, отправляет
  уведомления и сохраняет state после каждой успешной отправки.
- `src/sync-cli.js` — production entry point для `npm run sync`: dotenv,
  auth, appointments, sync, bounded exit.
- `src/index.js` — существующий smoke-test entry point остаётся отдельным и
  продолжает выполнять login/refresh/API debug flow.

`src/eschool.js` будет изменён только точечно: grouped task получит внутренние
`targetAppointmentId` и normalized description (либо эквивалентный helper),
чтобы sync мог использовать фактическую identity после dedupe. Формат
существующего пользовательского вывода и auth/API протокол не меняются.

## Конфигурация

В `.env.example` добавляются:

```env
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

`.env` и `data/state.json` добавляются в ignore rules. `data/.gitkeep`
разрешает сохранить пустой каталог в репозитории. Token и chat ID не
показываются в логах; текст Telegram-сообщения может быть выведен только без
секретных конфигурационных значений.

## State schema и fingerprint

Состояние имеет версию и словарь задач:

```json
{
  "version": 1,
  "initializedAt": "2026-09-09T12:00:00.000Z",
  "tasks": {
    "[\"185141\",\"normalized description\"]": {
      "fingerprint": "[\"185141\",\"normalized description\"]",
      "targetAppointmentId": 185141,
      "snapshot": {
        "subject": "...",
        "topics": ["..."],
        "description": "...",
        "assignedDate": "2026-09-09",
        "targetDate": "2026-09-11",
        "lessonNumber": 4,
        "startTime": "11:25",
        "filesCount": 0
      },
      "homeworkIds": [101171],
      "lastSeenAt": "2026-09-09T12:00:00.000Z",
      "lastSentAt": "2026-09-09T12:00:00.000Z"
    }
  }
}
```

Fingerprint состоит из `targetAppointmentId` и normalized description;
нормализация повторяет действующее правило: trim, переносы строк в пробелы,
несколько пробелов в один. Дубликаты, объединённые существующим dedupe,
получают один fingerprint и один snapshot; все уникальные `homeworkIds`
сохраняются в snapshot. Snapshot сравнивает normalized description,
targetDate и topics (а также хранит остальные поля для воспроизводимости).

## Поведение sync

1. Загрузить и провалидировать state. Отсутствующий файл означает
   неинициализированный state; повреждённый файл останавливает запуск до
   любых записей.
2. Получить текущую неделю через существующий `getAppointments()` и
   преобразовать результат в deduplicated sync tasks.
3. Если state ещё не инициализирован, записать все текущие snapshots без
   Telegram отправок и вывести `[sync] Baseline initialized with N tasks`.
4. На следующих запусках для каждой текущей задачи:
   - отсутствующая в state → сообщение `📚 Нове домашнє завдання`;
   - существующая с отличием description/targetDate/topics → сообщение
     `✏️ Домашнє завдання змінено`;
   - идентичная → без отправки.
5. Сначала успешно отправить сообщение, затем немедленно атомарно записать
   соответствующий snapshot и `lastSentAt`. Если Telegram упал, задача не
   получает новый snapshot/`lastSentAt`; ошибка завершает sync с ненулевым
   кодом. Уже успешно отправленные до ошибки задачи остаются сохранёнными.
6. Исчезнувшие задачи сохраняются в state без уведомления; текущие задачи
   обновляют `lastSeenAt`.

## Telegram message

Сообщение собирается из непустых секций:

```text
📚 Нове домашнє завдання

Алгебра і початок аналізу

📝 Вивчити конспект...

📖 Теми:
• Числові множини
• Множина дійсних чисел

📅 На: 11.09.2026
🕐 Урок 4, 11:25

📎 Прикріплено файлів: 1
```

Для update используется заголовок `✏️ Домашнє завдання змінено`. Пустые
описание, topics и files section не выводятся.

## CLI и verification

- `npm start` остаётся smoke-test/debug режимом.
- `npm run sync` выполняет один production sync и завершается.
- `npm run telegram:test` отправляет одно явно диагностическое сообщение,
  полезное для проверки credentials, но не участвует в baseline sync.

Добавляются тесты для baseline без отправки, new task, повторного запуска без
дубля, update notification, Telegram failure без state marking,
deduplication, malformed state, atomic persistence и Telegram 429/timeout.
После реализации выполняются `npm test`, реальный `npm run sync` и отдельно
один `npm run telegram:test`. Первый реальный sync не отправляет уже
существующие задания.
