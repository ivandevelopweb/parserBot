import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { SmokeTestError, errorMessage } from './utils.js';

let DatabaseSync;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch (error) {
  throw new SmokeTestError(
    'SQLite storage requires Node.js 22.5 or newer (the built-in node:sqlite module is unavailable)',
    { code: 'DATABASE_RUNTIME_ERROR', cause: error },
  );
}

export const DATABASE_VERSION = 2;
export const DEFAULT_DATABASE_PATH = resolve(process.cwd(), 'data', 'homeworks.sqlite');

function resolveConfiguredDatabasePath(filePath) {
  const configuredPath = filePath === undefined ? process.env.HOMEWORK_DATABASE_PATH : filePath;
  const value = String(configuredPath ?? '').trim();
  if (!value) {
    return DEFAULT_DATABASE_PATH;
  }
  if (value === ':memory:') {
    return value;
  }
  return resolve(value);
}

export class HomeworkDatabaseError extends SmokeTestError {
  constructor(message, options = {}) {
    super(message, { code: 'DATABASE_ERROR', ...options });
    this.name = 'HomeworkDatabaseError';
  }
}

const BASE_SCHEMA = `
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS database_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS homework_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL DEFAULT 'eschool',
    external_id TEXT,
    fingerprint TEXT NOT NULL UNIQUE,
    target_appointment_id TEXT NOT NULL,
    normalized_description TEXT NOT NULL,
    homework_ids_json TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0, 1)),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed')),
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    last_notified_at TEXT,
    notification_pending INTEGER NOT NULL DEFAULT 0 CHECK (notification_pending IN (0, 1)),
    notification_kind TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_homework_current
    ON homework_tasks (is_current, status, target_appointment_id);
  CREATE INDEX IF NOT EXISTS idx_homework_completed
    ON homework_tasks (status, completed_at);
`;

const SOURCE_INDEX_SCHEMA = `
  CREATE INDEX IF NOT EXISTS idx_homework_source_external
    ON homework_tasks (source, external_id);
`;

function assertTask(task) {
  if (!task || typeof task !== 'object' || !task.fingerprint || !task.snapshot) {
    throw new HomeworkDatabaseError('Cannot store an invalid homework task');
  }
}

function serializeJson(value, fallback) {
  try {
    return JSON.stringify(value ?? fallback);
  } catch (error) {
    throw new HomeworkDatabaseError(
      `Could not serialize homework data: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

function parseJson(value, fallback, label) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch (error) {
    throw new HomeworkDatabaseError(
      `Database row contains invalid ${label} JSON`,
      { cause: error },
    );
  }
}

function rowToTask(row) {
  if (!row) {
    return null;
  }

  return {
    id: Number(row.id),
    source: row.source ?? 'eschool',
    externalId: row.external_id,
    fingerprint: row.fingerprint,
    targetAppointmentId: row.target_appointment_id,
    normalizedDescription: row.normalized_description,
    homeworkIds: parseJson(row.homework_ids_json, [], 'homework ids'),
    snapshot: parseJson(row.snapshot_json, {}, 'snapshot'),
    isCurrent: row.is_current === 1,
    status: row.status,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    lastNotifiedAt: row.last_notified_at,
    notificationPending: row.notification_pending === 1,
    notificationKind: row.notification_kind,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function targetId(task) {
  return String(task.targetAppointmentId ?? '');
}

function sourceId(task) {
  return String(task.source ?? task.snapshot?.source ?? 'eschool').trim().toLowerCase() || 'eschool';
}

function externalId(task) {
  const value = task.externalId ?? task.snapshot?.externalId;
  return value === undefined || value === null || String(value).trim() === ''
    ? null
    : String(value);
}

function baselineMetaKey(source) {
  return source === 'eschool' ? 'baseline_initialized_at' : `baseline_initialized_at:${source}`;
}

export function createHomeworkDatabase({ filePath } = {}) {
  const databasePath = resolveConfiguredDatabasePath(filePath);
  try {
    if (databasePath !== ':memory:') {
      mkdirSync(dirname(databasePath), { recursive: true });
    }
  } catch (error) {
    throw new HomeworkDatabaseError(
      `Could not create database directory: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  let database;
  try {
    database = new DatabaseSync(databasePath);
    database.exec(BASE_SCHEMA);

    const columns = new Set(
      database.prepare('PRAGMA table_info(homework_tasks)').all().map((row) => row.name),
    );
    if (!columns.has('source')) {
      database.exec("ALTER TABLE homework_tasks ADD COLUMN source TEXT NOT NULL DEFAULT 'eschool'");
    }
    if (!columns.has('external_id')) {
      database.exec('ALTER TABLE homework_tasks ADD COLUMN external_id TEXT');
    }
    database.exec(SOURCE_INDEX_SCHEMA);
    database
      .prepare(`
        INSERT INTO database_meta (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `)
      .run('database_version', String(DATABASE_VERSION));
  } catch (error) {
    throw new HomeworkDatabaseError(
      `Could not open SQLite database ${databasePath}: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  const selectById = database.prepare('SELECT * FROM homework_tasks WHERE id = ?');
  const selectByFingerprint = database.prepare(
    'SELECT * FROM homework_tasks WHERE fingerprint = ?',
  );
  const selectBySourceFingerprint = database.prepare(
    'SELECT * FROM homework_tasks WHERE source = ? AND fingerprint = ?',
  );
  const selectByExternalId = database.prepare(
    'SELECT * FROM homework_tasks WHERE source = ? AND external_id = ?',
  );
  const selectByTargetId = database.prepare(
    'SELECT * FROM homework_tasks WHERE source = ? AND target_appointment_id = ? ORDER BY id',
  );
  const selectCurrent = database.prepare(`
    SELECT * FROM homework_tasks
    WHERE is_current = 1 AND status = 'pending'
    ORDER BY
      CASE WHEN COALESCE(json_extract(snapshot_json, '$.targetDate'), '') = '' THEN 1 ELSE 0 END,
      json_extract(snapshot_json, '$.targetDate'),
      id
  `);
  const selectCompleted = database.prepare(`
    SELECT * FROM homework_tasks
    WHERE status = 'completed'
    ORDER BY
      CASE WHEN COALESCE(json_extract(snapshot_json, '$.targetDate'), '') = '' THEN 1 ELSE 0 END,
      json_extract(snapshot_json, '$.targetDate'),
      completed_at DESC,
      id
  `);
  const countTasks = database.prepare('SELECT COUNT(*) AS count FROM homework_tasks');
  const countTasksBySource = database.prepare(
    'SELECT COUNT(*) AS count FROM homework_tasks WHERE source = ?',
  );
  const selectMeta = database.prepare('SELECT value FROM database_meta WHERE key = ?');
  const upsertMeta = database.prepare(`
    INSERT INTO database_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  const markNotCurrent = database.prepare(
    'UPDATE homework_tasks SET is_current = 0, updated_at = ? WHERE is_current = 1',
  );
  const markSourceNotCurrentStatement = database.prepare(
    'UPDATE homework_tasks SET is_current = 0, updated_at = ? WHERE source = ? AND is_current = 1',
  );
  const insertTask = database.prepare(`
    INSERT INTO homework_tasks (
      source,
      external_id,
      fingerprint,
      target_appointment_id,
      normalized_description,
      homework_ids_json,
      snapshot_json,
      is_current,
      status,
      first_seen_at,
      last_seen_at,
      last_notified_at,
      notification_pending,
      notification_kind,
      completed_at,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'pending', ?, ?, NULL, ?, ?, NULL, ?, ?)
  `);
  const updateTask = database.prepare(`
    UPDATE homework_tasks
    SET source = ?,
        external_id = ?,
        fingerprint = ?,
        target_appointment_id = ?,
        normalized_description = ?,
        homework_ids_json = ?,
        snapshot_json = ?,
        is_current = 1,
        last_seen_at = ?,
        notification_pending = CASE WHEN ? = 1 THEN 1 ELSE notification_pending END,
        notification_kind = CASE WHEN ? = 1 THEN ? ELSE notification_kind END,
        updated_at = ?
    WHERE id = ?
  `);
  const markNotified = database.prepare(`
    UPDATE homework_tasks
    SET last_notified_at = ?, notification_pending = 0, notification_kind = NULL, updated_at = ?
    WHERE id = ?
  `);
  const markCompleted = database.prepare(`
    UPDATE homework_tasks
    SET status = 'completed', completed_at = ?, updated_at = ?
    WHERE id = ? AND status <> 'completed'
  `);
  const markUncompleted = database.prepare(`
    UPDATE homework_tasks
    SET status = 'pending', completed_at = NULL, is_current = 1, updated_at = ?
    WHERE id = ? AND status = 'completed'
  `);
  const deleteCompletedBeforeStatement = database.prepare(`
    DELETE FROM homework_tasks
    WHERE status = 'completed'
      AND completed_at IS NOT NULL
      AND completed_at < ?
  `);

  function getMeta(key) {
    return selectMeta.get(String(key))?.value ?? null;
  }

  function setMeta(key, value) {
    try {
      upsertMeta.run(String(key), String(value));
    } catch (error) {
      throw new HomeworkDatabaseError(
        `Could not save database metadata: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  function count() {
    return Number(countTasks.get().count);
  }

  function countBySource(source) {
    return Number(countTasksBySource.get(sourceId({ source })).count);
  }

  function findById(id) {
    return rowToTask(selectById.get(Number(id)));
  }

  function findByFingerprint(fingerprint, source = null) {
    const row = source === null || source === undefined
      ? selectByFingerprint.get(String(fingerprint))
      : selectBySourceFingerprint.get(sourceId({ source }), String(fingerprint));
    return rowToTask(row);
  }

  function findByExternalId(external, source) {
    if (external === undefined || external === null || String(external).trim() === '') {
      return null;
    }
    return rowToTask(selectByExternalId.get(sourceId({ source }), String(external)));
  }

  function findMatch(task) {
    assertTask(task);
    const source = sourceId(task);
    const byExternalId = findByExternalId(externalId(task), source);
    if (byExternalId) {
      return byExternalId;
    }

    const exact = findByFingerprint(task.fingerprint, source);
    if (exact) {
      return exact;
    }

    if (source !== 'eschool') {
      return null;
    }

    const candidates = selectByTargetId.all(source, targetId(task)).map(rowToTask);
    return candidates.length === 1 ? candidates[0] : null;
  }

  function currentTasks() {
    return selectCurrent.all().map(rowToTask);
  }

  function completedTasks() {
    return selectCompleted.all().map(rowToTask);
  }

  function markAllNotCurrent(timestamp) {
    markNotCurrent.run(String(timestamp));
  }

  function markSourceNotCurrent(source, timestamp) {
    markSourceNotCurrentStatement.run(String(timestamp), sourceId({ source }));
  }

  function saveBaseline(tasks, timestamp, { source = null } = {}) {
    const now = String(timestamp);
    const taskSource = source
      ? sourceId({ source })
      : sourceId(tasks[0] ?? {});
    database.exec('BEGIN');
    try {
      for (const task of tasks) {
        assertTask(task);
        const existing = findMatch(task);
        if (existing) {
          continue;
        }

        insertTask.run(
          sourceId(task),
          externalId(task),
          task.fingerprint,
          targetId(task),
          String(task.snapshot.description ?? ''),
          serializeJson(task.homeworkIds ?? [], []),
          serializeJson(task.snapshot, {}),
          now,
          now,
          0,
          null,
          now,
          now,
        );
      }
      setMeta(baselineMetaKey(taskSource), now);
      database.exec('COMMIT');
    } catch (error) {
      try {
        database.exec('ROLLBACK');
      } catch {
        // Preserve the original error.
      }
      if (error instanceof HomeworkDatabaseError) {
        throw error;
      }
      throw new HomeworkDatabaseError(
        `Could not initialize database baseline: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  function importLegacyState(tasks, timestamp) {
    saveBaseline(tasks, timestamp, { source: 'eschool' });
  }

  function upsertSeenTask(task, { timestamp, notificationKind = null } = {}) {
    assertTask(task);
    const now = String(timestamp ?? new Date().toISOString());
    const existing = findMatch(task);
    const pending = notificationKind ? 1 : 0;

    try {
      if (!existing) {
        const result = insertTask.run(
          sourceId(task),
          externalId(task),
          task.fingerprint,
          targetId(task),
          String(task.snapshot.description ?? ''),
          serializeJson(task.homeworkIds ?? [], []),
          serializeJson(task.snapshot, {}),
          now,
          now,
          pending,
          notificationKind,
          now,
          now,
        );
        return findById(Number(result.lastInsertRowid));
      }

      updateTask.run(
        sourceId(task),
        externalId(task),
        task.fingerprint,
        targetId(task),
        String(task.snapshot.description ?? ''),
        serializeJson(task.homeworkIds ?? [], []),
        serializeJson(task.snapshot, {}),
        now,
        pending,
        pending,
        notificationKind,
        now,
        existing.id,
      );

      return findById(existing.id);
    } catch (error) {
      throw new HomeworkDatabaseError(
        `Could not save homework task: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  function recordNotificationSuccess(id, timestamp) {
    const now = String(timestamp ?? new Date().toISOString());
    try {
      markNotified.run(now, now, Number(id));
      return findById(id);
    } catch (error) {
      throw new HomeworkDatabaseError(
        `Could not record Telegram delivery: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  function completeTask(id, timestamp = new Date().toISOString()) {
    const task = findById(id);
    if (!task) {
      return null;
    }

    const now = String(timestamp);
    try {
      markCompleted.run(now, now, Number(id));
      return findById(id);
    } catch (error) {
      throw new HomeworkDatabaseError(
        `Could not mark homework as completed: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  function uncompleteTask(id, timestamp = new Date().toISOString()) {
    const task = findById(id);
    if (!task || task.status !== 'completed') {
      return null;
    }

    const now = String(timestamp);
    try {
      const result = markUncompleted.run(now, Number(id));
      return Number(result.changes) > 0 ? findById(id) : null;
    } catch (error) {
      throw new HomeworkDatabaseError(
        `Could not mark homework as uncompleted: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  function deleteCompletedBefore(cutoffTimestamp) {
    const cutoff = String(cutoffTimestamp);
    try {
      const result = deleteCompletedBeforeStatement.run(cutoff);
      return Number(result.changes ?? 0);
    } catch (error) {
      throw new HomeworkDatabaseError(
        `Could not delete expired completed homework: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  function close() {
    database.close();
  }

  return {
    filePath: databasePath,
    count,
    countBySource,
    getMeta,
    setMeta,
    findById,
    findByFingerprint,
    findByExternalId,
    findMatch,
    currentTasks,
    completedTasks,
    markAllNotCurrent,
    markSourceNotCurrent,
    saveBaseline,
    importLegacyState,
    upsertSeenTask,
    recordNotificationSuccess,
    completeTask,
    uncompleteTask,
    deleteCompletedBefore,
    close,
  };
}
