const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createGateway } = require('../src/gateway');

const origin = 'https://clips.jss.fi';

async function withGateway(run) {
  const calls = [];
  const gateway = createGateway({
    token: 'a-secure-test-token',
    port: 0,
    allowedOrigins: [origin],
    approvePairing: async request => {
      calls.push(['pair', request]);
      return true;
    },
    invoke: async (method, args) => {
      calls.push([method, args]);
      return { method, args };
    }
  });
  const port = await gateway.start();
  try { await run({ gateway, port, calls }); }
  finally { gateway.close(); }
}

function localWebAssets() {
  const source = path.join(__dirname, '..', 'src');
  return {
    index: path.join(source, 'index.html'),
    styles: path.join(source, 'styles.css'),
    renderer: path.join(source, 'renderer.js'),
    web: path.join(__dirname, '..', 'clips-worker', 'src', 'web.js'),
    changelog: path.join(source, 'changelog.json')
  };
}

test('gateway only accepts the configured website origin', async () => withGateway(async ({ port }) => {
  const denied = await fetch(`http://127.0.0.1:${port}/v1/health`, { headers: { Origin: 'https://example.com' } });
  assert.equal(denied.status, 403);

  const allowed = await fetch(`http://127.0.0.1:${port}/v1/health`, { headers: { Origin: origin } });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('access-control-allow-origin'), origin);
  assert.deepEqual(await allowed.json(), { product: 'jss/clips', apiVersion: 1, pairingRequired: true });
}));

test('gateway accepts same-origin loopback requests that omit Origin', async () => withGateway(async ({ gateway, port }) => {
  const response = await fetch(`http://127.0.0.1:${port}/v1/health`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), `http://127.0.0.1:${port}`);

  const events = await fetch(`http://127.0.0.1:${port}/v1/events?token=a-secure-test-token`);
  assert.equal(events.status, 200);
  const reader = events.body.getReader();
  assert.match(await reader.read().then(chunk => new TextDecoder().decode(chunk.value)), /connected/);
  assert.equal(gateway.hasEventClients(), true);
  await reader.cancel();
}));

test('gateway pairs and requires its capability for RPC', async () => withGateway(async ({ port, calls }) => {
  const endpoint = `http://127.0.0.1:${port}/v1`;
  const unauthenticated = await fetch(`${endpoint}/rpc`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}'
  });
  assert.equal(unauthenticated.status, 401);

  const pairing = await fetch(`${endpoint}/pair`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ clientName: 'Test browser' })
  });
  assert.deepEqual(await pairing.json(), { token: 'a-secure-test-token', apiVersion: 1 });
  assert.equal(calls[0][0], 'pair');

  const rpc = await fetch(`${endpoint}/rpc`, {
    method: 'POST',
    headers: { Origin: origin, Authorization: 'Bearer a-secure-test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: 'getState', args: [1] })
  });
  assert.deepEqual(await rpc.json(), { result: { method: 'getState', args: [1] } });
}));

test('gateway never shares an in-flight pairing approval with another origin', async () => {
  const secondOrigin = 'https://beta.clips.jss.fi';
  let approve;
  const gateway = createGateway({
    token: 'a-secure-test-token',
    port: 0,
    allowedOrigins: [origin, secondOrigin],
    approvePairing: () => new Promise(resolve => { approve = resolve; }),
    invoke: async () => ({})
  });
  const port = await gateway.start();
  try {
    const pair = requestOrigin => fetch(`http://127.0.0.1:${port}/v1/pair`, {
      method: 'POST',
      headers: { Origin: requestOrigin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientName: 'Browser' })
    });
    const first = pair(origin);
    while (!approve) await new Promise(resolve => setImmediate(resolve));
    const second = await pair(secondOrigin);
    assert.equal(second.status, 409);
    assert.deepEqual(await second.json(), { error: 'Another browser connection is awaiting approval.' });
    approve(true);
    assert.equal((await first).status, 200);
  } finally { gateway.close(); }
});

test('gateway clears a rejected pairing approval without an unhandled rejection', async () => {
  const unhandled = [];
  const onUnhandled = error => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  let approvals = 0;
  const gateway = createGateway({
    token: 'a-secure-test-token',
    port: 0,
    allowedOrigins: [origin],
    approvePairing: async () => {
      approvals += 1;
      throw new Error('Approval dialog failed.');
    },
    invoke: async () => ({})
  });
  const port = await gateway.start();
  const pair = () => fetch(`http://127.0.0.1:${port}/v1/pair`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientName: 'Browser' })
  });
  try {
    assert.equal((await pair()).status, 500);
    assert.equal((await pair()).status, 500);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(approvals, 2);
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
    gateway.close();
  }
});

test('gateway prevents other websites from framing its local browser UI', async () => {
  const gateway = createGateway({
    token: 'a-secure-test-token',
    port: 0,
    allowedOrigins: [origin],
    approvePairing: async () => true,
    invoke: async () => ({}),
    webAssets: localWebAssets()
  });
  const port = await gateway.start();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/app/`, {
      headers: { 'Sec-Fetch-Dest': 'iframe', 'Sec-Fetch-Site': 'cross-site' }
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  } finally { gateway.close(); }
});

test('gateway advertises local-network preflight permission', async () => withGateway(async ({ port }) => {
  const response = await fetch(`http://127.0.0.1:${port}/v1/rpc`, {
    method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Private-Network': 'true' }
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-private-network'), 'true');
}));

test('gateway identifies a surviving browser UI from an older app build', async () => {
  let staleUi;
  const gateway = createGateway({
    token: 'a-secure-test-token',
    port: 0,
    allowedOrigins: [origin],
    approvePairing: async () => true,
    invoke: async () => ({}),
    uiVersion: '0.4-new',
    onStaleUi: details => { staleUi = details; }
  });
  const port = await gateway.start();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/events?token=a-secure-test-token&uiVersion=0.4-old`, { headers: { Origin: origin } });
    const reader = response.body.getReader();
    await reader.read();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(staleUi, { clientUiVersion: '0.4-old', uiVersion: '0.4-new' });
    await reader.cancel();
  } finally { gateway.close(); }
});
