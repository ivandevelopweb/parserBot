import {
  deduplicateHomeworkRecords,
  getAppointments,
} from './eschool.js';
import { formatHomeworkMessage } from './messages.js';
import { sendTelegramMessage } from './telegram.js';
import { createStateStore } from './state.js';
import {
  SmokeTestError,
  errorMessage,
  normalizeDescription,
  normalizeTopic,
  uniqueStable,
} from './utils.js';

function getHomeworkIds(task) {
  const ids = Array.isArray(task.homeworkIds)
    ? task.homeworkIds
    : [task.homeworkId];

  return uniqueStable(ids.filter((id) => id !== undefined && id !== null));
}

function getTopics(task) {
  const topics = Array.isArray(task.topics)
    ? task.topics
    : [task.topic];

  return uniqueStable(
    topics
      .map((topic) => normalizeTopic(topic))
      .filter(Boolean),
  );
}

export function createHomeworkFingerprint({ targetAppointmentId, description, normalizedDescription } = {}) {
  const targetId = String(targetAppointmentId ?? '');
  const normalized = normalizedDescription ?? normalizeDescription(description);

  // JSON encoding avoids collisions when the description contains separators.
  return JSON.stringify([targetId, normalized]);
}

export function createClassroomFingerprint({ courseId, courseWorkId, externalId } = {}) {
  const stableExternalId = String(
    externalId ?? `${courseId ?? ''}:${courseWorkId ?? ''}`,
  ).trim();

  if (!stableExternalId || stableExternalId === ':') {
    throw new SmokeTestError('Cannot create a Classroom fingerprint without course and coursework ids', {
      code: 'SYNC_DATA_ERROR',
    });
  }

  return `classroom:${stableExternalId}`;
}

export function createHomeworkSnapshot(task) {
  const source = String(task.source ?? 'eschool').trim().toLowerCase() || 'eschool';

  if (source === 'classroom') {
    const title = normalizeDescription(task.title ?? task.description);
    const description = normalizeDescription(task.description ?? task.title ?? title);

    return {
      source,
      externalId: String(task.externalId ?? `${task.courseId ?? ''}:${task.courseWorkId ?? task.id ?? ''}`),
      subject: String(task.subject ?? '').trim(),
      title,
      topics: getTopics(task),
      description,
      assignedDate: String(task.assignedDate ?? '').trim(),
      targetDate: String(task.targetDate ?? '').trim(),
      targetTime: String(task.targetTime ?? '').trim(),
      lessonNumber: task.lessonNumber ?? null,
      startTime: String(task.startTime ?? '').trim(),
      url: task.url ?? task.alternateLink ?? null,
      updatedAt: task.updatedAt ?? null,
      filesCount: Number.isFinite(Number(task.filesCount))
        ? Number(task.filesCount)
        : 0,
    };
  }

  return {
    source,
    externalId: task.externalId ?? null,
    subject: String(task.subject ?? '').trim(),
    title: normalizeDescription(task.normalizedDescription ?? task.description),
    topics: getTopics(task),
    description: normalizeDescription(task.normalizedDescription ?? task.description),
    assignedDate: String(task.assignedDate ?? ''),
    targetDate: String(task.targetDate ?? ''),
    targetTime: String(task.targetTime ?? '').trim(),
    lessonNumber: task.lessonNumber ?? null,
    startTime: String(task.startTime ?? '').trim(),
    url: task.url ?? task.homeworkUrl ?? null,
    updatedAt: task.updatedAt ?? null,
    filesCount: Number.isFinite(Number(task.filesCount))
      ? Number(task.filesCount)
      : 0,
  };
}

export function toSyncTask(task) {
  if (task?.snapshot && task?.fingerprint) {
    return task;
  }

  const snapshot = createHomeworkSnapshot(task);
  const source = snapshot.source;

  if (source === 'classroom') {
    const externalId = String(
      task.externalId ?? snapshot.externalId ?? '',
    ).trim();

    return {
      source,
      externalId,
      fingerprint: task.fingerprint ?? createClassroomFingerprint({ externalId }),
      targetAppointmentId: null,
      homeworkIds: Array.isArray(task.homeworkIds) ? task.homeworkIds : [],
      snapshot,
    };
  }

  const targetAppointmentId = task.targetAppointmentId ?? null;
  const homeworkIds = getHomeworkIds(task);
  const fingerprint = createHomeworkFingerprint({
    targetAppointmentId,
    normalizedDescription: snapshot.description,
  });

  return {
    source,
    externalId: snapshot.externalId,
    fingerprint,
    targetAppointmentId,
    homeworkIds,
    snapshot,
  };
}

function snapshotsChanged(previousSnapshot, currentSnapshot) {
  const previous = previousSnapshot ?? {};
  return JSON.stringify({
    source: String(previous.source ?? 'eschool'),
    title: normalizeDescription(previous.title ?? previous.description),
    description: normalizeDescription(previous.description),
    targetDate: String(previous.targetDate ?? ''),
    targetTime: String(previous.targetTime ?? ''),
    topics: Array.isArray(previous.topics)
      ? previous.topics.map(normalizeTopic)
      : [],
    url: String(previous.url ?? previous.homeworkUrl ?? ''),
    updatedAt: String(previous.updatedAt ?? ''),
    filesCount: Number(previous.filesCount ?? 0),
  }) !== JSON.stringify({
    source: String(currentSnapshot.source ?? 'eschool'),
    title: normalizeDescription(currentSnapshot.title ?? currentSnapshot.description),
    description: currentSnapshot.description,
    targetDate: currentSnapshot.targetDate,
    targetTime: String(currentSnapshot.targetTime ?? ''),
    topics: currentSnapshot.topics,
    url: String(currentSnapshot.url ?? currentSnapshot.homeworkUrl ?? ''),
    updatedAt: String(currentSnapshot.updatedAt ?? ''),
    filesCount: Number(currentSnapshot.filesCount ?? 0),
  });
}

function sameTargetAppointment(left, right) {
  return String(left?.source ?? left?.snapshot?.source ?? 'eschool') === 'eschool'
    && String(right?.source ?? right?.snapshot?.source ?? 'eschool') === 'eschool'
    && String(left?.targetAppointmentId ?? '') === String(right.targetAppointmentId ?? '')
    && String(left?.targetAppointmentId ?? '') !== '';
}

function findPreviousTask(stateTasks, currentTask, matchedKeys) {
  const exact = stateTasks[currentTask.fingerprint];
  if (exact && !matchedKeys.has(currentTask.fingerprint)) {
    return { key: currentTask.fingerprint, entry: exact };
  }

  const candidates = Object.entries(stateTasks).filter(
    ([key, entry]) => !matchedKeys.has(key) && sameTargetAppointment(entry, currentTask),
  );

  return candidates.length === 1
    ? { key: candidates[0][0], entry: candidates[0][1] }
    : null;
}

function createStateEntry(task, timestamp, lastSentAt = null) {
  return {
    source: task.source,
    externalId: task.externalId,
    fingerprint: task.fingerprint,
    targetAppointmentId: task.targetAppointmentId,
    homeworkIds: task.homeworkIds,
    snapshot: task.snapshot,
    lastSeenAt: timestamp,
    lastSentAt,
  };
}

function getTasksFromAppointments(result) {
  if (Array.isArray(result?.homeworkTasks)) {
    return result.homeworkTasks;
  }

  if (Array.isArray(result?.rawHomeworks)) {
    return deduplicateHomeworkRecords(result.rawHomeworks);
  }

  throw new SmokeTestError(
    'getAppointments() did not return homeworkTasks or rawHomeworks for sync',
    { code: 'SYNC_DATA_ERROR' },
  );
}

async function sendAndPersist({ sendMessage, message, stateStore, state, task, previous, timestamp, kind }) {
  try {
    await sendMessage(message);
  } catch (error) {
    throw new SmokeTestError(
      `Telegram delivery failed for ${kind} ${task.source ?? 'eschool'} homework: ${errorMessage(error)}`,
      { code: 'SYNC_SEND_ERROR', cause: error },
    );
  }

  if (previous && previous.key !== task.fingerprint) {
    delete state.tasks[previous.key];
  }
  state.tasks[task.fingerprint] = createStateEntry(task, timestamp, timestamp);
  await stateStore.save(state);
}

export async function syncHomeworks({
  auth,
  getAppointmentsFn = getAppointments,
  sendMessageFn = sendTelegramMessage,
  stateStore = createStateStore(),
  logger = console.log,
  now = new Date(),
} = {}) {
  if (!auth) {
    throw new SmokeTestError('syncHomeworks requires an auth client');
  }

  const timestamp = new Date(now).toISOString();
  const state = await stateStore.load();
  const appointmentsResult = await getAppointmentsFn(auth);
  const currentTasks = getTasksFromAppointments(appointmentsResult).map(toSyncTask);

  if (state.initializedAt === null) {
    state.initializedAt = timestamp;
    state.tasks = {};
    for (const task of currentTasks) {
      state.tasks[task.fingerprint] = createStateEntry(task, timestamp);
    }

    await stateStore.save(state);
    logger(`[sync] Baseline initialized with ${currentTasks.length} tasks`);
    return {
      baselineInitialized: true,
      newTasks: 0,
      updatedTasks: 0,
      sentTasks: 0,
      taskCount: currentTasks.length,
    };
  }

  const matchedKeys = new Set();
  let newTasks = 0;
  let updatedTasks = 0;
  let sentTasks = 0;
  let stateChanged = false;

  for (const task of currentTasks) {
    const previous = findPreviousTask(state.tasks, task, matchedKeys);
    if (!previous) {
      await sendAndPersist({
        sendMessage: sendMessageFn,
        message: formatHomeworkMessage(task.snapshot, 'new'),
        stateStore,
        state,
        task,
        timestamp,
        kind: 'new',
      });
      matchedKeys.add(task.fingerprint);
      newTasks += 1;
      sentTasks += 1;
      continue;
    }

    matchedKeys.add(previous.key);
    if (snapshotsChanged(previous.entry.snapshot, task.snapshot)) {
      await sendAndPersist({
        sendMessage: sendMessageFn,
        message: formatHomeworkMessage(task.snapshot, 'changed'),
        stateStore,
        state,
        task,
        previous,
        timestamp,
        kind: 'changed',
      });
      matchedKeys.add(task.fingerprint);
      updatedTasks += 1;
      sentTasks += 1;
      continue;
    }

    state.tasks[previous.key] = {
      ...previous.entry,
      fingerprint: previous.key,
      targetAppointmentId: task.targetAppointmentId,
      homeworkIds: task.homeworkIds,
      snapshot: task.snapshot,
      lastSeenAt: timestamp,
    };
    stateChanged = true;
  }

  if (stateChanged) {
    await stateStore.save(state);
  }

  logger(`[sync] New: ${newTasks}, changed: ${updatedTasks}, sent: ${sentTasks}`);
  return {
    baselineInitialized: false,
    newTasks,
    updatedTasks,
    sentTasks,
    taskCount: currentTasks.length,
  };
}
