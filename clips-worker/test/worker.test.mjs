import test from 'node:test';
import assert from 'node:assert/strict';
import { artifactName, githubReleaseUrl, parseRange, serve } from '../src/updates.ts';
import { serveTelemetry } from '../src/telemetry.ts';
import { nextTelemetryBudget } from '../src/telemetry-budget.ts';

function allowTelemetry() {
  const limiter = { async limit() { return { success: true }; } };
  return {
    client: limiter,
    service: limiter,
    admission: { getByName() { return { async admit() { return true; } }; } }
  };
}

function versionEvent(overrides = {}) {
  return {
    schemaVersion: 1,
    installationId: '123e4567-e89b-42d3-a456-426614174000',
    mode: 'version',
    event: 'startup',
    timestamp: new Date().toISOString(),
    appVersion: '0.5.0',
    runtimeVersion: '2',
    ...overrides
  };
}

function telemetryRequest(event, clientIp = '192.0.2.1') {
  const headers = { 'Content-Type': 'application/json' };
  if (clientIp) headers['CF-Connecting-IP'] = clientIp;
  return new Request('https://clips.test/v1/events', {
    method: 'POST', headers, body: JSON.stringify(event)
  });
}

function r2Object(body, overrides = {}) {
  const bytes = new TextEncoder().encode(body);
  return {
    size: bytes.byteLength,
    httpEtag: '"test-etag"',
    body: new Blob([bytes]).stream(),
    writeHttpMetadata() {},
    ...overrides
  };
}

test('update routes reject traversal and parse complete byte ranges', () => {
  assert.equal(artifactName('/stable/../latest.json'), null);
  assert.equal(artifactName('/jss-clips-app-0.5.0-x64.zip')?.key, 'releases/jss-clips-app-0.5.0-x64.zip');
  assert.deepEqual(parseRange('bytes=10-19', 100), { offset: 10, length: 10 });
  assert.deepEqual(parseRange('bytes=-12', 100), { suffix: 12 });
  assert.equal(parseRange('bytes=100-101', 100), null);
  assert.equal(parseRange('bytes=20-10', 100), null);
});

test('GitHub fallback maps legacy nightly tags without changing artifact names', async () => {
  const legacyName = 'jss-clips-app-0.5.0-nightly.19.77e9a876-x64.zip';
  assert.equal(githubReleaseUrl(legacyName),
    `https://github.com/jssfi/clips/releases/download/v0.5.0-nightly.n000019.77e9a876/${legacyName}`);

  const fixedName = 'jss-clips-setup-0.5.0-nightly.n000019.77e9a876-x64.exe';
  assert.equal(githubReleaseUrl(fixedName),
    `https://github.com/jssfi/clips/releases/download/v0.5.0-nightly.n000019.77e9a876/${fixedName}`);

  const stableName = 'jss-clips-portable-0.5.0-x64.exe';
  assert.equal(githubReleaseUrl(stableName),
    `https://github.com/jssfi/clips/releases/download/v0.5.0/${stableName}`);

  let lookedUpKey;
  const response = await serve(new Request(`https://cdn.clips.jss.fi/${legacyName}`), {
    async get(key) { lookedUpKey = key; return null; }
  });
  assert.equal(lookedUpKey, `releases/${legacyName}`);
  assert.equal(response.status, 307);
  assert.equal(response.headers.get('location'),
    `https://github.com/jssfi/clips/releases/download/v0.5.0-nightly.n000019.77e9a876/${legacyName}`);
});

test('update serving returns correct range and conditional statuses', async () => {
  const object = r2Object('0123456789');
  const bucket = {
    async head() { return object; },
    async get(_key, options) {
      if (options?.onlyIf?.get('if-none-match')) {
        const { body: _body, ...conditional } = object;
        return conditional;
      }
      if (options?.range) return r2Object('2345', { size: 10, range: options.range });
      return object;
    }
  };
  const partial = await serve(new Request('https://clips.test/jss-clips-app-0.5.0-x64.zip', {
    headers: { Range: 'bytes=2-5' }
  }), bucket);
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(await partial.text(), '2345');

  const invalid = await serve(new Request('https://clips.test/jss-clips-app-0.5.0-x64.zip', {
    headers: { Range: 'bytes=20-30' }
  }), bucket);
  assert.equal(invalid.status, 416);

  const conditional = await serve(new Request('https://clips.test/latest.json', {
    headers: { 'If-None-Match': '"test-etag"' }
  }), bucket);
  assert.equal(conditional.status, 304);
});

test('telemetry rejects malformed and oversized events before writing R2', async () => {
  let writes = 0;
  const bucket = { async put() { writes += 1; } };
  const malformed = await serveTelemetry(new Request('https://clips.test/v1/events', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1' }, body: '{}'
  }), bucket, allowTelemetry());
  assert.equal(malformed.status, 400);

  const oversized = await serveTelemetry(new Request('https://clips.test/v1/events', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1' }, body: JSON.stringify({ padding: 'x'.repeat(70 * 1024) })
  }), bucket, allowTelemetry());
  assert.equal(oversized.status, 413);
  assert.equal(writes, 0);
});

test('telemetry stores a valid version-only event without diagnostic fields', async () => {
  const writes = [];
  const bucket = { async put(key, body, options) { writes.push({ key, body: JSON.parse(body), options }); } };
  const event = versionEvent({ appVersion: '0.5.0-nightly.17.0ae82234' });
  const response = await serveTelemetry(telemetryRequest(event), bucket, allowTelemetry());
  assert.equal(response.status, 202);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].key, `installations/${event.installationId}.json`);
  assert.equal(writes[0].body.system, undefined);
});

test('telemetry rate limits valid events before writing R2', async () => {
  let writes = 0;
  let clientCalls = 0;
  const keys = [];
  const bucket = { async put() { writes += 1; } };
  const rateLimits = {
    client: {
      async limit({ key }) {
        keys.push(['client', key]);
        clientCalls += 1;
        return { success: clientCalls === 1 };
      }
    },
    service: {
      async limit({ key }) {
        keys.push(['service', key]);
        return { success: true };
      }
    },
    admission: { getByName() { return { async admit() { return true; } }; } }
  };
  const event = versionEvent();
  const send = () => serveTelemetry(telemetryRequest(event, '192.0.2.10'), bucket, rateLimits);

  assert.equal((await send()).status, 202);
  const limited = await send();
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
  assert.equal(writes, 1);
  assert.deepEqual(keys, [
    ['client', '192.0.2.10'], ['service', 'telemetry'],
    ['client', '192.0.2.10']
  ]);
});

test('telemetry rejects missing client identity and exhausted service budgets without R2 writes', async () => {
  let writes = 0;
  let serviceCalls = 0;
  let admissionCalls = 0;
  const bucket = { async put() { writes += 1; } };
  const event = versionEvent();
  const controls = {
    client: { async limit() { return { success: true }; } },
    service: { async limit() { serviceCalls += 1; return { success: false }; } },
    admission: {
      getByName() {
        return { async admit() { admissionCalls += 1; return true; } };
      }
    }
  };
  const unidentified = await serveTelemetry(telemetryRequest(event, ''), bucket, controls);
  assert.equal(unidentified.status, 400);
  const limited = await serveTelemetry(telemetryRequest(event, '192.0.2.2'), bucket, controls);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
  assert.equal(serviceCalls, 1);
  assert.equal(admissionCalls, 0);
  assert.equal(writes, 0);
});

test('telemetry enforces a globally coordinated write budget before R2', async () => {
  let writes = 0;
  let admittedCost = 0;
  const bucket = { async put() { writes += 1; } };
  const controls = allowTelemetry();
  controls.admission = {
    getByName(name) {
      assert.equal(name, 'global');
      return { async admit(cost) { admittedCost = cost; return false; } };
    }
  };
  const event = versionEvent({
    mode: 'diagnostics',
    event: 'error',
    system: { platform: 'win32', architecture: 'x64', windowsRelease: '11', cpu: 'CPU', gpu: 'GPU', ramGiB: 16 },
    error: { message: 'failure', log: 'sanitized' }
  });
  const response = await serveTelemetry(telemetryRequest(event, '192.0.2.3'), bucket, controls);

  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '60');
  assert.equal(admittedCost, 2);
  assert.equal(writes, 0);
});

test('global telemetry budget is exact and resets at minute boundaries', () => {
  const start = Date.UTC(2026, 7, 23, 12, 0, 0);
  let budget = null;
  for (let index = 0; index < 299; index += 1) {
    const decision = nextTelemetryBudget(budget, start, 1);
    assert.equal(decision.accepted, true);
    budget = decision.budget;
  }
  const tooExpensive = nextTelemetryBudget(budget, start, 2);
  assert.equal(tooExpensive.accepted, false);
  assert.equal(tooExpensive.budget.used, 299);
  const lastWrite = nextTelemetryBudget(budget, start, 1);
  assert.equal(lastWrite.accepted, true);
  assert.equal(nextTelemetryBudget(lastWrite.budget, start, 1).accepted, false);
  assert.deepEqual(nextTelemetryBudget(lastWrite.budget, start + 60 * 1000, 2), {
    accepted: true,
    budget: { windowId: Math.floor((start + 60 * 1000) / (60 * 1000)), used: 2 }
  });
});
