import test from 'node:test';
import assert from 'node:assert/strict';

import { formatHomeworkList, formatHomeworkMessage } from '../src/messages.js';
import { MAX_TELEGRAM_MESSAGE_LENGTH } from '../src/telegram.js';

test('formatHomeworkMessage builds the requested Ukrainian notification', () => {
  const message = formatHomeworkMessage({
    subject: 'Алгебра і початок аналізу',
    topics: ['Числові множини', 'Множина дійсних чисел'],
    description: 'Вивчити конспект, №11',
    targetDate: '2026-09-11',
    lessonNumber: 4,
    startTime: '11:25',
    filesCount: 2,
  });

  assert.match(message, /📚 Нове домашнє завдання/);
  assert.match(message, /📖 Теми:\n• Числові множини\n• Множина дійсних чисел/);
  assert.match(message, /📅 На: 11\.09\.2026/);
  assert.match(message, /🕐 Урок 4, 11:25/);
  assert.match(message, /📎 Прикріплено файлів: 2/);
});

test('formatHomeworkMessage omits empty sections', () => {
  const message = formatHomeworkMessage({
    subject: 'Математика',
    description: '',
    topics: [],
    targetDate: '',
    lessonNumber: null,
    startTime: '',
    filesCount: 0,
  });

  assert.equal(message, '📚 Нове домашнє завдання\n\nМатематика');
  assert.doesNotMatch(message, /📝|📖|📅|🕐|📎/);
});

test('formatHomeworkList renders sorted homework titles as diary links without task buttons', () => {
  const view = formatHomeworkList([
    {
      id: 2,
      homeworkIds: [101172],
      snapshot: {
        subject: 'Хімія',
        description: 'Прочитати § 2 <та> повторити & формули',
        targetDate: '2026-09-10',
      },
    },
    {
      id: 1,
      homeworkIds: [101166],
      snapshot: {
        subject: 'Алгебра і початок аналізу',
        description: 'Вивчити конспект, №11',
        targetDate: '2026-09-09',
      },
    },
  ]);

  assert.equal(view.parseMode, 'HTML');
  assert.equal(view.keyboard.inline_keyboard.length, 2);
  assert.equal(view.keyboard.inline_keyboard[0].length, 2);
  assert.equal(
    view.keyboard.inline_keyboard[0][0].text,
    '✅ Алгебра і початок аналізу · 09.09 · Вивчити конспект, №11',
  );
  assert.equal(view.keyboard.inline_keyboard[0][0].callback_data, 'complete:list:1:0');
  assert.ok(view.text.indexOf('09.09.2026') < view.text.indexOf('10.09.2026'));
  assert.match(
    view.text,
    /<a href="https:\/\/diary\.eschool-ua\.com\/homework\/101166">Вивчити конспект, №11 \(Єдина школа\)<\/a>/,
  );
  assert.match(
    view.text,
    /Прочитати § 2 &lt;та&gt; повторити &amp; формули \(Єдина школа\)/,
  );
});

test('formatHomeworkList limits the page to six tasks in two columns and adds navigation', () => {
  const tasks = Array.from({ length: 7 }, (_, index) => ({
    id: index + 1,
    homeworkIds: [101200 + index],
    snapshot: {
      subject: `Предмет ${index + 1}`,
      description: `Завдання ${index + 1}`,
      targetDate: '2026-09-11',
    },
  }));

  const firstPage = formatHomeworkList(tasks);
  const firstRows = firstPage.keyboard.inline_keyboard;
  assert.equal(firstPage.pageCount, 2);
  assert.equal(firstRows.slice(0, 3).length, 3);
  assert.deepEqual(firstRows.slice(0, 3).map((row) => row.length), [2, 2, 2]);
  assert.deepEqual(firstRows[3], [
    { text: '1/2', callback_data: 'noop' },
    { text: '▶️', callback_data: 'current:page:1' },
  ]);

  const secondPage = formatHomeworkList(tasks, { page: 1 });
  assert.equal(secondPage.page, 1);
  assert.equal(secondPage.keyboard.inline_keyboard[0].length, 1);
  assert.deepEqual(secondPage.keyboard.inline_keyboard[1], [
    { text: '◀️', callback_data: 'current:page:0' },
    { text: '2/2', callback_data: 'noop' },
  ]);
});

test('formatHomeworkList renders Classroom source labels and links', () => {
  const view = formatHomeworkList([{
    id: 10,
    source: 'classroom',
    externalId: 'course-1:work-1',
    snapshot: {
      source: 'classroom',
      subject: 'Алгебра',
      title: 'Рціональні вирази №91-100',
      description: 'Розв’язати вправи №91-100',
      targetDate: '2026-09-11',
      url: 'https://classroom.google.com/c/course-1/a/work-1/details',
    },
  }]);

  assert.match(
    view.text,
    /<a href="https:\/\/classroom\.google\.com\/c\/Y291cnNlLTFa\/a\/d29yay0x\/details">Рціональні вирази №91-100 \(Classroom\)<\/a>/,
  );
  assert.equal(
    view.keyboard.inline_keyboard[0][0].text,
    '✅ Алгебра · 11.09 · Розв’язати вправи №91-100',
  );
});

test('Classroom links include the selected Google account order without changing task data', () => {
  const task = {
    id: 14,
    source: 'classroom',
    snapshot: {
      source: 'classroom',
      title: 'Завдання з акаунтом',
      description: 'Відкрити з потрібним акаунтом',
      targetDate: '2026-09-11',
      url: 'https://classroom.google.com/c/course-1/a/work-14/details',
    },
  };

  const view = formatHomeworkList([task], { classroomAuthuserIndex: 2 });
  assert.match(
    view.text,
    /<a href="https:\/\/classroom\.google\.com\/c\/Y291cnNlLTFa\/a\/d29yay0xNFpa\/details\?authuser=2">Завдання з акаунтом \(Classroom\)<\/a>/,
  );
  assert.match(
    formatHomeworkMessage(task, 'new', { classroomAuthuserIndex: 2 }),
    /<a href="https:\/\/classroom\.google\.com\/c\/Y291cnNlLTFa\/a\/d29yay0xNFpa\/details\?authuser=2">Завдання з акаунтом \(Classroom\)<\/a>/,
  );
  assert.equal(task.snapshot.url, 'https://classroom.google.com/c/course-1/a/work-14/details');
});

test('formatHomeworkList truncates long assignment text in links and buttons', () => {
  const longDescription = `${'А'.repeat(49)}TAIL ЗАВДАННЯ НЕ ПОКАЗУВАТИ`;
  const expectedDescription = `${'А'.repeat(49)}…`;
  const view = formatHomeworkList([{
    id: 11,
    source: 'classroom',
    snapshot: {
      source: 'classroom',
      description: longDescription,
      targetDate: '2026-09-11',
      url: 'https://classroom.google.com/c/course-1/a/work-11/details',
    },
  }]);

  assert.match(view.text, new RegExp(`${expectedDescription} \\(Classroom\\)`));
  assert.doesNotMatch(view.text, /TAIL ЗАВДАННЯ НЕ ПОКАЗУВАТИ/);
  assert.equal(view.keyboard.inline_keyboard[0][0].text, `✅ 11.09 · ${expectedDescription}`);
  assert.doesNotMatch(view.keyboard.inline_keyboard[0][0].text, /TAIL/);
});

test('formatHomeworkList ignores unsafe explicit links and uses the diary fallback', () => {
  const view = formatHomeworkList([{
    id: 12,
    homeworkIds: [101999],
    snapshot: {
      subject: 'Математика',
      description: 'Небезпечне посилання',
      targetDate: '2026-09-11',
      url: 'javascript:alert(1)',
    },
  }]);

  assert.doesNotMatch(view.text, /javascript:/i);
  assert.match(view.text, /https:\/\/diary\.eschool-ua\.com\/homework\/101999/);
});

test('Classroom homework without a due date is shown last with an explicit label', () => {
  const view = formatHomeworkList([
    {
      id: 1,
      source: 'classroom',
      snapshot: {
        source: 'classroom',
        subject: 'Фізика',
        title: 'Прочитати тему',
        description: 'Прочитати тему',
        targetDate: null,
      },
    },
  ]);

  assert.match(view.text, /📅 Дата здачі не вказана · 1/);
  assert.match(view.text, /Прочитати тему \(Classroom\)/);
  assert.match(
    formatHomeworkMessage({
      source: 'classroom',
      subject: 'Фізика',
      title: 'Прочитати тему',
      description: 'Прочитати тему',
      targetDate: null,
    }),
    /📅 Дата здачі не вказана/
  );
});

test('long Classroom notifications are shortened without breaking HTML and keep a safe link', () => {
  const longText = '&<>'.repeat(1800) + ' 😀';
  const message = formatHomeworkMessage({
    source: 'classroom',
    snapshot: {
      source: 'classroom',
      subject: longText,
      title: longText,
      description: longText,
       topics: [longText, longText],
       targetDate: '2026-09-11',
       lessonNumber: '<1>',
       startTime: '10:00 & <x>',
       url: 'https://classroom.google.com/c/course-1/a/work-1/details',
    },
  });

  assert.ok(message.length <= MAX_TELEGRAM_MESSAGE_LENGTH);
  assert.match(message, /скорочено/i);
  assert.match(
    message,
    /<a href="https:\/\/classroom\.google\.com\/c\/Y291cnNlLTFa\/a\/d29yay0x\/details">Відкрити повне завдання<\/a>/,
  );
  assert.match(message, /Урок &lt;1&gt;/);
  assert.match(message, /10:00 &amp; &lt;x&gt;/);
  assert.equal((message.match(/<a\b/g) ?? []).length, (message.match(/<\/a>/g) ?? []).length);
  assert.doesNotMatch(message, /<(?:a|\/a)\b[^>]*$/);
  assert.doesNotMatch(message, /&(?:amp|lt|gt|quot)?$/);
});

test('Classroom list repairs a previously stored raw-id assignment link', () => {
  const view = formatHomeworkList([{
    id: 13,
    source: 'classroom',
    snapshot: {
      source: 'classroom',
      title: 'Діагностичне завдання',
      description: 'Перевірити посилання',
      targetDate: '2026-09-11',
      url: 'https://classroom.google.com/c/876750472074/a/878258754750/details',
    },
  }]);

  assert.match(
    view.text,
    /<a href="https:\/\/classroom\.google\.com\/c\/ODc2NzUwNDcyMDc0\/a\/ODc4MjU4NzU0NzUw\/details">Діагностичне завдання \(Classroom\)<\/a>/,
  );
});

test('long URLs are omitted when they cannot fit instead of corrupting HTML', () => {
  const message = formatHomeworkMessage({
    source: 'classroom',
    snapshot: {
      source: 'classroom',
      title: 'Завдання',
      description: 'Опис',
      url: `https://classroom.google.com/c/course-1/a/work-1/details?q=${'x'.repeat(5000)}`,
    },
  });

  assert.ok(message.length <= MAX_TELEGRAM_MESSAGE_LENGTH);
  assert.match(message, /скорочено/i);
  assert.doesNotMatch(message, /<a\b/);
  assert.doesNotMatch(message, /<\/a>/);
});
