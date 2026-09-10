import { SmokeTestError } from './utils.js';

export const DATABASE_VERSION = 3;

export class HomeworkDatabaseError extends SmokeTestError {
  constructor(message, options = {}) {
    super(message, { code: 'DATABASE_ERROR', ...options });
    this.name = 'HomeworkDatabaseError';
  }
}

export function normalizeTimestampForStorage(value, label = 'timestamp') {
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

export function assertTask(task) {
  if (!task || typeof task !== 'object' || !task.fingerprint || !task.snapshot) {
    throw new HomeworkDatabaseError('Cannot store an invalid homework task');
  }
}

export function serializeJson(value, fallback) {
  try {
    return JSON.stringify(value ?? fallback);
  } catch (error) {
    throw new HomeworkDatabaseError(
      'Could not serialize homework data',
      { cause: error },
    );
  }
}

export function parseJson(value, fallback, label) {
  if (value !== null && value !== undefined && typeof value !== 'string') {
    return value;
  }
  try {
    return value ? JSON.parse(value) : fallback;
  } catch (error) {
    throw new HomeworkDatabaseError(
      `Database row contains invalid ${label} JSON`,
      { cause: error },
    );
  }
}

function isDatabaseFlagSet(value) {
  return value === 1 || value === true || String(value) === '1';
}

export function rowToTask(row) {
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
    isCurrent: isDatabaseFlagSet(row.is_current),
    status: row.status,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    lastNotifiedAt: row.last_notified_at,
    notificationPending: isDatabaseFlagSet(row.notification_pending),
    notificationKind: row.notification_kind,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function targetId(task) {
  return String(task.targetAppointmentId ?? '');
}

export function sourceId(task) {
  return String(task.source ?? task.snapshot?.source ?? 'eschool').trim().toLowerCase() || 'eschool';
}

export function externalId(task) {
  const value = task.externalId ?? task.snapshot?.externalId;
  return value === undefined || value === null || String(value).trim() === ''
    ? null
    : String(value);
}

export function taskIdentity(task) {
  const source = sourceId(task);
  if (source === 'classroom') {
    return `${source}:external:${externalId(task) ?? task.fingerprint}`;
  }
  return `${source}:fingerprint:${task.fingerprint}`;
}

export function baselineMetaKey(source) {
  return source === 'eschool' ? 'baseline_initialized_at' : `baseline_initialized_at:${source}`;
}
