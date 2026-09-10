import pg from 'pg';

import {
  DATABASE_VERSION,
  HomeworkDatabaseError,
  assertTask,
  baselineMetaKey,
  externalId,
  normalizeTimestampForStorage,
  rowToTask,
  serializeJson,
  sourceId,
  targetId,
  taskIdentity,
} from './homework-db-shared.js';
import { errorMessage } from './utils.js';

const { Pool } = pg;

const POSTGRES_SCHEMA = `
  CREATE TABLE IF NOT EXISTS database_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS homework_tasks (
    id BIGSERIAL PRIMARY KEY,
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
  CREATE INDEX IF NOT EXISTS idx_homework_source_external
    ON homework_tasks (source, external_id);
`;

function configuredConnectionString(value) {
  const connectionString = String(value ?? '').trim();
  if (!connectionString) {
    throw new HomeworkDatabaseError(
      'HOMEWORK_DATABASE_URL is required for PostgreSQL storage',
      { code: 'DATABASE_CONFIG_ERROR' },
    );
  }
  if (!/^postgres(?:ql)?:\/\//iu.test(connectionString)) {
    throw new HomeworkDatabaseError(
      'HOMEWORK_DATABASE_URL must be a PostgreSQL connection string',
      { code: 'DATABASE_CONFIG_ERROR' },
    );
  }
  return connectionString;
}

function wrapDatabaseError(message, error) {
  if (error instanceof HomeworkDatabaseError) {
    return error;
  }
  return new HomeworkDatabaseError(
    `${message}: ${errorMessage(error)}`,
    { cause: error },
  );
}

function parseDatabaseVersion(value) {
  if (value === null || value === undefined) {
    return 0;
  }
  const text = String(value);
  if (!/^\d+$/u.test(text)) {
    throw new HomeworkDatabaseError('PostgreSQL database version metadata is invalid');
  }
  const version = Number(text);
  if (!Number.isSafeInteger(version)) {
    throw new HomeworkDatabaseError('PostgreSQL database version metadata is invalid');
  }
  return version;
}

async function queryMeta(executor, key) {
  const result = await executor.query(
    'SELECT value FROM database_meta WHERE key = $1',
    [String(key)],
  );
  return result.rows[0]?.value ?? null;
}

async function setMetaWithExecutor(executor, key, value) {
  await executor.query(`
    INSERT INTO database_meta (key, value) VALUES ($1, $2)
    ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value
  `, [String(key), String(value)]);
}

function taskInsertValues(task, now, notificationPending = 0, notificationKind = null) {
  return [
    sourceId(task),
    externalId(task),
    task.fingerprint,
    targetId(task),
    String(task.snapshot.description ?? ''),
    serializeJson(task.homeworkIds ?? [], []),
    serializeJson(task.snapshot, {}),
    now,
    now,
    notificationPending,
    notificationKind,
    now,
    now,
  ];
}

async function updateSeenTaskWithExecutor(executor, task, {
  timestamp,
  notificationKind = null,
  previous,
} = {}) {
  const pending = notificationKind ? 1 : 0;
  const result = await executor.query(`
    UPDATE homework_tasks
    SET source = $1,
        external_id = $2,
        fingerprint = $3,
        target_appointment_id = $4,
        normalized_description = $5,
        homework_ids_json = $6,
        snapshot_json = $7,
        is_current = 1,
        last_seen_at = $8,
        notification_pending = CASE WHEN $9 = 1 THEN 1 ELSE notification_pending END,
        notification_kind = CASE WHEN $10 = 1 THEN $11 ELSE notification_kind END,
        updated_at = $12
    WHERE id = $13
    RETURNING *
  `, [
    sourceId(task),
    externalId(task),
    task.fingerprint,
    targetId(task),
    String(task.snapshot.description ?? ''),
    serializeJson(task.homeworkIds ?? [], []),
    serializeJson(task.snapshot, {}),
    timestamp,
    pending,
    pending,
    notificationKind,
    timestamp,
    Number(previous.id),
  ]);
  return rowToTask(result.rows[0]);
}

async function insertSeenTaskWithExecutor(executor, task, {
  timestamp,
  notificationKind = null,
} = {}) {
  const pending = notificationKind ? 1 : 0;
  const result = await executor.query(`
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
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, 1, 'pending', $8, $9, NULL, $10, $11, NULL, $12, $13)
    RETURNING *
  `, taskInsertValues(task, timestamp, pending, notificationKind));
  return rowToTask(result.rows[0]);
}

export async function createPostgresHomeworkDatabase({
  connectionString = process.env.HOMEWORK_DATABASE_URL,
  pool = null,
} = {}) {
  const configured = configuredConnectionString(connectionString);
  const ownsPool = !pool;
  const databasePool = pool ?? new Pool({
    connectionString: configured,
    max: 2,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });

  async function query(text, values = []) {
    try {
      return await databasePool.query(text, values);
    } catch (error) {
      throw wrapDatabaseError('PostgreSQL query failed', error);
    }
  }

  async function withTransaction(callback) {
    let client;
    try {
      client = await databasePool.connect();
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client?.query('ROLLBACK');
      } catch {
        // Preserve the original transaction error.
      }
      throw wrapDatabaseError('PostgreSQL transaction failed', error);
    } finally {
      client?.release();
    }
  }

  try {
    await query(POSTGRES_SCHEMA);
    const storedVersion = parseDatabaseVersion(await queryMeta(databasePool, 'database_version'));
    if (storedVersion > DATABASE_VERSION) {
      throw new HomeworkDatabaseError(
        `PostgreSQL database version ${storedVersion} is newer than supported version ${DATABASE_VERSION}`,
      );
    }
    if (storedVersion > 0 && storedVersion < DATABASE_VERSION) {
      throw new HomeworkDatabaseError(
        `PostgreSQL database version ${storedVersion} requires an explicit migration to ${DATABASE_VERSION}`,
      );
    }
    if (storedVersion === 0) {
      await setMetaWithExecutor(databasePool, 'database_version', DATABASE_VERSION);
    }
  } catch (error) {
    if (ownsPool) {
      await databasePool.end().catch(() => {});
    }
    throw wrapDatabaseError('Could not initialize PostgreSQL database', error);
  }

  let closed = false;
  const migrationDiagnostics = {
    fromVersion: DATABASE_VERSION,
    toVersion: DATABASE_VERSION,
    convertedValues: 0,
    invalidValues: 0,
  };

  async function getMeta(key) {
    const result = await query(
      'SELECT value FROM database_meta WHERE key = $1',
      [String(key)],
    );
    return result.rows[0]?.value ?? null;
  }

  async function setMeta(key, value) {
    try {
      await setMetaWithExecutor(databasePool, key, value);
    } catch (error) {
      throw wrapDatabaseError('Could not save PostgreSQL metadata', error);
    }
  }

  function getMigrationDiagnostics() {
    return { ...migrationDiagnostics };
  }

  async function count() {
    const result = await query('SELECT COUNT(*) AS count FROM homework_tasks');
    return Number(result.rows[0]?.count ?? 0);
  }

  async function countBySource(source) {
    const result = await query(
      'SELECT COUNT(*) AS count FROM homework_tasks WHERE source = $1',
      [sourceId({ source })],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async function findById(id, executor = databasePool) {
    const result = await executor.query('SELECT * FROM homework_tasks WHERE id = $1', [Number(id)]);
    return rowToTask(result.rows[0]);
  }

  async function findByFingerprint(fingerprint, source = null) {
    const result = source === null || source === undefined
      ? await query('SELECT * FROM homework_tasks WHERE fingerprint = $1', [String(fingerprint)])
      : await query(
        'SELECT * FROM homework_tasks WHERE source = $1 AND fingerprint = $2',
        [sourceId({ source }), String(fingerprint)],
      );
    return rowToTask(result.rows[0]);
  }

  async function findByExternalId(external, source) {
    if (external === undefined || external === null || String(external).trim() === '') {
      return null;
    }
    const result = await query(
      'SELECT * FROM homework_tasks WHERE source = $1 AND external_id = $2',
      [sourceId({ source }), String(external)],
    );
    return rowToTask(result.rows[0]);
  }

  async function findMatches(tasks) {
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

    for (let index = 0; index < uniqueTasks.length; index += 1) {
      const task = uniqueTasks[index];
      assign(index, await findByExternalId(externalId(task), sourceId(task)));
    }
    for (let index = 0; index < uniqueTasks.length; index += 1) {
      if (!matches[index]) {
        const task = uniqueTasks[index];
        assign(index, await findByFingerprint(task.fingerprint, sourceId(task)));
      }
    }

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

    for (const [appointmentId, indexes] of pendingByAppointment) {
      const result = await query(
        `SELECT * FROM homework_tasks
         WHERE source = $1 AND target_appointment_id = $2
         ORDER BY id`,
        ['eschool', appointmentId],
      );
      const candidates = result.rows
        .map(rowToTask)
        .filter((row) => !reservedRowIds.has(row.id));
      if (indexes.length === 1 && candidates.length === 1) {
        assign(indexes[0], candidates[0]);
      }
    }

    return uniqueTasks.map((task, index) => ({ task, previous: matches[index] }));
  }

  async function findMatch(task) {
    return (await findMatches([task]))[0]?.previous ?? null;
  }

  async function currentTasks() {
    const result = await query(`
      SELECT * FROM homework_tasks
      WHERE is_current = 1 AND status = 'pending'
      ORDER BY
        CASE WHEN COALESCE(snapshot_json::jsonb ->> 'targetDate', '') = '' THEN 1 ELSE 0 END,
        snapshot_json::jsonb ->> 'targetDate',
        id
    `);
    return result.rows.map(rowToTask);
  }

  async function completedTasks() {
    const result = await query(`
      SELECT * FROM homework_tasks
      WHERE status = 'completed'
      ORDER BY
        CASE WHEN COALESCE(snapshot_json::jsonb ->> 'targetDate', '') = '' THEN 1 ELSE 0 END,
        snapshot_json::jsonb ->> 'targetDate',
        completed_at DESC,
        id
    `);
    return result.rows.map(rowToTask);
  }

  async function pendingNotifications(source = null) {
    const result = await query(`
      SELECT * FROM homework_tasks
      WHERE notification_pending = 1
      ORDER BY id
    `);
    const tasks = result.rows.map(rowToTask);
    if (source === null || source === undefined) {
      return tasks;
    }
    const normalizedSource = sourceId({ source });
    return tasks.filter((task) => task.source === normalizedSource);
  }

  async function markAllNotCurrent(timestamp) {
    await query(
      'UPDATE homework_tasks SET is_current = 0, updated_at = $1 WHERE is_current = 1',
      [normalizeTimestampForStorage(timestamp)],
    );
  }

  async function markSourceNotCurrent(source, timestamp) {
    await query(
      `UPDATE homework_tasks
       SET is_current = 0, updated_at = $1
       WHERE source = $2 AND is_current = 1`,
      [normalizeTimestampForStorage(timestamp), sourceId({ source })],
    );
  }

  async function saveBaseline(tasks, timestamp, { source = null } = {}) {
    const now = normalizeTimestampForStorage(timestamp);
    const taskSource = source
      ? sourceId({ source })
      : sourceId(tasks[0] ?? {});
    const matches = await findMatches(tasks);
    try {
      await withTransaction(async (client) => {
        for (const { task, previous } of matches) {
          if (previous) {
            continue;
          }
          await insertSeenTaskWithExecutor(client, task, {
            timestamp: now,
            notificationKind: null,
          });
        }
        await setMetaWithExecutor(client, baselineMetaKey(taskSource), now);
      });
    } catch (error) {
      throw wrapDatabaseError('Could not initialize PostgreSQL database baseline', error);
    }
  }

  async function importLegacyState(tasks, timestamp) {
    await saveBaseline(tasks, timestamp, { source: 'eschool' });
  }

  async function applyProviderSnapshot(plan, timestamp, { source } = {}) {
    const now = normalizeTimestampForStorage(timestamp ?? new Date());
    const taskSource = sourceId({ source: source ?? plan[0]?.task?.source });
    try {
      const resolvedPlan = await Promise.all((plan ?? []).map(async (entry) => ({
        ...entry,
        // `null` is an explicit no-match from the sync planner. Only an
        // omitted previous row needs a compatibility lookup.
        previous: entry.previous === undefined
          ? await findMatch(entry.task)
          : entry.previous,
      })));
      return await withTransaction(async (client) => {
        await client.query(
          `UPDATE homework_tasks
           SET is_current = 0, updated_at = $1
           WHERE source = $2 AND is_current = 1`,
          [now, taskSource],
        );
        const rows = [];
        for (const entry of resolvedPlan) {
          const existing = entry.previous;
          const row = existing
            ? await updateSeenTaskWithExecutor(client, entry.task, {
              timestamp: now,
              notificationKind: entry.notificationKind ?? null,
              previous: existing,
            })
            : await insertSeenTaskWithExecutor(client, entry.task, {
              timestamp: now,
              notificationKind: entry.notificationKind ?? null,
            });
          rows.push(row);
        }
        return rows;
      });
    } catch (error) {
      throw new HomeworkDatabaseError(
        `Could not save ${taskSource} PostgreSQL snapshot: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  async function upsertSeenTask(task, {
    timestamp,
    notificationKind = null,
    previous = undefined,
  } = {}) {
    assertTask(task);
    const now = normalizeTimestampForStorage(timestamp ?? new Date());
    const existing = previous === undefined ? await findMatch(task) : previous;
    try {
      return existing
        ? await updateSeenTaskWithExecutor(databasePool, task, {
          timestamp: now,
          notificationKind,
          previous: existing,
        })
        : await insertSeenTaskWithExecutor(databasePool, task, {
          timestamp: now,
          notificationKind,
        });
    } catch (error) {
      throw wrapDatabaseError('Could not save PostgreSQL homework task', error);
    }
  }

  async function recordNotificationSuccess(id, timestamp) {
    const now = normalizeTimestampForStorage(timestamp ?? new Date());
    try {
      await query(`
        UPDATE homework_tasks
        SET last_notified_at = $1,
            notification_pending = 0,
            notification_kind = NULL,
            updated_at = $2
        WHERE id = $3
      `, [now, now, Number(id)]);
      return findById(id);
    } catch (error) {
      throw wrapDatabaseError('Could not record PostgreSQL Telegram delivery', error);
    }
  }

  async function completeTask(id, timestamp = new Date().toISOString()) {
    const task = await findById(id);
    if (!task) {
      return null;
    }
    const now = normalizeTimestampForStorage(timestamp, 'completed_at');
    try {
      const result = await query(`
        UPDATE homework_tasks
        SET status = 'completed', completed_at = $1, updated_at = $2
        WHERE id = $3 AND status <> 'completed'
        RETURNING *
      `, [now, now, Number(id)]);
      return rowToTask(result.rows[0]) ?? await findById(id);
    } catch (error) {
      throw wrapDatabaseError('Could not mark PostgreSQL homework as completed', error);
    }
  }

  async function uncompleteTask(id, timestamp = new Date().toISOString()) {
    const task = await findById(id);
    if (!task || task.status !== 'completed') {
      return null;
    }
    const now = normalizeTimestampForStorage(timestamp, 'updated_at');
    try {
      const result = await query(`
        UPDATE homework_tasks
        SET status = 'pending', completed_at = NULL, is_current = 1, updated_at = $1
        WHERE id = $2 AND status = 'completed'
        RETURNING *
      `, [now, Number(id)]);
      return rowToTask(result.rows[0]);
    } catch (error) {
      throw wrapDatabaseError('Could not restore PostgreSQL homework', error);
    }
  }

  async function deleteCompletedBefore(cutoffTimestamp) {
    const cutoff = normalizeTimestampForStorage(cutoffTimestamp, 'cleanup cutoff');
    try {
      const result = await query(`
        DELETE FROM homework_tasks
        WHERE status = 'completed'
          AND completed_at IS NOT NULL
          AND completed_at < $1
      `, [cutoff]);
      return Number(result.rowCount ?? 0);
    } catch (error) {
      throw wrapDatabaseError('Could not delete expired PostgreSQL homework', error);
    }
  }

  async function close() {
    if (closed) {
      return;
    }
    closed = true;
    if (typeof databasePool.end === 'function') {
      await databasePool.end();
    }
  }

  return {
    databaseType: 'postgres',
    filePath: null,
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
