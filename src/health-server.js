import { createServer } from 'node:http';

export const HEALTH_PATH = '/healthz';

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('PORT must be an integer between 0 and 65535');
  }
  return port;
}

export async function startHealthServer({
  port = process.env.PORT,
  host = '0.0.0.0',
  readiness = () => true,
  diagnostics,
} = {}) {
  if (port === undefined || port === null || String(port).trim() === '') {
    throw new Error('PORT is required for the Render web service');
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (!['GET', 'HEAD'].includes(request.method) || url.pathname !== HEALTH_PATH) {
      response.statusCode = 404;
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ error: 'not_found' }));
      return;
    }

    let ready = false;
    try {
      ready = Boolean(await readiness());
    } catch {
      ready = false;
    }

    let details;
    if (diagnostics && request.method === 'GET') {
      try {
        details = await diagnostics();
      } catch {
        details = { status: 'unavailable' };
      }
    }
    response.statusCode = ready ? 200 : 503;
    response.setHeader('cache-control', 'no-store');
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.end(request.method === 'HEAD'
      ? undefined
      : JSON.stringify({ status: ready ? 'ok' : 'unavailable', ...(details ? { sync: details } : {}) }));
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(parsePort(port), host);
  });

  let closed = false;
  return {
    server,
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      server.closeIdleConnections?.();
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
