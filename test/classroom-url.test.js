import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addClassroomAuthuserParam,
  parseClassroomAuthuserIndex,
} from '../src/classroom-url.js';

test('Classroom authuser index accepts only integers from zero through ten', () => {
  assert.equal(parseClassroomAuthuserIndex('0'), 0);
  assert.equal(parseClassroomAuthuserIndex('10'), 10);
  assert.equal(parseClassroomAuthuserIndex('01'), 1);
  assert.equal(parseClassroomAuthuserIndex('11'), null);
  assert.equal(parseClassroomAuthuserIndex('-1'), null);
  assert.equal(parseClassroomAuthuserIndex('1.5'), null);
  assert.equal(parseClassroomAuthuserIndex(''), null);
});

test('Classroom authuser parameter repairs the route and replaces an old value', () => {
  assert.equal(
    addClassroomAuthuserParam(
      'https://classroom.google.com/c/876750472074/a/878258754750/details?authuser=9&tab=details',
      2,
    ),
    'https://classroom.google.com/c/ODc2NzUwNDcyMDc0/a/ODc4MjU4NzU0NzUw/details?authuser=2&tab=details',
  );
});

test('Classroom authuser parameter leaves invalid indexes and non-Classroom links unchanged', () => {
  const classroomUrl = 'https://classroom.google.com/c/course/a/work/details';
  const externalUrl = 'https://docs.google.com/document/d/example?tab=1';

  assert.equal(
    addClassroomAuthuserParam(classroomUrl, 11),
    'https://classroom.google.com/c/Y291cnNl/a/d29ya1pa/details',
  );
  assert.equal(addClassroomAuthuserParam(externalUrl, 2), externalUrl);
});
