import { deduplicateHomeworkRecords, getAppointments } from './eschool.js';
import {
  createCompleteKeyboard,
  formatChangedHomeworkMessage,
  formatNewHomeworkMessage,
} from './messages.js';
import { createStateStore } from './state.js';
import { createHomeworkDatabase } from './homework-db.js';
import { toSyncTask } from './sync.js';
import { SmokeTestError, errorMessage, normalizeDescription, normalizeTopic } from './utils.js';

export const COMPLETED_TASK_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
export const ESCHOOL_SOURCE = 'eschool';
export const CLASSROOM_SOURCE = 'classroom';

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

  return tasks.map((task) => {
    if (task?.snapshot && task?.fingerprint) {
      return task;
    }
    return toSyncTask({ ...task, source });
  });
}

function snapshotsChanged(previous, current) {
  const left = previous?.snapshot ?? {};
  const right = current?.snapshot ?? {};

  return JSON.stringify({
    source: String(left.source ?? 'eschool'),
    title: normalizeDescription(left.title ?? left.description),
    description: normalizeDescription(left.description),
    targetDate: String(left.targetDate ?? ''),
    targetTime: String(left.targetTime ?? ''),
    topics: Array.isArray(left.topics) ? left.topics.map(normalizeTopic) : [],
    url: String(left.url ?? left.alternateLink ?? left.homeworkUrl ?? ''),
    updatedAt: String(left.updatedAt ?? ''),
    filesCount: Number(left.filesCount ?? 0),
  }) !== JSON.stringify({
    source: String(right.source ?? 'eschool'),
    title: normalizeDescription(right.title ?? right.description),
    description: normalizeDescription(right.description),
    targetDate: String(right.targetDate ?? ''),
    targetTime: String(right.targetTime ?? ''),
    topics: Array.isArray(right.topics) ? right.topics.map(normalizeTopic) : [],
    url: String(right.url ?? right.alternateLink ?? right.homeworkUrl ?? ''),
    updatedAt: String(right.updatedAt ?? ''),
    filesCount: Number(right.filesCount ?? 0),
  });
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
  timestamp,
  logger,
}) {
  const metaKey = providerBaselineKey(source);
  if (database.getMeta(metaKey)) {
    return { imported: false, initialized: false };
  }

  if (source === ESCHOOL_SOURCE && legacyStateStore) {
    const legacyState = await legacyStateStore.load();
    if (legacyState.initializedAt !== null) {
      const legacyTasks = Object.entries(legacyState.tasks).map(([key, entry]) => (
        legacyEntryToTask(key, entry)
      ));
      database.importLegacyState(legacyTasks, legacyState.initializedAt);
      logger(`[bot-sync] Imported ${legacyTasks.length} tasks from the existing JSON baseline`);
      return { imported: true, initialized: true };
    }
  }

  database.saveBaseline(currentTasks, timestamp, { source });
  logger(`[bot-sync] Baseline initialized for ${source} with ${currentTasks.length} tasks`);
  return { imported: false, initialized: true };
}

function removeExpiredCompletedTasks(database, timestamp, logger) {
  const cleanupCutoff = new Date(
    new Date(timestamp).getTime() - COMPLETED_TASK_RETENTION_MS,
  ).toISOString();
  const removedCompletedTasks = typeof database.deleteCompletedBefore === 'function'
    ? database.deleteCompletedBefore(cleanupCutoff)
    : 0;
  if (removedCompletedTasks > 0) {
    logger(`[bot-sync] Removed ${removedCompletedTasks} completed tasks older than 14 days`);
  }
  return removedCompletedTasks;
}

function isClassroomTask(task) {
  return String(task?.source ?? task?.snapshot?.source ?? ESCHOOL_SOURCE) === CLASSROOM_SOURCE;
}

export async function syncProviderHomeworks({
  source,
  fetchTasksFn,
  database,
  legacyStateStore = null,
  sendMessageFn,
  logger = console.log,
  now = new Date(),
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

  const timestamp = new Date(now).toISOString();
  const providerResult = await fetchTasksFn();
  const currentTasks = getTasksFromProviderResult(providerResult, source);
  const initialization = await initializeDatabase({
    database,
    legacyStateStore,
    source,
    currentTasks,
    timestamp,
    logger,
  });

  if (initialization.initialized && !initialization.imported) {
    return {
      source,
      status: 'ok',
      baselineInitialized: true,
      newTasks: 0,
      updatedTasks: 0,
      sentTasks: 0,
      taskCount: currentTasks.length,
    };
  }

  if (typeof database.markSourceNotCurrent === 'function') {
    database.markSourceNotCurrent(source, timestamp);
  } else {
    database.markAllNotCurrent(timestamp);
  }

  let newTasks = 0;
  let updatedTasks = 0;
  let sentTasks = 0;

  for (const task of currentTasks) {
    const previous = database.findMatch(task);
    let kind = null;

    if (!previous) {
      kind = 'new';
      newTasks += 1;
    } else if (previous.notificationPending) {
      kind = previous.notificationKind || 'new';
      if (kind === 'changed') {
        updatedTasks += 1;
      } else {
        newTasks += 1;
      }
    } else if (snapshotsChanged(previous, task)) {
      kind = 'changed';
      updatedTasks += 1;
    }

    const row = database.upsertSeenTask(task, {
      timestamp,
      notificationKind: kind,
    });

    if (!kind) {
      continue;
    }

    const message = kind === 'changed'
      ? formatChangedHomeworkMessage(task)
      : formatNewHomeworkMessage(task);
    const sendOptions = {
      replyMarkup: createCompleteKeyboard(row.id),
      task: row,
      kind,
    };
    if (isClassroomTask(task)) {
      sendOptions.parseMode = 'HTML';
    }

    try {
      await sendMessageFn(message, sendOptions);
    } catch (error) {
      throw new SmokeTestError(
        `Telegram delivery failed for ${kind} ${source} homework: ${errorMessage(error)}`,
        { code: 'SYNC_SEND_ERROR', cause: error },
      );
    }

    database.recordNotificationSuccess(row.id, timestamp);
    sentTasks += 1;
  }

  logger(`[bot-sync] ${source} — New: ${newTasks}, changed: ${updatedTasks}, sent: ${sentTasks}`);
  return {
    source,
    status: 'ok',
    baselineInitialized: false,
    newTasks,
    updatedTasks,
    sentTasks,
    taskCount: currentTasks.length,
  };
}

export async function syncBotHomeworks({
  auth,
  database = createHomeworkDatabase(),
  legacyStateStore = createStateStore(),
  getAppointmentsFn = getAppointments,
  sendMessageFn,
  telegram,
  logger = console.log,
  now = new Date(),
} = {}) {
  if (!auth) {
    throw new SmokeTestError('syncBotHomeworks requires an auth client');
  }

  const sendMessage = sendMessageFn ?? telegram?.sendTelegramMessage;
  if (typeof sendMessage !== 'function') {
    throw new SmokeTestError('syncBotHomeworks requires a Telegram sendMessage function');
  }

  const result = await syncProviderHomeworks({
    source: ESCHOOL_SOURCE,
    fetchTasksFn: async () => getAppointmentsFn(auth),
    database,
    legacyStateStore,
    sendMessageFn: sendMessage,
    logger,
    now,
  });
  removeExpiredCompletedTasks(database, new Date(now).toISOString(), logger);
  return result;
}

export async function syncAllHomeworks({
  auth,
  classroom = null,
  database = createHomeworkDatabase(),
  legacyStateStore = createStateStore(),
  getAppointmentsFn = getAppointments,
  getClassroomHomeworksFn,
  sendMessageFn,
  telegram,
  logger = console.log,
  now = new Date(),
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
    providers.push(await syncProviderHomeworks({
      source: ESCHOOL_SOURCE,
      fetchTasksFn: async () => getAppointmentsFn(auth),
      database,
      legacyStateStore,
      sendMessageFn: sendMessage,
      logger,
      now,
    }));
  } catch (error) {
    logger(`[bot-sync] ${ESCHOOL_SOURCE} provider failed: ${errorMessage(error)}`);
    providers.push({
      source: ESCHOOL_SOURCE,
      status: 'error',
      error: errorMessage(error),
      newTasks: 0,
      updatedTasks: 0,
      sentTasks: 0,
      taskCount: null,
    });
  }

  const classroomFetcher = getClassroomHomeworksFn
    ?? classroom?.getClassroomHomeworks;
  if (typeof classroomFetcher !== 'function') {
    logger('[bot-sync] Classroom provider is not configured; skipping it');
    providers.push({
      source: CLASSROOM_SOURCE,
      status: 'skipped',
      newTasks: 0,
      updatedTasks: 0,
      sentTasks: 0,
      taskCount: 0,
    });
  } else {
    try {
      providers.push(await syncProviderHomeworks({
        source: CLASSROOM_SOURCE,
        fetchTasksFn: async () => classroomFetcher(),
        database,
        sendMessageFn: sendMessage,
        logger,
        now,
      }));
    } catch (error) {
      logger(`[bot-sync] ${CLASSROOM_SOURCE} provider failed: ${errorMessage(error)}`);
      providers.push({
        source: CLASSROOM_SOURCE,
        status: 'error',
        error: errorMessage(error),
        newTasks: 0,
        updatedTasks: 0,
        sentTasks: 0,
        taskCount: null,
      });
    }
  }

  removeExpiredCompletedTasks(database, new Date(now).toISOString(), logger);
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
  };
  logger(`[bot-sync] Combined sync — new: ${result.newTasks}, changed: ${result.updatedTasks}, sent: ${result.sentTasks}`);
  return result;
}
