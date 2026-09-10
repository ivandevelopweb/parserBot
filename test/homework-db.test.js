import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHomeworkDatabase } from '../src/homework-db.js';
import { toSyncTask } from '../src/sync.js';

const { DatabaseSync } = await import('node:sqlite');

test('completed homework remains in SQLite after reopening the database', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eschool-homework-db-'));
  const filePath = join(directory, 'nested', 'homeworks.sqlite');

  try {
    const database = createHomeworkDatabase({ filePath });
    database.saveBaseline([{
      fingerprint: 'task-1',
      targetAppointmentId: 500,
      homeworkIds: [101],
      snapshot: {
        subject: 'Алгебра',
        description: 'Вправа 1',
        targetDate: '2026-09-11',
        topics: [],
      },
    }], '2026-09-09T12:00:00.000Z');
    database.completeTask(1, new Date('2026-09-09T12:01:00.000Z'));
    database.close();

    const reopened = createHomeworkDatabase({ filePath });
    assert.equal(reopened.currentTasks().length, 0);
    assert.equal(reopened.completedTasks().length, 1);
    assert.equal(reopened.completedTasks()[0].snapshot.subject, 'Алгебра');
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('database uses HOMEWORK_DATABASE_PATH when no explicit path is provided', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eschool-homework-db-config-'));
  const filePath = join(directory, 'configured', 'homeworks.sqlite');
  const previousPath = process.env.HOMEWORK_DATABASE_PATH;

  try {
    process.env.HOMEWORK_DATABASE_PATH = filePath;
    const database = createHomeworkDatabase();
    try {
      assert.equal(database.filePath, filePath);
    } finally {
      database.close();
    }
  } finally {
    if (previousPath === undefined) {
      delete process.env.HOMEWORK_DATABASE_PATH;
    } else {
      process.env.HOMEWORK_DATABASE_PATH = previousPath;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('completed homework can be restored and only old completed rows are deleted', () => {
  const database = createHomeworkDatabase({ filePath: ':memory:' });
  database.saveBaseline([
    {
      fingerprint: 'old-completed',
      targetAppointmentId: 501,
      homeworkIds: [101],
      snapshot: { subject: 'Алгебра', description: 'Старе', targetDate: '2026-08-01' },
    },
    {
      fingerprint: 'recent-completed',
      targetAppointmentId: 502,
      homeworkIds: [102],
      snapshot: { subject: 'Хімія', description: 'Недавнє', targetDate: '2026-08-20' },
    },
    {
      fingerprint: 'pending-old',
      targetAppointmentId: 503,
      homeworkIds: [103],
      snapshot: { subject: 'Геометрія', description: 'Невиконане', targetDate: '2026-07-01' },
    },
  ], '2026-09-01T12:00:00.000Z');

  try {
    database.completeTask(1, new Date('2026-08-01T12:00:00.000Z'));
    database.completeTask(2, new Date('2026-08-20T12:00:00.000Z'));

    assert.equal(
      database.deleteCompletedBefore(new Date('2026-08-15T12:00:00.000Z')),
      1,
    );
    assert.equal(database.findByFingerprint('old-completed'), null);
    assert.ok(database.findByFingerprint('recent-completed'));
    assert.ok(database.findByFingerprint('pending-old'));

    const restored = database.uncompleteTask(2, new Date('2026-09-01T12:00:00.000Z'));
    assert.equal(restored.status, 'pending');
    assert.equal(restored.completedAt, null);
    assert.equal(database.currentTasks().some((task) => task.id === 2), true);
    assert.equal(database.completedTasks().length, 0);
  } finally {
    database.close();
  }
});

test('database migration preserves v1 tasks and adds source-aware identity columns', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eschool-homework-db-migration-'));
  const filePath = join(directory, 'homeworks.sqlite');

  try {
    const legacy = new DatabaseSync(filePath);
    legacy.exec(`
      CREATE TABLE database_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE homework_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fingerprint TEXT NOT NULL UNIQUE,
        target_appointment_id TEXT NOT NULL,
        normalized_description TEXT NOT NULL,
        homework_ids_json TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        is_current INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'pending',
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        last_notified_at TEXT,
        notification_pending INTEGER NOT NULL DEFAULT 0,
        notification_kind TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO database_meta (key, value) VALUES ('database_version', '1');
      INSERT INTO homework_tasks (
        fingerprint, target_appointment_id, normalized_description,
        homework_ids_json, snapshot_json, first_seen_at, last_seen_at,
        created_at, updated_at
      ) VALUES (
        '["185141","Вправа 1"]', '185141', 'Вправа 1',
        '[101171]', '{"subject":"Алгебра","description":"Вправа 1"}',
        '2026-09-09T12:00:00.000Z', '2026-09-09T12:00:00.000Z',
        '2026-09-09T12:00:00.000Z', '2026-09-09T12:00:00.000Z'
      );
    `);
    legacy.close();

    const database = createHomeworkDatabase({ filePath });
    try {
      const task = database.findByFingerprint('["185141","Вправа 1"]');
      assert.equal(task.source, 'eschool');
      assert.equal(task.externalId, null);
      assert.equal(database.getMeta('database_version'), '3');
    } finally {
      database.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('timestamp migration converts legacy Date strings and preserves invalid values', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eschool-homework-db-date-migration-'));
  const filePath = join(directory, 'homeworks.sqlite');
  const legacyDate = new Date('2026-08-01T12:00:00.000Z').toString();

  try {
    const legacy = new DatabaseSync(filePath);
    legacy.exec(`
      CREATE TABLE database_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE homework_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL DEFAULT 'eschool',
        external_id TEXT,
        fingerprint TEXT NOT NULL UNIQUE,
        target_appointment_id TEXT NOT NULL,
        normalized_description TEXT NOT NULL,
        homework_ids_json TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        is_current INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'pending',
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        last_notified_at TEXT,
        notification_pending INTEGER NOT NULL DEFAULT 0,
        notification_kind TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO database_meta (key, value) VALUES ('database_version', '2');
      INSERT INTO homework_tasks (
        source, fingerprint, target_appointment_id, normalized_description,
        homework_ids_json, snapshot_json, first_seen_at, last_seen_at,
        completed_at, created_at, updated_at, status
      ) VALUES
        (
          'eschool', 'legacy-date', '701', 'Стара дата',
          '[1]', '{"subject":"Алгебра"}', '${legacyDate}', '${legacyDate}',
          '${legacyDate}', '${legacyDate}', '${legacyDate}', 'completed'
        ),
        (
          'eschool', 'invalid-date', '702', 'Невідома дата',
          '[2]', '{"subject":"Хімія"}', 'not-a-date', 'not-a-date',
          'not-a-date', 'not-a-date', 'not-a-date', 'completed'
        );
    `);
    legacy.close();

    const database = createHomeworkDatabase({ filePath });
    try {
      const migrated = database.findByFingerprint('legacy-date');
      const invalid = database.findByFingerprint('invalid-date');
      assert.equal(migrated.completedAt, '2026-08-01T12:00:00.000Z');
      assert.equal(migrated.updatedAt, '2026-08-01T12:00:00.000Z');
      assert.equal(invalid.completedAt, 'not-a-date');
      assert.equal(invalid.updatedAt, 'not-a-date');
      assert.deepEqual(database.getMigrationDiagnostics(), {
        fromVersion: 2,
        toVersion: 3,
        convertedValues: 5,
        invalidValues: 5,
      });
      assert.equal(database.getMeta('database_version'), '3');
    } finally {
      database.close();
    }

    const reopened = createHomeworkDatabase({ filePath });
    try {
      assert.equal(reopened.findByFingerprint('legacy-date').completedAt, '2026-08-01T12:00:00.000Z');
      assert.deepEqual(reopened.getMigrationDiagnostics(), {
        fromVersion: 3,
        toVersion: 3,
        convertedValues: 0,
        invalidValues: 0,
      });
    } finally {
      reopened.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('database does not open a future schema version as the current version', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eschool-homework-db-future-'));
  const filePath = join(directory, 'homeworks.sqlite');

  try {
    const legacy = new DatabaseSync(filePath);
    legacy.exec(`
      CREATE TABLE database_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO database_meta (key, value) VALUES ('database_version', '999');
    `);
    legacy.close();

    assert.throws(
      () => createHomeworkDatabase({ filePath }),
      /newer than supported/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('transactional notification queue survives SQLite reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eschool-homework-db-queue-'));
  const filePath = join(directory, 'homeworks.sqlite');
  const timestamp = '2026-09-09T12:00:00.000Z';
  const existing = toSyncTask({
    targetAppointmentId: 601,
    homeworkId: 1,
    subject: 'Алгебра',
    description: 'Вже збережене',
  });
  const queued = toSyncTask({
    targetAppointmentId: 602,
    homeworkId: 2,
    subject: 'Хімія',
    description: 'Має бути доставлене',
  });

  try {
    const database = createHomeworkDatabase({ filePath });
    database.saveBaseline([existing], timestamp, { source: 'eschool' });
    database.applyProviderSnapshot([
      { task: existing, previous: database.findMatch(existing), notificationKind: null },
      { task: queued, previous: null, notificationKind: 'new' },
    ], timestamp, { source: 'eschool' });
    database.close();

    const reopened = createHomeworkDatabase({ filePath });
    try {
      assert.deepEqual(
        reopened.pendingNotifications('eschool').map((task) => task.snapshot.description),
        ['Має бути доставлене'],
      );
      assert.equal(reopened.currentTasks().length, 2);
    } finally {
      reopened.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
