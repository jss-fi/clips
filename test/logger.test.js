const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLogger, pruneLogText, readRecentLogEntries, redactLogText } = require('../src/logger');

test('log pruning keeps only the recent hour', () => {
  const text = [
    '[2026-07-29T10:00:00.000Z] [INFO] old',
    '[2026-07-29T11:15:00.000Z] [INFO] recent'
  ].join('\n');
  assert.equal(
    pruneLogText(text, Date.parse('2026-07-29T11:00:00.000Z'), 1024),
    '[2026-07-29T11:15:00.000Z] [INFO] recent\n'
  );
});

test('log pruning respects the file-size cap', () => {
  const text = [
    '[2026-07-29T11:15:00.000Z] [INFO] first',
    '[2026-07-29T11:16:00.000Z] [INFO] second'
  ].join('\n');
  const result = pruneLogText(text, Date.parse('2026-07-29T11:00:00.000Z'), 50);
  assert.doesNotMatch(result, /first/);
  assert.match(result, /second/);
});

test('logs redact user paths, capture device ids, and window titles', () => {
  const sensitive = 'C:\\Users\\tikru\\AppData title: BanaanaJ - Discord "microphoneDeviceId":"{0.0.1.00000000}.{4502c661-e199-45c7-ac7a-78d3eac69fe0}"';
  const redacted = redactLogText(sensitive);
  assert.doesNotMatch(redacted, /tikru|BanaanaJ|4502c661/i);
  assert.match(redacted, /<redacted-user>/);
  assert.match(redacted, /<redacted-window-title>/);
});

test('logger maintenance redacts sensitive text already on disk', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clips-log-'));
  const filePath = path.join(directory, 'clips.log');
  fs.writeFileSync(filePath, '[2026-08-12T19:00:00.000Z] [INFO] C:\\Users\\tikru\\AppData\n');
  createLogger({ directory, now: () => Date.parse('2026-08-12T19:00:01.000Z') });
  assert.doesNotMatch(fs.readFileSync(filePath, 'utf8'), /tikru/);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('recent log entries recover bounded structured updater diagnostics', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clips-log-entries-'));
  const filePath = path.join(directory, 'clips.log');
  fs.writeFileSync(filePath, [
    '[2026-08-22T20:47:56.260Z] [INFO] staged updater download begin {"version":"0.6.0-nightly.n000011.test","size":245122252}',
    '[2026-08-22T20:47:56.261Z] [INFO] unrelated event {"ignored":true}',
    '[2026-08-22T20:47:56.262Z] [WARN] staged updater download fallback to single stream {"status":200}',
    '[2026-08-22T20:47:56.263Z] [INFO] staged updater malformed {not-json}'
  ].join('\n'));

  assert.deepEqual(readRecentLogEntries(filePath, {
    eventPrefix: 'staged updater ',
    maxEntries: 1
  }), [{
    time: '2026-08-22T20:47:56.262Z',
    level: 'warn',
    event: 'staged updater download fallback to single stream',
    details: { status: 200 }
  }]);
  fs.rmSync(directory, { recursive: true, force: true });
});
