import test from 'node:test';
import assert from 'node:assert/strict';
import { isClassroomPublicationEligible } from '../src/classroom-policy.js';
import { decodeCourseWorkPayload } from '../src/classroom-web.js';
import { toSyncTask } from '../src/sync.js';
import { createTestDatabase } from '../test-support/postgres-test-database.js';

test('publication cutoff uses Kyiv midnight, never edits or deadlines', () => {
  assert.equal(isClassroomPublicationEligible({ publishedAt: '2026-08-31T21:00:00Z' }), true);
  assert.equal(isClassroomPublicationEligible({ publishedAt: '2026-08-31T20:59:59.999Z' }), false);
  assert.equal(isClassroomPublicationEligible({ publishedAt: '2022-09-01T10:00:00Z', updatedAt: '2026-09-11T10:00:00Z', targetDate: '2027-01-01' }), false);
  assert.equal(isClassroomPublicationEligible({ updatedAt: '2026-09-11T10:00:00Z' }), false);
});

test('wire decoder distinguishes publication from creation, edits, and scheduled time', () => {
  const record = Array(28).fill(null);
  record[0] = ['work', ['course']];
  record[1] = Date.parse('2022-08-20T10:00:00Z');
  record[2] = Date.parse('2026-09-11T10:00:00Z');
  record[5] = 'Assignment';
  record[9] = [2, ['author'], Date.parse('2022-09-01T10:00:00Z'), null, Date.parse('2027-01-01T10:00:00Z')];
  const [assignment] = decodeCourseWorkPayload(['hrsi.qr', [false], [[2, [record]]]], { courseId: 'course' });
  assert.equal(assignment.publishedAt, '2022-09-01T10:00:00.000Z');
  assert.equal(isClassroomPublicationEligible(assignment), false);
  record[9][0] = 3;
  assert.equal(decodeCourseWorkPayload([record], { courseId: 'course' })[0].publishedAt, null);
});

test('pre-policy rows are hidden and cannot notify or restore; fresh evidence backfills without deletion', async () => {
  const { database } = await createTestDatabase();
  const make = (id, publishedAt) => toSyncTask({ source: 'classroom', externalId: `course:${id}`, title: id, publishedAt });
  const now = '2026-09-11T10:00:00Z';
  const old = make('old', '2022-09-01T10:00:00Z');
  const unknown = make('unknown', null);
  const recent = make('recent', '2026-09-01T00:00:00+03:00');
  try {
    // Seed rows as they existed before the policy, including a queued message.
    await database.saveBaseline([old, unknown, recent], now, { source: 'classroom' });
    const oldRow = await database.findMatch(old);
    await database.upsertSeenTask(old, { timestamp: now, previous: oldRow, notificationKind: 'new' });
    assert.deepEqual((await database.currentTasks()).map(t => t.externalId), ['course:recent']);
    assert.equal((await database.pendingNotifications()).length, 0);
    assert.equal(await database.completeTask(oldRow.id, now), null);
    const recentRow = await database.findMatch(recent);
    await database.completeTask(recentRow.id, now);
    // An old completed record is retained but excluded even from old buttons.
    await database.upsertSeenTask(make('recent', '2022-09-01T10:00:00Z'), { timestamp: now, previous: recentRow });
    assert.equal((await database.completedTasks()).length, 0);
    assert.equal(await database.uncompleteTask(recentRow.id, now), null);
    const backfilled = make('unknown', '2026-09-02T10:00:00Z');
    await database.applyProviderSnapshot([], now, { source: 'classroom', statusUpdates: [{ task: backfilled, status: 'pending' }] });
    assert.deepEqual((await database.currentTasks()).map(t => t.externalId), ['course:unknown']);
    assert.ok(await database.findMatch(old));
  } finally {
    await database.close();
  }
});
