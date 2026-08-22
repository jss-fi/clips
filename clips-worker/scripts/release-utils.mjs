function limiter(maximum) {
  let active = 0;
  const waiting = [];
  const run = () => {
    while (active < maximum && waiting.length) {
      const { task, resolve, reject } = waiting.shift();
      active += 1;
      Promise.resolve().then(task).then(resolve, reject).finally(() => { active -= 1; run(); });
    }
  };
  return task => new Promise((resolve, reject) => { waiting.push({ task, resolve, reject }); run(); });
}

const VERSIONED_ARTIFACTS = [
  /^jss-clips-(?:update|setup|portable)-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-(?:x64|arm64)\.(?:exe|exe\.blockmap)$/,
  /^jss-clips-app-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-x64\.zip$/,
  /^jss-clips-source-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.zip$/
];
const RELEASE_MARKER = /^\.published-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.json$/;

function artifactVersion(key) {
  const name = String(key || '').split('/').at(-1);
  return VERSIONED_ARTIFACTS.map(pattern => pattern.exec(name)?.[1]).find(Boolean) || null;
}

function releaseArtifactNames(version) {
  const names = [
    `jss-clips-update-${version}-x64.exe`,
    `jss-clips-update-${version}-x64.exe.blockmap`,
    `jss-clips-app-${version}-x64.zip`,
    `jss-clips-source-${version}.zip`
  ];
  if (!version.includes('-')) names.push(`jss-clips-setup-${version}-x64.exe`);
  return names;
}

function releaseMarkerName(version) {
  return `.published-${version}.json`;
}

function releaseMarkerVersion(key) {
  const name = String(key || '').split('/').at(-1);
  return RELEASE_MARKER.exec(name)?.[1] || null;
}

function parseReleaseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version);
  if (!match) return null;
  const prerelease = match[4]?.split('.') || [];
  const sortableNightly = prerelease[0]?.toLowerCase() === 'nightly'
    ? /^n(\d{6})$/i.exec(prerelease[1])
    : null;
  if (sortableNightly) prerelease[1] = String(Number(sortableNightly[1]));
  return {
    core: match.slice(1, 4).map(Number),
    prerelease
  };
}

function compareReleaseVersions(left, right) {
  const a = parseReleaseVersion(left);
  const b = parseReleaseVersion(right);
  if (!a || !b) return left.localeCompare(right);
  for (let index = 0; index < a.core.length; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] - b.core[index];
  }
  if (!a.prerelease.length || !b.prerelease.length) {
    return a.prerelease.length === b.prerelease.length ? 0 : (a.prerelease.length ? -1 : 1);
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    if (a.prerelease[index] === undefined) return -1;
    if (b.prerelease[index] === undefined) return 1;
    if (a.prerelease[index] === b.prerelease[index]) continue;
    const aNumeric = /^\d+$/.test(a.prerelease[index]);
    const bNumeric = /^\d+$/.test(b.prerelease[index]);
    if (aNumeric && bNumeric) return Number(a.prerelease[index]) - Number(b.prerelease[index]);
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a.prerelease[index].localeCompare(b.prerelease[index]);
  }
  return 0;
}

function releaseRetentionPlan(objects, retainedVersionCount = 3) {
  if (!Number.isSafeInteger(retainedVersionCount) || retainedVersionCount < 1) {
    throw new Error('retainedVersionCount must be a positive integer.');
  }
  const releases = new Map();
  const markers = new Map();
  for (const object of objects) {
    const markerVersion = releaseMarkerVersion(object.Key);
    if (markerVersion) {
      markers.set(markerVersion, object);
      continue;
    }
    const version = artifactVersion(object.Key);
    if (!version) continue;
    if (!releases.has(version)) releases.set(version, { names: new Set(), objects: [] });
    const release = releases.get(version);
    release.names.add(String(object.Key).split('/').at(-1));
    release.objects.push(object);
  }
  const complete = [...releases.entries()].filter(([version, release]) =>
    markers.has(version) && releaseArtifactNames(version).every(name => release.names.has(name)));
  const versions = complete.map(([version]) => version).sort((a, b) => compareReleaseVersions(b, a));
  const completeVersions = new Set(versions);
  const retainedVersions = versions.slice(0, retainedVersionCount);
  const deletedVersions = versions.slice(retainedVersionCount);
  const incompleteVersions = [...markers.keys()]
    .filter(version => !completeVersions.has(version))
    .sort((a, b) => compareReleaseVersions(b, a));
  const unmarkedVersions = [...releases.keys()]
    .filter(version => !markers.has(version))
    .sort((a, b) => compareReleaseVersions(b, a));
  const unmarkedCompleteVersions = unmarkedVersions.filter(version =>
    releaseArtifactNames(version).every(name => releases.get(version).names.has(name)));
  const unmarkedIncompleteVersions = unmarkedVersions.filter(version =>
    !unmarkedCompleteVersions.includes(version));
  return {
    retainedVersions,
    deletedVersions,
    incompleteVersions,
    unmarkedVersions,
    unmarkedCompleteVersions,
    unmarkedIncompleteVersions,
    deleteObjects: deletedVersions.flatMap(version => [...releases.get(version).objects, markers.get(version)]),
    incompleteObjects: incompleteVersions.flatMap(version => [
      ...(releases.get(version)?.objects || []),
      markers.get(version)
    ]),
    unmarkedCompleteObjects: unmarkedCompleteVersions.flatMap(version => releases.get(version).objects),
    unmarkedIncompleteObjects: unmarkedIncompleteVersions.flatMap(version => releases.get(version).objects)
  };
}

async function publishMetadataPair(names, operations) {
  const previous = new Map();
  for (const name of names) {
    const value = await operations.readPrevious(name);
    if (value !== null) previous.set(name, value);
  }
  const published = [];
  try {
    for (const name of names) {
      await operations.publishAndVerify(name);
      published.push(name);
    }
  } catch (error) {
    const rollback = await Promise.allSettled(published.map(name => previous.has(name)
      ? operations.restore(name, previous.get(name))
      : operations.remove(name)));
    const failed = rollback.filter(result => result.status === 'rejected');
    if (failed.length) throw new AggregateError([error, ...failed.map(result => result.reason)], 'Metadata publication and rollback both failed.');
    throw new Error(`Metadata publication rolled back after failure: ${error.message}`);
  }
}

export {
  artifactVersion, compareReleaseVersions, limiter, publishMetadataPair, releaseArtifactNames,
  releaseMarkerName, releaseMarkerVersion, releaseRetentionPlan
};
