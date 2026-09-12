import pg from 'pg';
import { readFileSync } from 'node:fs';

import {
  DATABASE_VERSION,
  HomeworkDatabaseError,
  CLASSROOM_STATUS_RECONCILED_META_KEY,
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
import { isTaskInAccountingPeriod } from './classroom-policy.js';

const { Pool } = pg;

const CLASSROOM_TOMBSTONE_SCHEMA = `
  CREATE TABLE classroom_task_tombstones (
    external_id TEXT PRIMARY KEY
  )
`;

const HOMEWORK_TASK_COLUMNS = Object.freeze([
  'id',
  'source',
  'external_id',
  'fingerprint',
  'target_appointment_id',
  'normalized_description',
  'homework_ids_json',
  'snapshot_json',
  'is_current',
  'status',
  'completion_origin',
  'first_seen_at',
  'last_seen_at',
  'last_notified_at',
  'notification_pending',
  'notification_kind',
  'completed_at',
  'created_at',
  'updated_at',
]);
const HOMEWORK_TASK_SELECT = HOMEWORK_TASK_COLUMNS.join(', ');
const MATCH_BATCH_SIZE = 250;
const INSERT_BATCH_SIZE = 100;

function taskStorageValues(task) {
  return {
    source: sourceId(task),
    externalId: externalId(task),
    fingerprint: String(task.fingerprint),
    targetAppointmentId: targetId(task),
    normalizedDescription: String(task.snapshot?.description ?? ''),
    homeworkIdsJson: serializeJson(task.homeworkIds ?? [], []),
    snapshotJson: serializeJson(task.snapshot, {}),
  };
}

function storageValuesEqual(previous, task) {
  if (!previous) {
    return false;
  }
  const current = taskStorageValues(task);
  return previous.source === current.source
    && String(previous.externalId ?? '') === String(current.externalId ?? '')
    && previous.fingerprint === current.fingerprint
    && String(previous.targetAppointmentId ?? '') === current.targetAppointmentId
    && previous.normalizedDescription === current.normalizedDescription
    && serializeJson(previous.homeworkIds ?? [], []) === current.homeworkIdsJson
    && serializeJson(previous.snapshot ?? {}, {}) === current.snapshotJson;
}

function rowLikeTask(previous, task, timestamp, {
  id = previous?.id ?? null,
  isCurrent = previous?.isCurrent ?? true,
  status = previous?.status ?? 'pending',
  completionOrigin = previous?.completionOrigin ?? null,
  completedAt = previous?.completedAt ?? null,
  lastSeenAt = previous?.lastSeenAt ?? timestamp,
  lastNotifiedAt = previous?.lastNotifiedAt ?? null,
  notificationPending = previous?.notificationPending ?? false,
  notificationKind = previous?.notificationKind ?? null,
  firstSeenAt = previous?.firstSeenAt ?? timestamp,
  createdAt = previous?.createdAt ?? timestamp,
  updatedAt = previous?.updatedAt ?? timestamp,
} = {}) {
  const values = taskStorageValues(task);
  return rowToTask({
    id,
    source: values.source,
    external_id: values.externalId,
    fingerprint: values.fingerprint,
    target_appointment_id: values.targetAppointmentId,
    normalized_description: values.normalizedDescription,
    homework_ids_json: values.homeworkIdsJson,
    snapshot_json: values.snapshotJson,
    is_current: isCurrent ? 1 : 0,
    status,
    completion_origin: completionOrigin,
    first_seen_at: firstSeenAt,
    last_seen_at: lastSeenAt,
    last_notified_at: lastNotifiedAt,
    notification_pending: notificationPending ? 1 : 0,
    notification_kind: notificationKind,
    completed_at: completedAt,
    created_at: createdAt,
    updated_at: updatedAt,
  });
}

function chunkValues(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function parameterizedIn(column, values, firstParameter = 1) {
  return `${column} IN (${values.map((_, index) => `$${firstParameter + index}`).join(', ')})`;
}

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
    completion_origin TEXT CHECK (completion_origin IS NULL OR completion_origin IN ('manual', 'classroom')),
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

function configuredDatabaseSsl() {
  const inlineCertificate = String(process.env.HOMEWORK_DATABASE_CA_CERT ?? '').trim();
  const certificatePath = String(process.env.HOMEWORK_DATABASE_CA_CERT_PATH ?? '').trim();
  if (inlineCertificate && certificatePath) {
    throw new HomeworkDatabaseError(
      'Configure only one of HOMEWORK_DATABASE_CA_CERT or HOMEWORK_DATABASE_CA_CERT_PATH',
      { code: 'DATABASE_CONFIG_ERROR' },
    );
  }
  if (!inlineCertificate && !certificatePath) {
    return undefined;
  }
  try {
    const certificate = inlineCertificate || readFileSync(certificatePath, 'utf8');
    if (!String(certificate).trim()) {
      throw new Error('empty certificate');
    }
    return {
      rejectUnauthorized: true,
      ca: String(certificate),
    };
  } catch {
    throw new HomeworkDatabaseError(
      'Could not load the PostgreSQL CA certificate',
      { code: 'DATABASE_CONFIG_ERROR' },
    );
  }
}

function connectionStringForExplicitSsl(connectionString, ssl) {
  if (!ssl) {
    return connectionString;
  }
  try {
    const parsed = new URL(connectionString);
    for (const parameter of ['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'uselibpqcompat']) {
      parsed.searchParams.delete(parameter);
    }
    return parsed.toString();
  } catch {
    throw new HomeworkDatabaseError(
      'HOMEWORK_DATABASE_URL must be a valid PostgreSQL connection string',
      { code: 'DATABASE_CONFIG_ERROR' },
    );
  }
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

async function migrateV3ToV4(executor) {
  await executor.query(`
    ALTER TABLE homework_tasks
    ADD COLUMN completion_origin TEXT
  `);
  await executor.query(`
    ALTER TABLE homework_tasks
    ADD CONSTRAINT homework_tasks_completion_origin_check
      CHECK (completion_origin IS NULL OR completion_origin IN ('manual', 'classroom'))
  `);
  const converted = await executor.query(`
    UPDATE homework_tasks
    SET completion_origin = 'manual'
    WHERE status = 'completed'
  `);
  await setMetaWithExecutor(executor, 'database_version', 4);
  return Number(converted.rowCount ?? 0);
}

function taskInsertValues(task, now, {
  notificationPending = 0,
  notificationKind = null,
  status = 'pending',
  completionOrigin = null,
  completedAt = null,
  isCurrent = status === 'pending' ? 1 : 0,
} = {}) {
  const values = taskStorageValues(task);
  return [
    values.source,
    values.externalId,
    values.fingerprint,
    values.targetAppointmentId,
    values.normalizedDescription,
    values.homeworkIdsJson,
    values.snapshotJson,
    isCurrent,
    status,
    completionOrigin,
    now,
    now,
    null,
    notificationPending,
    notificationKind,
    completedAt,
    now,
    now,
  ];
}

async function updateSeenTaskWithExecutor(executor, task, {
  timestamp,
  notificationKind = null,
  previous,
} = {}) {
  if (!previous) {
    throw new HomeworkDatabaseError('Cannot update a missing PostgreSQL homework task');
  }
  const values = taskStorageValues(task);
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
        notification_pending = CASE WHEN $9 = 1 AND status = 'pending' THEN 1 ELSE notification_pending END,
        notification_kind = CASE WHEN $9 = 1 AND status = 'pending' THEN $10 ELSE notification_kind END,
        updated_at = $11
    WHERE id = $12
    RETURNING id
  `, [
    values.source,
    values.externalId,
    values.fingerprint,
    values.targetAppointmentId,
    values.normalizedDescription,
    values.homeworkIdsJson,
    values.snapshotJson,
    timestamp,
    pending,
    notificationKind,
    timestamp,
    Number(previous.id),
  ]);
  if (!result.rows[0]) {
    return null;
  }
  return rowLikeTask(previous, task, timestamp, {
    isCurrent: true,
    lastSeenAt: timestamp,
    notificationPending: previous.notificationPending || Boolean(pending && previous.status === 'pending'),
    notificationKind: pending && previous.status === 'pending'
      ? notificationKind
      : previous.notificationKind,
    updatedAt: timestamp,
  });
}

async function insertSeenTaskWithExecutor(executor, task, {
  timestamp,
  notificationKind = null,
  status = 'pending',
  completionOrigin = null,
  completedAt = null,
  isCurrent = status === 'pending' ? 1 : 0,
  retiredExternalIds = null,
} = {}) {
  const taskExternalId = externalId(task);
  if (sourceId(task) === 'classroom' && !retiredExternalIds) {
    const retired = await executor.query(
      'SELECT external_id FROM classroom_task_tombstones WHERE external_id = $1',
      [taskExternalId],
    );
    // Every insert path (including baselines and status-only observations)
    // must respect retention. Only a confirmed pending status clears this key.
    if (retired.rows.length > 0) {
      return null;
    }
  }
  if (sourceId(task) === 'classroom' && retiredExternalIds?.has(taskExternalId)) {
    return null;
  }
  const pending = notificationKind ? 1 : 0;
  const values = taskInsertValues(task, timestamp, {
    notificationPending: pending,
    notificationKind,
    status,
    completionOrigin,
    completedAt,
    isCurrent,
  });
  const result = await executor.query(`
    INSERT INTO homework_tasks (
      source, external_id, fingerprint, target_appointment_id,
      normalized_description, homework_ids_json, snapshot_json,
      is_current, status, completion_origin, first_seen_at, last_seen_at,
      last_notified_at, notification_pending, notification_kind,
      completed_at, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
    RETURNING id
  `, values);
  const id = result.rows[0]?.id;
  return id === undefined
    ? null
    : rowLikeTask(null, task, timestamp, {
      id: Number(id),
      isCurrent,
      status,
      completionOrigin,
      completedAt,
      notificationPending: Boolean(pending),
      notificationKind,
      lastSeenAt: timestamp,
      firstSeenAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
}

function buildMultiInsertQuery(entries) {
  const columns = [
    'source',
    'external_id',
    'fingerprint',
    'target_appointment_id',
    'normalized_description',
    'homework_ids_json',
    'snapshot_json',
    'is_current',
    'status',
    'completion_origin',
    'first_seen_at',
    'last_seen_at',
    'last_notified_at',
    'notification_pending',
    'notification_kind',
    'completed_at',
    'created_at',
    'updated_at',
  ];
  const placeholders = entries.map((_, rowIndex) => (
    `(${columns.map((__, columnIndex) => `$${rowIndex * columns.length + columnIndex + 1}`).join(', ')})`
  ));
  return `
    INSERT INTO homework_tasks (${columns.join(', ')})
    VALUES ${placeholders.join(', ')}
    RETURNING id, fingerprint
  `;
}

async function insertManySeenTasksWithExecutor(executor, entries, {
  timestamp,
  retiredExternalIds = null,
} = {}) {
  const accepted = entries.filter(({ task }) => (
    sourceId(task) !== 'classroom'
      || !retiredExternalIds?.has(externalId(task))
  ));
  const inserted = [];
  for (const batch of chunkValues(accepted, INSERT_BATCH_SIZE)) {
    if (batch.length === 0) {
      continue;
    }
    const values = batch.flatMap(({ task, notificationKind = null, status = 'pending',
      completionOrigin = null, completedAt = null, isCurrent = status === 'pending' ? 1 : 0 }) => (
      taskInsertValues(task, timestamp, {
        notificationPending: notificationKind ? 1 : 0,
        notificationKind,
        status,
        completionOrigin,
        completedAt,
        isCurrent,
      })
    ));
    const result = await executor.query(buildMultiInsertQuery(batch), values);
    const idsByFingerprint = new Map(
      result.rows.map((row) => [String(row.fingerprint), Number(row.id)]),
    );
    for (const entry of batch) {
      const id = idsByFingerprint.get(String(entry.task.fingerprint));
      if (id === undefined) {
        continue;
      }
      inserted.push(rowLikeTask(null, entry.task, timestamp, {
        id,
        isCurrent: entry.isCurrent ?? (entry.status === 'pending' ? 1 : 0),
        status: entry.status ?? 'pending',
        completionOrigin: entry.completionOrigin ?? null,
        completedAt: entry.completedAt ?? null,
        notificationPending: Boolean(entry.notificationKind),
        notificationKind: entry.notificationKind ?? null,
        lastSeenAt: timestamp,
        firstSeenAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      }));
    }
  }
  return inserted;
}

export async function createPostgresHomeworkDatabase({
  connectionString = process.env.HOMEWORK_DATABASE_URL,
  pool = null,
  ssl = undefined,
} = {}) {
  const configured = configuredConnectionString(connectionString);
  const ownsPool = !pool;
  const poolOptions = {
    connectionString: configured,
    max: 2,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  };
  if (ownsPool) {
    const configuredSsl = ssl ?? configuredDatabaseSsl();
    if (configuredSsl) {
      poolOptions.connectionString = connectionStringForExplicitSsl(configured, configuredSsl);
      poolOptions.ssl = configuredSsl;
    }
  }
  const databasePool = pool ?? new Pool(poolOptions);

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

  const migrationDiagnostics = {
    fromVersion: DATABASE_VERSION,
    toVersion: DATABASE_VERSION,
    convertedValues: 0,
    invalidValues: 0,
  };

  try {
    const schemaTables = await query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = $1
         AND table_name IN ($2, $3)`,
      ['public', 'database_meta', 'homework_tasks'],
    );
    const existingTables = new Set(schemaTables.rows.map((row) => row.table_name));
    if (existingTables.size === 0) {
      await query(POSTGRES_SCHEMA);
    } else {
      // pg-mem rejects a repeated CREATE TABLE IF NOT EXISTS with constraints;
      // checking the catalog also avoids needless DDL on a live PostgreSQL DB.
      if (!existingTables.has('database_meta')) {
        await query(`
          CREATE TABLE database_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
          )
        `);
      }
      if (!existingTables.has('homework_tasks')) {
        await query(`
          CREATE TABLE homework_tasks (
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
            completion_origin TEXT CHECK (completion_origin IS NULL OR completion_origin IN ('manual', 'classroom')),
            first_seen_at TEXT NOT NULL,
            last_seen_at TEXT NOT NULL,
            last_notified_at TEXT,
            notification_pending INTEGER NOT NULL DEFAULT 0 CHECK (notification_pending IN (0, 1)),
            notification_kind TEXT,
            completed_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          )
        `);
      }
    }
    const storedVersion = parseDatabaseVersion(await queryMeta(databasePool, 'database_version'));
    migrationDiagnostics.fromVersion = storedVersion || DATABASE_VERSION;
    if (storedVersion > DATABASE_VERSION) {
      throw new HomeworkDatabaseError(
        `PostgreSQL database version ${storedVersion} is newer than supported version ${DATABASE_VERSION}`,
      );
    }
    if (storedVersion === 0 || storedVersion === 3 || storedVersion === 4) {
      await withTransaction(async (client) => {
        if (storedVersion === 3) {
          migrationDiagnostics.convertedValues = await migrateV3ToV4(client);
        }
        await client.query(CLASSROOM_TOMBSTONE_SCHEMA);
        await setMetaWithExecutor(client, 'database_version', DATABASE_VERSION);
      });
    } else if (storedVersion > 0 && storedVersion < DATABASE_VERSION) {
      throw new HomeworkDatabaseError(
        `PostgreSQL database version ${storedVersion} requires an explicit migration to ${DATABASE_VERSION}`,
      );
    }
  } catch (error) {
    if (ownsPool) {
      await databasePool.end().catch(() => {});
    }
    throw wrapDatabaseError('Could not initialize PostgreSQL database', error);
  }

  let closed = false;

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
    const result = await executor.query(
      `SELECT ${HOMEWORK_TASK_SELECT} FROM homework_tasks WHERE id = $1`,
      [Number(id)],
    );
    return rowToTask(result.rows[0]);
  }

  async function findByFingerprint(fingerprint, source = null) {
    const result = source === null || source === undefined
      ? await query(
        `SELECT ${HOMEWORK_TASK_SELECT} FROM homework_tasks WHERE fingerprint = $1`,
        [String(fingerprint)],
      )
      : await query(
        `SELECT ${HOMEWORK_TASK_SELECT}
         FROM homework_tasks WHERE source = $1 AND fingerprint = $2`,
        [sourceId({ source }), String(fingerprint)],
      );
    return rowToTask(result.rows[0]);
  }

  async function findByExternalIdWithExecutor(executor, external, source) {
    if (external === undefined || external === null || String(external).trim() === '') {
      return null;
    }
    const result = await executor.query(
      `SELECT ${HOMEWORK_TASK_SELECT}
       FROM homework_tasks WHERE source = $1 AND external_id = $2`,
      [sourceId({ source }), String(external)],
    );
    return rowToTask(result.rows[0]);
  }

  async function findByExternalId(external, source) {
    return findByExternalIdWithExecutor(databasePool, external, source);
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

    const grouped = new Map();
    uniqueTasks.forEach((task, index) => {
      const source = sourceId(task);
      const group = grouped.get(source) ?? { indexes: [], externalIds: [], fingerprints: [] };
      group.indexes.push(index);
      const external = externalId(task);
      if (external) group.externalIds.push(external);
      group.fingerprints.push(String(task.fingerprint));
      grouped.set(source, group);
    });

    async function loadByAny(source, column, values) {
      const rows = [];
      for (const batch of chunkValues([...new Set(values)], MATCH_BATCH_SIZE)) {
        if (batch.length === 0) continue;
        const result = await query(
          `SELECT ${HOMEWORK_TASK_SELECT}
           FROM homework_tasks
           WHERE source = $1 AND ${parameterizedIn(column, batch, 2)}
           ORDER BY id`,
          [source, ...batch],
        );
        rows.push(...result.rows.map(rowToTask));
      }
      return rows;
    }

    for (const [source, group] of grouped) {
      const externalRows = await loadByAny(source, 'external_id', group.externalIds);
      const externalMap = new Map();
      for (const row of externalRows) {
        const key = String(row.externalId ?? '');
        if (!externalMap.has(key)) externalMap.set(key, []);
        externalMap.get(key).push(row);
      }
      for (const index of group.indexes) {
        assign(index, externalMap.get(String(externalId(uniqueTasks[index]) ?? ''))?.shift());
      }

      const fingerprintRows = await loadByAny(source, 'fingerprint', group.fingerprints);
      const fingerprintMap = new Map();
      for (const row of fingerprintRows) {
        if (!fingerprintMap.has(row.fingerprint)) fingerprintMap.set(row.fingerprint, []);
        fingerprintMap.get(row.fingerprint).push(row);
      }
      for (const index of group.indexes) {
        if (!matches[index]) {
          assign(index, fingerprintMap.get(String(uniqueTasks[index].fingerprint))?.shift());
        }
      }
    }

    const appointmentIds = [...new Set(uniqueTasks
      .map((task, index) => matches[index] || sourceId(task) !== 'eschool' ? null : targetId(task))
      .filter(Boolean))];
    for (const batch of chunkValues(appointmentIds, MATCH_BATCH_SIZE)) {
      if (batch.length === 0) continue;
      const result = await query(
        `SELECT ${HOMEWORK_TASK_SELECT}
         FROM homework_tasks
         WHERE source = $1 AND ${parameterizedIn('target_appointment_id', batch, 2)}
         ORDER BY id`,
        ['eschool', ...batch],
      );
      const candidatesByAppointment = new Map();
      for (const row of result.rows.map(rowToTask)) {
        const key = String(row.targetAppointmentId ?? '');
        if (!candidatesByAppointment.has(key)) candidatesByAppointment.set(key, []);
        candidatesByAppointment.get(key).push(row);
      }
      const pendingByAppointment = new Map();
      uniqueTasks.forEach((task, index) => {
        if (matches[index] || sourceId(task) !== 'eschool') return;
        const appointmentId = targetId(task);
        if (!batch.includes(appointmentId)) return;
        const indexes = pendingByAppointment.get(appointmentId) ?? [];
        indexes.push(index);
        pendingByAppointment.set(appointmentId, indexes);
      });
      for (const [appointmentId, indexes] of pendingByAppointment) {
        const candidates = (candidatesByAppointment.get(appointmentId) ?? [])
          .filter((row) => !reservedRowIds.has(row.id));
        if (indexes.length === 1 && candidates.length === 1) {
          assign(indexes[0], candidates[0]);
        }
      }
    }

    return uniqueTasks.map((task, index) => ({ task, previous: matches[index] }));
  }

  async function findMatch(task) {
    return (await findMatches([task]))[0]?.previous ?? null;
  }

  async function currentTasks() {
    const result = await query(`
      SELECT ${HOMEWORK_TASK_SELECT} FROM homework_tasks
      WHERE is_current = 1 AND status = 'pending'
      ORDER BY
        CASE WHEN COALESCE(snapshot_json::jsonb ->> 'targetDate', '') = '' THEN 1 ELSE 0 END,
        snapshot_json::jsonb ->> 'targetDate',
        id
    `);
    return result.rows.map(rowToTask).filter(isTaskInAccountingPeriod);
  }

  async function completedTasks() {
    const result = await query(`
      SELECT ${HOMEWORK_TASK_SELECT} FROM homework_tasks
      WHERE status = 'completed'
      ORDER BY
        CASE WHEN COALESCE(snapshot_json::jsonb ->> 'targetDate', '') = '' THEN 1 ELSE 0 END,
        snapshot_json::jsonb ->> 'targetDate',
        completed_at DESC,
        id
    `);
    return result.rows.map(rowToTask).filter(isTaskInAccountingPeriod);
  }

  async function pendingNotifications(source = null) {
    const values = [];
    const sourceClause = source === null || source === undefined
      ? ''
      : (() => {
        values.push(sourceId({ source }));
        return ' AND source = $1';
      })();
    const result = await query(`
      SELECT ${HOMEWORK_TASK_SELECT} FROM homework_tasks
      WHERE notification_pending = 1${sourceClause}
      ORDER BY id
    `, values);
    const tasks = result.rows.map(rowToTask).filter(isTaskInAccountingPeriod);
    return tasks;
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

  async function loadRetiredClassroomIds(executor, tasks) {
    const ids = [...new Set(tasks
      .filter((task) => sourceId(task) === 'classroom')
      .map((task) => externalId(task))
      .filter(Boolean))];
    const retired = new Set();
    for (const batch of chunkValues(ids, MATCH_BATCH_SIZE)) {
      if (batch.length === 0) continue;
      const result = await executor.query(
        `SELECT external_id FROM classroom_task_tombstones
         WHERE ${parameterizedIn('external_id', batch, 1)}`,
        batch,
      );
      for (const row of result.rows) retired.add(String(row.external_id));
    }
    return retired;
  }

  async function restoreClassroomTombstones(executor, updates, snapshotComplete) {
    if (snapshotComplete === false) {
      return new Set();
    }
    const ids = [...new Set(updates
      .filter((update) => update.status === 'pending'
        && isTaskInAccountingPeriod(update.task))
      .map((update) => externalId(update.task))
      .filter(Boolean))];
    const restored = new Set();
    for (const batch of chunkValues(ids, MATCH_BATCH_SIZE)) {
      if (batch.length === 0) continue;
      const result = await executor.query(
        `DELETE FROM classroom_task_tombstones
         WHERE ${parameterizedIn('external_id', batch, 1)}
         RETURNING external_id`,
        batch,
      );
      for (const row of result.rows) restored.add(String(row.external_id));
    }
    return restored;
  }

  async function saveBaseline(tasks, timestamp, {
    source = null,
    statusUpdates = [],
  } = {}) {
    const now = normalizeTimestampForStorage(timestamp);
    const taskSource = source
      ? sourceId({ source })
      : sourceId(tasks[0] ?? {});
    const statusByIdentity = new Map();
    for (const entry of statusUpdates ?? []) {
      const task = entry?.task ?? entry;
      const status = String(entry?.status ?? task?.classroomStatus ?? '')
        .trim()
        .toLowerCase();
      if (taskSource === 'classroom' && ['pending', 'completed'].includes(status)) {
        statusByIdentity.set(taskIdentity(task), status);
      }
    }
    const matches = await findMatches(tasks);
    try {
      const result = await withTransaction(async (client) => {
        const missing = matches.filter(({ previous }) => !previous);
        const retiredExternalIds = await loadRetiredClassroomIds(
          client,
          missing.map(({ task }) => task),
        );
        const inserted = await insertManySeenTasksWithExecutor(
          client,
          missing.map(({ task }) => {
            const status = statusByIdentity.get(taskIdentity(task))
              ?? (taskSource === 'classroom' && task.classroomStatus === 'completed'
                ? 'completed'
                : 'pending');
            return {
              task,
              notificationKind: null,
              status,
              completionOrigin: status === 'completed' && taskSource === 'classroom'
                ? 'classroom'
                : null,
              completedAt: status === 'completed' ? now : null,
              isCurrent: status === 'pending' ? 1 : 0,
            };
          }),
          { timestamp: now, retiredExternalIds },
        );
        await setMetaWithExecutor(client, baselineMetaKey(taskSource), now);
        return {
          inserted: inserted.length,
          unchanged: matches.length - missing.length,
          statusAppliedIdentities: inserted.map((task) => taskIdentity(task)),
        };
      });
      return result;
    } catch (error) {
      throw wrapDatabaseError('Could not initialize PostgreSQL database baseline', error);
    }
  }

  async function importLegacyState(tasks, timestamp) {
    await saveBaseline(tasks, timestamp, { source: 'eschool' });
  }

  async function findRowsByIdsWithExecutor(executor, ids) {
    const rows = [];
    for (const batch of chunkValues([...new Set(ids.map(Number).filter(Number.isSafeInteger))], MATCH_BATCH_SIZE)) {
      if (batch.length === 0) continue;
      const result = await executor.query(
        `SELECT ${HOMEWORK_TASK_SELECT} FROM homework_tasks
         WHERE ${parameterizedIn('id', batch, 1)}`,
        batch,
      );
      rows.push(...result.rows.map(rowToTask));
    }
    return new Map(rows.map((row) => [row.id, row]));
  }

  async function updateObservedTaskWithExecutor(executor, {
    task,
    existing,
    timestamp,
    notificationKind = null,
    statusUpdate = null,
  }) {
    assertTask(task);
    if (!existing) {
      return { row: null, changed: false, statusChanged: false, queueChanged: false };
    }

    const values = taskStorageValues(task);
    const classroomStatus = statusUpdate?.status ?? null;
    const outsideAccountingPeriod = statusUpdate
      && !isTaskInAccountingPeriod(task);
    let nextStatus = existing.status;
    let nextOrigin = existing.completionOrigin;
    let nextCompletedAt = existing.completedAt;
    let nextIsCurrent = existing.isCurrent;

    // Manual actions are authoritative. Provider data can refresh the task
    // payload, but it cannot undo a manual completion/restoration.
    if (classroomStatus && !outsideAccountingPeriod
      && existing.completionOrigin !== 'manual') {
      if (classroomStatus === 'completed') {
        nextStatus = 'completed';
        nextOrigin = 'classroom';
        nextIsCurrent = false;
        nextCompletedAt = existing.completedAt ?? timestamp;
      } else if (classroomStatus === 'pending') {
        nextStatus = 'pending';
        nextOrigin = null;
        nextIsCurrent = true;
        nextCompletedAt = null;
      }
    } else if (!classroomStatus && sourceId(task) === 'eschool') {
      nextIsCurrent = true;
    } else if (!classroomStatus && existing.completionOrigin !== 'manual') {
      nextIsCurrent = true;
    }

    let nextNotificationPending = existing.notificationPending;
    let nextNotificationKind = existing.notificationKind;
    if (outsideAccountingPeriod || nextStatus === 'completed') {
      nextNotificationPending = false;
      nextNotificationKind = null;
    } else if (notificationKind && nextStatus === 'pending') {
      // Manual completion/restoration owns the status, but it must not hide
      // a later provider content change while the task is pending.
      nextNotificationPending = true;
      nextNotificationKind = notificationKind;
    }

    const dataChanged = !storageValuesEqual(existing, task);
    const statusChanged = existing.status !== nextStatus
      || existing.completionOrigin !== nextOrigin
      || existing.completedAt !== nextCompletedAt;
    const currentChanged = existing.isCurrent !== nextIsCurrent;
    const queueChanged = existing.notificationPending !== nextNotificationPending
      || existing.notificationKind !== nextNotificationKind;
    const observedChanged = dataChanged || statusChanged || currentChanged;
    if (!observedChanged && !queueChanged) {
      return { row: existing, changed: false, statusChanged: false, queueChanged: false };
    }

    const assignments = [];
    const parameters = [];
    const add = (column, value) => {
      parameters.push(value);
      assignments.push(`${column} = $${parameters.length}`);
    };
    if (dataChanged) {
      add('source', values.source);
      add('external_id', values.externalId);
      add('fingerprint', values.fingerprint);
      add('target_appointment_id', values.targetAppointmentId);
      add('normalized_description', values.normalizedDescription);
      add('homework_ids_json', values.homeworkIdsJson);
      add('snapshot_json', values.snapshotJson);
    }
    if (currentChanged) add('is_current', nextIsCurrent ? 1 : 0);
    if (statusChanged) {
      add('status', nextStatus);
      add('completion_origin', nextOrigin);
      add('completed_at', nextCompletedAt);
    }
    if (queueChanged) {
      add('notification_pending', nextNotificationPending ? 1 : 0);
      add('notification_kind', nextNotificationKind);
    }
    if (observedChanged) add('last_seen_at', timestamp);
    add('updated_at', timestamp);
    const idParameter = parameters.length + 1;
    parameters.push(Number(existing.id));
    const result = await executor.query(`
      UPDATE homework_tasks
      SET ${assignments.join(', ')}
      WHERE id = $${idParameter}
        AND (${statusUpdate && existing.completionOrigin !== 'manual'
          ? "completion_origin IS NULL OR completion_origin <> 'manual'"
          : 'TRUE'})
      RETURNING id
    `, parameters);
    if (!result.rows[0]) {
      return { row: null, changed: false, statusChanged: false, queueChanged: false };
    }
    return {
      row: rowLikeTask(existing, task, timestamp, {
        id: existing.id,
        isCurrent: nextIsCurrent,
        status: nextStatus,
        completionOrigin: nextOrigin,
        completedAt: nextCompletedAt,
        lastSeenAt: observedChanged ? timestamp : existing.lastSeenAt,
        notificationPending: nextNotificationPending,
        notificationKind: nextNotificationKind,
        updatedAt: timestamp,
      }),
      changed: dataChanged,
      statusChanged,
      queueChanged,
    };
  }

  async function applyProviderSnapshot(plan, timestamp, {
    source,
    statusUpdates = [],
    currentExternalIds = null,
    snapshotComplete = true,
    statusReconciliationComplete = false,
    statusReconciliationMetaKey = CLASSROOM_STATUS_RECONCILED_META_KEY,
  } = {}) {
    const now = normalizeTimestampForStorage(timestamp ?? new Date());
    const taskSource = sourceId({
      source: source ?? plan[0]?.task?.source ?? statusUpdates[0]?.task?.source,
    });
    const normalizedStatusUpdates = [];
    const statusByIdentity = new Map();
    for (const entry of statusUpdates ?? []) {
      const task = entry?.task ?? entry;
      const status = String(entry?.status ?? task?.classroomStatus ?? '').trim().toLowerCase();
      if (taskSource !== 'classroom' || !['pending', 'completed'].includes(status)) continue;
      assertTask(task);
      const identity = externalId(task);
      if (!identity) {
        throw new HomeworkDatabaseError('Classroom status update is missing an external id');
      }
      const previousStatus = statusByIdentity.get(identity);
      if (previousStatus) {
        if (previousStatus.status !== status) previousStatus.status = 'unknown';
        continue;
      }
      const normalized = {
        task,
        status,
        allowInsert: entry?.allowInsert !== false,
        previous: entry?.previous,
      };
      statusByIdentity.set(identity, normalized);
      normalizedStatusUpdates.push(normalized);
    }

    const observations = new Map();
    for (const entry of plan ?? []) {
      assertTask(entry.task);
      const identity = taskIdentity(entry.task);
      const observation = observations.get(identity) ?? { task: entry.task };
      if (observation.content === undefined) observation.content = entry;
      observations.set(identity, observation);
    }
    for (const update of normalizedStatusUpdates) {
      const identity = taskIdentity(update.task);
      const observation = observations.get(identity) ?? { task: update.task };
      observation.task = observation.content?.task ?? update.task;
      observation.status = update;
      observations.set(identity, observation);
    }

    try {
      const unresolved = [];
      for (const observation of observations.values()) {
        if (observation.content?.previous === undefined) unresolved.push(observation.task);
        if (observation.status && observation.status.previous === undefined) {
          unresolved.push(observation.status.task);
        }
      }
      const lookup = unresolved.length > 0
        ? await findMatches(unresolved)
        : [];
      const lookupByIdentity = new Map(
        lookup.map(({ task, previous }) => [taskIdentity(task), previous]),
      );

      return await withTransaction(async (client) => {
        const ids = [...observations.values()]
          .map((observation) => observation.content?.previous?.id
            ?? lookupByIdentity.get(taskIdentity(observation.task))?.id)
          .filter((id) => id !== undefined && id !== null);
        const freshRows = await findRowsByIdsWithExecutor(client, ids);
        const restoredTombstones = taskSource === 'classroom'
          ? await restoreClassroomTombstones(
            client,
            normalizedStatusUpdates,
            snapshotComplete,
          )
          : new Set();
        const presentIds = new Set();
        const missing = [];
        const rows = [];
        let inserted = 0;
        let changed = 0;
        let unchanged = 0;
        let statusTransitions = 0;
        let notificationsQueued = 0;

        for (const observation of observations.values()) {
          const content = observation.content;
          const statusUpdate = observation.status?.status === 'unknown'
            ? null
            : observation.status;
          const plannedPrevious = content?.previous !== undefined
            ? content.previous
            : observation.status?.previous !== undefined
              ? observation.status.previous
              : lookupByIdentity.get(taskIdentity(observation.task));
          const existing = plannedPrevious?.id
            ? freshRows.get(Number(plannedPrevious.id)) ?? plannedPrevious
            : null;
          const notificationKind = content?.notificationKind ?? null;

          if (existing) {
            presentIds.add(existing.id);
            const outcome = await updateObservedTaskWithExecutor(client, {
              task: observation.task,
              existing,
              timestamp: now,
              notificationKind,
              statusUpdate,
            });
            if (outcome.row) rows.push(outcome.row);
            if (content) {
              if (outcome.changed) changed += 1;
              else unchanged += 1;
            }
            if (outcome.statusChanged) statusTransitions += 1;
            if (outcome.queueChanged && outcome.row?.notificationPending) {
              notificationsQueued += 1;
            }
            continue;
          }

          if (statusUpdate && (!isTaskInAccountingPeriod(observation.task)
            || (statusUpdate.allowInsert === false
              && !restoredTombstones.has(externalId(observation.task))))) {
            continue;
          }
          if (!content && !statusUpdate) continue;
          const status = statusUpdate?.status ?? 'pending';
          const insertEntry = {
            task: observation.task,
            notificationKind: status === 'pending' ? notificationKind : null,
            status,
            completionOrigin: status === 'completed' && taskSource === 'classroom'
              ? 'classroom'
              : null,
            completedAt: status === 'completed' ? now : null,
            isCurrent: status === 'pending' ? 1 : 0,
          };
          // A restored tombstone is intentionally allowed to re-enter only
          // after the provider reports a current, eligible pending status.
          if (taskSource === 'classroom'
            && restoredTombstones.has(externalId(observation.task))) {
            insertEntry.allowInsert = true;
          }
          missing.push(insertEntry);
        }

        const retiredExternalIds = await loadRetiredClassroomIds(
          client,
          missing.map(({ task }) => task),
        );
        const insertedRows = await insertManySeenTasksWithExecutor(client, missing, {
          timestamp: now,
          retiredExternalIds,
        });
        for (const row of insertedRows) {
          rows.push(row);
          presentIds.add(row.id);
          inserted += 1;
          if (row.notificationPending) notificationsQueued += 1;
        }

        let notCurrent = 0;
        if (taskSource !== 'classroom' && snapshotComplete !== false) {
          const parameters = [now, taskSource];
          let exclusion = '';
          if (presentIds.size > 0) {
            const firstParameter = parameters.length + 1;
            parameters.push(...presentIds);
            exclusion = ` AND NOT (${parameterizedIn('id', [...presentIds], firstParameter)})`;
          }
          const sweep = await client.query(`
            UPDATE homework_tasks
            SET is_current = 0, updated_at = $1
            WHERE source = $2 AND is_current = 1${exclusion}
          `, parameters);
          notCurrent = Number(sweep.rowCount ?? 0);
        }

        if (taskSource === 'classroom'
          && statusReconciliationComplete
          && snapshotComplete !== false) {
          await setMetaWithExecutor(client, statusReconciliationMetaKey, now);
        }
        return {
          rows,
          inserted,
          changed,
          unchanged,
          notCurrent,
          statusTransitions,
          notificationsQueued,
          observed: [...observations.values()].filter(({ content }) => content).length,
          currentExternalIds,
        };
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
      const result = await query(`
        UPDATE homework_tasks
        SET last_notified_at = $1,
            notification_pending = 0,
            notification_kind = NULL,
            updated_at = $2
        WHERE id = $3
      `, [now, now, Number(id)]);
      // The send path only needs an acknowledgement. Avoid fetching the full
      // snapshot again after a successful Telegram request.
      return Number(result.rowCount ?? 0) > 0;
    } catch (error) {
      throw wrapDatabaseError('Could not record PostgreSQL Telegram delivery', error);
    }
  }

  async function clearNotification(id, timestamp = new Date()) {
    const now = normalizeTimestampForStorage(timestamp, 'notification cleanup timestamp');
    try {
      const result = await query(`
        UPDATE homework_tasks
        SET notification_pending = 0,
            notification_kind = NULL,
            updated_at = $1
        WHERE id = $2
      `, [now, Number(id)]);
      return Number(result.rowCount ?? 0) > 0;
    } catch (error) {
      throw wrapDatabaseError('Could not clear PostgreSQL Telegram notification', error);
    }
  }

  async function completeTask(id, timestamp = new Date().toISOString()) {
    const task = await findById(id);
    if (!task || !isTaskInAccountingPeriod(task)) {
      return null;
    }
    const now = normalizeTimestampForStorage(timestamp, 'completed_at');
    try {
      const result = await query(`
        UPDATE homework_tasks
        SET status = 'completed',
            completion_origin = 'manual',
            completed_at = COALESCE(completed_at, $1),
            notification_pending = 0,
            notification_kind = NULL,
            updated_at = $2
        WHERE id = $3
        RETURNING ${HOMEWORK_TASK_SELECT}
      `, [now, now, Number(id)]);
      return rowToTask(result.rows[0]);
    } catch (error) {
      throw wrapDatabaseError('Could not mark PostgreSQL homework as completed', error);
    }
  }

  async function uncompleteTask(id, timestamp = new Date().toISOString()) {
    const task = await findById(id);
    if (!task || task.status !== 'completed' || !isTaskInAccountingPeriod(task)) {
      return null;
    }
    const now = normalizeTimestampForStorage(timestamp, 'updated_at');
    try {
      const result = await query(`
        UPDATE homework_tasks
        SET status = 'pending',
            completion_origin = 'manual',
            completed_at = NULL,
            is_current = 1,
            notification_pending = 0,
            notification_kind = NULL,
            updated_at = $1
        WHERE id = $2 AND status = 'completed'
        RETURNING ${HOMEWORK_TASK_SELECT}
      `, [now, Number(id)]);
      return rowToTask(result.rows[0]);
    } catch (error) {
      throw wrapDatabaseError('Could not restore PostgreSQL homework', error);
    }
  }

  async function deleteCompletedBefore(cutoffTimestamp) {
    const cutoff = normalizeTimestampForStorage(cutoffTimestamp, 'cleanup cutoff');
    try {
      return await withTransaction(async (client) => {
        const result = await client.query(`
          DELETE FROM homework_tasks
          WHERE status = 'completed'
            AND completed_at IS NOT NULL
            AND completed_at < $1
          RETURNING source, external_id
        `, [cutoff]);
        for (const row of result.rows) {
          if (row.source !== 'classroom' || !row.external_id) {
            continue;
          }
          await client.query(`
            INSERT INTO classroom_task_tombstones (external_id) VALUES ($1)
            ON CONFLICT (external_id) DO NOTHING
          `, [row.external_id]);
        }
        return Number(result.rowCount ?? 0);
      });
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
    clearNotification,
    completeTask,
    uncompleteTask,
    deleteCompletedBefore,
    close,
  };
}
