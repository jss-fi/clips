const test = require('node:test');
const assert = require('node:assert/strict');
const { parseProcessList } = require('../src/process-list');
const { updateCandidateHistory } = require('../src/game-candidates');

test('process list parsing normalizes a single PowerShell object', () => {
  assert.deepEqual(parseProcessList('{"name":"game.exe","path":null,"title":"Game","windowClass":"GameWnd","bounds":null}'), [{
    name: 'game.exe', path: '', title: 'Game', windowClass: 'GameWnd', isFullscreen: false, isForeground: false, bounds: null
  }]);
});

test('process list parsing preserves fullscreen game candidates', () => {
  const [game] = parseProcessList('{"name":"Subnautica2-Win64-Shipping.exe","path":"C:\\\\Games\\\\Subnautica2.exe","title":"Subnautica 2","windowClass":"UnrealWindow","isFullscreen":true,"bounds":{"x":0,"y":0,"width":2560,"height":1440}}');
  const history = new Map();

  assert.equal(game.isFullscreen, true);
  assert.deepEqual(updateCandidateHistory(history, [game], [], [], 1000), []);
  assert.deepEqual(updateCandidateHistory(history, [game], [], [], 16001), [game]);
});

test('process list parsing rejects incomplete PowerShell JSON', () => {
  assert.throws(() => parseProcessList('[{"name":"game.exe"}'), SyntaxError);
});

test('process list preserves explicit foreground state and defaults unknown focus to false', () => {
  const processes = parseProcessList('[{"name":"game.exe","isForeground":true},{"name":"other.exe","isForeground":"true"}]');
  assert.deepEqual(processes.map(process => process.isForeground), [true, false]);
});
