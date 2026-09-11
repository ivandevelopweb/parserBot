import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAppointmentUrl,
  buildHomeworkWebUrl,
  deduplicateHomeworks,
  getAppointments,
  getCurrentAndNextWeekRange,
  getCurrentWeekRange,
} from '../src/eschool.js';

test('buildHomeworkWebUrl points to the diary homework page', () => {
  assert.equal(
    buildHomeworkWebUrl(101166),
    'https://diary.eschool-ua.com/homework/101166',
  );
  assert.equal(buildHomeworkWebUrl(null), null);
});

test('getCurrentWeekRange uses the Kyiv calendar date', () => {
  assert.deepEqual(
    getCurrentWeekRange(new Date('2026-09-09T12:00:00.000Z')),
    { start: '2026-09-07', end: '2026-09-13' },
  );

  // 22:30 UTC is already Monday in Kyiv during September.
  assert.deepEqual(
    getCurrentWeekRange(new Date('2026-09-06T22:30:00.000Z')),
    { start: '2026-09-07', end: '2026-09-13' },
  );
});

test('getCurrentAndNextWeekRange covers two Kyiv calendar weeks', () => {
  assert.deepEqual(
    getCurrentAndNextWeekRange(new Date('2026-09-09T12:00:00.000Z')),
    { start: '2026-09-07', end: '2026-09-20' },
  );
});

test('buildAppointmentUrl contains the required API query parameters', () => {
  const url = buildAppointmentUrl({ start: '2026-09-07', end: '2026-09-13' });
  assert.equal(url.searchParams.get('start'), '2026-09-07');
  assert.equal(url.searchParams.get('end'), '2026-09-13');
  assert.equal(
    url.searchParams.get('embed'),
    'Topic,Rate,TargetHomework,Teacher,Meeting',
  );
  assert.equal(url.searchParams.get('fileRole'), 'schoolboy');
});

test('deduplicateHomeworks groups by target appointment and normalized description', () => {
  const appointments = [
    {
      Subject: 'Алгебра',
      Date: '2026-09-09',
      LessonNumber: 4,
      StartTime: '11:25',
      Embed: {
        TargetHomeworks: [
          {
            Id: 101,
            TargetAppointmentId: 500,
            AppointmentDate: '2026-09-09',
            TargetAppointmentDate: '2026-09-11',
            Topic: ' Числові множини ',
            Description: 'Вивчити\nконспект  №11',
            FilesCount: 0,
          },
          {
            Id: 102,
            TargetAppointmentId: 500,
            AppointmentDate: '2026-09-09',
            TargetAppointmentDate: '2026-09-11',
            Topic: 'Множина дійсних чисел',
            Description: '  Вивчити конспект №11  ',
            FilesCount: 1,
          },
          {
            Id: 103,
            TargetAppointmentId: 501,
            AppointmentDate: '2026-09-09',
            TargetAppointmentDate: '2026-09-09',
            Topic: 'Інша тема',
            Description: 'Інше завдання',
            FilesCount: 0,
          },
        ],
      },
    },
  ];

  const result = deduplicateHomeworks(appointments);
  assert.equal(result.length, 2);
  assert.deepEqual(result[0].homeworkIds, [101, 102]);
  assert.deepEqual(result[0].topics, [
    'Числові множини',
    'Множина дійсних чисел',
  ]);
  assert.equal(result[0].filesCount, 1);
  assert.equal(result[0].description, 'Вивчити\nконспект  №11');
  assert.equal(result[1].homeworkId, 103);
  assert.equal(result[1].topic, 'Інша тема');
});

test('getAppointments requests the current and next week by default', async () => {
  const appointmentUrls = [];
  const auth = {
    async fetch(url) {
      const textUrl = String(url);
      if (textUrl.endsWith('/api/v1/seplogin')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }

      appointmentUrls.push(new URL(textUrl));
      return new Response(JSON.stringify({ Appointment: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
    async getCookieValue(name) {
      return name === 'application_token' ? 'already-bound' : null;
    },
  };

  const result = await getAppointments(auth, {
    now: new Date('2026-09-09T12:00:00.000Z'),
    logger: () => {},
  });

  assert.equal(appointmentUrls.length, 1);
  assert.equal(appointmentUrls[0].searchParams.get('start'), '2026-09-07');
  assert.equal(appointmentUrls[0].searchParams.get('end'), '2026-09-20');
  assert.deepEqual(result, {
    start: '2026-09-07',
    end: '2026-09-20',
    appointments: [],
    rawHomeworks: [],
    homeworkTasks: [],
    homeworks: [],
  });
});

test('getAppointments refreshes once and retries an expired session', async () => {
  const appointmentCalls = [];
  const diarySessionCalls = [];
  let refreshCalls = 0;
  const auth = {
    async fetch(url, options = {}) {
      const textUrl = String(url);
      if (textUrl.endsWith('/api/v1/seplogin')) {
        diarySessionCalls.push({ url: textUrl, method: options.method ?? 'GET' });
        if (options.method === 'POST') {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }

        return new Response(
          JSON.stringify({ Items: [{ school_id: 8276, user_id: 1, role: 'schoolboy' }] }),
          { status: 200 },
        );
      }

      appointmentCalls.push(textUrl);
      if (appointmentCalls.length === 1) {
        return new Response('session expired', { status: 401 });
      }

      return new Response(JSON.stringify({ Appointment: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
    async refreshSession() {
      refreshCalls += 1;
    },
    async getCookieValue(name) {
      return name === 'application_token' ? 'already-bound' : null;
    },
  };

  const result = await getAppointments(auth, {
    start: '2026-09-07',
    end: '2026-09-13',
    logger: () => {},
  });

  assert.equal(refreshCalls, 1);
  assert.equal(appointmentCalls.length, 2);
  assert.deepEqual(diarySessionCalls.map(({ method }) => method), ['GET', 'POST']);
  assert.deepEqual(result.homeworks, []);
});
