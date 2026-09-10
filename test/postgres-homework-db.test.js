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
    assert.equal(await database.getMeta('database_version'), '3');
    assert.equal((await database.currentTasks()).length, 1);
    assert.equal((await database.findByFingerprint(first.fingerprint)).snapshot.description, 'Вивчити конспект');

    const completed = await database.completeTask(1, '2026-09-09T12:01:00.000Z');
    assert.equal(completed.status, 'completed');
    assert.equal((await database.currentTasks()).length, 0);
    assert.equal((await database.completedTasks()).length, 1);

    const restored = await database.uncompleteTask(1, '2026-09-09T12:02:00.000Z');
    assert.equal(restored.status, 'pending');
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
