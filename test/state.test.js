import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createEmptyState, loadState, saveState } from '../src/state.js';

async function withTempDirectory(callback) {
  const directory = await mkdtemp(join(tmpdir(), 'eschool-state-test-'));
  try {
    return await callback(directory);
  } finally {
    await import('node:fs/promises').then(({ rm }) => rm(directory, { recursive: true, force: true }));
  }
}

test('state store creates directories and writes atomically', async () => {
  await withTempDirectory(async (directory) => {
    const filePath = join(directory, 'nested', 'state.json');
    const state = createEmptyState();
    state.initializedAt = '2026-09-09T12:00:00.000Z';

    await saveState(state, filePath);

    assert.deepEqual(await loadState(filePath), state);
    assert.deepEqual(await readdir(join(directory, 'nested')), ['state.json']);
  });
});

test('corrupted state is reported and not overwritten', async () => {
  await withTempDirectory(async (directory) => {
    const filePath = join(directory, 'state.json');
    const corrupted = '{"version": 1, ';
    await writeFile(filePath, corrupted, 'utf8');

    await assert.rejects(
      () => loadState(filePath),
      /is not valid JSON.*It was not overwritten/,
    );
    assert.equal(await readFile(filePath, 'utf8'), corrupted);
  });
});
