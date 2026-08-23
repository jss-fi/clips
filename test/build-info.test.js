const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  releaseConfigFromEnv,
  runtimeComponentsFromResources,
  verifyRuntimeAbi
} = require('../scripts/write-build-info');

test('release configuration supports every endpoint combination independently', () => {
  assert.deepEqual(releaseConfigFromEnv({}), {});
  assert.deepEqual(releaseConfigFromEnv({ CLIPS_UPDATE_URL: 'https://updates.example.test/' }), {
    updateUrl: 'https://updates.example.test'
  });
  assert.deepEqual(releaseConfigFromEnv({ CLIPS_TELEMETRY_URL: 'https://telemetry.example.test/' }), {
    telemetryUrl: 'https://telemetry.example.test'
  });
  assert.deepEqual(releaseConfigFromEnv({
    CLIPS_UPDATE_URL: 'https://updates.example.test/cdn/',
    CLIPS_TELEMETRY_URL: 'https://telemetry.example.test/events/'
  }), {
    updateUrl: 'https://updates.example.test/cdn',
    telemetryUrl: 'https://telemetry.example.test/events'
  });
});

test('release configuration rejects insecure configured endpoints', () => {
  assert.throws(() => releaseConfigFromEnv({ CLIPS_UPDATE_URL: 'http://updates.example.test' }), /HTTPS/);
  assert.throws(() => releaseConfigFromEnv({ CLIPS_TELEMETRY_URL: 'file://telemetry' }), /HTTPS/);
});

test('release builds fail closed when staged OBS changes without a runtime ABI bump', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clips-runtime-abi-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const obsPath = path.join(directory, 'obs.dll');
  const manifestPath = path.join(directory, 'runtime-abi.json');
  fs.writeFileSync(obsPath, 'pinned obs runtime');
  fs.writeFileSync(manifestPath, JSON.stringify({
    runtimeVersion: 2,
    obsSha256: crypto.createHash('sha256').update('pinned obs runtime').digest('hex')
  }));
  assert.equal(verifyRuntimeAbi({ manifestPath, obsPath }).runtimeVersion, 2);
  fs.writeFileSync(obsPath, 'different obs runtime');
  assert.throws(() => verifyRuntimeAbi({ manifestPath, obsPath }), /changed without an ABI declaration/);
});

test('build metadata anchors required and supplemental runtime hashes by installed path', t => {
  const resources = fs.mkdtempSync(path.join(os.tmpdir(), 'clips-runtime-components-'));
  t.after(() => fs.rmSync(resources, { recursive: true, force: true }));
  const requiredSources = {
    'libobs/bin/64bit/obs.dll': 'libobs/bin/64bit/obs.dll',
    'libobs/bin/64bit/clips-capture-host.exe': 'capture-host/clips-capture-host.exe',
    'libobs/obs-plugins/64bit/win-capture.dll': 'libobs/obs-plugins/64bit/win-capture.dll',
    'libobs/obs-plugins/64bit/win-wasapi.dll': 'libobs/obs-plugins/64bit/win-wasapi.dll',
    'libobs/obs-plugins/64bit/obs-ffmpeg.dll': 'libobs/obs-plugins/64bit/obs-ffmpeg.dll',
    'ffmpeg/ffmpeg.exe': 'ffmpeg/ffmpeg.exe',
    'libmpv/mpv-host.exe': 'libmpv/mpv-host.exe',
    'libmpv/libmpv-2.dll': 'libmpv/libmpv-2.dll'
  };
  const expectedRequired = {};
  for (const [relative, sourceRelative] of Object.entries(requiredSources)) {
    const source = path.join(resources, ...sourceRelative.split('/'));
    const contents = `trusted ${relative}`;
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, contents);
    expectedRequired[relative] = crypto.createHash('sha256').update(contents).digest('hex');
  }
  const executable = path.join(resources, 'mpv', 'mpv.exe');
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, 'trusted standalone mpv');

  assert.deepEqual(runtimeComponentsFromResources(resources), {
    schema: 1,
    requiredFiles: expectedRequired,
    supplementalFiles: {
      'mpv/mpv.exe': crypto.createHash('sha256').update('trusted standalone mpv').digest('hex')
    }
  });
});
