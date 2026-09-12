import pg from 'pg';
import { config } from 'dotenv';
import { readFileSync } from 'node:fs';

import { createPostgresHomeworkDatabase } from '../src/postgres-homework-db.js';

config();

const { Pool } = pg;

const DATABASE_VERSION = '5';
const BATCH_SIZE = 100;

const EXPECTED_TABLES = Object.freeze([
  'classroom_task_tombstones',
  'database_meta',
  'homework_tasks',
]);

const META_COLUMNS = Object.freeze(['key', 'value']);
const TOMBSTONE_COLUMNS = Object.freeze(['external_id']);
const TASK_COLUMNS = Object.freeze([
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

const EXPECTED_COLUMNS = Object.freeze({
  classroom_task_tombstones: TOMBSTONE_COLUMNS,
  database_meta: META_COLUMNS,
  homework_tasks: TASK_COLUMNS,
});

function parseArguments(argv) {
  const flags = new Set(argv);
  return {
    apply: flags.has('--apply'),
    confirmSourceFrozen: flags.has('--confirm-source-frozen'),
    help: flags.has('--help') || flags.has('-h'),
  };
}

function printHelp() {
  console.log(`
PostgreSQL migration helper for HomeworkParser

Environment variables:
  SOURCE_DATABASE_URL  source URL; falls back to HOMEWORK_DATABASE_URL
  TARGET_DATABASE_URL  target URL; falls back to AIVEN_DATABASE_URL
  HOMEWORK_DATABASE_CA_CERT_PATH  local Aiven CA PEM path
  HOMEWORK_DATABASE_CA_CERT       inline CA PEM for a hosted runtime

Commands:
  node scripts/postgres-migration.mjs --check
      Read-only schema and data comparison. Never writes to either database.

  node scripts/postgres-migration.mjs --apply --confirm-source-frozen
      Initialize an empty target and copy the HomeworkParser PostgreSQL data.
      The source must be stopped/frozen first. The target is never cleared.

The script never prints connection strings or row contents.
`);
}

function requiredEnvironment(...names) {
  for (const name of names) {
    const value = String(process.env[name] ?? '').trim();
    if (value) {
      return value;
    }
  }
  throw new Error(`Missing required environment variable: ${names.join(' or ')}`);
}

function validateConnectionString(value, label) {
  if (!/^postgres(?:ql)?:\/\//iu.test(value)) {
    throw new Error(`${label} must be a PostgreSQL connection string`);
  }
  try {
    const parsed = new URL(value);
    if (!parsed.hostname) {
      throw new Error('missing host');
    }
  } catch {
    throw new Error(`${label} is not a valid PostgreSQL connection string`);
  }
}

function connectionIdentity(value) {
  const parsed = new URL(value);
  return [
    parsed.protocol.toLowerCase(),
    parsed.hostname.toLowerCase(),
    parsed.port || 'default',
    parsed.pathname,
  ].join('|');
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
    throw new Error('Target database URL must be a valid PostgreSQL connection string');
  }
}

function createPool(connectionString, label) {
  const ssl = label.startsWith('target') ? configuredTargetSsl() : undefined;
  const poolOptions = {
    connectionString: connectionStringForExplicitSsl(connectionString, ssl),
    max: 1,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    applicationName: `homeworkparser-migration-${label}`,
  };
  if (ssl) {
    poolOptions.ssl = ssl;
  }
  return new Pool(poolOptions);
}

function safeErrorMessage(error) {
  const message = String(error?.message ?? error);
  return message.replace(/postgres(?:ql)?:\/\/[^\s)]+/giu, '[connection redacted]');
}

function configuredTargetSsl() {
  const inlineCertificate = String(process.env.HOMEWORK_DATABASE_CA_CERT ?? '').trim();
  const certificatePath = String(process.env.HOMEWORK_DATABASE_CA_CERT_PATH ?? '').trim();
  if (inlineCertificate && certificatePath) {
    throw new Error(
      'Configure only one of HOMEWORK_DATABASE_CA_CERT or HOMEWORK_DATABASE_CA_CERT_PATH',
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
    throw new Error('Could not load the PostgreSQL CA certificate');
  }
}

function quoteIdentifier(identifier) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}

function tableReference(table) {
  return `public.${quoteIdentifier(table)}`;
}

async function withReadOnlySnapshot(pool, callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    await client.query("SET LOCAL statement_timeout = '60s'");
    return await callback(client);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

async function readPublicTables(client) {
  const result = await client.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);
  return result.rows.map((row) => String(row.table_name));
}

async function readColumns(client, table) {
  const result = await client.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = $1
    ORDER BY ordinal_position
  `, [table]);
  return result.rows.map((row) => String(row.column_name));
}

async function readTaskSummary(client) {
  const result = await client.query(`
    SELECT
      COUNT(*)::text AS total,
      COUNT(*) FILTER (WHERE status = 'pending')::text AS pending,
      COUNT(*) FILTER (WHERE status = 'completed')::text AS completed,
      COUNT(*) FILTER (WHERE is_current = 1)::text AS current_tasks,
      COUNT(*) FILTER (WHERE notification_pending = 1)::text AS notifications_pending,
      COALESCE(SUM(octet_length(homework_ids_json)), 0)::text AS homework_ids_bytes,
      COALESCE(SUM(octet_length(snapshot_json)), 0)::text AS snapshot_bytes,
      COALESCE(MIN(id)::text, '') AS min_id,
      COALESCE(MAX(id)::text, '') AS max_id,
      COALESCE(
        md5(string_agg(
          md5(jsonb_build_object(
            'id', id,
            'source', source,
            'external_id', external_id,
            'fingerprint', fingerprint,
            'target_appointment_id', target_appointment_id,
            'normalized_description', normalized_description,
            'homework_ids_json', homework_ids_json,
            'snapshot_json', snapshot_json,
            'is_current', is_current,
            'status', status,
            'completion_origin', completion_origin,
            'first_seen_at', first_seen_at,
            'last_seen_at', last_seen_at,
            'last_notified_at', last_notified_at,
            'notification_pending', notification_pending,
            'notification_kind', notification_kind,
            'completed_at', completed_at,
            'created_at', created_at,
            'updated_at', updated_at
          )::text), ',' ORDER BY id)),
        md5('')
      ) AS row_hash
    FROM ${tableReference('homework_tasks')} AS homework_tasks
  `);
  const row = result.rows[0];
  return {
    total: Number(row.total),
    pending: Number(row.pending),
    completed: Number(row.completed),
    current: Number(row.current_tasks),
    notificationsPending: Number(row.notifications_pending),
    homeworkIdsBytes: Number(row.homework_ids_bytes),
    snapshotBytes: Number(row.snapshot_bytes),
    minId: String(row.min_id),
    maxId: String(row.max_id),
    rowHash: String(row.row_hash),
  };
}

async function readMetaSummary(client) {
  const result = await client.query(`
    SELECT
      COUNT(*)::text AS total,
      COALESCE(md5(string_agg(md5(key || '=' || value), ',' ORDER BY key)), md5('')) AS row_hash,
      MAX(value) FILTER (WHERE key = 'database_version') AS database_version
    FROM ${tableReference('database_meta')}
  `);
  const keys = await client.query(`
    SELECT key
    FROM ${tableReference('database_meta')}
    ORDER BY key
  `);
  const row = result.rows[0];
  return {
    total: Number(row.total),
    rowHash: String(row.row_hash),
    databaseVersion: row.database_version === null
      ? null
      : String(row.database_version),
    keys: keys.rows.map((item) => String(item.key)),
  };
}

async function readTombstoneSummary(client) {
  const result = await client.query(`
    SELECT
      COUNT(*)::text AS total,
      COALESCE(md5(string_agg(md5(external_id), ',' ORDER BY external_id)), md5('')) AS row_hash
    FROM ${tableReference('classroom_task_tombstones')}
  `);
  const row = result.rows[0];
  return {
    total: Number(row.total),
    rowHash: String(row.row_hash),
  };
}

async function readRelationSize(client, table) {
  const result = await client.query(
    `SELECT pg_total_relation_size($1::regclass)::text AS bytes`,
    [`public.${table}`],
  );
  return Number(result.rows[0].bytes);
}

async function readState(client) {
  const tables = await readPublicTables(client);
  const columns = {};
  for (const table of EXPECTED_TABLES) {
    if (tables.includes(table)) {
      columns[table] = await readColumns(client, table);
    }
  }

  const hasMeta = tables.includes('database_meta');
  const hasTasks = tables.includes('homework_tasks');
  const hasTombstones = tables.includes('classroom_task_tombstones');
  const meta = hasMeta
    ? await readMetaSummary(client)
    : { total: 0, rowHash: null, databaseVersion: null, keys: [] };
  const tasks = hasTasks ? await readTaskSummary(client) : null;
  const tombstones = hasTombstones
    ? await readTombstoneSummary(client)
    : { total: 0, rowHash: null };
  const relationBytes = hasTasks ? await readRelationSize(client, 'homework_tasks') : 0;

  return {
    tables,
    columns,
    meta,
    tasks,
    tombstones,
    relationBytes,
  };
}

function unexpectedTables(state) {
  return state.tables.filter((table) => !EXPECTED_TABLES.includes(table));
}

function schemaMismatches(state) {
  const mismatches = [];
  for (const table of EXPECTED_TABLES) {
    const actual = state.columns[table];
    if (!actual) {
      mismatches.push(`${table}: missing`);
      continue;
    }
    const expected = EXPECTED_COLUMNS[table];
    if (
      actual.length !== expected.length
      || expected.some((column) => !actual.includes(column))
    ) {
      mismatches.push(`${table}: columns differ`);
    }
  }
  return mismatches;
}

function assertSourceReady(state) {
  const unexpected = unexpectedTables(state);
  if (unexpected.length > 0) {
    throw new Error(`Source has unexpected public tables: ${unexpected.join(', ')}`);
  }
  const mismatches = schemaMismatches(state);
  if (mismatches.length > 0) {
    throw new Error(`Source schema is not the supported HomeworkParser schema: ${mismatches.join('; ')}`);
  }
  if (state.meta.databaseVersion !== DATABASE_VERSION) {
    throw new Error(
      `Source database version must be ${DATABASE_VERSION}, got ${state.meta.databaseVersion ?? 'missing'}`,
    );
  }
}

function assertTargetSafeForApply(state) {
  const unexpected = unexpectedTables(state);
  if (unexpected.length > 0) {
    throw new Error(`Target has unexpected public tables: ${unexpected.join(', ')}`);
  }
  if ((state.tasks?.total ?? 0) > 0 || state.tombstones.total > 0) {
    throw new Error('Target is not empty; migration refuses to overwrite target data');
  }
  if (state.meta.total > 0) {
    const onlyVersion = state.meta.total === 1 && state.meta.keys[0] === 'database_version';
    if (!onlyVersion || (state.meta.databaseVersion !== null && state.meta.databaseVersion !== DATABASE_VERSION)) {
      throw new Error('Target contains existing metadata; use a fresh empty Aiven database');
    }
  }
}

function printState(label, state) {
  const taskSummary = state.tasks;
  const taskText = taskSummary === null
    ? 'no homework_tasks table'
    : [
      `tasks=${taskSummary.total}`,
      `pending=${taskSummary.pending}`,
      `completed=${taskSummary.completed}`,
      `current=${taskSummary.current}`,
      `notificationsPending=${taskSummary.notificationsPending}`,
      `snapshotBytes=${taskSummary.snapshotBytes}`,
      `homeworkIdsBytes=${taskSummary.homeworkIdsBytes}`,
      `idRange=${taskSummary.minId || '-'}..${taskSummary.maxId || '-'}`,
    ].join(', ');
  console.log(
    `${label}: tables=${state.tables.join(', ') || '(none)'}; `
      + `databaseVersion=${state.meta.databaseVersion ?? '-'}; `
      + `${taskText}; tombstones=${state.tombstones.total}; `
      + `homeworkTableBytes=${state.relationBytes}`,
  );
}

function comparableState(state) {
  return {
    databaseVersion: state.meta.databaseVersion,
    meta: state.meta,
    tasks: state.tasks,
    tombstones: state.tombstones,
  };
}

function compareStates(source, target) {
  const sourceComparable = comparableState(source);
  const targetComparable = comparableState(target);
  const mismatches = [];
  for (const key of ['databaseVersion', 'meta', 'tasks', 'tombstones']) {
    if (JSON.stringify(sourceComparable[key]) !== JSON.stringify(targetComparable[key])) {
      mismatches.push(key);
    }
  }
  return mismatches;
}

async function readSourceRows(client) {
  const metaResult = await client.query(`
    SELECT ${META_COLUMNS.map(quoteIdentifier).join(', ')}
    FROM ${tableReference('database_meta')}
    ORDER BY key
  `);
  const taskResult = await client.query(`
    SELECT ${TASK_COLUMNS.map(quoteIdentifier).join(', ')}
    FROM ${tableReference('homework_tasks')}
    ORDER BY id
  `);
  const tombstoneResult = await client.query(`
    SELECT ${TOMBSTONE_COLUMNS.map(quoteIdentifier).join(', ')}
    FROM ${tableReference('classroom_task_tombstones')}
    ORDER BY external_id
  `);
  return {
    meta: metaResult.rows,
    tasks: taskResult.rows,
    tombstones: tombstoneResult.rows,
  };
}

function insertStatement(table, columns, rowCount) {
  const quotedColumns = columns.map(quoteIdentifier).join(', ');
  const placeholders = [];
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const rowPlaceholders = columns.map((_, columnIndex) => (
      `$${rowIndex * columns.length + columnIndex + 1}`
    ));
    placeholders.push(`(${rowPlaceholders.join(', ')})`);
  }
  return `INSERT INTO ${tableReference(table)} (${quotedColumns}) VALUES ${placeholders.join(', ')}`;
}

async function insertRows(client, table, columns, rows, onConflict = '') {
  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    const batch = rows.slice(offset, offset + BATCH_SIZE);
    if (batch.length === 0) continue;
    const values = batch.flatMap((row) => columns.map((column) => row[column]));
    const statement = `${insertStatement(table, columns, batch.length)} ${onConflict}`.trim();
    await client.query(statement, values);
  }
}

async function initializeTarget(connectionString) {
  const database = await createPostgresHomeworkDatabase({
    connectionString,
    ssl: configuredTargetSsl(),
  });
  await database.close();
}

async function copySnapshot(targetPool, snapshot) {
  const client = await targetPool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '60s'");
    const targetBefore = await readState(client);
    assertTargetSafeForApply(targetBefore);

    await insertRows(
      client,
      'database_meta',
      META_COLUMNS,
      snapshot.meta,
      'ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    );
    await insertRows(client, 'homework_tasks', TASK_COLUMNS, snapshot.tasks);
    await insertRows(client, 'classroom_task_tombstones', TOMBSTONE_COLUMNS, snapshot.tombstones);
    await client.query(`
      SELECT setval(
        pg_get_serial_sequence('public.homework_tasks', 'id'),
        COALESCE(MAX(id), 1),
        MAX(id) IS NOT NULL
      )
      FROM ${tableReference('homework_tasks')}
    `);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function runCheck(sourceUrl, targetUrl) {
  const sourcePool = createPool(sourceUrl, 'source-check');
  const targetPool = createPool(targetUrl, 'target-check');
  try {
    const sourceState = await withReadOnlySnapshot(sourcePool, readState);
    const targetState = await withReadOnlySnapshot(targetPool, readState);
    assertSourceReady(sourceState);
    printState('Source', sourceState);
    printState('Target', targetState);

    if (targetState.tables.length === 0) {
      console.log('Target is empty and has not been initialized. No changes were made.');
      return;
    }
    const targetSchemaMismatches = schemaMismatches(targetState);
    if (targetSchemaMismatches.length > 0) {
      throw new Error(`Target schema is incomplete: ${targetSchemaMismatches.join('; ')}`);
    }
    const differences = compareStates(sourceState, targetState);
    if (differences.length > 0) {
      throw new Error(`Source and target differ in: ${differences.join(', ')}`);
    }
    console.log('Read-only verification passed: schema and application data match.');
  } finally {
    await Promise.all([
      sourcePool.end().catch(() => {}),
      targetPool.end().catch(() => {}),
    ]);
  }
}

async function runApply(sourceUrl, targetUrl) {
  const sourcePool = createPool(sourceUrl, 'source-copy');
  let targetPool = null;
  try {
    const sourceSnapshot = await withReadOnlySnapshot(sourcePool, async (client) => {
      const state = await readState(client);
      assertSourceReady(state);
      const rows = await readSourceRows(client);
      return { state, rows };
    });
    printState('Source snapshot', sourceSnapshot.state);

    targetPool = createPool(targetUrl, 'target-preflight');
    const targetBefore = await withReadOnlySnapshot(targetPool, readState);
    assertTargetSafeForApply(targetBefore);
    if (targetBefore.tables.length === 0) {
      await targetPool.end();
      targetPool = null;
      await initializeTarget(targetUrl);
      targetPool = createPool(targetUrl, 'target-copy');
    }

    const initializedState = await withReadOnlySnapshot(targetPool, readState);
    const initializedSchemaMismatches = schemaMismatches(initializedState);
    if (initializedSchemaMismatches.length > 0) {
      throw new Error(`Target schema is incomplete: ${initializedSchemaMismatches.join('; ')}`);
    }
    assertTargetSafeForApply(initializedState);

    await copySnapshot(targetPool, sourceSnapshot.rows);
    const sourceAfter = await withReadOnlySnapshot(sourcePool, readState);
    const targetAfter = await withReadOnlySnapshot(targetPool, readState);
    printState('Target after copy', targetAfter);

    const sourceChanged = compareStates(sourceSnapshot.state, sourceAfter);
    if (sourceChanged.length > 0) {
      throw new Error(
        `Source changed during migration (${sourceChanged.join(', ')}); do not switch Render yet`,
      );
    }
    const differences = compareStates(sourceSnapshot.state, targetAfter);
    if (differences.length > 0) {
      throw new Error(`Copy verification failed; differences: ${differences.join(', ')}`);
    }
    console.log('Migration and read-only verification passed. Render has not been changed.');
  } finally {
    await sourcePool.end().catch(() => {});
    if (targetPool) {
      await targetPool.end().catch(() => {});
    }
  }
}

async function main() {
  const { apply, confirmSourceFrozen, help } = parseArguments(process.argv.slice(2));
  if (help) {
    printHelp();
    return;
  }

  const sourceUrl = requiredEnvironment('SOURCE_DATABASE_URL', 'HOMEWORK_DATABASE_URL');
  const targetUrl = requiredEnvironment('TARGET_DATABASE_URL', 'AIVEN_DATABASE_URL');
  validateConnectionString(sourceUrl, 'Source database URL');
  validateConnectionString(targetUrl, 'Target database URL');
  if (connectionIdentity(sourceUrl) === connectionIdentity(targetUrl)) {
    throw new Error('Source and target database URLs point to the same database');
  }

  if (apply) {
    if (!confirmSourceFrozen) {
      throw new Error('Apply requires --confirm-source-frozen after the bot is stopped');
    }
    await runApply(sourceUrl, targetUrl);
    return;
  }
  await runCheck(sourceUrl, targetUrl);
}

main().catch((error) => {
  console.error(`Migration check failed: ${safeErrorMessage(error)}`);
  process.exitCode = 1;
});
