import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { SmokeTestError, errorMessage } from './utils.js';

let DatabaseSync;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch (error) {
  throw new SmokeTestError(
    'SQLite storage requires Node.js 24.21.0 or a later 24.x patch below 25 (the built-in node:sqlite module is unavailable)',
    { code: 'DATABASE_RUNTIME_ERROR', cause: error },
  );
}

export const DATABASE_VERSION = 3;
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

const TIMESTAMP_COLUMNS = [
  'first_seen_at',
  'last_seen_at',
  'last_notified_at',
  'completed_at',
  'created_at',
  'updated_at',
];

function normalizeTimestampForStorage(value, label = 'timestamp') {
  if (value === null || value === undefined
    || (typeof value === 'string' && value.trim() === '')) {
    throw new HomeworkDatabaseError(`${label} must be a valid timestamp`);
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new HomeworkDatabaseError(`${label} must be a valid timestamp`);
  }
  return date.toISOString();
}

function normalizePersistedTimestamp(value) {
  if (value === null || value === undefined || value === '') {
    return { value, converted: false, invalid: false };
  }

  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    return { value, converted: false, invalid: true };
  }

  const normalized = date.toISOString();
  return {
    value: normalized,
    converted: normalized !== value,
    invalid: false,
  };
}

function readDatabaseVersion(database) {
  const row = database
    .prepare('SELECT value FROM database_meta WHERE key = ?')
    .get('database_version');
  if (!row) {
    return 0;
  }

  const value = String(row.value);
  if (!/^\d+$/u.test(value)) {
    throw new HomeworkDatabaseError('SQLite database version metadata is invalid');
  }

  const version = Number(value);
  if (!Number.isSafeInteger(version)) {
    throw new HomeworkDatabaseError('SQLite database version metadata is invalid');
  }
  return version;
}

function migratePersistedTimestamps(database, fromVersion) {
  const diagnostics = {
    fromVersion,
    toVersion: DATABASE_VERSION,
    convertedValues: 0,
    invalidValues: 0,
  };

  if (fromVersion >= DATABASE_VERSION) {
    return diagnostics;
  }

  const rows = database.prepare(`
    SELECT id, ${TIMESTAMP_COLUMNS.join(', ')}
    FROM homework_tasks
  `).all();
  const update = database.prepare(`
    UPDATE homework_tasks
    SET ${TIMESTAMP_COLUMNS.map((column) => `${column} = ?`).join(', ')}
    WHERE id = ?
  `);
  const setVersion = database.prepare(`
    INSERT INTO database_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  database.exec('BEGIN');
  try {
    for (const row of rows) {
      const values = [];
      let changed = false;
      for (const column of TIMESTAMP_COLUMNS) {
        const normalized = normalizePersistedTimestamp(row[column]);
        values.push(normalized.value);
        diagnostics.convertedValues += normalized.converted ? 1 : 0;
        diagnostics.invalidValues += normalized.invalid ? 1 : 0;
        changed ||= normalized.converted;
      }
      if (changed) {
        update.run(...values, Number(row.id));
      }
    }

    setVersion.run('database_version', String(DATABASE_VERSION));
    database.exec('COMMIT');
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // Preserve the original migration error.
    }
    if (error instanceof HomeworkDatabaseError) {
      throw error;
    }
    throw new HomeworkDatabaseError(
      `Could not migrate SQLite timestamps: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  return diagnostics;
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

function taskIdentity(task) {
  const source = sourceId(task);
  if (source === 'classroom') {
    return `${source}:external:${externalId(task) ?? task.fingerprint}`;
  }
  return `${source}:fingerprint:${task.fingerprint}`;
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
  let migrationDiagnostics = {
    fromVersion: DATABASE_VERSION,
    toVersion: DATABASE_VERSION,
    convertedValues: 0,
    invalidValues: 0,
  };
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
    const storedVersion = readDatabaseVersion(database);
    if (storedVersion > DATABASE_VERSION) {
      throw new HomeworkDatabaseError(
        `SQLite database version ${storedVersion} is newer than supported version ${DATABASE_VERSION}`,
      );
    }
    migrationDiagnostics = migratePersistedTimestamps(database, storedVersion);
  } catch (error) {
    try {
      database?.close();
    } catch {
      // Preserve the original database-open error.
    }
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
  const selectPendingNotifications = database.prepare(`
    SELECT * FROM homework_tasks
    WHERE notification_pending = 1
    ORDER BY id
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

  function getMigrationDiagnostics() {
    return { ...migrationDiagnostics };
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

  function findMatches(tasks) {
    const uniqueTasks = [];
    const seenIdentities = new Set();
    for (const task of tasks ?? []) {
      assertTask(task);
      const identity = taskIdentity(task);
      if (seenIdentities.has(identity)) {
        continue;
      }
      seenIdentities.add(identity);
      uniqueTasks.push(task);
    }

    const matches = uniqueTasks.map(() => null);
    const reservedRowIds = new Set();
    const assign = (index, row) => {
      if (!row || reservedRowIds.has(row.id)) {
        return false;
      }
      matches[index] = row;
      reservedRowIds.add(row.id);
      return true;
    };

    // Exact identities always win and reserve their rows before the
    // appointment-id compatibility fallback is considered.
    uniqueTasks.forEach((task, index) => {
      assign(index, findByExternalId(externalId(task), sourceId(task)));
    });
    uniqueTasks.forEach((task, index) => {
      if (!matches[index]) {
        assign(index, findByFingerprint(task.fingerprint, sourceId(task)));
      }
    });

    const pendingByAppointment = new Map();
    uniqueTasks.forEach((task, index) => {
      if (matches[index] || sourceId(task) !== 'eschool') {
        return;
      }
      const appointmentId = targetId(task);
      if (!appointmentId) {
        return;
      }
      const indexes = pendingByAppointment.get(appointmentId) ?? [];
      indexes.push(index);
      pendingByAppointment.set(appointmentId, indexes);
    });

    // The fallback is safe only when both the old and new sides are
    // unambiguous. This prevents one old row from being reused for two
    // different assignments from the same lesson.
    for (const [appointmentId, indexes] of pendingByAppointment) {
      const candidates = selectByTargetId
        .all('eschool', appointmentId)
        .map(rowToTask)
        .filter((row) => !reservedRowIds.has(row.id));
      if (indexes.length === 1 && candidates.length === 1) {
        assign(indexes[0], candidates[0]);
      }
    }

    return uniqueTasks.map((task, index) => ({
      task,
      previous: matches[index],
    }));
  }

  function findMatch(task) {
    return findMatches([task])[0]?.previous ?? null;
  }

  function currentTasks() {
    return selectCurrent.all().map(rowToTask);
  }

  function completedTasks() {
    return selectCompleted.all().map(rowToTask);
  }

  function pendingNotifications(source = null) {
    const tasks = selectPendingNotifications.all().map(rowToTask);
    if (source === null || source === undefined) {
      return tasks;
    }
    const normalizedSource = sourceId({ source });
    return tasks.filter((task) => task.source === normalizedSource);
  }

  function markAllNotCurrent(timestamp) {
    markNotCurrent.run(normalizeTimestampForStorage(timestamp));
  }

  function markSourceNotCurrent(source, timestamp) {
    markSourceNotCurrentStatement.run(
      normalizeTimestampForStorage(timestamp),
      sourceId({ source }),
    );
  }

  function saveBaseline(tasks, timestamp, { source = null } = {}) {
    const now = normalizeTimestampForStorage(timestamp);
    const taskSource = source
      ? sourceId({ source })
      : sourceId(tasks[0] ?? {});
    database.exec('BEGIN');
    try {
      for (const { task, previous } of findMatches(tasks)) {
        const existing = previous;
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

  function applyProviderSnapshot(plan, timestamp, { source } = {}) {
    const now = normalizeTimestampForStorage(timestamp ?? new Date());
    const taskSource = sourceId({ source: source ?? plan[0]?.task?.source });
    database.exec('BEGIN');
    try {
      markSourceNotCurrentStatement.run(now, taskSource);
      const rows = [];
      for (const entry of plan) {
        const row = upsertSeenTask(entry.task, {
          timestamp: now,
          notificationKind: entry.notificationKind ?? null,
          previous: entry.previous ?? null,
        });
        rows.push(row);
      }
      database.exec('COMMIT');
      return rows;
    } catch (error) {
      try {
        database.exec('ROLLBACK');
      } catch {
        // Preserve the original transaction error.
      }
      if (error instanceof HomeworkDatabaseError) {
        throw error;
      }
      throw new HomeworkDatabaseError(
        `Could not save ${taskSource} snapshot: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  function upsertSeenTask(task, {
    timestamp,
    notificationKind = null,
    previous = undefined,
  } = {}) {
    assertTask(task);
    const now = normalizeTimestampForStorage(timestamp ?? new Date());
    const existing = previous === undefined ? findMatch(task) : previous;
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
    const now = normalizeTimestampForStorage(timestamp ?? new Date());
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

    const now = normalizeTimestampForStorage(timestamp, 'completed_at');
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

    const now = normalizeTimestampForStorage(timestamp, 'updated_at');
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
    const cutoff = normalizeTimestampForStorage(cutoffTimestamp, 'cleanup cutoff');
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
    getMigrationDiagnostics,
    findById,
    findByFingerprint,
    findByExternalId,
    findMatches,
    findMatch,
    currentTasks,
    completedTasks,
    pendingNotifications,
    markAllNotCurrent,
    markSourceNotCurrent,
    saveBaseline,
    importLegacyState,
    applyProviderSnapshot,
    upsertSeenTask,
    recordNotificationSuccess,
    completeTask,
    uncompleteTask,
    deleteCompletedBefore,
    close,
  };
}
