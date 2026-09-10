export class SmokeTestError extends Error {
  constructor(message, { code = 'SMOKE_TEST_ERROR', cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'SmokeTestError';
    this.code = code;
  }
}

export class ConfigError extends SmokeTestError {
  constructor(message) {
    super(message, { code: 'CONFIG_ERROR' });
    this.name = 'ConfigError';
  }
}

export class HttpError extends SmokeTestError {
  constructor(message, { url, status, statusText, sessionExpired = false } = {}) {
    super(message, { code: 'HTTP_ERROR' });
    this.name = 'HttpError';
    this.url = url;
    this.status = status;
    this.statusText = statusText;
    this.sessionExpired = sessionExpired;
  }
}

export function maskToken(value) {
  if (value === undefined || value === null || value === '') {
    return 'absent';
  }

  const text = String(value);
  if (text.length <= 14) {
    return '[masked]';
  }

  return `${text.slice(0, 8)}…${text.slice(-6)}`;
}

export function normalizeDescription(value) {
  return String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeTopic(value) {
  return String(value ?? '').trim();
}

export function uniqueStable(values) {
  const result = [];
  const seen = new Set();

  for (const value of values) {
    const key = typeof value === 'string' ? value : JSON.stringify(value);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(value);
  }

  return result;
}

export function formatDateForDisplay(value) {
  const text = String(value ?? '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);

  if (!match) {
    return text || '—';
  }

  return `${match[3]}.${match[2]}.${match[1]}`;
}

export function errorMessage(error) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return String(error);
}
