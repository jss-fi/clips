const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadProjectEnv } = require('./env');
const { RUNTIME_VERSION, buildRuntimeComponentManifest } = require('../src/runtime');

const target = path.join(__dirname, '..', 'src', 'build-info.json');
const releaseConfigTarget = path.join(__dirname, '..', 'src', 'release-config.json');
const runtimeAbiTarget = path.join(__dirname, '..', 'src', 'runtime-abi.json');
const vendorRoot = path.join(__dirname, '..', 'vendor');
const bundledObs = path.join(__dirname, '..', 'vendor', 'libobs', 'bin', '64bit', 'obs.dll');

function runtimeComponentsFromResources(resourcesPath = vendorRoot) {
  return buildRuntimeComponentManifest(
    resourcesPath,
    path.join(resourcesPath, '.manifest-runtime', `v${RUNTIME_VERSION}`)
  );
}

function verifyRuntimeAbi({ manifestPath = runtimeAbiTarget, obsPath = bundledObs } = {}) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!Number.isSafeInteger(manifest.runtimeVersion) || manifest.runtimeVersion < 1 || !/^[0-9a-f]{64}$/i.test(manifest.obsSha256 || '')) {
    throw new Error('src/runtime-abi.json is invalid.');
  }
  const actual = crypto.createHash('sha256').update(fs.readFileSync(obsPath)).digest('hex');
  if (actual.toLowerCase() !== manifest.obsSha256.toLowerCase()) {
    throw new Error(`The staged OBS runtime changed without an ABI declaration. Bump RUNTIME_VERSION and update src/runtime-abi.json before building (expected ${manifest.obsSha256}, got ${actual}).`);
  }
  return manifest;
}
function releaseConfigFromEnv(env) {
  const baseUrl = String(env.CLIPS_BASE_URL || '').trim().replace(/\/+$/, '');
  const values = {
    updateUrl: String(env.CLIPS_UPDATE_URL || (baseUrl && `${baseUrl}${env.CLIPS_UPDATE_PATH || '/cdn'}`)).trim(),
    telemetryUrl: String(env.CLIPS_TELEMETRY_URL || (baseUrl && `${baseUrl}${env.CLIPS_TELEMETRY_PATH || '/telemetry'}`)).trim()
  };
  const releaseConfig = {};
  for (const [name, value] of Object.entries(values)) {
    if (!value) continue;
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:') throw new Error(`${name} must use HTTPS.`);
    releaseConfig[name] = parsed.href.replace(/\/$/, '');
  }
  return releaseConfig;
}

function writeBuildInfo(env = loadProjectEnv()) {
  const runtimeAbi = verifyRuntimeAbi();
  console.log(`Runtime ABI v${runtimeAbi.runtimeVersion}: ${runtimeAbi.obsSha256}`);
  const buildInfo = {
    buildTime: new Date().toISOString(),
    runtimeComponents: runtimeComponentsFromResources()
  };
  fs.writeFileSync(target, `${JSON.stringify(buildInfo, null, 2)}\n`);
  console.log(`Build time: ${buildInfo.buildTime}`);
  const releaseConfig = releaseConfigFromEnv(env);
  if (Object.keys(releaseConfig).length) {
  fs.writeFileSync(releaseConfigTarget, `${JSON.stringify(releaseConfig, null, 2)}\n`);
    console.log(`Release configuration: ${Object.keys(releaseConfig).join(', ')}`);
  } else {
    fs.rmSync(releaseConfigTarget, { force: true });
    console.log('Release configuration: disabled');
  }
}

if (require.main === module) writeBuildInfo();

module.exports = { releaseConfigFromEnv, runtimeComponentsFromResources, verifyRuntimeAbi, writeBuildInfo };
