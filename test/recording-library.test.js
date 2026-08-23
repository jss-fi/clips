const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRecordingLibrary, isRawRecordingName } = require('../src/recording-library');

function fixture(overrides = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'clips-recordings-'));
  const recordingsFolder = path.join(base, 'recordings');
  fs.mkdirSync(recordingsFolder);
  const settings = { recordingsFolder, storageCleanupMode: 'age', retentionDays: 2, ...overrides };
  const metadata = new Map();
  const library = createRecordingLibrary({
    getSettings: () => settings,
    getMetadata: () => ({ get: file => metadata.get(file) || {} }),
    favoritesPath: () => path.join(base, 'favorites.json'),
    today: () => '2026-08-17'
  });
  library.loadFavorites();
  return { base, recordingsFolder, metadata, library };
}

function recording(root, day, name, contents = 'video') {
  const file = path.join(root, day, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}

test('recording library lists and enriches recent and archived recordings', async () => {
  const { recordingsFolder, metadata, library } = fixture();
  const recent = recording(recordingsFolder, '2026-08-17', 'Replay 1.mkv');
  recording(recordingsFolder, '2026-08-16', 'Recording.mp4', 'longer video');
  metadata.set(recent, { title: 'Last fight', tags: ['ranked'], game: 'Arena' });
  library.setFavorite(recent, true);

  assert.deepEqual((await library.recentRecordings()).map(item => ({ name: item.name, title: item.title, kind: item.kind, favorite: item.favorite })), [
    { name: 'Replay 1.mkv', title: 'Last fight', kind: 'replay', favorite: true }
  ]);
  assert.deepEqual((await library.archivedRecordings()).map(item => ({ name: item.name, day: item.day, bytes: item.bytes })), [
    { name: 'Recording.mp4', day: '2026-08-16', bytes: 12 }
  ]);
});

test('unchanged archive days reuse their file index', async t => {
  const { recordingsFolder, library } = fixture();
  const archived = recording(recordingsFolder, '2026-08-16', 'Recording.mp4', 'video');
  const originalStat = fs.promises.stat;
  let fileStats = 0;
  t.mock.method(fs.promises, 'stat', async target => {
    if (path.resolve(target) === path.resolve(archived)) fileStats += 1;
    return originalStat.call(fs.promises, target);
  });

  await library.archivedRecordings();
  await library.archivedRecordings();

  assert.equal(fileStats, 1);
});

test('age cleanup deletes only expired raw footage and preserves favorites and exports', async () => {
  const { recordingsFolder, library } = fixture();
  const expired = recording(recordingsFolder, '2026-08-14', 'Recording.mkv');
  const favorite = recording(recordingsFolder, '2026-08-14', 'Favorite.mkv');
  const replay = recording(recordingsFolder, '2026-08-14', 'Replay 1.mkv');
  const trimmed = recording(recordingsFolder, '2026-08-14', 'Recording-trimmed.mkv');
  const mixed = recording(recordingsFolder, '2026-08-14', 'Recording-mixed-2.mkv');
  const compilation = recording(recordingsFolder, '2026-08-14', 'Compilation-1724350000000.mkv');
  const current = recording(recordingsFolder, '2026-08-16', 'Recording.mkv');
  library.setFavorite(favorite, true);

  await library.cleanupStorage(folder => fs.mkdirSync(folder, { recursive: true }));

  assert.equal(fs.existsSync(expired), false);
  for (const preserved of [favorite, replay, trimmed, mixed, compilation, current]) assert.equal(fs.existsSync(preserved), true);
});

test('disk cleanup excludes derived exports from the raw-footage byte limit', async t => {
  const { recordingsFolder, library } = fixture({
    storageCleanupMode: 'disk',
    maxDiskUsagePercent: 99,
    maxRawRecordingGigabytes: 1
  });
  const raw = recording(recordingsFolder, '2026-08-14', 'Recording.mkv');
  const mixed = recording(recordingsFolder, '2026-08-14', 'Recording-mixed.mkv');
  const compilation = recording(recordingsFolder, '2026-08-14', 'Compilation-1724350000000.mkv');
  for (const file of [raw, mixed, compilation]) fs.truncateSync(file, 600 * 1024 ** 2);
  t.mock.method(fs.promises, 'statfs', async () => ({ blocks: 100, bavail: 50 }));

  await library.cleanupStorage(folder => fs.mkdirSync(folder, { recursive: true }));

  for (const preserved of [raw, mixed, compilation]) assert.equal(fs.existsSync(preserved), true);
});

test('disk cleanup scans raw recordings once while deleting multiple files', async t => {
  const { recordingsFolder, library } = fixture({
    storageCleanupMode: 'disk',
    maxDiskUsagePercent: 99,
    maxRawRecordingGigabytes: 1
  });
  const first = recording(recordingsFolder, '2026-08-13', 'Recording-1.mkv');
  const second = recording(recordingsFolder, '2026-08-14', 'Recording-2.mkv');
  const third = recording(recordingsFolder, '2026-08-15', 'Recording-3.mkv');
  for (const file of [first, second, third]) fs.truncateSync(file, 600 * 1024 ** 2);
  const originalReaddir = fs.promises.readdir;
  let rootScans = 0;
  t.mock.method(fs.promises, 'readdir', async (target, options) => {
    if (path.resolve(target) === path.resolve(recordingsFolder)) rootScans += 1;
    return originalReaddir.call(fs.promises, target, options);
  });

  await library.cleanupStorage(folder => fs.mkdirSync(folder, { recursive: true }));

  assert.equal(rootScans, 1);
  assert.equal(fs.existsSync(first), false);
  assert.equal(fs.existsSync(second), false);
  assert.equal(fs.existsSync(third), true);
});

test('recording path validation rejects a directory link that escapes the library', { skip: process.platform !== 'win32' }, () => {
  const { base, recordingsFolder, library } = fixture();
  const outside = path.join(base, 'outside'); fs.mkdirSync(outside);
  const recordingPath = recording(outside, '.', 'Recording.mkv');
  const linkedDay = path.join(recordingsFolder, '2026-08-16');
  fs.symlinkSync(outside, linkedDay, 'junction');
  assert.throws(() => library.validatePath(path.join(linkedDay, path.basename(recordingPath))), /no longer exists/);
});

test('recording path validation rejects missing and outside files', () => {
  const { base, recordingsFolder, library } = fixture();
  const inside = recording(recordingsFolder, '2026-08-17', 'Recording.mkv');
  const outside = path.join(base, 'outside.mkv'); fs.writeFileSync(outside, 'video');
  assert.equal(library.validatePath(inside), inside);
  assert.throws(() => library.validatePath(outside), /no longer exists/);
  assert.throws(() => library.validatePath(path.join(recordingsFolder, 'missing.mkv')), /no longer exists/);
});

test('raw recording classification excludes replays and generated exports', () => {
  assert.equal(isRawRecordingName('Recording.mkv'), true);
  assert.equal(isRawRecordingName('Replay-123.mkv'), false);
  assert.equal(isRawRecordingName('Recording-trimmed-2.mp4'), false);
  assert.equal(isRawRecordingName('Compilation-1724350000000.mkv'), false);
  assert.equal(isRawRecordingName('compilation-123.MP4'), false);
  assert.equal(isRawRecordingName('Recording-mixed.mov'), false);
  assert.equal(isRawRecordingName('Recording-mixed-10.flv'), false);
  assert.equal(isRawRecordingName('Recording-mixed-mixed-2.webm'), false);
  assert.equal(isRawRecordingName('Compilation.mkv'), true);
  assert.equal(isRawRecordingName('My-Compilation-123.mkv'), true);
  assert.equal(isRawRecordingName('Recording-mixed-up.mkv'), true);
  assert.equal(isRawRecordingName('Recording-mixed-2-extra.mkv'), true);
  assert.equal(isRawRecordingName('notes.txt'), false);
});
