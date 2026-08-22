const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('release upload limiter enforces concurrency while completing every task', async () => {
  const { limiter } = await import('../clips-worker/scripts/release-utils.mjs');
  const schedule = limiter(3);
  let active = 0;
  let maximum = 0;
  const completed = [];
  await Promise.all(Array.from({ length: 12 }, (_, index) => schedule(async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => setImmediate(resolve));
    completed.push(index);
    active -= 1;
  })));
  assert.equal(maximum, 3);
  assert.deepEqual(completed.sort((a, b) => a - b), Array.from({ length: 12 }, (_, index) => index));
});

test('release completion is marked after public verification and before archival', () => {
  const publisher = fs.readFileSync(path.join(__dirname, '..', 'clips-worker', 'scripts', 'publish.ps1'), 'utf8');
  const publicVerification = publisher.indexOf('verify-public-release.mjs');
  const completionMarker = publisher.indexOf('$Channel $Version mark');
  const archival = publisher.indexOf('$archiveScript =');
  assert.ok(publicVerification >= 0);
  assert.ok(completionMarker > publicVerification);
  assert.ok(archival > completionMarker);
});

test('release retention keeps the newest three complete version groups', async () => {
  const { artifactVersion, releaseArtifactNames, releaseMarkerName, releaseRetentionPlan } = await import('../clips-worker/scripts/release-utils.mjs');
  const versions = [
    '0.6.0-nightly.n000009.aaaaaaaa',
    '0.6.0-nightly.n000012.dddddddd',
    '0.6.0-nightly.n000010.bbbbbbbb',
    '0.6.0-nightly.n000011.cccccccc'
  ];
  const objects = versions.flatMap(version => [
    ...releaseArtifactNames(version).map(name => ({ Key: `releases/${name}`, Size: 100 })),
    { Key: `releases/${releaseMarkerName(version)}`, Size: 100 }
  ]);
  objects.push({ Key: 'releases/latest.json', Size: 1 });

  assert.equal(artifactVersion('releases/stable/jss-clips-app-0.6.0-x64.zip'), '0.6.0');
  assert.equal(artifactVersion('releases/latest.yml'), null);
  assert.deepEqual(releaseRetentionPlan(objects), {
    retainedVersions: versions.slice(1).sort().reverse(),
    deletedVersions: [versions[0]],
    incompleteVersions: [],
    unmarkedVersions: [],
    unmarkedCompleteVersions: [],
    unmarkedIncompleteVersions: [],
    deleteObjects: objects.slice(0, 5),
    incompleteObjects: [],
    unmarkedCompleteObjects: [],
    unmarkedIncompleteObjects: []
  });
});

test('release retention understands stable and legacy nightly version ordering', async () => {
  const {
    compareReleaseVersions, releaseArtifactNames, releaseMarkerName, releaseRetentionPlan
  } = await import('../clips-worker/scripts/release-utils.mjs');
  assert.ok(compareReleaseVersions('0.6.0', '0.6.0-nightly.n000099.aaaaaaaa') > 0);
  assert.ok(compareReleaseVersions('0.6.0-nightly.n000001.bbbbbbbb', '0.5.0-nightly.20.aaaaaaaa') > 0);
  assert.equal(compareReleaseVersions('0.5.0-nightly.19.aaaaaaaa', '0.5.0-nightly.n000019.aaaaaaaa'), 0);
  assert.ok(compareReleaseVersions('0.5.0-nightly.n000019.bbbbbbbb', '0.5.0-nightly.18.aaaaaaaa') > 0);
  assert.ok(compareReleaseVersions('0.5.0-nightly.20.cccccccc', '0.5.0-nightly.n000019.bbbbbbbb') > 0);
  const objects = ['0.4.0', '0.5.0', '0.6.0', '0.7.0'].flatMap(version => [
    ...releaseArtifactNames(version).map(name => ({ Key: `releases/stable/${name}`, Size: 100 })),
    { Key: `releases/stable/${releaseMarkerName(version)}`, Size: 100 }
  ]);
  assert.deepEqual(releaseRetentionPlan(objects).deletedVersions, ['0.4.0']);
});

test('unmarked full and partial uploads do not occupy published release retention slots', async () => {
  const {
    releaseArtifactNames, releaseMarkerName, releaseRetentionPlan
  } = await import('../clips-worker/scripts/release-utils.mjs');
  const completeVersions = [
    '0.6.0-nightly.n000009.aaaaaaaa',
    '0.6.0-nightly.n000010.bbbbbbbb',
    '0.6.0-nightly.n000011.cccccccc'
  ];
  const unmarkedCompleteVersion = '0.6.0-nightly.n000012.dddddddd';
  const unmarkedPartialVersion = '0.6.0-nightly.n000013.eeeeeeee';
  const objects = completeVersions.flatMap(version => [
    ...releaseArtifactNames(version).map(name => ({ Key: `releases/${name}`, Size: 100 })),
    { Key: `releases/${releaseMarkerName(version)}`, Size: 100 }
  ]);
  objects.push(...releaseArtifactNames(unmarkedCompleteVersion).map(name => ({ Key: `releases/${name}`, Size: 100 })));
  objects.push({ Key: `releases/${releaseArtifactNames(unmarkedPartialVersion)[0]}`, Size: 100 });

  const plan = releaseRetentionPlan(objects);
  assert.deepEqual(plan.retainedVersions, completeVersions.slice().reverse());
  assert.deepEqual(plan.deletedVersions, []);
  assert.deepEqual(plan.incompleteVersions, []);
  assert.deepEqual(plan.unmarkedVersions, [unmarkedPartialVersion, unmarkedCompleteVersion]);
  assert.deepEqual(plan.unmarkedCompleteVersions, [unmarkedCompleteVersion]);
  assert.deepEqual(plan.unmarkedIncompleteVersions, [unmarkedPartialVersion]);
  assert.deepEqual(plan.deleteObjects, []);
  assert.equal(plan.unmarkedCompleteObjects.length, 4);
  assert.equal(plan.unmarkedIncompleteObjects.length, 1);
});

test('dual update metadata publication rolls back the first feed on partial failure', async () => {
  const { publishMetadataPair } = await import('../clips-worker/scripts/release-utils.mjs');
  const live = new Map([['latest.json', 'old-json'], ['latest.yml', 'old-yml']]);
  await assert.rejects(publishMetadataPair(['latest.json', 'latest.yml'], {
    readPrevious: async name => live.get(name) ?? null,
    publishAndVerify: async name => {
      if (name === 'latest.yml') throw new Error('injected second-write failure');
      live.set(name, 'new-json');
    },
    restore: async (name, body) => live.set(name, body),
    remove: async name => live.delete(name)
  }), /rolled back/);
  assert.equal(live.get('latest.json'), 'old-json');
  assert.equal(live.get('latest.yml'), 'old-yml');
});
