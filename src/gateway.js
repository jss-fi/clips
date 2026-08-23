const http = require('http');
const crypto = require('crypto');
const fs = require('fs');

const DEFAULT_GATEWAY_PORT = 32191;
const MAX_BODY_BYTES = 1024 * 1024;

function json(response, status, value, origin = '') {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    ...(origin ? {
      'Access-Control-Allow-Origin': origin,
      Vary: 'Origin'
    } : {}),
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(body);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        reject(new Error('Request body is too large.'));
        request.destroy();
      }
    });
    request.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error('Request body must be valid JSON.')); }
    });
    request.on('error', reject);
  });
}

function createGateway({
  token,
  invoke,
  approvePairing,
  logger,
  allowedOrigins = ['https://clips.jss.fi'],
  port = DEFAULT_GATEWAY_PORT,
  webAssets = null,
  uiVersion = '',
  onStaleUi = null
}) {
  const origins = new Set(allowedOrigins);
  const eventClients = new Set();
  let server = null;
  let pairingRequest = null;

  function allowedOrigin(request) {
    const origin = String(request.headers.origin || '');
    const localPort = server?.address()?.port || port;
    if (!origin && String(request.headers.host || '') === `127.0.0.1:${localPort}`) {
      return `http://127.0.0.1:${localPort}`;
    }
    return origins.has(origin) ? origin : '';
  }

  function authenticated(request, url) {
    const authorization = String(request.headers.authorization || '');
    const supplied = authorization.startsWith('Bearer ')
      ? authorization.slice(7)
      : String(url.searchParams.get('token') || '');
    return supplied.length === token.length
      && Buffer.from(supplied).length === Buffer.from(token).length
      && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(token));
  }

  async function handle(request, response) {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    if (request.method === 'GET' && webAssets) {
      if (url.pathname === '/' || url.pathname === '/app') {
        response.writeHead(302, { Location: '/app/', 'Cache-Control': 'no-store' });
        response.end();
        return;
      }
      const asset = {
        '/app/': ['index', 'text/html; charset=utf-8'],
        '/app/styles.css': ['styles', 'text/css; charset=utf-8'],
        '/app/renderer.js': ['renderer', 'text/javascript; charset=utf-8'],
        '/app/web.js': ['web', 'text/javascript; charset=utf-8'],
        '/app/changelog.json': ['changelog', 'application/json; charset=utf-8']
      }[url.pathname];
      if (asset) {
        let body = await fs.promises.readFile(webAssets[asset[0]]);
        if (asset[0] === 'index') {
          body = Buffer.from(body.toString('utf8').replace(
            '<script src="renderer.js"></script>',
            '<script src="web.js"></script>\n  <script src="renderer.js"></script>'
          ));
        }
        response.writeHead(200, {
          'Cache-Control': 'no-store',
          'Content-Type': asset[1],
          'Content-Length': body.length,
          ...(asset[0] === 'index' ? {
            'Content-Security-Policy': "frame-ancestors 'none'",
            'X-Frame-Options': 'DENY'
          } : {}),
          'X-Content-Type-Options': 'nosniff'
        });
        response.end(body);
        return;
      }
    }
    const origin = allowedOrigin(request);
    if (!origin) {
      logger?.warn('web gateway rejected origin', {
        origin: String(request.headers.origin || ''),
        host: String(request.headers.host || ''),
        method: request.method,
        path: url.pathname
      });
      json(response, 403, { error: 'This website is not allowed to control Clips.' });
      return;
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Private-Network': 'true',
        'Access-Control-Max-Age': '600',
        Vary: 'Origin'
      });
      response.end();
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/health') {
      json(response, 200, { product: 'jss/clips', apiVersion: 1, pairingRequired: true }, origin);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/pair') {
      const input = await readJson(request);
      const clientName = String(input.clientName || 'Browser').slice(0, 80);
      const pairingKey = `${origin}\n${clientName}`;
      if (pairingRequest && pairingRequest.key !== pairingKey) {
        json(response, 409, { error: 'Another browser connection is awaiting approval.' }, origin);
        return;
      }
      if (!pairingRequest) {
        const current = {
          key: pairingKey,
          promise: Promise.resolve(approvePairing({ origin, clientName }))
        };
        pairingRequest = current;
        const clearPairingRequest = () => {
          if (pairingRequest === current) pairingRequest = null;
        };
        current.promise.then(clearPairingRequest, clearPairingRequest);
      }
      if (!await pairingRequest.promise) {
        json(response, 403, { error: 'Pairing was not approved in Clips.' }, origin);
        return;
      }
      json(response, 200, { token, apiVersion: 1 }, origin);
      return;
    }
    if (!authenticated(request, url)) {
      json(response, 401, { error: 'Reconnect this browser to Clips.' }, origin);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/events') {
      response.writeHead(200, {
        'Access-Control-Allow-Origin': origin,
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream; charset=utf-8',
        Vary: 'Origin',
        'X-Accel-Buffering': 'no'
      });
      response.write(': connected\n\n');
      eventClients.add(response);
      const clientUiVersion = String(url.searchParams.get('uiVersion') || '');
      if (uiVersion && clientUiVersion !== uiVersion) {
        setImmediate(() => onStaleUi?.({ clientUiVersion, uiVersion }));
      }
      request.on('close', () => eventClients.delete(response));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/rpc') {
      try {
        const input = await readJson(request);
        const result = await invoke(String(input.method || ''), Array.isArray(input.args) ? input.args : []);
        json(response, 200, { result }, origin);
      } catch (error) {
        logger?.warn('web gateway request failed', { message: error.message });
        json(response, 400, { error: error.message || 'The Clips request failed.' }, origin);
      }
      return;
    }
    json(response, 404, { error: 'Not found.' }, origin);
  }

  function start() {
    if (server) return Promise.resolve(port);
    server = http.createServer((request, response) => {
      handle(request, response).catch(error => {
        logger?.warn('web gateway connection failed', { message: error.message });
        if (!response.headersSent) json(response, 500, { error: 'The Clips gateway could not complete the request.' });
        else response.end();
      });
    });
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve(server.address().port);
      });
    });
  }

  function emit(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const response of eventClients) {
      try { response.write(payload); }
      catch { eventClients.delete(response); }
    }
  }

  function hasEventClients() { return eventClients.size > 0; }

  function close() {
    for (const response of eventClients) response.end();
    eventClients.clear();
    server?.close();
    server = null;
  }

  return { start, emit, hasEventClients, close, port };
}

module.exports = { createGateway, DEFAULT_GATEWAY_PORT };
