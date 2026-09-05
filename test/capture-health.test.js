const test = require('node:test');
const assert = require('node:assert/strict');
const { CaptureHealth } = require('../src/capture-health');

function sample(health, now, laggedFrames, options = {}) {
  return health.inspect({ recording: true, renderedFrames: now, outputFrames: now, laggedFrames, droppedFrames: 0, ...options.status }, {
    now, applications: [{ name: 'Game.exe', isForeground: true }], targets: ['game.exe'], sessionId: 1, ...options
  });
}

test('game close silences warnings even when another configured game is running', () => {
  const health = new CaptureHealth();
  sample(health, 1000, 0);
  sample(health, 11000, 0);
  assert.equal(sample(health, 16000, 6).warning, true);
  assert.equal(sample(health, 80000, 100, { applications: [{ name: 'other.exe', isForeground: true }] }), null);
  assert.equal(sample(health, 90000, 200, { applications: [] }), null);
});

test('Alt+Tab out and back discards background drops and the entire return grace interval', () => {
  const health = new CaptureHealth();
  sample(health, 1000, 0);
  sample(health, 11000, 0);
  assert.equal(sample(health, 16000, 5).warning, false);
  assert.equal(sample(health, 21000, 50, { applications: [{ name: 'game.exe', isForeground: false }] }), null);
  assert.equal(sample(health, 26000, 100), null);
  assert.equal(sample(health, 31000, 200), null);
  assert.equal(sample(health, 37000, 300), null);
  assert.equal(sample(health, 42000, 305).warning, false);
  assert.equal(sample(health, 47000, 305), null);
  assert.equal(sample(health, 52000, 311).warning, true);
});

test('normal foreground warnings retain burst, sustained-loss and cooldown thresholds', () => {
  const health = new CaptureHealth();
  sample(health, 1000, 0);
  sample(health, 11000, 0);
  assert.equal(sample(health, 16000, 4).warning, false);
  assert.equal(sample(health, 21000, 8).warning, false);
  assert.equal(sample(health, 26000, 12).warning, true);
  assert.equal(sample(health, 31000, 20).warning, false);
  assert.equal(sample(health, 91000, 30).warning, true);
});

test('desktop recording still warns without a foreground game', () => {
  const health = new CaptureHealth();
  const options = { targets: [], applications: [] };
  assert.equal(sample(health, 1000, 0, options), null);
  assert.equal(sample(health, 6000, 6, options).warning, true);
});

test('recording restart and counter reset discard previous loss windows', () => {
  const health = new CaptureHealth();
  sample(health, 1000, 0);
  sample(health, 11000, 0);
  sample(health, 16000, 5);
  assert.equal(sample(health, 21000, 0), null);
  assert.equal(sample(health, 26000, 5).warning, false);
  assert.equal(sample(health, 31000, 100, { sessionId: 2 }), null);
  assert.equal(sample(health, 41000, 200, { sessionId: 2 }), null);
  assert.equal(sample(health, 46000, 205, { sessionId: 2 }).warning, false);
  assert.equal(sample(health, 51000, 300, { status: { recording: false } }), null);
});
