import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

import serverlessChromium from '@sparticuz/chromium';
import { chromium as playwrightChromium } from 'playwright-core';

import { createClassroomWebClient, CLASSROOM_HOME_PATH, CLASSROOM_ORIGIN } from './classroom-web.js';
import { parseClassroomAuthuserIndex } from './classroom-url.js';
import { ConfigError } from './utils.js';

export const CLASSROOM_CAPTURE_PATH = '/capture/classroom';
export const CLASSROOM_CAPTURE_SESSION_COOKIE = 'classroom_capture_session';
export const DEFAULT_CLASSROOM_CAPTURE_TIMEOUT_MS = 20 * 60 * 1000;
export const CLASSROOM_CAPTURE_VIEWPORT = Object.freeze({ width: 1280, height: 800 });

const GOOGLE_HOST_SUFFIXES = Object.freeze([
  'google.com',
  'googleapis.com',
  'gstatic.com',
  'googleusercontent.com',
  'recaptcha.net',
]);
const REMOTE_KEYS = new Set([
  'Enter', 'Tab', 'Escape', 'Backspace', 'Delete',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown', 'Space',
  'Control+a', 'Control+c', 'Control+v', 'Control+x',
  'Shift+Tab',
]);

const PAGE_HEADERS = Object.freeze({
  'cache-control': 'no-store, max-age=0',
  'content-security-policy': "default-src 'self'; img-src 'self' blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
});

const LOGIN_HTML = `<!doctype html>
<html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Classroom cookie capture</title>
<style>
  *{box-sizing:border-box}body{margin:0;background:#10141c;color:#edf2f7;font:16px system-ui;display:grid;min-height:100vh;place-items:center}
  main{width:min(440px,calc(100% - 32px));padding:28px;border:1px solid #344155;border-radius:14px;background:#171e29}
  h1{font-size:21px;margin:0 0 12px}p{color:#b8c4d6;line-height:1.5}label{display:block;margin:20px 0 8px}
  input,button{width:100%;padding:12px;border-radius:8px;border:1px solid #46556d;background:#0d121a;color:#fff;font:inherit}
  button{margin-top:12px;background:#2563eb;border:0;font-weight:650;cursor:pointer}#status{min-height:24px;color:#fbbf24}
</style><main><h1>Подключение к захвату Classroom</h1>
<p>Введите временный ключ доступа из настроек DeployHatch. Ключ не попадёт в адрес страницы.</p>
<form id="login"><label for="key">Ключ доступа</label><input id="key" type="password" autocomplete="off" required><button>Подключиться</button></form>
<p id="status" role="status"></p></main>
<script>
const form=document.querySelector('#login'),status=document.querySelector('#status');
form.addEventListener('submit',async event=>{event.preventDefault();status.textContent='Проверяю ключ…';
  const key=document.querySelector('#key').value;document.querySelector('#key').value='';
  try{const response=await fetch('/capture/classroom/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key})});
    const result=await response.json();if(!response.ok)throw new Error(result.error||'Не удалось подключиться');location.reload();
  }catch(error){status.textContent=error.message||'Не удалось подключиться';}
});
</script></html>`;

const REMOTE_HTML = `<!doctype html>
<html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Classroom server browser</title>
<style>
  *{box-sizing:border-box}body{margin:0;background:#10141c;color:#edf2f7;font:14px system-ui}
  header{position:sticky;top:0;z-index:1;background:#171e29;padding:12px 16px;border-bottom:1px solid #344155;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
  header strong{margin-right:auto}button,input{padding:9px 11px;border-radius:7px;border:1px solid #46556d;background:#0d121a;color:#fff;font:inherit}
  button{cursor:pointer;background:#26364d}button.primary{background:#2563eb;border:0;font-weight:650}button:disabled{opacity:.55;cursor:default}
  main{padding:14px}.help{color:#b8c4d6;margin:0 0 12px}.frame{display:block;max-width:100%;height:auto;margin:auto;border:1px solid #344155;background:#07090d;cursor:crosshair;touch-action:none}
  #status{min-height:23px;color:#fbbf24}.text-entry{width:min(360px,48vw)}
</style><header><strong>Браузер Classroom на сервере</strong><span id="status">Откройте страницу Classroom и войдите в аккаунт /u/1/.</span>
<input class="text-entry" id="text" type="password" autocomplete="off" placeholder="Ввод текста в активное поле Google">
<button id="type">Ввести</button><button id="reload">Обновить экран</button><button class="primary" id="capture">Снять cookies</button></header>
<main><p class="help">Нажимайте по изображению для кликов. Для пароля или кода введите текст в скрытое поле выше и нажмите «Ввести». После входа нажмите «Снять cookies».</p>
<img id="frame" class="frame" alt="Экран браузера Classroom на сервере"></main>
<script>
const frame=document.querySelector('#frame'),status=document.querySelector('#status');let active=true,previousUrl='';
async function action(data){const response=await fetch('/capture/classroom/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});const result=await response.json();if(!response.ok)throw new Error(result.error||'Ошибка управления браузером');return result;}
async function refresh(){if(!active)return;try{const response=await fetch('/capture/classroom/frame?ts='+Date.now(),{cache:'no-store'});if(!response.ok)throw new Error('Серверный браузер недоступен');const blob=await response.blob();const next=URL.createObjectURL(blob);const old=frame.dataset.objectUrl;frame.src=next;frame.dataset.objectUrl=next;if(old)URL.revokeObjectURL(old);const url=response.headers.get('x-classroom-page')||'';if(url&&url!==previousUrl){previousUrl=url;status.textContent=url.includes('classroom.google.com/u/')?'Classroom открыт. После загрузки страницы нажмите «Снять cookies».':'Войдите в Google в окне ниже.';}}catch(error){status.textContent=error.message;}setTimeout(refresh,1200);}
frame.addEventListener('click',async event=>{const rect=frame.getBoundingClientRect();const x=(event.clientX-rect.left)*frame.naturalWidth/rect.width;const y=(event.clientY-rect.top)*frame.naturalHeight/rect.height;try{await action({type:'click',x,y});}catch(error){status.textContent=error.message;}});
document.querySelector('#type').addEventListener('click',async()=>{const input=document.querySelector('#text');const value=input.value;input.value='';try{await action({type:'type',text:value});}catch(error){status.textContent=error.message;}});
document.querySelector('#reload').addEventListener('click',async()=>{try{await action({type:'reload'});}catch(error){status.textContent=error.message;}});
document.querySelector('#capture').addEventListener('click',async event=>{event.currentTarget.disabled=true;status.textContent='Проверяю текущую сессию…';try{const response=await fetch('/capture/classroom/export',{method:'POST'});const result=await response.json();if(!response.ok)throw new Error(result.error||'Не удалось снять cookies');active=false;status.textContent='Header выведен в логи; Node courses и pONvgf успешно проверены. Выключите capture mode после копирования.';}catch(error){event.currentTarget.disabled=false;status.textContent=error.message;}});
document.addEventListener('keydown',async event=>{if(event.target instanceof HTMLInputElement)return;const key=event.key===' ' ? 'Space' : event.key;if(['Enter','Tab','Escape','Backspace','Delete','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown',' '].includes(key)){event.preventDefault();try{await action({type:'press',key});}catch(error){status.textContent=error.message;}}});
refresh();
</script></html>`;

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function send(response, statusCode, body, contentType = 'application/json; charset=utf-8', extraHeaders = {}) {
  response.writeHead(statusCode, {
    ...PAGE_HEADERS,
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  response.end(body);
}

function sendJson(response, statusCode, value, extraHeaders) {
  send(response, statusCode, JSON.stringify(value), 'application/json; charset=utf-8', extraHeaders);
}

async function readJsonRequest(request, maximumBytes = 4096) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maximumBytes) {
      throw new ConfigError('Capture request is too large.');
    }
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    throw new ConfigError('Capture request must contain valid JSON.');
  }
}

function secureEquals(left, right) {
  const leftBytes = Buffer.from(String(left ?? ''), 'utf8');
  const rightBytes = Buffer.from(String(right ?? ''), 'utf8');
  return leftBytes.length === rightBytes.length && leftBytes.length > 0
    && timingSafeEqual(leftBytes, rightBytes);
}

function getSessionId(request) {
  const header = String(request.headers.cookie ?? '');
  const match = header.match(new RegExp(`(?:^|;\\s*)${CLASSROOM_CAPTURE_SESSION_COOKIE}=([^;]+)`));
  return match?.[1] ?? null;
}

function forwardedHttps(request) {
  const forwardedProtocol = String(request.headers['x-forwarded-proto'] ?? '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  return Boolean(request.socket.encrypted) || forwardedProtocol === 'https';
}

function isGoogleHost(hostname) {
  const normalized = String(hostname ?? '').toLowerCase();
  return GOOGLE_HOST_SUFFIXES.some((suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`));
}

export function buildClassroomCaptureUrl(authuserIndex = '1') {
  const parsedIndex = parseClassroomAuthuserIndex(authuserIndex);
  if (parsedIndex === null) {
    throw new ConfigError('CLASSROOM_AUTHUSER_INDEX must be an integer from 0 through 10.');
  }
  return `${CLASSROOM_ORIGIN}/u/${parsedIndex}${CLASSROOM_HOME_PATH}`;
}

export function isAllowedClassroomCaptureUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && isGoogleHost(url.hostname);
  } catch {
    return false;
  }
}

export function buildClassroomCookieHeader(cookies) {
  if (!Array.isArray(cookies)) {
    throw new ConfigError('Browser did not return a cookie list.');
  }
  return cookies
    .filter((cookie) => cookie && hasValue(cookie.name) && cookie.value !== undefined && cookie.value !== null)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

async function launchServerBrowser() {
  const executablePath = await serverlessChromium.executablePath();
  const browser = await playwrightChromium.launch({
    args: serverlessChromium.args,
    executablePath,
    headless: serverlessChromium.headless,
  });
  return browser;
}

function normalizePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError('PORT must be an integer between 0 and 65535.');
  }
  return port;
}

export function parseClassroomCaptureAction(value) {
  if (!value || typeof value !== 'object') {
    throw new ConfigError('Invalid browser action.');
  }
  if (value.type === 'click') {
    const x = Number(value.x);
    const y = Number(value.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)
      || x < 0 || x > CLASSROOM_CAPTURE_VIEWPORT.width
      || y < 0 || y > CLASSROOM_CAPTURE_VIEWPORT.height) {
      throw new ConfigError('Click coordinates are outside the browser viewport.');
    }
    return { type: 'click', x, y };
  }
  if (value.type === 'type') {
    const text = String(value.text ?? '');
    if (text.length > 2048) {
      throw new ConfigError('Text input is too long.');
    }
    return { type: 'type', text };
  }
  if (value.type === 'press' && REMOTE_KEYS.has(String(value.key))) {
    return { type: 'press', key: String(value.key) };
  }
  if (value.type === 'reload') {
    return { type: 'reload' };
  }
  throw new ConfigError('Unsupported browser action.');
}

async function applyAction(page, action) {
  if (action.type === 'click') {
    await page.mouse.click(action.x, action.y);
  } else if (action.type === 'type') {
    await page.keyboard.insertText(action.text);
  } else if (action.type === 'press') {
    await page.keyboard.press(action.key);
  } else if (action.type === 'reload') {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
  }
}

function createSession(request, response, sessions, ttlMs) {
  const sessionId = randomBytes(32).toString('base64url');
  sessions.set(sessionId, Date.now() + ttlMs);
  const secure = forwardedHttps(request) ? '; Secure' : '';
  response.setHeader('set-cookie', `${CLASSROOM_CAPTURE_SESSION_COOKIE}=${sessionId}; HttpOnly; SameSite=Strict; Path=/capture; Max-Age=${Math.floor(ttlMs / 1000)}${secure}`);
}

function validSession(request, sessions) {
  const sessionId = getSessionId(request);
  const expiresAt = sessionId ? sessions.get(sessionId) : null;
  if (!expiresAt || expiresAt <= Date.now()) {
    if (sessionId) {
      sessions.delete(sessionId);
    }
    return false;
  }
  return true;
}

async function verifyNodeCookieHeader({ cookieHeader, env, logger }) {
  try {
    const client = createClassroomWebClient({
      env: { ...env, CLASSROOM_COOKIE_HEADER: cookieHeader },
      cookieHeader,
      authuserIndex: env.CLASSROOM_AUTHUSER_INDEX ?? '1',
      timeoutMs: 20_000,
    });
    await client.getAuthenticatedHomePage({ force: true });
    const courses = await client.getCourses();
    if (!Array.isArray(courses) || courses.length === 0) {
      throw Object.assign(new Error('No Classroom courses were returned.'), {
        code: 'CLASSROOM_COURSE_LIST_RESPONSE_ERROR',
      });
    }
    const configuredCourseId = String(env.CLASSROOM_COURSE_ID ?? '').trim();
    const course = courses.find((item) => String(item?.courseId ?? '') === configuredCourseId)
      ?? courses[0];
    const assignments = await client.getCourseWorkForCourse(course.courseId);
    if (!Array.isArray(assignments)) {
      throw Object.assign(new Error('Classroom coursework response was not an array.'), {
        code: 'CLASSROOM_COURSEWORK_RESPONSE_ERROR',
      });
    }
    logger(`[classroom-cookie-capture] Node HTTP check: passed; courses=${courses.length}; pONvgf assignments=${assignments.length}`);
    return true;
  } catch (error) {
    const code = /^[A-Z0-9_]{2,64}$/u.test(String(error?.code ?? ''))
      ? String(error.code)
      : 'CLASSROOM_HTTP_CHECK_FAILED';
    logger(`[classroom-cookie-capture] Node HTTP and pONvgf check: failed (${code})`);
    return false;
  }
}

export async function startClassroomCookieCapture({
  env = process.env,
  logger = console.log,
  launchBrowser = launchServerBrowser,
  verifyNode = verifyNodeCookieHeader,
  port = env.PORT ?? 8080,
  host = '0.0.0.0',
  timeoutMs = DEFAULT_CLASSROOM_CAPTURE_TIMEOUT_MS,
} = {}) {
  const accessKey = String(env.CLASSROOM_COOKIE_CAPTURE_ACCESS_KEY ?? '');
  if (accessKey.length < 32) {
    throw new ConfigError('Set CLASSROOM_COOKIE_CAPTURE_ACCESS_KEY to a random value of at least 32 characters.');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 60_000) {
    throw new ConfigError('Classroom cookie capture timeout must be at least one minute.');
  }

  const classroomUrl = buildClassroomCaptureUrl(env.CLASSROOM_AUTHUSER_INDEX ?? '1');
  const browser = await launchBrowser();
  const context = await browser.newContext({
    viewport: CLASSROOM_CAPTURE_VIEWPORT,
    locale: 'uk-UA',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  await page.route('**/*', async (route) => {
    let allowed = false;
    try {
      const url = new URL(route.request().url());
      allowed = url.protocol === 'https:' && isGoogleHost(url.hostname);
    } catch {
      allowed = false;
    }
    if (allowed || route.request().isNavigationRequest() && route.request().url().startsWith('about:')) {
      await route.continue();
    } else {
      await route.abort('blockedbyclient');
    }
  });
  const sessions = new Map();
  const failedLogins = new Map();
  let captured = false;
  let captureInProgress = false;
  let closed = false;
  const closeBrowser = async () => {
    if (closed) return;
    closed = true;
    await browser.close().catch(() => {});
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/healthz') {
      sendJson(response, 200, { status: 'ok', mode: 'classroom-cookie-capture' });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/') {
      response.writeHead(302, { ...PAGE_HEADERS, location: CLASSROOM_CAPTURE_PATH });
      response.end();
      return;
    }
    if (request.method === 'GET' && url.pathname === CLASSROOM_CAPTURE_PATH) {
      const authenticated = validSession(request, sessions);
      send(response, 200, authenticated ? REMOTE_HTML : LOGIN_HTML, 'text/html; charset=utf-8');
      return;
    }
    if (request.method === 'POST' && url.pathname === `${CLASSROOM_CAPTURE_PATH}/login`) {
      const address = String(request.headers['x-forwarded-for'] ?? request.socket.remoteAddress ?? 'unknown')
        .split(',')[0]
        .trim();
      const failed = failedLogins.get(address);
      if (failed && failed.count >= 6 && failed.resetAt > Date.now()) {
        sendJson(response, 429, { error: 'Слишком много попыток. Подождите 10 минут.' });
        return;
      }
      let body;
      try {
        body = await readJsonRequest(request);
      } catch {
        sendJson(response, 400, { error: 'Некорректный запрос.' });
        return;
      }
      if (!secureEquals(body.key, accessKey)) {
        const current = failed && failed.resetAt > Date.now()
          ? failed
          : { count: 0, resetAt: Date.now() + 10 * 60 * 1000 };
        current.count += 1;
        failedLogins.set(address, current);
        sendJson(response, 401, { error: 'Неверный ключ доступа.' });
        return;
      }
      failedLogins.delete(address);
      createSession(request, response, sessions, timeoutMs);
      sendJson(response, 200, { ok: true });
      return;
    }
    if (!url.pathname.startsWith(`${CLASSROOM_CAPTURE_PATH}/`)
      || !validSession(request, sessions)) {
      sendJson(response, 404, { error: 'not_found' });
      return;
    }
    if (captured || captureInProgress || closed) {
      sendJson(response, 410, { error: 'Захват уже завершён.' });
      return;
    }
    if (request.method === 'GET' && url.pathname === `${CLASSROOM_CAPTURE_PATH}/frame`) {
      try {
        const screenshot = await page.screenshot({ type: 'jpeg', quality: 65 });
        response.writeHead(200, {
          ...PAGE_HEADERS,
          'content-type': 'image/jpeg',
          'content-length': screenshot.length,
          'x-classroom-page': (() => {
            try {
              const pageUrl = new URL(page.url());
              return `${pageUrl.origin}${pageUrl.pathname}`.slice(0, 400);
            } catch {
              return '';
            }
          })(),
        });
        response.end(screenshot);
      } catch {
        send(response, 503, 'Browser is unavailable.', 'text/plain; charset=utf-8');
      }
      return;
    }
    if (request.method === 'POST' && url.pathname === `${CLASSROOM_CAPTURE_PATH}/action`) {
      try {
        const action = parseClassroomCaptureAction(await readJsonRequest(request, 8192));
        await applyAction(page, action);
        sendJson(response, 200, { ok: true });
      } catch (error) {
        sendJson(response, 400, {
          error: error instanceof ConfigError ? error.message : 'Не удалось выполнить действие в браузере.',
        });
      }
      return;
    }
    if (request.method === 'POST' && url.pathname === `${CLASSROOM_CAPTURE_PATH}/export`) {
      const currentUrl = new URL(page.url());
      const authuserIndex = parseClassroomAuthuserIndex(env.CLASSROOM_AUTHUSER_INDEX ?? '1');
      if (currentUrl.hostname !== 'classroom.google.com'
        || authuserIndex === null
        || currentUrl.pathname !== `/u/${authuserIndex}${CLASSROOM_HOME_PATH}`
          && !currentUrl.pathname.startsWith(`/u/${authuserIndex}/`)) {
        sendJson(response, 409, { error: 'Сначала войдите и откройте Classroom под аккаунтом /u/1/.' });
        return;
      }
      try {
        captureInProgress = true;
        const cookies = await context.cookies(classroomUrl);
        const cookieHeader = buildClassroomCookieHeader(cookies);
        if (!cookieHeader || cookies.length < 5) {
          captureInProgress = false;
          sendJson(response, 409, { error: 'В браузере пока недостаточно Classroom cookies. Войдите заново и повторите.' });
          return;
        }
        const nodeAccepted = await verifyNode({ cookieHeader, env, logger });
        if (!nodeAccepted) {
          captureInProgress = false;
          sendJson(response, 502, {
            error: 'Node не подтвердил Classroom cookies через список курсов и pONvgf; header не выведен. Войдите заново и повторите.',
          });
          return;
        }
        const names = cookies.map((cookie) => cookie.name).filter(Boolean);
        logger(`[classroom-cookie-capture] Captured ${cookies.length} cookies for /u/${authuserIndex}; Node HTTP and pONvgf checks: passed`);
        logger(`[classroom-cookie-capture] CLASSROOM_COOKIE_HEADER=${cookieHeader}`);
        captured = true;
        captureInProgress = false;
        await closeBrowser();
        sendJson(response, 200, { ok: true, count: cookies.length, names, nodeAccepted: true });
      } catch {
        captureInProgress = false;
        sendJson(response, 500, { error: 'Не удалось проверить или экспортировать cookies.' });
      }
      return;
    }
    sendJson(response, 404, { error: 'not_found' });
  });

  try {
    await new Promise((resolveListen, rejectListen) => {
      const onError = (error) => {
        server.removeListener('listening', onListening);
        rejectListen(error);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolveListen();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(normalizePort(port), host);
    });
  } catch (error) {
    await closeBrowser();
    throw error;
  }

  logger(`[classroom-cookie-capture] Ready at ${CLASSROOM_CAPTURE_PATH}; open Classroom, sign in to /u/${env.CLASSROOM_AUTHUSER_INDEX ?? '1'}/, then press Capture.`);
  // Bind the public endpoint before waiting for Google's first navigation. DeployHatch
  // probes web services shortly after launch, while Classroom redirects can take much
  // longer. The protected browser UI can load immediately and will show the page once
  // this background navigation completes.
  void page.goto(classroomUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {
    logger('[classroom-cookie-capture] Initial Classroom navigation did not finish; the remote browser remains available.');
  });
  const timer = setTimeout(async () => {
    if (captured) return;
    logger('[classroom-cookie-capture] Capture window expired; browser closed without exporting cookies.');
    await closeBrowser();
    server.close();
  }, timeoutMs);
  timer.unref?.();

  return {
    server,
    browser,
    page,
    close: async () => {
      clearTimeout(timer);
      await closeBrowser();
      await new Promise((resolveClose) => {
        server.close(() => resolveClose());
      });
    },
  };
}
