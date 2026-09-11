import {
  HttpError,
  SmokeTestError,
  errorMessage,
  formatDateForDisplay,
  normalizeDescription,
  normalizeTopic,
  uniqueStable,
} from './utils.js';

export const SCHOOL_ID = 8276;
export const SCHOOLBOY_ID = 1574557;
export const DIARY_ORIGIN = 'https://diary.eschool-ua.com';
export const APPOINTMENT_URL = `${DIARY_ORIGIN}/api/v1/${SCHOOL_ID}/SchoolBoy/${SCHOOLBOY_ID}/Appointment`;
export const DIARY_LOGIN_URL = `${DIARY_ORIGIN}/api/v1/seplogin`;
export const APPOINTMENT_EMBED = 'Topic,Rate,TargetHomework,Teacher,Meeting';
export const TIME_ZONE = 'Europe/Kyiv';

function getDatePartsInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const values = Object.fromEntries(
    parts
      .filter(({ type }) => type !== 'literal')
      .map(({ type, value }) => [type, value]),
  );

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
  };
}

function formatUtcDate(date) {
  return date.toISOString().slice(0, 10);
}

function getCurrentWeekStartDate(now, timeZone) {
  const { year, month, day } = getDatePartsInTimeZone(now, timeZone);
  const localDate = new Date(Date.UTC(year, month - 1, day));
  const dayOfWeek = localDate.getUTCDay();
  const daysFromMonday = (dayOfWeek + 6) % 7;

  const startDate = new Date(localDate);
  startDate.setUTCDate(startDate.getUTCDate() - daysFromMonday);

  return startDate;
}

function buildWeekRange(startDate, numberOfDays) {
  const endDate = new Date(startDate);
  endDate.setUTCDate(endDate.getUTCDate() + numberOfDays - 1);

  return {
    start: formatUtcDate(startDate),
    end: formatUtcDate(endDate),
  };
}

export function getCurrentWeekRange(now = new Date(), timeZone = TIME_ZONE) {
  return buildWeekRange(getCurrentWeekStartDate(now, timeZone), 7);
}

export function getCurrentAndNextWeekRange(now = new Date(), timeZone = TIME_ZONE) {
  return buildWeekRange(getCurrentWeekStartDate(now, timeZone), 14);
}

export function buildAppointmentUrl({ start, end }) {
  const url = new URL(APPOINTMENT_URL);
  url.searchParams.set('start', start);
  url.searchParams.set('end', end);
  url.searchParams.set('embed', APPOINTMENT_EMBED);
  url.searchParams.set('fileRole', 'schoolboy');
  return url;
}

export function buildHomeworkWebUrl(homeworkId) {
  const normalizedId = String(homeworkId ?? '').trim();
  if (!normalizedId) {
    return null;
  }

  return new URL(`/homework/${encodeURIComponent(normalizedId)}`, DIARY_ORIGIN).toString();
}

export async function initializeDiarySession(auth, { force = false, signal } = {}) {
  if (!auth || typeof auth.fetch !== 'function') {
    throw new SmokeTestError('initializeDiarySession requires an auth client');
  }

  if (!force && typeof auth.getCookieValue === 'function') {
    const applicationToken = await auth.getCookieValue(
      'application_token',
      `${DIARY_ORIGIN}/`,
    );
    if (applicationToken) {
      return { reused: true };
    }
  }

  const probeResponse = await auth.fetch(DIARY_LOGIN_URL, {
    method: 'GET',
    headers: { accept: 'application/json' },
    signal,
  });
  const probeText = await probeResponse.text();

  if (!probeResponse.ok) {
    throw new HttpError(
      `Diary session probe failed with HTTP ${probeResponse.status} ${probeResponse.statusText}`,
      {
        url: DIARY_LOGIN_URL,
        status: probeResponse.status,
        statusText: probeResponse.statusText,
        sessionExpired: probeResponse.status === 401 || probeResponse.status === 403,
      },
    );
  }

  let probePayload;
  try {
    probePayload = JSON.parse(probeText);
  } catch (error) {
    throw new SmokeTestError(
      `Diary session probe returned invalid JSON: ${errorMessage(error)}`,
      { code: 'DIARY_SESSION_ERROR', cause: error },
    );
  }

  const bindings = Array.isArray(probePayload?.Items) ? probePayload.Items : [];
  const binding = bindings.find((item) => Number(item?.school_id) === SCHOOL_ID);
  if (!binding) {
    throw new SmokeTestError(
      `Diary session probe did not return a binding for school ${SCHOOL_ID}`,
      { code: 'DIARY_SESSION_ERROR' },
    );
  }

  const bindResponse = await auth.fetch(DIARY_LOGIN_URL, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(binding),
    signal,
  });
  const bindText = await bindResponse.text();

  if (!bindResponse.ok) {
    throw new HttpError(
      `Diary session bind failed with HTTP ${bindResponse.status} ${bindResponse.statusText}`,
      {
        url: DIARY_LOGIN_URL,
        status: bindResponse.status,
        statusText: bindResponse.statusText,
        sessionExpired: bindResponse.status === 401 || bindResponse.status === 403,
      },
    );
  }

  try {
    JSON.parse(bindText);
  } catch (error) {
    throw new SmokeTestError(
      `Diary session bind returned invalid JSON: ${errorMessage(error)}`,
      { code: 'DIARY_SESSION_ERROR', cause: error },
    );
  }

  if (typeof auth.getCookieValue !== 'function') {
    throw new SmokeTestError(
      'Auth client cannot verify the diary application_token cookie',
      { code: 'DIARY_SESSION_ERROR' },
    );
  }

  const applicationToken = await auth.getCookieValue(
    'application_token',
    `${DIARY_ORIGIN}/`,
  );
  if (!applicationToken) {
    throw new SmokeTestError(
      'Diary session bind completed without an application_token cookie',
      { code: 'DIARY_SESSION_ERROR' },
    );
  }

  return { reused: false };
}

function extractAppointmentArray(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  const candidates = [
    payload?.Items,
    payload?.Appointment,
    payload?.Appointments,
    payload?.appointments,
    payload?.items,
    payload?.value,
    payload?.data,
  ];

  const appointments = candidates.find(Array.isArray);
  if (appointments) {
    return appointments;
  }

  throw new SmokeTestError(
    'Appointment API returned JSON without an appointment array',
    { code: 'APPOINTMENT_RESPONSE_ERROR' },
  );
}

function toFilesCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

export function collectHomeworkRecords(appointments) {
  const records = [];

  for (const appointment of appointments) {
    const targetHomeworks = appointment?.Embed?.TargetHomeworks;
    if (!Array.isArray(targetHomeworks)) {
      continue;
    }

    for (const homework of targetHomeworks) {
      if (!homework || typeof homework !== 'object') {
        continue;
      }

      records.push({
        homeworkId: homework.Id,
        targetAppointmentId: homework.TargetAppointmentId,
        subject: String(appointment.Subject ?? '').trim(),
        topic: normalizeTopic(homework.Topic),
        description: String(homework.Description ?? '').trim(),
        assignedDate: homework.AppointmentDate ?? appointment.Date ?? '',
        targetDate: homework.TargetAppointmentDate ?? appointment.Date ?? '',
        lessonNumber: appointment.LessonNumber ?? null,
        startTime: appointment.StartTime ?? '',
        filesCount: toFilesCount(homework.FilesCount),
      });
    }
  }

  return records;
}

export function deduplicateHomeworkRecords(appointmentsOrRecords) {
  const records = appointmentsOrRecords.some(
    (item) => Object.prototype.hasOwnProperty.call(item ?? {}, 'Embed'),
  )
    ? collectHomeworkRecords(appointmentsOrRecords)
    : appointmentsOrRecords;

  const groups = new Map();

  for (const record of records) {
    const targetAppointmentId = String(record.targetAppointmentId ?? '');
    const normalizedDescription = normalizeDescription(record.description);
    const key = `${targetAppointmentId}\u0000${normalizedDescription}`;

    if (!groups.has(key)) {
      groups.set(key, []);
    }

    groups.get(key).push(record);
  }

  return [...groups.values()].map((group) => {
    const first = group[0];
    const normalizedDescription = normalizeDescription(first.description);
    const topics = uniqueStable(
      group.map((record) => record.topic).filter((topic) => topic !== ''),
    );
    const homeworkIds = uniqueStable(
      group
        .map((record) => record.homeworkId)
        .filter((homeworkId) => homeworkId !== undefined && homeworkId !== null),
    );

    const result = {
      targetAppointmentId: first.targetAppointmentId ?? null,
      normalizedDescription,
      subject: first.subject,
      description: first.description,
      assignedDate: first.assignedDate,
      targetDate: first.targetDate,
      lessonNumber: first.lessonNumber,
      startTime: first.startTime,
      filesCount: Math.max(...group.map((record) => record.filesCount), 0),
    };

    if (group.length > 1) {
      result.homeworkIds = homeworkIds;
      result.topics = topics;
    } else {
      result.homeworkId = homeworkIds[0] ?? null;
      result.topic = topics[0] ?? '';
    }

    return result;
  });
}

export function deduplicateHomeworks(appointmentsOrRecords) {
  return deduplicateHomeworkRecords(appointmentsOrRecords).map(
    ({ targetAppointmentId, normalizedDescription, ...homework }) => homework,
  );
}

function isSessionExpired(status, responseText) {
  if (status === 401 || status === 403) {
    return true;
  }

  const text = responseText.toLowerCase();
  return (
    /session[\s_-]*(?:token|cookie)?[\s\S]{0,80}(?:expired|invalid|unauthori[sz]ed)/i.test(text) ||
    /(?:expired|invalid)[\s\S]{0,80}session[\s_-]*(?:token|cookie)?/i.test(text) ||
    /unauthori[sz]ed|forbidden|token[\s_-]*expired/i.test(text)
  );
}

async function requestAppointments(auth, url, { forceDiarySession = false, signal } = {}) {
  await initializeDiarySession(auth, { force: forceDiarySession, signal });

  const response = await auth.fetch(url, {
    method: 'GET',
    headers: {
      accept: 'application/json',
    },
    signal,
  });

  const responseText = await response.text();
  if (!response.ok) {
    const sessionExpired = isSessionExpired(response.status, responseText);
    const error = new HttpError(
      `Appointment API request failed with HTTP ${response.status} ${response.statusText}`,
      {
        url: String(url),
        status: response.status,
        statusText: response.statusText,
        sessionExpired,
      },
    );
    throw error;
  }

  try {
    return extractAppointmentArray(JSON.parse(responseText));
  } catch (error) {
    if (error instanceof SmokeTestError) {
      throw error;
    }

    throw new SmokeTestError(
      `Appointment API returned invalid JSON: ${errorMessage(error)}`,
      { code: 'APPOINTMENT_RESPONSE_ERROR', cause: error },
    );
  }
}

async function runRecoveryLogin(auth, log, signal) {
  log('[eschool] Portal refresh failed; performing full login...');
  try {
    await auth.fullLogin({ signal });
    await initializeDiarySession(auth, { force: true, signal });
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    throw new SmokeTestError(
      `Appointment API recovery full login failed: ${errorMessage(error)}`,
      { code: 'APPOINTMENT_RECOVERY_ERROR', cause: error },
    );
  }
}

export async function getAppointments(
  auth,
  {
    start,
    end,
    now = new Date(),
    timeZone = TIME_ZONE,
    logger = console.log,
    signal,
  } = {},
) {
  if (!auth || typeof auth.fetch !== 'function') {
    throw new SmokeTestError('getAppointments requires an auth client');
  }

  const dateRange = start && end
    ? { start, end }
    : getCurrentAndNextWeekRange(now, timeZone);
  const url = buildAppointmentUrl(dateRange);
  const log = (message) => logger(message);

  log(`[eschool] Loading appointments ${dateRange.start} -> ${dateRange.end}`);

  let appointments;
  try {
    appointments = await requestAppointments(auth, url, { signal });
  } catch (firstError) {
    if (!firstError.sessionExpired) {
      throw firstError;
    }

    log('[eschool] Session expired; refreshing through /portal...');
    let portalRefreshWorked = true;
    try {
      await auth.refreshSession({ logOutput: false, signal });
      await initializeDiarySession(auth, { force: true, signal });
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      portalRefreshWorked = false;
    }

    if (!portalRefreshWorked) {
      await runRecoveryLogin(auth, log, signal);
    }

    try {
      appointments = await requestAppointments(auth, url, { signal });
    } catch (retryError) {
      if (!retryError.sessionExpired || !portalRefreshWorked) {
        throw retryError;
      }

      log('[eschool] Refresh retry still unauthorized; performing full login...');
      await runRecoveryLogin(auth, log, signal);
      appointments = await requestAppointments(auth, url, { signal });
    }
  }

  const rawHomeworks = collectHomeworkRecords(appointments);
  const homeworkTasks = deduplicateHomeworkRecords(rawHomeworks);
  const homeworks = homeworkTasks.map(
    ({ targetAppointmentId, normalizedDescription, ...homework }) => homework,
  );

  log(`[eschool] Received ${appointments.length} appointments`);
  log(`[eschool] Found ${rawHomeworks.length} raw homework records`);
  log(`[eschool] ${homeworks.length} unique homework tasks`);

  return {
    start: dateRange.start,
    end: dateRange.end,
    appointments,
    rawHomeworks,
    homeworkTasks,
    homeworks,
  };
}

export function formatHomework(homework) {
  const topics = Array.isArray(homework.topics)
    ? homework.topics
    : [homework.topic].filter((topic) => topic);
  const when = [
    homework.targetDate || homework.assignedDate,
    homework.lessonNumber === null || homework.lessonNumber === undefined
      ? null
      : `урок ${homework.lessonNumber}`,
    homework.startTime || null,
  ]
    .filter(Boolean)
    .map((part, index) => (index === 0 ? formatDateForDisplay(part) : part))
    .join(', ');

  const lines = [
    '-'.repeat(48),
    homework.subject || 'Без предмета',
    `На: ${when || 'дата не указана'}`,
    'Тема:',
    ...(topics.length > 0 ? topics.map((topic) => `- ${topic}`) : ['- —']),
    'ДЗ:',
    homework.description || '—',
  ];

  if (homework.filesCount > 0) {
    lines.push(`Файлы: ${homework.filesCount}`);
  }

  lines.push('-'.repeat(48));
  return lines.join('\n');
}
