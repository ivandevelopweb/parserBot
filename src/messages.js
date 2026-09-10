import { buildHomeworkWebUrl } from './eschool.js';
import { MAX_TELEGRAM_MESSAGE_LENGTH } from './telegram.js';
import {
  addClassroomAuthuserParam,
  normalizeClassroomAssignmentUrl,
  parseClassroomAuthuserIndex,
} from './classroom-url.js';
import { formatDateForDisplay, normalizeDescription, uniqueStable } from './utils.js';

function getSnapshot(task) {
  return task?.snapshot ?? task ?? {};
}

function getSource(task) {
  const snapshot = getSnapshot(task);
  return String(task?.source ?? snapshot.source ?? 'eschool').trim().toLowerCase() || 'eschool';
}

function getSourceLabel(task) {
  return getSource(task) === 'classroom' ? 'Classroom' : 'Єдина школа';
}

function getTopics(task) {
  const snapshot = getSnapshot(task);
  const topics = Array.isArray(snapshot.topics)
    ? snapshot.topics
    : [snapshot.topic].filter(Boolean);

  return uniqueStable(
    topics
      .map((topic) => String(topic ?? '').trim())
      .filter(Boolean),
  );
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function isSafeHomeworkUrl(value) {
  try {
    const url = new URL(String(value).trim());
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
}

function getHomeworkWebUrlCandidates(task, { classroomAuthuserIndex = null } = {}) {
  const snapshot = getSnapshot(task);
  const explicitUrls = [
    snapshot.url,
    snapshot.alternateLink,
    snapshot.homeworkUrl,
    task?.url,
    task?.alternateLink,
    task?.homeworkUrl,
  ];
  const safeExplicitUrls = explicitUrls
    .filter((value) => value && isSafeHomeworkUrl(value))
    .map((value) => {
      const normalized = String(value).trim();
      return getSource(task) === 'classroom'
        ? addClassroomAuthuserParam(normalizeClassroomAssignmentUrl(normalized), classroomAuthuserIndex)
        : normalized;
    });

  const ids = [
    ...(Array.isArray(task?.homeworkIds) ? task.homeworkIds : []),
    task?.homeworkId,
    snapshot.homeworkId,
  ];
  const homeworkId = ids.find((id) => id !== undefined && id !== null && String(id).trim() !== '');
  const fallbackUrl = buildHomeworkWebUrl(homeworkId);
  return [...new Set([...safeExplicitUrls, fallbackUrl].filter(Boolean))];
}

function getHomeworkWebUrl(task, options = {}) {
  return getHomeworkWebUrlCandidates(task, options)[0] ?? null;
}

function getShortestHomeworkWebUrl(task, options = {}) {
  return getHomeworkWebUrlCandidates(task, options)
    .sort((left, right) => left.length - right.length)[0] ?? null;
}

const HOMEWORK_DISPLAY_MAX_LENGTH = 50;

function truncateText(value, maxLength) {
  const text = String(value ?? '').trim();
  const characters = Array.from(text);
  if (characters.length <= maxLength) {
    return text;
  }

  return `${characters.slice(0, maxLength - 1).join('').trimEnd()}…`;
}

function truncatePlainTextToLength(value, maxLength) {
  const characters = Array.from(String(value ?? ''));
  let result = '';
  let index = 0;
  while (index < characters.length && result.length + characters[index].length <= maxLength) {
    result += characters[index];
    index += 1;
  }
  if (index < characters.length && result.length < maxLength) {
    result += '…';
  }
  return result;
}

function truncateEscapedHtmlTextToLength(value, maxLength) {
  const characters = Array.from(String(value ?? ''));
  let result = '';
  let index = 0;
  while (index < characters.length) {
    const escaped = escapeHtml(characters[index]);
    if (result.length + escaped.length > maxLength) {
      break;
    }
    result += escaped;
    index += 1;
  }
  if (index < characters.length && result.length < maxLength) {
    result += '…';
  }
  return result;
}

function formatLinkedHomeworkTitle(task, {
  truncate = false,
  classroomAuthuserIndex = null,
} = {}) {
  const snapshot = getSnapshot(task);
  const normalizedDescription = normalizeDescription(snapshot.title ?? snapshot.description);
  const description = truncate
    ? truncateText(normalizedDescription, HOMEWORK_DISPLAY_MAX_LENGTH)
    : normalizedDescription;
  const url = getHomeworkWebUrl(task, { classroomAuthuserIndex });
  const sourceLabel = getSourceLabel(task);
  const label = description ? `${description} (${sourceLabel})` : sourceLabel;

  if (!url) {
    return escapeHtml(label || 'Без назви');
  }

  return `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
}

function formatHomeworkListItem(task, { classroomAuthuserIndex = null } = {}) {
  const snapshot = getSnapshot(task);
  const subject = String(snapshot.subject ?? '').trim();
  const linkedTitle = formatLinkedHomeworkTitle(task, {
    truncate: true,
    classroomAuthuserIndex,
  });

  if (!subject) {
    return `• ${linkedTitle}`;
  }

  return `• ${escapeHtml(subject)} — ${linkedTitle}`;
}

function formatLesson(snapshot, { escape = false } = {}) {
  const details = [];
  if (snapshot.lessonNumber !== null && snapshot.lessonNumber !== undefined && snapshot.lessonNumber !== '') {
    const lessonNumber = String(snapshot.lessonNumber).trim();
    details.push(`Урок ${escape ? escapeHtml(lessonNumber) : lessonNumber}`);
  }
  if (snapshot.startTime) {
    const startTime = String(snapshot.startTime).trim();
    details.push(escape ? escapeHtml(startTime) : startTime);
  }

  return details.join(', ');
}

function buildHomeworkMessage(task, type = 'new', {
  title,
  classroomAuthuserIndex = null,
} = {}) {
  const snapshot = getSnapshot(task);
  const source = getSource(task);
  const resolvedTitle = title ?? (type === 'changed'
    ? '✏️ Домашнє завдання змінено'
    : '📚 Нове домашнє завдання');
  const sections = [resolvedTitle];
  const subject = String(snapshot.subject ?? '').trim();
  const description = normalizeDescription(snapshot.description);
  const homeworkTitle = normalizeDescription(snapshot.title ?? snapshot.description);
  const topics = getTopics(task);
  const targetDate = snapshot.targetDate || snapshot.assignedDate;
  const displayTargetDate = targetDate ? formatDateForDisplay(targetDate) : '';
  const lesson = formatLesson({
    ...snapshot,
    startTime: snapshot.targetTime || snapshot.startTime,
  }, { escape: source === 'classroom' });
  const filesCount = Number(snapshot.filesCount);
  const displaySubject = source === 'classroom' ? escapeHtml(subject) : subject;

  if (subject) {
    sections.push(displaySubject);
  }
  if (description) {
    if (source === 'classroom') {
      sections.push(`📝 ${formatLinkedHomeworkTitle(task, { classroomAuthuserIndex })}`);
      if (homeworkTitle && homeworkTitle !== description) {
        sections.push(`📄 ${escapeHtml(description)}`);
      }
    } else {
      sections.push(`📝 ${description}`);
    }
  } else if (source === 'classroom' && homeworkTitle) {
    sections.push(`📝 ${formatLinkedHomeworkTitle(task, { classroomAuthuserIndex })}`);
  }
  if (topics.length > 0) {
    sections.push(`📖 Теми:\n${topics.map((topic) => (
      `• ${source === 'classroom' ? escapeHtml(topic) : topic}`
    )).join('\n')}`);
  }
  if (targetDate) {
    sections.push(`📅 На: ${source === 'classroom'
      ? escapeHtml(displayTargetDate)
      : displayTargetDate}`);
  } else if (source === 'classroom') {
    sections.push('📅 Дата здачі не вказана');
  }
  if (lesson) {
    sections.push(`🕐 ${lesson}`);
  }
  if (Number.isFinite(filesCount) && filesCount > 0) {
    sections.push(`📎 Прикріплено файлів: ${filesCount}`);
  }

  return sections.join('\n\n');
}

const COMPACT_NOTIFICATION_MARKER = 'ℹ️ Повідомлення скорочено; повний текст збережено.';

function buildCompactHomeworkMessage(task, type = 'new', {
  title,
  classroomAuthuserIndex = null,
} = {}) {
  const snapshot = getSnapshot(task);
  const source = getSource(task);
  const resolvedTitle = title ?? (type === 'changed'
    ? '✏️ Завдання змінено'
    : '📚 Нове завдання');
  const sections = [resolvedTitle, COMPACT_NOTIFICATION_MARKER];
  const subject = String(snapshot.subject ?? '').trim();
  const description = normalizeDescription(snapshot.title ?? snapshot.description);
  const targetDate = snapshot.targetDate || snapshot.assignedDate;
  const displayTargetDate = targetDate ? formatDateForDisplay(targetDate) : '';
  const lesson = formatLesson({
    ...snapshot,
    startTime: snapshot.targetTime || snapshot.startTime,
  }, { escape: source === 'classroom' });
  const filesCount = Number(snapshot.filesCount);

  if (subject) {
    sections.push(source === 'classroom'
      ? truncateEscapedHtmlTextToLength(subject, 500)
      : truncatePlainTextToLength(subject, 500));
  }
  if (description) {
    sections.push(`📝 ${source === 'classroom'
      ? truncateEscapedHtmlTextToLength(description, 1500)
      : truncatePlainTextToLength(description, 1500)}`);
  }

  const topics = getTopics(task);
  if (topics.length > 0) {
    const topicText = topics.map((topic) => `• ${topic}`).join('\n');
    sections.push(`📖 Теми:\n${source === 'classroom'
      ? truncateEscapedHtmlTextToLength(topicText, 1000)
      : truncatePlainTextToLength(topicText, 1000)}`);
  }
  if (targetDate) {
    sections.push(`📅 На: ${source === 'classroom'
      ? escapeHtml(displayTargetDate)
      : displayTargetDate}`);
  } else if (source === 'classroom') {
    sections.push('📅 Дата здачі не вказана');
  }
  if (lesson) {
    sections.push(`🕐 ${lesson}`);
  }
  if (Number.isFinite(filesCount) && filesCount > 0) {
    sections.push(`📎 Прикріплено файлів: ${filesCount}`);
  }

  const compact = sections.join('\n\n');
  const url = getShortestHomeworkWebUrl(task, { classroomAuthuserIndex });
  if (url) {
    const link = source === 'classroom'
      ? `<a href="${escapeHtml(url)}">Відкрити повне завдання</a>`
      : `🔗 ${url}`;
    const withLink = `${compact}\n\n${link}`;
    if (withLink.length <= MAX_TELEGRAM_MESSAGE_LENGTH) {
      return withLink;
    }
  }

  if (compact.length <= MAX_TELEGRAM_MESSAGE_LENGTH) {
    return compact;
  }

  // The field budgets above are intentionally conservative, but keep a final
  // plain/HTML-safe fallback if a future fixed section grows unexpectedly.
  const fallbackSubject = source === 'classroom'
    ? truncateEscapedHtmlTextToLength(subject, 250)
    : truncatePlainTextToLength(subject, 250);
  const fallbackDescription = source === 'classroom'
    ? truncateEscapedHtmlTextToLength(description, 800)
    : truncatePlainTextToLength(description, 800);
  return [
    resolvedTitle,
    COMPACT_NOTIFICATION_MARKER,
    fallbackSubject,
    fallbackDescription ? `📝 ${fallbackDescription}` : null,
  ].filter(Boolean).join('\n\n');
}

export function formatHomeworkMessage(task, type = 'new', options = {}) {
  const fullMessage = buildHomeworkMessage(task, type, options);
  if (fullMessage.length <= MAX_TELEGRAM_MESSAGE_LENGTH) {
    return fullMessage;
  }
  return buildCompactHomeworkMessage(task, type, options);
}

export function formatNewHomeworkMessage(task, options = {}) {
  return formatHomeworkMessage(task, 'new', {
    ...options,
    title: '📚 Нове завдання',
  });
}

export function formatChangedHomeworkMessage(task, options = {}) {
  return formatHomeworkMessage(task, 'changed', {
    ...options,
    title: '✏️ Завдання змінено',
  });
}

export function createMainMenuKeyboard({ classroomAuthuserIndex = null } = {}) {
  const parsedIndex = parseClassroomAuthuserIndex(classroomAuthuserIndex);
  const accountLabel = parsedIndex === null
    ? '🔗 Акаунт Classroom: не задано'
    : `🔗 Акаунт Classroom: ${parsedIndex}`;

  return {
    inline_keyboard: [
      [{ text: '📚 Поточні завдання', callback_data: 'menu:current' }],
      [{ text: '✅ Все виконані завдання', callback_data: 'menu:completed' }],
      [{ text: accountLabel, callback_data: 'menu:classroom-authuser' }],
      [{ text: 'ℹ️ Довідка', callback_data: 'menu:help' }],
    ],
  };
}

export const MAIN_MENU_KEYBOARD = createMainMenuKeyboard();

export const TELEGRAM_BOT_COMMANDS = [
  { command: 'start', description: 'Відкрити головне меню' },
  { command: 'menu', description: 'Відкрити головне меню' },
  { command: 'current', description: 'Показати поточні завдання' },
  { command: 'completed', description: 'Показати виконані завдання' },
  { command: 'help', description: 'Показати довідку' },
];

export function createCompleteKeyboard(taskId) {
  return {
    inline_keyboard: [[
      { text: '✅ Позначити виконаним', callback_data: `complete:${taskId}` },
    ]],
  };
}

export function createBackToMenuKeyboard() {
  return {
    inline_keyboard: [[
      { text: '↩️ До меню', callback_data: 'menu:main' },
    ]],
  };
}

function truncateButtonText(value, maxLength = 64) {
  return truncateText(value, maxLength);
}

function getListButtonLabel(task, { completed = false } = {}) {
  const snapshot = getSnapshot(task);
  const subject = String(snapshot.subject ?? '').trim();
  const date = snapshot.targetDate || snapshot.assignedDate;
  const dateText = date
    ? formatDateForDisplay(date).slice(0, 5)
    : 'Дата здачі не вказана';
  const description = truncateText(
    normalizeDescription(snapshot.description),
    HOMEWORK_DISPLAY_MAX_LENGTH,
  );
  const label = [subject, dateText, description].filter(Boolean).join(' · ') || 'Завдання';
  return truncateButtonText(`${completed ? '❌' : '✅'} ${label}`);
}

export function createListKeyboard(tasks, {
  page = 0,
  pageCount = 1,
  prefix = 'current',
  completed = false,
} = {}) {
  const rows = [];
  const taskButtons = tasks.map((task) => {
    const snapshot = getSnapshot(task);
    const callbackData = completed
      ? `uncomplete:list:${task.id}:${page}`
      : `complete:list:${task.id}:${page}`;
    return {
      text: getListButtonLabel({ ...task, snapshot }, { completed }),
      callback_data: callbackData,
    };
  });

  for (let index = 0; index < taskButtons.length; index += 2) {
    rows.push(taskButtons.slice(index, index + 2));
  }

  if (pageCount > 1) {
    const navigation = [];
    if (page > 0) {
      navigation.push({ text: '◀️', callback_data: `${prefix}:page:${page - 1}` });
    }
    navigation.push({ text: `${page + 1}/${pageCount}`, callback_data: 'noop' });
    if (page < pageCount - 1) {
      navigation.push({ text: '▶️', callback_data: `${prefix}:page:${page + 1}` });
    }
    rows.push(navigation);
  }

  rows.push([{ text: '↩️ До меню', callback_data: 'menu:main' }]);
  return { inline_keyboard: rows };
}

function groupByDate(tasks) {
  const groups = new Map();
  for (const task of tasks) {
    const snapshot = getSnapshot(task);
    const date = snapshot.targetDate || snapshot.assignedDate || '';
    const key = date || 'unknown';
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(task);
  }
  return [...groups.entries()];
}

export const HOMEWORK_LIST_PAGE_SIZE = 6;

export function formatHomeworkList(
  tasks,
  {
    completed = false,
    page = 0,
    pageSize = HOMEWORK_LIST_PAGE_SIZE,
    classroomAuthuserIndex = null,
  } = {},
) {
  const sorted = [...tasks].sort((left, right) => {
    const leftDate = getSnapshot(left).targetDate || getSnapshot(left).assignedDate || '9999-99-99';
    const rightDate = getSnapshot(right).targetDate || getSnapshot(right).assignedDate || '9999-99-99';
    return leftDate.localeCompare(rightDate) || Number(left.id) - Number(right.id);
  });
  const safePageSize = Number.isInteger(pageSize) && pageSize > 0
    ? pageSize
    : HOMEWORK_LIST_PAGE_SIZE;
  const pageCount = Math.max(1, Math.ceil(sorted.length / safePageSize));
  const safePage = Math.min(Math.max(Number(page) || 0, 0), pageCount - 1);
  const pageTasks = sorted.slice(safePage * safePageSize, (safePage + 1) * safePageSize);
  const heading = completed
    ? '✅ Виконані домашні завдання'
    : '📚 Поточні домашні завдання';

  if (sorted.length === 0) {
    return {
      text: completed
        ? `${heading}\n\nПоки що немає виконаних завдань.`
        : `${heading}\n\nНаразі немає невиконаних завдань.`,
      keyboard: createBackToMenuKeyboard(),
      page: 0,
      pageCount: 1,
    };
  }

  const lines = [heading];
  for (const [date, dateTasks] of groupByDate(pageTasks)) {
    lines.push('');
    lines.push(
      `📅 ${date === 'unknown' ? 'Дата здачі не вказана' : formatDateForDisplay(date)} · ${dateTasks.length}`,
    );
    lines.push(...dateTasks.map((task) => formatHomeworkListItem(task, {
      classroomAuthuserIndex,
    })));
  }

  return {
    text: lines.join('\n'),
    keyboard: createListKeyboard(pageTasks, {
      page: safePage,
      pageCount,
      prefix: completed ? 'completed' : 'current',
      completed,
    }),
    parseMode: 'HTML',
    page: safePage,
    pageCount,
  };
}

export function formatHomeworkDetails(task, {
  completed = false,
  classroomAuthuserIndex = null,
} = {}) {
  return formatHomeworkMessage(task, 'new', {
    title: completed ? '✅ Виконане завдання' : '📚 Завдання',
    classroomAuthuserIndex,
  });
}
