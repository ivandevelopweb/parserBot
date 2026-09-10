import test from 'node:test';
import assert from 'node:assert/strict';

import { createEmptyState } from '../src/state.js';
import { syncHomeworks } from '../src/sync.js';

const FIXED_NOW = new Date('2026-09-09T12:00:00.000Z');

function createMemoryStore(initialState = createEmptyState()) {
  let state = structuredClone(initialState);
  let saves = 0;

  return {
    async load() {
      return state;
    },
    async save(nextState) {
      state = structuredClone(nextState);
      saves += 1;
    },
    get state() {
      return state;
    },
    get saves() {
      return saves;
    },
  };
}

function homework(overrides = {}) {
  return {
    targetAppointmentId: 185141,
    homeworkId: 101171,
    subject: 'Алгебра і початок аналізу',
    topic: 'Числові множини',
    description: 'Вивчити конспект, №11',
    assignedDate: '2026-09-09',
    targetDate: '2026-09-11',
    lessonNumber: 4,
    startTime: '11:25',
    filesCount: 0,
    ...overrides,
  };
}

function appointmentsResult(tasks) {
  return { homeworkTasks: tasks };
}

function syncOptions({ stateStore, getAppointmentsFn, sendMessageFn }) {
  return {
    auth: {},
    stateStore,
    getAppointmentsFn,
    sendMessageFn,
    logger: () => {},
    now: FIXED_NOW,
  };
}

test('first sync creates baseline and sends nothing', async () => {
  const stateStore = createMemoryStore();
  const messages = [];

  const result = await syncHomeworks(syncOptions({
    stateStore,
    getAppointmentsFn: async () => appointmentsResult([homework()]),
    sendMessageFn: async (message) => messages.push(message),
  }));

  assert.equal(result.baselineInitialized, true);
  assert.equal(result.taskCount, 1);
  assert.equal(messages.length, 0);
  assert.equal(Object.keys(stateStore.state.tasks).length, 1);
  assert.equal(stateStore.state.tasks[Object.keys(stateStore.state.tasks)[0]].lastSentAt, null);
});

test('new homework sends one notification and persists after success', async () => {
  const state = createEmptyState();
  state.initializedAt = '2026-09-08T12:00:00.000Z';
  const stateStore = createMemoryStore(state);
  const messages = [];

  const result = await syncHomeworks(syncOptions({
    stateStore,
    getAppointmentsFn: async () => appointmentsResult([homework()]),
    sendMessageFn: async (message) => messages.push(message),
  }));

  assert.equal(result.newTasks, 1);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /📚 Нове домашнє завдання/);
  assert.equal(stateStore.saves, 1);
  assert.equal(
    stateStore.state.tasks[Object.keys(stateStore.state.tasks)[0]].lastSentAt,
    '2026-09-09T12:00:00.000Z',
  );
});

test('repeated sync does not send a duplicate', async () => {
  const stateStore = createMemoryStore();
  const messages = [];
  let currentTasks = [homework()];
  const options = {
    stateStore,
    getAppointmentsFn: async () => appointmentsResult(currentTasks),
    sendMessageFn: async (message) => messages.push(message),
  };

  await syncHomeworks(syncOptions(options));
  currentTasks = [
    homework(),
    homework({
      targetAppointmentId: 185142,
      homeworkId: 101172,
      topic: 'Нова тема',
      description: 'Нове завдання',
    }),
  ];
  await syncHomeworks(syncOptions(options));
  await syncHomeworks(syncOptions(options));

  assert.equal(messages.length, 1);
});

test('description change sends an update notification and replaces the fingerprint', async () => {
  const stateStore = createMemoryStore();
  const messages = [];
  let current = homework();

  await syncHomeworks(syncOptions({
    stateStore,
    getAppointmentsFn: async () => appointmentsResult([current]),
    sendMessageFn: async (message) => messages.push(message),
  }));

  current = homework({ description: 'Вивчити оновлений конспект, №12' });
  const result = await syncHomeworks(syncOptions({
    stateStore,
    getAppointmentsFn: async () => appointmentsResult([current]),
    sendMessageFn: async (message) => messages.push(message),
  }));

  assert.equal(result.updatedTasks, 1);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /✏️ Домашнє завдання змінено/);
  assert.match(messages[0], /оновлений конспект/);
  assert.equal(Object.keys(stateStore.state.tasks).length, 1);
  assert.match(Object.keys(stateStore.state.tasks)[0], /оновлений конспект/);
});

test('Telegram failure does not mark a new homework as sent or expose its fingerprint', async () => {
  const state = createEmptyState();
  state.initializedAt = '2026-09-08T12:00:00.000Z';
  const stateStore = createMemoryStore(state);

  let error;
  try {
    await syncHomeworks(syncOptions({
      stateStore,
      getAppointmentsFn: async () => appointmentsResult([homework()]),
      sendMessageFn: async () => {
        throw new Error('network down');
      },
    }));
  } catch (caughtError) {
    error = caughtError;
  }

  assert.ok(error);
  assert.match(error.message, /Telegram delivery failed/);
  assert.doesNotMatch(error.message, /Вивчити конспект/);
  assert.equal(Object.keys(stateStore.state.tasks).length, 0);
  assert.equal(stateStore.saves, 0);
});

test('sync keeps deduplication: duplicate API homework records become one baseline task', async () => {
  const stateStore = createMemoryStore();
  const duplicateA = homework({ topic: 'Тема A', homeworkId: 1 });
  const duplicateB = homework({ topic: 'Тема B', homeworkId: 2, description: '  Вивчити конспект, №11  ' });
  const rawHomeworks = [duplicateA, duplicateB];

  const result = await syncHomeworks(syncOptions({
    stateStore,
    getAppointmentsFn: async () => ({ rawHomeworks }),
    sendMessageFn: async () => {
      throw new Error('baseline must not send');
    },
  }));

  assert.equal(result.baselineInitialized, true);
  assert.equal(result.taskCount, 1);
  const task = stateStore.state.tasks[Object.keys(stateStore.state.tasks)[0]];
  assert.deepEqual(task.homeworkIds, [1, 2]);
  assert.deepEqual(task.snapshot.topics, ['Тема A', 'Тема B']);
});
