const assert = require('node:assert/strict');
const test = require('node:test');

let workflow;
test.before(async () => { workflow = await import('../scripts/release.mjs'); });

test('release specs infer nightly and stable channels from one version argument', () => {
  assert.deepEqual(workflow.parseReleaseSpec('0.7-nightly'), { base: '0.7', channel: 'nightly' });
  assert.deepEqual(workflow.parseReleaseSpec('0.7'), { base: '0.7', channel: 'stable' });
  assert.throws(() => workflow.parseReleaseSpec('0.7.0'), /must look like/);
  assert.throws(() => workflow.parseReleaseSpec('nightly'), /must look like/);
});

test('the next development line follows the latest stable minor', () => {
  assert.equal(workflow.nextDevelopmentLine('0.6'), '0.7');
  assert.equal(workflow.nextDevelopmentLine('2.19'), '2.20');
});

test('worktree porcelain parsing preserves the primary worktree and branches', () => {
  const parsed = workflow.parseWorktrees([
    'worktree G:/clips',
    'HEAD aaaaaaaa',
    'branch refs/heads/main',
    '',
    'worktree C:/worktrees/release',
    'HEAD bbbbbbbb',
    'branch refs/heads/feature/release'
  ].join('\n'));
  assert.equal(parsed[0].worktree, 'G:/clips');
  assert.equal(parsed[0].branch, 'refs/heads/main');
  assert.equal(parsed[1].worktree, 'C:/worktrees/release');
});

test('runtime-affecting changes select a fresh build while application changes do not', () => {
  assert.equal(workflow.requiresFreshRuntime(['src/main.js', 'test/updater.test.js']), false);
  assert.equal(workflow.requiresFreshRuntime(['native/capture-host.cpp']), true);
  assert.equal(workflow.requiresFreshRuntime(['scripts/stage-ffmpeg.ps1']), true);
  assert.equal(workflow.requiresFreshRuntime(['electron-builder.bootstrap.json']), true);
  assert.equal(workflow.requiresFreshRuntime(['package-lock.json']), true);
});
