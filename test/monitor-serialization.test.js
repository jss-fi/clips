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
  assert.match(source, /await cleanupStorageOnSchedule\(true\)/);
  assert.match(source, /await cleanupStorageOnSchedule\(\)/);
});
