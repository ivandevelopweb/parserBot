import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatDateForDisplay,
  maskToken,
  normalizeDescription,
} from '../src/utils.js';

test('maskToken keeps only the permitted token fragments', () => {
  assert.equal(maskToken('12345678abcdefghijkl123456'), '12345678…123456');
  assert.equal(maskToken('short-token'), '[masked]');
  assert.equal(maskToken(null), 'absent');
});

test('normalizeDescription trims, flattens lines, and collapses whitespace', () => {
  assert.equal(
    normalizeDescription('  one\n  two\t\tthree  '),
    'one two three',
  );
});

test('formatDateForDisplay formats API dates without timezone shifts', () => {
  assert.equal(formatDateForDisplay('2026-09-11'), '11.09.2026');
});
