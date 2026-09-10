import test from 'node:test';
import assert from 'node:assert/strict';

import { newDb } from 'pg-mem';

import { createHomeworkDatabase, createPostgresHomeworkDatabase } from '../src/homework-db.js';
import { toSyncTask } from '../src/sync.js';

function createPool() {
  const memory = newDb();
  const { Pool } = memory.adapters.createPg();
  return { memory, pool: new Pool() };
}

function task({
  targetAppointmentId = 185141,
  description = 'Вивчити конспект',
  source = 'eschool',
  externalId = null,
} = {}) {
  return toSyncTask({
    source,
    externalId,
    targetAppointmentId,
    homeworkId: 101171,
    subject: 'Алгебра',
    description,
    targetDate: '2026-09-11',
  });
}

test('PostgreSQL adapter initializes schema and preserves task lifecycle', async () => {
  const { pool } = createPool();
  const database = await createPostgresHomeworkDatabase({
    connectionString: 'postgresql://test/test',
    pool,
  });
  const timestamp = '2026-09-09T12:00:00.000Z';
  const first = task();

  try {
    await database.saveBaseline([first], timestamp, { source: 'eschool' });
    assert.equal(await database.getMeta('database_version'), '4');
    assert.equal((await database.currentTasks()).length, 1);
    assert.equal((await database.findByFingerprint(first.fingerprint)).snapshot.description, 'Вивчити конспект');

    const completed = await database.completeTask(1, '2026-09-09T12:01:00.000Z');
    assert.equal(completed.status, 'completed');
    assert.equal(completed.completionOrigin, 'manual');
    assert.equal((await database.currentTasks()).length, 0);
    assert.equal((await database.completedTasks()).length, 1);

    const restored = await database.uncompleteTask(1, '2026-09-09T12:02:00.000Z');
    assert.equal(restored.status, 'pending');
    assert.equal(restored.completionOrigin, 'manual');
    assert.equal((await database.currentTasks()).length, 1);
  } finally {
    await database.close();
  }
});

test('the public homework database factory is PostgreSQL-only', async () => {
  const { pool } = createPool();
  const database = await createHomeworkDatabase({
    connectionString: 'postgresql://test/test',
    pool,
  });

  try {
    assert.equal(database.databaseType, 'postgres');
    assert.equal(database.filePath, null);
    assert.equal(typeof database.currentTasks, 'function');
  } finally {
    await database.close();
  }
});

test('PostgreSQL storage fails closed without a PostgreSQL URL', async () => {
  await assert.rejects(
    () => createPostgresHomeworkDatabase({ connectionString: '' }),
    /HOMEWORK_DATABASE_URL is required/,
  );
  await assert.rejects(
    () => createPostgresHomeworkDatabase({ connectionString: 'file:data/homeworks.sqlite' }),
    /must be a PostgreSQL connection string/,
  );
});

test('PostgreSQL adapter commits notification queue and keeps pending tasks during cleanup', async () => {
  const { pool } = createPool();
  const database = await createPostgresHomeworkDatabase({
    connectionString: 'postgresql://test/test',
    pool,
  });
  const timestamp = '2026-09-09T12:00:00.000Z';
  const existing = task({ targetAppointmentId: 185141 });
  const queued = task({ targetAppointmentId: 185142, description: 'Вправа 2' });

  try {
    await database.saveBaseline([existing], timestamp, { source: 'eschool' });
    await database.applyProviderSnapshot([
      { task: existing, previous: await database.findMatch(existing), notificationKind: null },
      { task: queued, previous: null, notificationKind: 'new' },
    ], timestamp, { source: 'eschool' });

    assert.deepEqual(
      (await database.pendingNotifications('eschool')).map((item) => item.snapshot.description),
      ['Вправа 2'],
    );
    await database.recordNotificationSuccess(2, '2026-09-09T12:01:00.000Z');
    assert.equal((await database.pendingNotifications('eschool')).length, 0);

    await database.completeTask(1, '2026-08-01T12:00:00.000Z');
    assert.equal(
      await database.deleteCompletedBefore('2026-08-15T12:00:00.000Z'),
      1,
    );
    assert.equal((await database.findById(2)).status, 'pending');
  } finally {
    await database.close();
  }
});

test('PostgreSQL adapter rejects an unsupported future schema version', async () => {
  const pool = {
    async query(sql) {
      if (/SELECT value FROM database_meta/iu.test(sql)) {
        return { rows: [{ value: '999' }] };
      }
      return { rows: [] };
    },
    async end() {},
  };

  await assert.rejects(
    () => createPostgresHomeworkDatabase({
      connectionString: 'postgresql://test/test',
      pool,
    }),
    /newer than supported/,
  );
});

test('PostgreSQL v3 migration preserves rows, marks old completed rows manual, and supports reopen', async () => {
  const memory = newDb();
  const { Pool } = memory.adapters.createPg();
  const pool = new Pool();
  await pool.query(`
    CREATE TABLE database_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
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
  const snapshot = JSON.stringify({
    source: 'eschool',
    description: 'Збережене завдання',
    title: 'Збережене завдання',
    targetDate: '2026-09-11',
  });
  await pool.query(
    'INSERT INTO database_meta (key, value) VALUES ($1, $2)',
    ['database_version', '3'],
  );
  await pool.query(`
    INSERT INTO homework_tasks (
      source, external_id, fingerprint, target_appointment_id,
      normalized_description, homework_ids_json, snapshot_json,
      is_current, status, first_seen_at, last_seen_at, last_notified_at,
      notification_pending, notification_kind, completed_at, created_at, updated_at
    ) VALUES
      ('eschool', NULL, 'old-completed', '185141', $1, $2, $3, 0, 'completed', $4, $4, NULL, 0, NULL, $5, $4, $4),
      ('eschool', NULL, 'old-pending', '185142', $1, $2, $3, 1, 'pending', $4, $4, NULL, 0, NULL, NULL, $4, $4)
  `, [
    'Збережене завдання',
    JSON.stringify([101171]),
    snapshot,
    '2026-09-09T12:00:00.000Z',
    '2026-09-08T12:00:00.000Z',
  ]);

  const database = await createPostgresHomeworkDatabase({
    connectionString: 'postgresql://test/test',
    pool,
  });
  try {
    assert.equal(await database.getMeta('database_version'), '4');
    assert.deepEqual(database.getMigrationDiagnostics(), {
      fromVersion: 3,
      toVersion: 4,
      convertedValues: 1,
      invalidValues: 0,
    });
    assert.equal((await database.findByFingerprint('old-completed')).completionOrigin, 'manual');
    assert.equal((await database.findByFingerprint('old-pending')).completionOrigin, null);
  } finally {
    await database.close();
  }

  const { Pool: ReopenPool } = memory.adapters.createPg();
  const reopened = await createPostgresHomeworkDatabase({
    connectionString: 'postgresql://test/test',
    pool: new ReopenPool(),
  });
  try {
    assert.equal((await reopened.findByFingerprint('old-completed')).status, 'completed');
    assert.equal((await reopened.findByFingerprint('old-completed')).completionOrigin, 'manual');
    assert.equal((await reopened.findByFingerprint('old-pending')).status, 'pending');
  } finally {
    await reopened.close();
  }
});
