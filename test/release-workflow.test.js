const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { signMetadata, signPackageMetadata } = require('../scripts/update-signature');

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

test('stable releases always build a setup installer without unnecessarily restaging the runtime', () => {
  assert.deepEqual(workflow.releaseBuildScripts({ channel: 'nightly' }, false), ['dist:release']);
  assert.deepEqual(workflow.releaseBuildScripts({ channel: 'stable' }, false), ['dist:bootstrap', 'dist:release']);
  assert.deepEqual(workflow.releaseBuildScripts({ channel: 'stable' }, true), ['dist:fresh', 'dist:release']);
  assert.ok(workflow.releaseArtifactNames('0.7.0').includes('jss-clips-setup-0.7.0-x64.exe'));
});

test('metadata preparation restores files and the index callback when commit work fails', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'clips-release-rollback-'));
  const first = path.join(temporary, 'package.json');
  const second = path.join(temporary, 'changelog.json');
  fs.writeFileSync(first, 'original package');
  fs.writeFileSync(second, 'original changelog');
  let unstaged = false;
  try {
    assert.throws(() => workflow.withFileRollback([first, second], () => {
      fs.writeFileSync(first, 'versioned package');
      fs.writeFileSync(second, 'versioned changelog');
      throw new Error('commit hook rejected metadata');
    }, () => { unstaged = true; }), /commit hook rejected metadata/);
    assert.equal(fs.readFileSync(first, 'utf8'), 'original package');
    assert.equal(fs.readFileSync(second, 'utf8'), 'original changelog');
    assert.equal(unstaged, true);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('prepared retries reuse only the exact signed artifact set recorded after the build', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'clips-release-artifacts-'));
  const dist = path.join(temporary, 'dist');
  const manifestPath = path.join(temporary, '.clips-release.json');
  const version = '0.7.0-nightly.n000001.aaaaaaaa';
  const commit = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  fs.mkdirSync(dist);
  try {
    for (const name of workflow.releaseArtifactNames(version)) fs.writeFileSync(path.join(dist, name), `contents:${name}`);
    const appName = `jss-clips-app-${version}-x64.zip`;
    const app = fs.readFileSync(path.join(dist, appName));
    const staged = {
      version,
      url: appName,
      sha512: crypto.createHash('sha512').update(app).digest('base64'),
      size: app.length,
      asarSha512: 'test-asar-hash',
      releaseDate: '2026-08-22T00:00:00.000Z'
    };
    staged.signature = signMetadata(staged, privateKey);
    staged.packageSignature = signPackageMetadata(staged, privateKey);
    fs.writeFileSync(path.join(dist, 'latest.json'), `${JSON.stringify(staged, null, 2)}\n`);

    const installerName = `jss-clips-update-${version}-x64.exe`;
    const installer = fs.readFileSync(path.join(dist, installerName));
    fs.writeFileSync(path.join(dist, 'latest.yml'), [
      `version: ${version}`,
      'files:',
      `  - url: ${installerName}`,
      `    sha512: ${crypto.createHash('sha512').update(installer).digest('base64')}`,
      `    size: ${installer.length}`,
      `path: ${installerName}`,
      `sha512: ${crypto.createHash('sha512').update(installer).digest('base64')}`
    ].join('\n'));

    await workflow.writeReleaseManifest({ dist, manifestPath, version, commit, publicKey });
    assert.equal(await workflow.canReuseReleaseManifest({ dist, manifestPath, version, commit, publicKey }), true);

    fs.appendFileSync(path.join(dist, `jss-clips-source-${version}.zip`), 'changed');
    await assert.rejects(
      workflow.canReuseReleaseManifest({ dist, manifestPath, version, commit, publicKey }),
      /artifact changed after it was built/
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
