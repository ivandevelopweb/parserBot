import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { SmokeTestError, errorMessage } from './utils.js';

export const STATE_VERSION = 1;
export const DEFAULT_STATE_PATH = resolve(process.cwd(), 'data', 'state.json');

export class StateFileError extends SmokeTestError {
  constructor(message, options = {}) {
    super(message, { code: 'STATE_FILE_ERROR', ...options });
    this.name = 'StateFileError';
  }
}

export function createEmptyState() {
  return {
    version: STATE_VERSION,
    initializedAt: null,
    tasks: {},
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalidState(filePath, reason, cause) {
  return new StateFileError(
    `State file ${filePath} is invalid: ${reason}. It was not overwritten.`,
    { cause },
  );
}

export function validateState(state, filePath = DEFAULT_STATE_PATH) {
  if (!isPlainObject(state)) {
    throw invalidState(filePath, 'root value must be an object');
  }

  if (state.version !== STATE_VERSION) {
    throw invalidState(
      filePath,
      `unsupported version ${JSON.stringify(state.version)} (expected ${STATE_VERSION})`,
    );
  }

  if (state.initializedAt !== null && typeof state.initializedAt !== 'string') {
    throw invalidState(filePath, 'initializedAt must be a string or null');
  }

  if (!isPlainObject(state.tasks)) {
    throw invalidState(filePath, 'tasks must be an object');
  }

  for (const [fingerprint, task] of Object.entries(state.tasks)) {
    if (!isPlainObject(task)) {
      throw invalidState(filePath, `task ${fingerprint} must be an object`);
    }

    if (task.fingerprint !== fingerprint) {
      throw invalidState(filePath, `task ${fingerprint} has a mismatched fingerprint`);
    }

    if (!isPlainObject(task.snapshot)) {
      throw invalidState(filePath, `task ${fingerprint} is missing its snapshot`);
    }

    if (task.homeworkIds !== undefined && !Array.isArray(task.homeworkIds)) {
      throw invalidState(filePath, `task ${fingerprint} homeworkIds must be an array`);
    }

    for (const field of ['lastSeenAt', 'lastSentAt']) {
      if (task[field] !== undefined && task[field] !== null && typeof task[field] !== 'string') {
        throw invalidState(filePath, `task ${fingerprint} ${field} must be a string or null`);
      }
    }
  }

  return state;
}

export async function loadState(filePath = DEFAULT_STATE_PATH) {
  let content;

  try {
    content = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return createEmptyState();
    }

    throw new StateFileError(
      `Could not read state file ${filePath}: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  let state;
  try {
    state = JSON.parse(content);
  } catch (error) {
    throw invalidState(filePath, 'it is not valid JSON', error);
  }

  return validateState(state, filePath);
}

export async function saveState(state, filePath = DEFAULT_STATE_PATH) {
  validateState(state, filePath);
  await mkdir(dirname(filePath), { recursive: true });

  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    const content = `${JSON.stringify(state, null, 2)}\n`;
    await writeFile(temporaryPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporaryPath, filePath);
  } catch (error) {
    throw new StateFileError(
      `Could not atomically write state file ${filePath}: ${errorMessage(error)}`,
      { cause: error },
    );
  } finally {
    try {
      await unlink(temporaryPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        // The original write/rename error is more useful to the caller.
      }
    }
  }
}

export function createStateStore({ filePath = DEFAULT_STATE_PATH } = {}) {
  return {
    filePath,
    load: () => loadState(filePath),
    save: (state) => saveState(state, filePath),
  };
}
