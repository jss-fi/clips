import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unstable_dev } from 'wrangler';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(testDirectory, 'telemetry-admission-worker.ts');
const config = path.join(testDirectory, 'wrangler.telemetry-integration.jsonc');

async function startWorker(persistTo) {
  return unstable_dev(script, {
    config,
    local: true,
    persist: true,
    persistTo,
    logLevel: 'none',
    experimental: {
      disableDevRegistry: true,
      disableExperimentalWarning: true,
      watch: false
    }
  });
}

async function admit(worker, name, costs) {
  const response = await worker.fetch('http://telemetry-admission.test/admit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, costs })
  });
  const body = await response.text();
  assert.equal(response.status, 200, body);
  return JSON.parse(body).accepted;
}

test('real Durable Object serializes the global budget and persists it across restart', { timeout: 45000 }, async t => {
  const persistTo = fs.mkdtempSync(path.join(os.tmpdir(), 'clips-telemetry-admission-'));
  t.after(() => fs.rmSync(persistTo, { recursive: true, force: true }));

  // Keep both workerd starts in one fixed-minute window so a reset cannot mask lost persistence.
  const remaining = 60_000 - (Date.now() % 60_000);
  if (remaining < 15_000) await new Promise(resolve => setTimeout(resolve, remaining + 100));

  let worker = await startWorker(persistTo);
  try {
    const concurrent = await admit(worker, 'concurrent-budget', Array(301).fill(1));
    assert.equal(concurrent.filter(Boolean).length, 300);
    assert.equal(concurrent.filter(value => !value).length, 1);

    assert.deepEqual(await admit(worker, 'persistent-budget', [299, 1, 1]), [true, true, false]);
  } finally {
    await worker.stop();
  }

  worker = await startWorker(persistTo);
  try {
    assert.deepEqual(await admit(worker, 'persistent-budget', [1]), [false]);
  } finally {
    await worker.stop();
  }
});
