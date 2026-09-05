const assert = require('node:assert/strict');
const test = require('node:test');
const { ObsController } = require('../src/obs');
const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');

test('stdin EPIPE rejects pending requests without an uncaught stream error', async t => {
  const failure = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => { child.killed = true; };
  child.stdin = new Writable({ write(chunk, encoding, callback) { callback(failure); } });
  t.mock.method(childProcess, 'spawn', () => child);
  const controller = new ObsController();
  await assert.rejects(controller.connect({ executable: 'capture-host', runtimeRoot: '.', settings: {} }), /EPIPE/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(controller.child, null);
  assert.equal(controller.pending.size, 0);
  assert.equal(child.killed, true);
  const replacement = {};
  controller.child = replacement;
  child.stdin.emit('error', failure);
  assert.equal(controller.child, replacement);
});

test('shutdown blocks polling before the engine closes its pipe', async () => {
  const controller = new ObsController();
  const commands = [];
  controller.connected = true;
  controller.child = {
    kill() {},
    stdin: { writable: true, write(line) { commands.push(JSON.parse(line)); } }
  };
  const shutdown = controller.disconnect();
  await assert.rejects(controller.request('microphoneLevel'), /offline/);
  assert.equal((await controller.status()).connected, false);
  assert.deepEqual(commands.map(request => request.command), ['shutdown']);
  controller.handleStdout(`${JSON.stringify({ id: commands[0].id, ok: true })}\n`);
  await shutdown;
  assert.equal(controller.pending.size, 0);
});

test('synchronous pipe failures clear all pending requests and terminate the host', async () => {
  const controller = new ObsController();
  const child = { stdin: { writable: true, write() {} }, kill() { this.killed = true; } };
  controller.child = child;
  const pending = controller.request('status');
  child.stdin.write = () => { throw new Error('write EPIPE'); };
  await Promise.all([
    assert.rejects(pending, /EPIPE/),
    assert.rejects(controller.request('microphoneLevel'), /EPIPE/)
  ]);
  assert.equal(controller.pending.size, 0);
  assert.equal(child.killed, true);
});

test('stopSession allows the capture engine time to finalize its outputs', async () => {
  const controller = new ObsController();
  controller.connected = true;

  let request;
  controller.request = async (...args) => {
    request = args;
  };

  await controller.stopSession();

  assert.deepEqual(request, ['stop', {}, 60000]);
});

test('startSession sends the selected microphone and desktop audio to the capture engine', async () => {
  const controller = new ObsController();
  controller.applications = [];

  let request;
  controller.request = async (...args) => {
    request = args;
  };

  await controller.startSession('C:\\Clips', [], 'microphone-id', 75, -35, true);

  assert.equal(request[0], 'start');
  assert.equal(request[1].microphoneDeviceId, 'microphone-id');
  assert.equal(request[1].microphoneVolumePercent, 75);
  assert.equal(request[1].microphoneNoiseGateDb, -35);
  assert.equal(request[1].microphoneNvidiaNoiseRemoval, true);
  assert.equal(request[1].applications[0].captureDisplay, true);
  assert.equal(request[1].applications[0].captureVideo, true);
  assert.equal(request[1].applications[0].captureAudio, true);
});

test('stopRecording leaves replay-buffer lifecycle to the capture engine', async () => {
  const controller = new ObsController();
  controller.connected = true;
  let request;
  controller.request = async (...args) => { request = args; };
  await controller.stopRecording();
  assert.deepEqual(request, ['stopRecording', {}, 60000]);
});

test('microphone volume is sent to the running capture engine', async () => {
  const controller = new ObsController();
  controller.connected = true;
  let request;
  controller.request = async (...args) => { request = args; };
  await controller.setMicrophoneVolume(125);
  assert.deepEqual(request, ['microphoneVolume', { microphoneVolumePercent: 125 }]);
});

test('capture status retains frame-drop health counters', async () => {
  const controller = new ObsController();
  let status;
  controller.pending.set(7, {
    resolve: response => { status = response; },
    reject: assert.fail,
    timeout: setTimeout(() => {}, 1000)
  });

  controller.handleStdout(`${JSON.stringify({
    id: 7, ok: true, connected: true, recording: true, replayBuffer: true,
    durationMs: 5000, renderedFrames: 300, laggedFrames: 4, outputFrames: 296, droppedFrames: 2
  })}\n`);

  assert.equal(status.ok, true);
  assert.deepEqual(controller.lastStatus, {
    connected: true, recording: true, replayBuffer: true, durationMs: 5000,
    renderedFrames: 300, laggedFrames: 4, outputFrames: 296, droppedFrames: 2
  });
});

test('capture initialization retains available and selected encoders', async () => {
  const controller = new ObsController();
  controller.connected = true;
  controller.settings = { clipLengthSeconds: 60 };
  let request;
  controller.request = async (...args) => {
    request = args;
    return {
    encoders: [{ id: 'obs_x264', name: 'Software (x264)' }],
    selectedEncoder: 'obs_x264'
    };
  };

  await controller.applyRecordingSettings({
    quality: 'HQ', encoder: 'obs_x264', resolution: '1920x1080', fps: 60, format: 'mkv', clipLengthSeconds: 60
  });

  assert.equal(request[1].encoder, 'obs_x264');
  assert.deepEqual(controller.availableEncoders, [{ id: 'obs_x264', name: 'Software (x264)' }]);
  assert.equal(controller.selectedEncoder, 'obs_x264');
});

test('high-frequency microphone meter polling stays out of the log', () => {
  const events = [];
  const controller = new ObsController(null, { info: (...args) => events.push(args) });
  controller.child = { stdin: { writable: true, write: () => {} } };
  controller.request('microphoneLevel', {}, 1).catch(() => {});
  assert.equal(events.length, 0);
});

test('a timed out request terminates the unresponsive capture engine', async () => {
  const controller = new ObsController();
  let killed = false;
  controller.connected = true;
  controller.child = {
    killed: false,
    kill: () => { killed = true; },
    stdin: { writable: true, write: () => {} }
  };

  await assert.rejects(controller.request('start', {}, 1), /timed out while handling start/);

  assert.equal(killed, true);
  assert.equal(controller.child, null);
  assert.equal(controller.connected, false);
  assert.equal(controller.pending.size, 0);
});

test('a timed out request rejects other requests queued behind it', async () => {
  const controller = new ObsController();
  controller.connected = true;
  controller.child = {
    killed: false,
    kill: () => {},
    stdin: { writable: true, write: () => {} }
  };

  const blocked = controller.request('status', {}, 1000);
  const timedOut = controller.request('start', {}, 1);
  await assert.rejects(timedOut, /timed out while handling start/);
  await assert.rejects(blocked, /timed out while handling start/);
});

test('an error from a replaced child cannot disconnect the active capture engine', () => {
  const controller = new ObsController();
  const stale = {};
  const active = { stdin: { writable: true } };
  controller.child = active;
  controller.handleChildError(stale, new Error('stale'));
  assert.equal(controller.child, active);
});
