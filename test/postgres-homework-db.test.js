import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { newDb } from 'pg-mem';

import { createHomeworkDatabase, createPostgresHomeworkDatabase } from '../src/homework-db.js';
import { configuredDatabaseSsl } from '../src/postgres-homework-db.js';
import { toSyncTask } from '../src/sync.js';

function createPool() {
  const memory = newDb();
  const { Pool } = memory.adapters.createPg();
  return { memory, pool: new Pool() };
}

function createEventedPool(pool) {
  const events = new EventEmitter();
  const wrapped = {
    query: (...args) => pool.query(...args),
    connect: (...args) => pool.connect(...args),
    end: (...args) => pool.end(...args),
    on(...args) {
      events.on(...args);
      return wrapped;
    },
    off(...args) {
      events.off(...args);
      return wrapped;
    },
    emit: (...args) => events.emit(...args),
    listenerCount: (...args) => events.listenerCount(...args),
    removeListener(...args) {
      events.removeListener(...args);
      return wrapped;
    },
  };
  return wrapped;
}

function createControlledTransactionPool() {
  const { pool } = createPool();
  const state = {
    statements: [],
    releaseCalls: [],
    operationError: null,
    rollbackError: null,
  };
  const controlledPool = {
    on: (...args) => pool.on(...args),
    off: (...args) => pool.off(...args),
    query: (...args) => pool.query(...args),
    end: (...args) => pool.end(...args),
    async connect() {
      const client = await pool.connect();
      let clientReleased = false;
      return {
        async query(sql, values) {
          const statement = String(sql).trim();
          state.statements.push(statement);
          if (state.operationError && /^DELETE FROM homework_tasks/u.test(statement)) {
            throw state.operationError;
          }
          if (state.rollbackError && statement === 'ROLLBACK') {
            throw state.rollbackError;
          }
          return client.query(sql, values);
        },
        release(value) {
          if (clientReleased) {
            throw new Error('test client released twice');
          }
          clientReleased = true;
          state.releaseCalls.push(value);
          client.release();
        },
      };
    },
  };
  return { pool: controlledPool, state };
}

function resetControlledTransactionState(state) {
  state.statements.length = 0;
  state.releaseCalls.length = 0;
  state.operationError = null;
  state.rollbackError = null;
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
    publishedAt: '2026-09-09T10:00:00Z',
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
    assert.equal(await database.getMeta('database_version'), '5');
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

test('PostgreSQL baseline can persist Classroom status observations in one write path', async () => {
  const { pool } = createPool();
  const database = await createPostgresHomeworkDatabase({
    connectionString: 'postgresql://test/test',
    pool,
  });
  const timestamp = '2026-09-09T12:00:00.000Z';
  const completed = task({
    source: 'classroom',
    externalId: 'course-1:work-1',
  });

  try {
    await database.saveBaseline([completed], timestamp, {
      source: 'classroom',
      statusUpdates: [{ task: completed, status: 'completed' }],
    });
    const stored = await database.findByExternalId(completed.externalId, 'classroom');
    assert.equal(stored.status, 'completed');
    assert.equal(stored.completionOrigin, 'classroom');
    assert.equal(stored.isCurrent, false);
    assert.equal(stored.completedAt, timestamp);
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

test('PostgreSQL CA certificate decodes from base64', () => {
  const certificate = '-----BEGIN CERTIFICATE-----\nbase64-ca\n-----END CERTIFICATE-----\n';
  const ssl = configuredDatabaseSsl({
    env: {
      HOMEWORK_DATABASE_CA_CERT_BASE64: Buffer.from(certificate, 'utf8').toString('base64'),
    },
  });

  assert.deepEqual(ssl, { rejectUnauthorized: true, ca: certificate });
});

test('base64 PostgreSQL CA certificate takes priority over plain env', () => {
  const base64Certificate = '-----BEGIN CERTIFICATE-----\nbase64-ca\n-----END CERTIFICATE-----\n';
  const plainCertificate = '-----BEGIN CERTIFICATE-----\nplain-ca\n-----END CERTIFICATE-----\n';
  const ssl = configuredDatabaseSsl({
    env: {
      HOMEWORK_DATABASE_CA_CERT_BASE64: Buffer.from(base64Certificate, 'utf8').toString('base64'),
      HOMEWORK_DATABASE_CA_CERT: plainCertificate,
    },
  });

  assert.equal(ssl.ca, base64Certificate);
});

test('PostgreSQL CA certificate falls back to plain env', () => {
  const certificate = '-----BEGIN CERTIFICATE-----\nplain-ca\n-----END CERTIFICATE-----\n';
  const ssl = configuredDatabaseSsl({
    env: { HOMEWORK_DATABASE_CA_CERT: certificate },
  });

  assert.deepEqual(ssl, { rejectUnauthorized: true, ca: certificate.trim() });
});

test('PostgreSQL CA certificate falls back to PATH', () => {
  const certificate = '-----BEGIN CERTIFICATE-----\npath-ca\n-----END CERTIFICATE-----\n';
  const certificatePath = 'C:\\certs\\homework-ca.pem';
  const ssl = configuredDatabaseSsl({
    env: { HOMEWORK_DATABASE_CA_CERT_PATH: certificatePath },
    readCertificate: (path) => {
      assert.equal(path, certificatePath);
      return certificate;
    },
  });

  assert.deepEqual(ssl, { rejectUnauthorized: true, ca: certificate });
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

test('PostgreSQL v4 migration preserves data and retention keys survive reopening every insert path', async () => {
  const { memory, pool } = createPool();
  const config = { connectionString: 'postgresql://test/test' };
  const original = await createPostgresHomeworkDatabase({ ...config, pool });
  const completed = task({ source: 'classroom', externalId: 'course-a:expired' });
  const pending = task({ source: 'classroom', externalId: 'course-a:pending' });
  const eschool = task();
  const timestamp = '2026-09-01T12:00:00.000Z';
  let savedRows;
  try {
    await original.saveBaseline([completed], timestamp, { source: 'classroom' });
    await original.saveBaseline([eschool], timestamp, { source: 'eschool' });
    const completedRow = await original.findMatch(completed);
    await original.completeTask(completedRow.id, timestamp);
    await original.completeTask((await original.findMatch(eschool)).id, timestamp);
    await original.upsertSeenTask(pending, { timestamp, notificationKind: 'new' });
    await original.setMeta('telegram_update_offset', '123');
    savedRows = (await pool.query('SELECT * FROM homework_tasks ORDER BY id')).rows;
    // A v4 fixture has the same task schema and no retention table.
    // pg-mem leaves index names behind when dropping their table.
    await pool.query('DROP INDEX classroom_task_tombstones_pkey');
    await pool.query('DROP TABLE classroom_task_tombstones');
    await original.setMeta('database_version', '4');
  } finally {
    await original.close();
  }

  const { Pool } = memory.adapters.createPg();
  const migratedPool = new Pool();
  const migrated = await createPostgresHomeworkDatabase({ ...config, pool: migratedPool });
  try {
    assert.equal(await migrated.getMeta('database_version'), '5');
    assert.equal(migrated.getMigrationDiagnostics().fromVersion, 4);
    assert.deepEqual((await migratedPool.query('SELECT * FROM homework_tasks ORDER BY id')).rows, savedRows);
    assert.equal(await migrated.getMeta('telegram_update_offset'), '123');
    assert.equal(await migrated.getMeta('baseline_initialized_at:classroom'), timestamp);
    assert.equal(await migrated.deleteCompletedBefore('2026-09-16T12:00:00.000Z'), 2);
    assert.equal(await migrated.deleteCompletedBefore('2026-09-16T12:00:00.000Z'), 0);
    assert.deepEqual((await migratedPool.query('SELECT * FROM classroom_task_tombstones')).rows, [
      { external_id: completed.externalId },
    ], 'only the course-qualified id is retained; no text, snapshot, or E-school data');
    assert.equal((await migrated.pendingNotifications()).length, 1);
  } finally {
    await migrated.close();
  }

  const reopened = await createPostgresHomeworkDatabase({ ...config, pool: new Pool() });
  try {
    const later = '2026-09-17T12:00:00.000Z';
    const completedTask = { ...completed, classroomStatus: 'completed' };
    assert.equal(await reopened.upsertSeenTask(completedTask, { timestamp: later }), null);
    await reopened.saveBaseline([completedTask], later, { source: 'classroom' });
    await reopened.applyProviderSnapshot([
      { task: completedTask, previous: null, notificationKind: null },
    ], later, {
      source: 'classroom',
      statusUpdates: [{ task: completedTask, status: 'completed' }],
      statusReconciliationComplete: true,
    });
    assert.equal(await reopened.findMatch(completedTask), null);
    assert.equal((await reopened.completedTasks()).length, 0);
    assert.equal(await reopened.count(), 1);
    assert.equal((await reopened.pendingNotifications())[0].externalId, pending.externalId);
  } finally {
    await reopened.close();
  }
});

test('PostgreSQL retention rolls back when saving a deleted Classroom id fails', async () => {
  const { pool } = createPool();
  const statements = [];
  let failRetention = false;
  const wrappedPool = {
    query: (...args) => pool.query(...args),
    end: () => pool.end(),
    async connect() {
      const client = await pool.connect();
      return {
        release: () => client.release(),
        async query(sql, values) {
          if (failRetention) {
            statements.push(sql.trim());
            if (/INSERT INTO classroom_task_tombstones/u.test(sql)) {
              throw new Error('simulated retention write failure');
            }
          }
          return client.query(sql, values);
        },
      };
    },
  };
  const database = await createPostgresHomeworkDatabase({
    connectionString: 'postgresql://test/test', pool: wrappedPool,
  });
  try {
    const timestamp = '2026-09-01T12:00:00.000Z';
    const completed = task({ source: 'classroom', externalId: 'course-a:expired' });
    await database.saveBaseline([completed], timestamp);
    await database.completeTask((await database.findMatch(completed)).id, timestamp);
    failRetention = true;
    await assert.rejects(
      () => database.deleteCompletedBefore('2026-09-16T12:00:00.000Z'),
      /PostgreSQL transaction failed: simulated retention write failure/,
    );
    // pg-mem does not implement rollback. Verify the application's transaction
    // boundary explicitly; real PostgreSQL rolls the deletion back on this path.
    assert.equal(statements[0], 'BEGIN');
    assert.match(statements[1], /^DELETE FROM homework_tasks/u);
    assert.match(statements[2], /^INSERT INTO classroom_task_tombstones/u);
    assert.equal(statements[3], 'ROLLBACK');
    assert.equal(statements.length, 4);
  } finally {
    await database.close();
  }
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
    assert.equal(await database.getMeta('database_version'), '5');
    assert.deepEqual(database.getMigrationDiagnostics(), {
      fromVersion: 3,
      toVersion: 5,
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

test('PostgreSQL pool background errors are safe and do not block the next query', async () => {
  const { pool: rawPool } = createPool();
  const pool = createEventedPool(rawPool);
  const diagnostics = [];
  const foreignErrors = [];
  const foreignListener = (error) => foreignErrors.push(error);
  pool.on('error', foreignListener);
  const listenersBeforeDatabase = pool.listenerCount('error');
  const database = await createPostgresHomeworkDatabase({
    connectionString: 'postgresql://test/test',
    pool,
    logger: (message) => diagnostics.push(message),
  });
  const secret = 'postgresql://user:secret@example.test/homework SELECT private homework text';

  try {
    assert.equal(pool.listenerCount('error'), listenersBeforeDatabase + 1);
    assert.doesNotThrow(() => pool.emit('error', new Error(secret)));
    assert.equal(await database.count(), 0, 'another available connection remains usable');
    assert.deepEqual(diagnostics, [
      '[database] PostgreSQL pool reported an idle-client error; pg removed the connection',
    ]);
    assert.doesNotMatch(diagnostics.join('\n'), /secret|SELECT|private homework/i);
    assert.equal(foreignErrors.length, 1);
  } finally {
    await database.close();
  }

  assert.equal(pool.listenerCount('error'), listenersBeforeDatabase);
  pool.emit('error', new Error('foreign listener remains installed'));
  assert.equal(foreignErrors.length, 2);
  pool.removeListener('error', foreignListener);
});

test('PostgreSQL keeps its pool error handler installed until close has drained', async () => {
  const { pool: rawPool } = createPool();
  const pool = createEventedPool(rawPool);
  const diagnostics = [];
  const originalEnd = pool.end;
  let notifyEndStarted;
  let finishEnd;
  const endStarted = new Promise((resolve) => {
    notifyEndStarted = resolve;
  });
  const endGate = new Promise((resolve) => {
    finishEnd = resolve;
  });
  pool.end = async () => {
    notifyEndStarted();
    await endGate;
    return originalEnd();
  };
  const database = await createPostgresHomeworkDatabase({
    connectionString: 'postgresql://test/test',
    pool,
    logger: (message) => diagnostics.push(message),
  });

  const closePromise = database.close();
  await endStarted;
  assert.equal(pool.listenerCount('error'), 1);
  assert.doesNotThrow(() => pool.emit('error', new Error('synthetic idle close error')));
  assert.equal(diagnostics.length, 1);
  finishEnd();
  await closePromise;
  assert.equal(pool.listenerCount('error'), 0);
});

test('PostgreSQL adapter accepts a pool without EventEmitter methods and closes it once', async () => {
  const { pool } = createPool();
  let endCalls = 0;
  const noEventPool = {
    query: (...args) => pool.query(...args),
    connect: (...args) => pool.connect(...args),
    async end() {
      endCalls += 1;
      return pool.end();
    },
  };
  const database = await createPostgresHomeworkDatabase({
    connectionString: 'postgresql://test/test',
    pool: noEventPool,
  });

  try {
    assert.equal(await database.count(), 0);
  } finally {
    await database.close();
    await database.close();
  }

  assert.equal(endCalls, 1);
});

test('PostgreSQL removes only its listener after an injected-pool initialization error', async () => {
  const pool = new EventEmitter();
  const foreignErrors = [];
  const foreignListener = (error) => foreignErrors.push(error);
  pool.on('error', foreignListener);
  const listenersBeforeDatabase = pool.listenerCount('error');
  let endCalls = 0;
  pool.query = async () => {
    throw new Error('synthetic schema failure');
  };
  pool.end = async () => {
    endCalls += 1;
  };

  await assert.rejects(
    () => createPostgresHomeworkDatabase({
      connectionString: 'postgresql://test/test',
      pool,
      logger: () => {},
    }),
    /PostgreSQL query failed: synthetic schema failure/,
  );

  assert.equal(endCalls, 0, 'the adapter does not close a failed injected pool');
  assert.equal(pool.listenerCount('error'), listenersBeforeDatabase);
  pool.emit('error', new Error('foreign listener remains installed'));
  assert.equal(foreignErrors.length, 1);
  pool.removeListener('error', foreignListener);
});

test('ordinary transaction SQL errors roll back and release the client once', async () => {
  const { pool, state } = createControlledTransactionPool();
  const database = await createPostgresHomeworkDatabase({
    connectionString: 'postgresql://test/test',
    pool,
  });
  const originalError = new Error('synthetic write failure');

  try {
    resetControlledTransactionState(state);
    state.operationError = originalError;
    let receivedError;
    await assert.rejects(
      () => database.deleteCompletedBefore('2026-09-16T12:00:00.000Z'),
      (error) => {
        receivedError = error;
        return error.name === 'HomeworkDatabaseError';
      },
    );

    assert.equal(receivedError.cause, originalError);
    assert.equal(state.statements[0], 'BEGIN');
    assert.match(state.statements[1], /^DELETE FROM homework_tasks/u);
    assert.equal(state.statements[2], 'ROLLBACK');
    assert.equal(state.statements.length, 3);
    assert.deepEqual(state.releaseCalls, [undefined]);
  } finally {
    await database.close();
  }
});

test('a client query timeout discards the transaction client without queuing rollback', async () => {
  const { pool, state } = createControlledTransactionPool();
  const database = await createPostgresHomeworkDatabase({
    connectionString: 'postgresql://test/test',
    pool,
  });
  const timeoutError = new Error('Query read timeout');

  try {
    resetControlledTransactionState(state);
    state.operationError = timeoutError;
    let receivedError;
    await assert.rejects(
      () => database.deleteCompletedBefore('2026-09-16T12:00:00.000Z'),
      (error) => {
        receivedError = error;
        return error.name === 'HomeworkDatabaseError';
      },
    );

    assert.equal(receivedError.cause, timeoutError);
    assert.equal(state.statements[0], 'BEGIN');
    assert.match(state.statements[1], /^DELETE FROM homework_tasks/u);
    assert.equal(state.statements.some((statement) => statement === 'ROLLBACK'), false);
    assert.deepEqual(state.releaseCalls, [true]);
  } finally {
    await database.close();
  }
});

test('a transport failure discards the transaction client without queuing rollback', async () => {
  const { pool, state } = createControlledTransactionPool();
  const database = await createPostgresHomeworkDatabase({
    connectionString: 'postgresql://test/test',
    pool,
  });
  const transportError = Object.assign(new Error('synthetic socket reset'), { code: 'ECONNRESET' });

  try {
    resetControlledTransactionState(state);
    state.operationError = transportError;
    let receivedError;
    await assert.rejects(
      () => database.deleteCompletedBefore('2026-09-16T12:00:00.000Z'),
      (error) => {
        receivedError = error;
        return error.name === 'HomeworkDatabaseError';
      },
    );

    assert.equal(receivedError.cause, transportError);
    assert.equal(state.statements.some((statement) => statement === 'ROLLBACK'), false);
    assert.deepEqual(state.releaseCalls, [true]);
  } finally {
    await database.close();
  }
});

test('a rollback error discards the client once while preserving the original failure', async () => {
  const { pool, state } = createControlledTransactionPool();
  const database = await createPostgresHomeworkDatabase({
    connectionString: 'postgresql://test/test',
    pool,
  });
  const originalError = new Error('synthetic write failure');
  const rollbackError = new Error('synthetic rollback failure');

  try {
    resetControlledTransactionState(state);
    state.operationError = originalError;
    state.rollbackError = rollbackError;
    let receivedError;
    await assert.rejects(
      () => database.deleteCompletedBefore('2026-09-16T12:00:00.000Z'),
      (error) => {
        receivedError = error;
        return error.name === 'HomeworkDatabaseError';
      },
    );

    assert.equal(receivedError.cause, originalError);
    assert.equal(state.statements.at(-1), 'ROLLBACK');
    assert.deepEqual(state.releaseCalls, [true]);
  } finally {
    await database.close();
  }
});
