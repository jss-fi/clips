const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('monitor scheduling coalesces requests while a monitor is active', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert.match(source, /if \(monitorPromise\) \{\s*monitorRerunRequested = true;\s*return monitorPromise;/);
  assert.match(source, /monitorPromise = monitor\(\)\.finally/);
  assert.match(source, /monitorTimer = setTimeout\(scheduleMonitor, monitorDelayMs\(\)\)/);
  assert.doesNotMatch(source, /monitorTimer = setTimeout\(monitor, monitorDelayMs\(\)\)/);
});

test('monitor throttles full storage scans independently of game detection', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert.match(source, /const STORAGE_CLEANUP_INTERVAL_MS = 60 \* 1000/);
  assert.match(source, /async function cleanupStorageOnSchedule\(force = false\)/);
  assert.match(source, /if \(!storageCleanupFresh\) await cleanupStorageOnSchedule\(true\)/);
  assert.match(source, /await cleanupStorageOnSchedule\(\)/);
  assert.match(source, /await startSession\(\{ storageCleanupFresh: true \}\)/);
  assert.match(source, /await cleanupStorage\(\);\s*lastStorageCleanupAt = Date\.now\(\)/);
  assert.match(source, /async function startInstantReplay\(\{ storageCleanupFresh = false \} = \{\}\)/);
  assert.match(source, /replayLengthSeconds: settings\.instantReplayLengthSeconds, storageCleanupFresh/);
  assert.equal((source.match(/await startInstantReplay\(\{ storageCleanupFresh: true \}\);/g) || []).length, 2);
});
