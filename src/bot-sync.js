import { deduplicateHomeworkRecords, getAppointments } from './eschool.js';
import {
  formatChangedHomeworkMessage,
  formatNewHomeworkMessage,
} from './messages.js';
import { createStateStore } from './state.js';
import { toSyncTask } from './sync.js';
import {
  CLASSROOM_AUTHUSER_META_KEY,
  normalizeClassroomAssignmentUrl,
  parseClassroomAuthuserIndex,
} from './classroom-url.js';
import { SmokeTestError, errorMessage, normalizeDescription, normalizeTopic } from './utils.js';
import {
  CLASSROOM_STATUS_RECONCILED_META_KEY,
  taskIdentity,
} from './homework-db-shared.js';
import { isTaskInAccountingPeriod } from './classroom-policy.js';

export const COMPLETED_TASK_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
export const ESCHOOL_SOURCE = 'eschool';
export const CLASSROOM_SOURCE = 'classroom';

const loggedInEschoolClients = new WeakSet();
export const ESCHOOL_SYNC_META_KEY = 'eschool_sync_status';
export const CLASSROOM_SYNC_META_KEY = 'classroom_sync_status';

async function readProviderSyncDiagnostics(database, key) {
  if (typeof database?.getMeta !== 'function') {
    return {};
  }
  try {
    const parsed = JSON.parse(await database.getMeta(key) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

async function persistProviderSyncDiagnostics(database, key, status, logger, source) {
  if (typeof database?.setMeta !== 'function') {
    return;
  }
  try {
    await database.setMeta(key, JSON.stringify(status));
  } catch {
    try {
      logger(`[${source}] Could not persist sync diagnostics`);
    } catch {
      // Diagnostic logging must not replace the provider result.
    }
  }
}

async function syncEschool({ auth, getAppointmentsFn, database, logger, now, signal, ...options }) {
  const attemptedAt = new Date(now).toISOString();
  let stage = 'login';
  const previous = await readProviderSyncDiagnostics(database, ESCHOOL_SYNC_META_KEY);
  const saveStatus = (status) => persistProviderSyncDiagnostics(
    database,
    ESCHOOL_SYNC_META_KEY,
    status,
    logger,
    ESCHOOL_SOURCE,
  );
  try {
    const result = await syncProviderHomeworks({
      ...options, database, logger, now, signal, source: ESCHOOL_SOURCE,
      fetchTasksFn: async (requestSignal) => {
        try {
          await ensureEschoolAuth(auth, requestSignal);
          stage = 'appointments';
          const result = await getAppointmentsFn(auth, { signal: requestSignal, now, logger });
          stage = 'snapshot';
          return result;
        } catch (error) {
          // An unrecognized session failure must not pin every future cycle
          // to the same client session. Retry login only on the next cycle.
          loggedInEschoolClients.delete(auth);
          throw error;
        }
      },
    });
    const status = {
      attemptedAt, lastSuccessAt: attemptedAt, taskCount: result.taskCount,
      status: result.deliveryErrors ? 'delivery_error' : 'ok',
      stage: result.deliveryErrors ? 'delivery' : null,
    };
    await saveStatus(status);
    logger(`[eschool] Sync status: ${status.status}; tasks: ${status.taskCount}; last success: ${attemptedAt}`);
    return { ...result, stage: status.stage };
  } catch (error) {
    if (!signal?.aborted) {
      await saveStatus({
        attemptedAt, lastSuccessAt: previous?.lastSuccessAt ?? null,
        taskCount: previous?.taskCount ?? null, status: 'error', stage,
      });
      logger(`[eschool] Sync failed at stage: ${stage}; last success: ${previous?.lastSuccessAt ?? 'unknown'}`);
    }
    try {
      error.syncStage = stage;
    } catch {
      // Some external error objects may be immutable; the persisted status is
      // still sufficient for the next operator inspection.
    }
    throw error;
  }
}

async function recordClassroomProviderFailure({ database, timestamp, logger }) {
  const previous = await readProviderSyncDiagnostics(database, CLASSROOM_SYNC_META_KEY);
  await persistProviderSyncDiagnostics(database, CLASSROOM_SYNC_META_KEY, {
    attemptedAt: timestamp,
    lastSuccessAt: previous?.lastSuccessAt ?? null,
    taskCount: previous?.taskCount ?? null,
    status: 'error',
  }, logger, CLASSROOM_SOURCE);
}

function throwIfAborted(signal) {
  if (!signal?.aborted) {
    return;
  }
  const error = new Error('Sync was cancelled');
  error.name = 'AbortError';
  throw error;
}

async function ensureEschoolAuth(auth, signal) {
  throwIfAborted(signal);
  if (typeof auth?.fullLogin !== 'function' || loggedInEschoolClients.has(auth)) {
    return;
  }
  await auth.fullLogin({ signal });
  loggedInEschoolClients.add(auth);
}

function getTasksFromProviderResult(result, source) {
  let tasks;
  if (Array.isArray(result)) {
    tasks = result;
  } else if (Array.isArray(result?.homeworkTasks)) {
    tasks = result.homeworkTasks;
  } else if (Array.isArray(result?.homeworks)) {
    tasks = result.homeworks;
  } else if (source === ESCHOOL_SOURCE && Array.isArray(result?.rawHomeworks)) {
    tasks = deduplicateHomeworkRecords(result.rawHomeworks);
  } else {
    throw new SmokeTestError(
      `${source} provider did not return a homework task array`,
      { code: 'SYNC_DATA_ERROR' },
    );
  }

  const normalizedTasks = tasks.map((task) => {
    if (!task || typeof task !== 'object') {
      throw new SmokeTestError(
        `${source} provider returned an invalid homework task`,
        { code: 'SYNC_DATA_ERROR' },
      );
    }
    const normalized = task?.snapshot && task?.fingerprint
      ? task
      : toSyncTask({ ...task, source });
    if (source === ESCHOOL_SOURCE
      && String(normalized.targetAppointmentId ?? '').trim() === '') {
      throw new SmokeTestError(
        'E-school provider returned a homework without targetAppointmentId',
        { code: 'SYNC_DATA_ERROR' },
      );
    }
    return normalized;
  });

  const seenIdentities = new Set();
  return normalizedTasks.filter((task) => {
    if (!isTaskInAccountingPeriod(task)) return false;
    const identity = source === CLASSROOM_SOURCE
      ? `${source}:external:${task.externalId ?? task.snapshot?.externalId ?? task.fingerprint}`
      : `${source}:fingerprint:${task.fingerprint}`;
    if (seenIdentities.has(identity)) {
      return false;
    }
    seenIdentities.add(identity);
    return true;
  });
}

function getProviderSnapshot(result, source) {
  if (source === ESCHOOL_SOURCE && result?.snapshotComplete === false) {
    throw new SmokeTestError(
      'E-school provider returned an incomplete snapshot',
      { code: 'SYNC_DATA_ERROR' },
    );
  }
  const rawTasks = getTasksFromProviderResult(result, source);
  const metadata = result;
  const statusSyncEnabled = source === CLASSROOM_SOURCE
    && metadata?.statusSyncEnabled === true;
  if (!statusSyncEnabled) {
    return {
      currentTasks: rawTasks,
      statusUpdates: [],
      currentExternalIds: null,
      snapshotComplete: true,
      statusReconciliationComplete: false,
      statusSyncEnabled: false,
    };
  }

  if (!Array.isArray(metadata.statusUpdates)
    || metadata.snapshotComplete !== true
    || metadata.statusReconciliationComplete !== true) {
    throw new SmokeTestError(
      'Classroom provider returned an incomplete status snapshot',
      { code: 'SYNC_DATA_ERROR' },
    );
  }

  const statusUpdates = [];
  const seenIds = new Set();
  for (const entry of metadata.statusUpdates) {
    const task = entry?.task ?? entry;
    const normalizedTask = task?.snapshot && task?.fingerprint
      ? task
      : toSyncTask({ ...task, source });
    const identity = String(
      normalizedTask.externalId
        ?? normalizedTask.snapshot?.externalId
        ?? normalizedTask.fingerprint,
    ).trim();
    const status = String(entry?.status ?? normalizedTask.classroomStatus ?? '').trim().toLowerCase();
    if (!identity || !['pending', 'completed'].includes(status)) {
      continue;
    }
    if (seenIds.has(identity)) {
      continue;
    }
    seenIds.add(identity);
    statusUpdates.push({
      task: normalizedTask,
      status,
      allowInsert: entry?.allowInsert !== false,
    });
  }

  return {
    currentTasks: rawTasks.filter((task) => (
      task.classroomStatus === 'pending' || task.classroomStatus === 'completed'
    )),
    statusUpdates,
    currentExternalIds: Array.isArray(metadata.currentExternalIds)
      ? metadata.currentExternalIds.map((value) => String(value))
      : [],
    snapshotComplete: true,
    statusReconciliationComplete: true,
    statusSyncEnabled: true,
  };
}

function snapshotComparable(snapshot, { includeUpdatedAt = true, source = null } = {}) {
  const snapshotSource = String(source ?? snapshot?.source ?? 'eschool');
  const rawUrl = String(snapshot?.url ?? snapshot?.alternateLink ?? snapshot?.homeworkUrl ?? '');
  const value = {
    source: snapshotSource,
    subject: normalizeDescription(snapshot?.subject),
    title: normalizeDescription(snapshot?.title ?? snapshot?.description),
    description: normalizeDescription(snapshot?.description),
    assignedDate: String(snapshot?.assignedDate ?? ''),
    targetDate: String(snapshot?.targetDate ?? ''),
    targetTime: String(snapshot?.targetTime ?? ''),
    lessonNumber: snapshot?.lessonNumber === null || snapshot?.lessonNumber === undefined
      ? null
      : String(snapshot.lessonNumber),
    startTime: String(snapshot?.startTime ?? ''),
    topics: Array.isArray(snapshot?.topics) ? snapshot.topics.map(normalizeTopic) : [],
    // The direct Classroom route is derived from stable ids. Comparing its
    // old raw-id form with the corrected encoded form would create a false
    // "changed" notification during the link-format migration.
    url: snapshotSource === CLASSROOM_SOURCE
      ? normalizeClassroomAssignmentUrl(rawUrl)
      : rawUrl,
    filesCount: Number(snapshot?.filesCount ?? 0),
  };
  if (includeUpdatedAt) {
    value.updatedAt = String(snapshot?.updatedAt ?? '');
  }
  return value;
}

function snapshotsChanged(previous, current, source = null) {
  const left = previous?.snapshot ?? {};
  const right = current?.snapshot ?? {};
  const isClassroom = source === CLASSROOM_SOURCE
    || String(left.source ?? right.source ?? ESCHOOL_SOURCE) === CLASSROOM_SOURCE;

  return JSON.stringify(snapshotComparable(left, {
    includeUpdatedAt: !isClassroom,
    source,
  })) !== JSON.stringify(snapshotComparable(right, {
    includeUpdatedAt: !isClassroom,
    source,
  }));
}

function legacyEntryToTask(key, entry) {
  return {
    source: ESCHOOL_SOURCE,
    externalId: entry.externalId ?? entry.snapshot?.externalId ?? null,
    fingerprint: entry.fingerprint ?? key,
    targetAppointmentId: entry.targetAppointmentId ?? null,
    homeworkIds: Array.isArray(entry.homeworkIds) ? entry.homeworkIds : [],
    snapshot: { source: ESCHOOL_SOURCE, ...(entry.snapshot ?? {}) },
  };
}

function providerBaselineKey(source) {
  return source === ESCHOOL_SOURCE ? 'baseline_initialized_at' : `baseline_initialized_at:${source}`;
}

async function initializeDatabase({
  database,
  legacyStateStore,
  source,
  currentTasks,
  statusUpdates = [],
  timestamp,
  logger,
}) {
  const metaKey = providerBaselineKey(source);
  if (await database.getMeta(metaKey)) {
    return { imported: false, initialized: false };
  }

  if (source === ESCHOOL_SOURCE && legacyStateStore) {
    const legacyState = await legacyStateStore.load();
    if (legacyState.initializedAt !== null) {
      const legacyTasks = Object.entries(legacyState.tasks).map(([key, entry]) => (
        legacyEntryToTask(key, entry)
      ));
      await database.importLegacyState(legacyTasks, legacyState.initializedAt);
      logger(`[bot-sync] Imported ${legacyTasks.length} tasks from the existing JSON baseline`);
      return { imported: true, initialized: true };
    }
  }

  const baselineResult = await database.saveBaseline(currentTasks, timestamp, {
    source,
    statusUpdates,
  });
  logger(`[bot-sync] Baseline initialized for ${source} with ${currentTasks.length} tasks`);
  return {
    imported: false,
    initialized: true,
    statusAppliedIdentities: baselineResult?.statusAppliedIdentities ?? [],
    metrics: baselineResult ?? {
      inserted: currentTasks.length,
      unchanged: 0,
    },
  };
}

async function removeExpiredCompletedTasks(database, timestamp, logger) {
  const cleanupCutoff = new Date(
    new Date(timestamp).getTime() - COMPLETED_TASK_RETENTION_MS,
  ).toISOString();
  const removedCompletedTasks = typeof database.deleteCompletedBefore === 'function'
    ? await database.deleteCompletedBefore(cleanupCutoff)
    : 0;
  if (removedCompletedTasks > 0) {
    logger(`[bot-sync] Removed ${removedCompletedTasks} completed tasks older than 14 days`);
  }
  return removedCompletedTasks;
}

function classifyNotification(previous, task, source) {
  if (!previous) {
    if (source === CLASSROOM_SOURCE && task.classroomStatus === 'completed') {
      return null;
    }
    return 'new';
  }
  if (previous.notificationPending) {
    return previous.notificationKind || 'new';
  }
  return snapshotsChanged(previous, task, source) ? 'changed' : null;
}

async function deliverPendingNotifications({
  source,
  database,
  sendMessageFn,
  logger,
  now,
  signal,
} = {}) {
  const pendingTasks = typeof database.pendingNotifications === 'function'
    ? await database.pendingNotifications(source)
    : [];
  const classroomAuthuserIndex = source === CLASSROOM_SOURCE
    && typeof database.getMeta === 'function'
    ? parseClassroomAuthuserIndex(await database.getMeta(CLASSROOM_AUTHUSER_META_KEY))
    : null;
  let sentTasks = 0;
  let deliveryErrors = 0;

  for (const task of pendingTasks) {
    throwIfAborted(signal);
    let currentTask = task;
    if (typeof database.findById === 'function') {
      try {
        const latest = await database.findById(task.id);
        if (!latest || !latest.notificationPending || latest.status === 'completed'
          || !isTaskInAccountingPeriod(latest)) {
          if (latest?.status === 'completed' && latest.notificationPending
            && typeof database.clearNotification === 'function') {
            await database.clearNotification(latest.id, new Date(now).toISOString());
          }
          continue;
        }
        currentTask = latest;
      } catch (error) {
        deliveryErrors += 1;
        logger(`[bot-sync] Could not recheck queued notification: ${errorMessage(error)}`);
        continue;
      }
    }

    const kind = currentTask.notificationKind || 'new';
    const message = kind === 'changed'
      ? formatChangedHomeworkMessage(currentTask, { classroomAuthuserIndex })
      : formatNewHomeworkMessage(currentTask, { classroomAuthuserIndex });
    const sendOptions = {
      task: currentTask,
      kind,
      signal,
      parseMode: 'HTML',
    };

    try {
      await sendMessageFn(message, sendOptions);
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      deliveryErrors += 1;
      logger(
        `[bot-sync] Telegram delivery failed for ${kind} ${source} homework: ${errorMessage(error)}`,
      );
      // Telegram's retry_after is a server-side pacing instruction. Do not
      // turn one rate limit into a burst of more rejected requests.
      if (Number.isFinite(Number(error?.retryAfter))) {
        break;
      }
      continue;
    }

    try {
      await database.recordNotificationSuccess(currentTask.id, new Date(now).toISOString());
      sentTasks += 1;
    } catch (error) {
      deliveryErrors += 1;
      logger(`[bot-sync] Could not record Telegram delivery: ${errorMessage(error)}`);
    }
  }

  return { sentTasks, deliveryErrors };
}

export async function syncProviderHomeworks({
  source,
  fetchTasksFn,
  database,
  legacyStateStore = null,
  sendMessageFn,
  logger = console.log,
  now = new Date(),
  signal,
} = {}) {
  if (!source || typeof fetchTasksFn !== 'function') {
    throw new SmokeTestError('syncProviderHomeworks requires a source and fetchTasks function');
  }
  if (!database) {
    throw new SmokeTestError('syncProviderHomeworks requires a homework database');
  }
  if (typeof sendMessageFn !== 'function') {
    throw new SmokeTestError('syncProviderHomeworks requires a Telegram sendMessage function');
  }

  const startedAt = Date.now();
  const timestamp = new Date(now).toISOString();
  let currentTasks;
  let providerSnapshot;
  try {
    throwIfAborted(signal);
    const providerResult = await fetchTasksFn(signal);
    providerSnapshot = getProviderSnapshot(providerResult, source);
    currentTasks = providerSnapshot.currentTasks;
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    // A provider outage must not discard a queue committed by an earlier
    // cycle. Attempt that queue, then preserve the original provider error.
    await deliverPendingNotifications({
      source,
      database,
      sendMessageFn,
      logger,
      now: timestamp,
      signal,
    });
    throw error;
  }
  const initialization = await initializeDatabase({
    database,
    legacyStateStore,
    source,
    currentTasks,
    statusUpdates: providerSnapshot.statusUpdates,
    timestamp,
    logger,
  });

  if (initialization.initialized && !initialization.imported) {
    let reconciliation = null;
    if (providerSnapshot.statusSyncEnabled) {
      const statusAppliedIdentities = new Set(initialization.statusAppliedIdentities ?? []);
      reconciliation = await database.applyProviderSnapshot([], timestamp, {
        source,
        statusUpdates: providerSnapshot.statusUpdates.filter(({ task }) => (
          !statusAppliedIdentities.has(taskIdentity(task))
        )),
        currentExternalIds: providerSnapshot.currentExternalIds,
        snapshotComplete: providerSnapshot.snapshotComplete,
        statusReconciliationComplete: true,
      });
    }
    const baselineMetrics = initialization.metrics ?? {};
    const reconciliationMetrics = reconciliation ?? {};
    const metrics = {
      observed: currentTasks.length,
      inserted: Number(baselineMetrics.inserted ?? currentTasks.length)
        + Number(reconciliationMetrics.inserted ?? 0),
      changed: 0,
      unchanged: Number(baselineMetrics.unchanged ?? 0),
      notCurrent: Number(reconciliationMetrics.notCurrent ?? 0),
      statusTransitions: Number(reconciliationMetrics.statusTransitions ?? 0),
      notificationsQueued: Number(reconciliationMetrics.notificationsQueued ?? 0),
      notificationsSent: 0,
      durationMs: Date.now() - startedAt,
    };
    if (source === CLASSROOM_SOURCE && typeof database.setMeta === 'function') {
      try {
        await database.setMeta(CLASSROOM_SYNC_META_KEY, JSON.stringify({
          attemptedAt: timestamp,
          lastSuccessAt: timestamp,
          taskCount: currentTasks.length,
          status: 'ok',
          metrics,
        }));
      } catch {
        logger('[classroom] Could not persist sync diagnostics');
      }
    }
    return {
      source,
      status: 'ok',
      baselineInitialized: true,
      newTasks: 0,
      updatedTasks: 0,
      sentTasks: 0,
      taskCount: currentTasks.length,
      statusReconciled: providerSnapshot.statusSyncEnabled,
      attemptedAt: timestamp,
      lastSuccessAt: timestamp,
      metrics,
    };
  }

  const matchCandidates = [
    ...currentTasks,
    ...(providerSnapshot.statusSyncEnabled
      ? providerSnapshot.statusUpdates.map(({ task }) => task)
      : []),
  ];
  const allMatches = typeof database.findMatches === 'function'
    ? await database.findMatches(matchCandidates)
    : await Promise.all(matchCandidates.map(async (task) => ({
      task,
      previous: await database.findMatch(task),
    })));
  const previousByIdentity = new Map(
    allMatches.map(({ task, previous }) => [taskIdentity(task), previous]),
  );
  const matchedTasks = currentTasks.map((task) => ({
    task,
    previous: previousByIdentity.get(taskIdentity(task)) ?? null,
  }));
  const statusUpdates = providerSnapshot.statusUpdates.map((update) => ({
    ...update,
    previous: previousByIdentity.get(taskIdentity(update.task)) ?? null,
  }));
  const notificationPlan = [];
  const statusMarker = providerSnapshot.statusSyncEnabled
    ? await database.getMeta(CLASSROOM_STATUS_RECONCILED_META_KEY)
    : null;
  const statusReconciliationPending = providerSnapshot.statusSyncEnabled && !statusMarker;
  let persistence = null;
  let newTasks = 0;
  let updatedTasks = 0;
  for (const { task, previous } of matchedTasks) {
    const normalKind = classifyNotification(previous, task, source);
    // The first Classroom status pass is a migration of observations, not a
    // notification event. Existing queue flags remain untouched for pending
    // work, while a completed status update can clear a stale flag atomically.
    const kind = initialization.imported || statusReconciliationPending ? null : normalKind;
    if (kind === 'changed') {
      updatedTasks += 1;
    } else if (kind === 'new') {
      newTasks += 1;
    }
    notificationPlan.push({ task, previous, notificationKind: kind });
  }

  if (typeof database.applyProviderSnapshot === 'function') {
    persistence = await database.applyProviderSnapshot(notificationPlan, timestamp, {
      source,
      statusUpdates,
      currentExternalIds: providerSnapshot.currentExternalIds,
      snapshotComplete: providerSnapshot.snapshotComplete,
      statusReconciliationComplete: providerSnapshot.statusSyncEnabled
        && statusReconciliationPending,
    });
  } else {
    // Compatibility fallback for test doubles that predate the transactional
    // database API. The production database always takes the transaction path.
    for (const entry of notificationPlan) {
      await database.upsertSeenTask(entry.task, {
        timestamp,
        notificationKind: entry.notificationKind,
        previous: entry.previous,
      });
    }
  }

  const delivery = await deliverPendingNotifications({
    source,
    database,
    sendMessageFn,
    logger,
    now: timestamp,
    signal,
  });

  const persistenceMetrics = persistence ?? {};
  const metrics = {
    observed: currentTasks.length,
    inserted: Number(persistenceMetrics.inserted ?? newTasks),
    changed: Number(persistenceMetrics.changed ?? updatedTasks),
    unchanged: Number(persistenceMetrics.unchanged ?? Math.max(
      0,
      currentTasks.length - newTasks - updatedTasks,
    )),
    notCurrent: Number(persistenceMetrics.notCurrent ?? 0),
    statusTransitions: Number(persistenceMetrics.statusTransitions ?? 0),
    notificationsQueued: Number(persistenceMetrics.notificationsQueued ?? 0),
    notificationsSent: delivery.sentTasks,
    durationMs: Date.now() - startedAt,
  };
  if (source === CLASSROOM_SOURCE && typeof database.setMeta === 'function') {
    try {
      await database.setMeta(CLASSROOM_SYNC_META_KEY, JSON.stringify({
        attemptedAt: timestamp,
        lastSuccessAt: timestamp,
        taskCount: currentTasks.length,
        status: delivery.deliveryErrors ? 'delivery_error' : 'ok',
        metrics,
      }));
    } catch {
      logger('[classroom] Could not persist sync diagnostics');
    }
  }

  logger(`[bot-sync] ${source} — New: ${newTasks}, changed: ${updatedTasks}, sent: ${delivery.sentTasks}`);
  return {
    source,
    status: delivery.deliveryErrors ? 'delivery_error' : 'ok',
    baselineInitialized: false,
    newTasks,
    updatedTasks,
    sentTasks: delivery.sentTasks,
    deliveryErrors: delivery.deliveryErrors,
    taskCount: currentTasks.length,
    statusReconciled: providerSnapshot.statusSyncEnabled
      && Boolean(statusMarker || statusReconciliationPending),
    attemptedAt: timestamp,
    lastSuccessAt: timestamp,
    metrics,
  };
}

export async function syncBotHomeworks({
  auth,
  database,
  legacyStateStore = createStateStore(),
  getAppointmentsFn = getAppointments,
  sendMessageFn,
  telegram,
  logger = console.log,
  now = new Date(),
  signal,
} = {}) {
  if (!auth) {
    throw new SmokeTestError('syncBotHomeworks requires an auth client');
  }

  const sendMessage = sendMessageFn ?? telegram?.sendTelegramMessage;
  if (typeof sendMessage !== 'function') {
    throw new SmokeTestError('syncBotHomeworks requires a Telegram sendMessage function');
  }

  const result = await syncEschool({
    auth,
    getAppointmentsFn,
    database,
    legacyStateStore,
    sendMessageFn: sendMessage,
    logger,
    now,
    signal,
  });
  await removeExpiredCompletedTasks(database, new Date(now).toISOString(), logger);
  return result;
}

export async function syncAllHomeworks({
  auth,
  classroom = null,
  database,
  legacyStateStore = createStateStore(),
  getAppointmentsFn = getAppointments,
  getClassroomHomeworksFn,
  sendMessageFn,
  telegram,
  logger = console.log,
  now = new Date(),
  signal,
} = {}) {
  if (!auth) {
    throw new SmokeTestError('syncAllHomeworks requires an e-school auth client');
  }
  if (!database) {
    throw new SmokeTestError('syncAllHomeworks requires a homework database');
  }

  const sendMessage = sendMessageFn ?? telegram?.sendTelegramMessage;
  if (typeof sendMessage !== 'function') {
    throw new SmokeTestError('syncAllHomeworks requires a Telegram sendMessage function');
  }

  const providers = [];

  try {
    providers.push(await syncEschool({
      auth,
      getAppointmentsFn,
      database,
      legacyStateStore,
      sendMessageFn: sendMessage,
      logger,
      now,
      signal,
    }));
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    logger(`[bot-sync] ${ESCHOOL_SOURCE} provider failed: ${errorMessage(error)}`);
    providers.push({
      source: ESCHOOL_SOURCE,
      status: 'error',
      error: errorMessage(error),
      stage: error.syncStage ?? 'unknown',
      attemptedAt: new Date(now).toISOString(),
      newTasks: 0,
      updatedTasks: 0,
      sentTasks: 0,
      taskCount: null,
      metrics: {
        observed: 0,
        inserted: 0,
        changed: 0,
        unchanged: 0,
        notCurrent: 0,
        statusTransitions: 0,
        notificationsQueued: 0,
        notificationsSent: 0,
        durationMs: 0,
      },
    });
  }

  const classroomFetcher = getClassroomHomeworksFn
    ?? classroom?.getClassroomHomeworks;
  if (typeof classroomFetcher !== 'function') {
    logger('[bot-sync] Classroom provider is not configured; skipping it');
    providers.push({
      source: CLASSROOM_SOURCE,
      status: 'skipped',
      attemptedAt: new Date(now).toISOString(),
      newTasks: 0,
      updatedTasks: 0,
      sentTasks: 0,
      taskCount: 0,
      metrics: {
        observed: 0,
        inserted: 0,
        changed: 0,
        unchanged: 0,
        notCurrent: 0,
        statusTransitions: 0,
        notificationsQueued: 0,
        notificationsSent: 0,
        durationMs: 0,
      },
    });
  } else {
    try {
      providers.push(await syncProviderHomeworks({
        source: CLASSROOM_SOURCE,
        fetchTasksFn: async (requestSignal) => classroomFetcher({ signal: requestSignal }),
        database,
        sendMessageFn: sendMessage,
        logger,
        now,
        signal,
      }));
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      await recordClassroomProviderFailure({
        database,
        timestamp: new Date(now).toISOString(),
        logger,
      });
      logger(`[bot-sync] ${CLASSROOM_SOURCE} provider failed: ${errorMessage(error)}`);
      providers.push({
        source: CLASSROOM_SOURCE,
        status: 'error',
        error: errorMessage(error),
        attemptedAt: new Date(now).toISOString(),
        newTasks: 0,
        updatedTasks: 0,
        sentTasks: 0,
        taskCount: null,
        metrics: {
          observed: 0,
          inserted: 0,
          changed: 0,
          unchanged: 0,
          notCurrent: 0,
          statusTransitions: 0,
          notificationsQueued: 0,
          notificationsSent: 0,
          durationMs: 0,
        },
      });
    }
  }

  await removeExpiredCompletedTasks(database, new Date(now).toISOString(), logger);
  const failedProviders = providers.filter((provider) => provider.status === 'error');
  const result = {
    baselineInitialized: providers.some((provider) => provider.baselineInitialized),
    newTasks: providers.reduce((total, provider) => total + (provider.newTasks ?? 0), 0),
    updatedTasks: providers.reduce((total, provider) => total + (provider.updatedTasks ?? 0), 0),
    sentTasks: providers.reduce((total, provider) => total + (provider.sentTasks ?? 0), 0),
    taskCount: providers.reduce(
      (total, provider) => total + (Number.isFinite(provider.taskCount) ? provider.taskCount : 0),
      0,
    ),
    providers,
    failedProviders,
    metrics: providers.reduce((total, provider) => {
      const metrics = provider.metrics ?? {};
      for (const key of [
        'observed',
        'inserted',
        'changed',
        'unchanged',
        'notCurrent',
        'statusTransitions',
        'notificationsQueued',
        'notificationsSent',
      ]) {
        total[key] += Number(metrics[key] ?? 0);
      }
      total.durationMs += Number(metrics.durationMs ?? 0);
      return total;
    }, {
      observed: 0,
      inserted: 0,
      changed: 0,
      unchanged: 0,
      notCurrent: 0,
      statusTransitions: 0,
      notificationsQueued: 0,
      notificationsSent: 0,
      durationMs: 0,
    }),
  };
  logger(`[bot-sync] Combined sync — new: ${result.newTasks}, changed: ${result.updatedTasks}, sent: ${result.sentTasks}`);
  return result;
}
