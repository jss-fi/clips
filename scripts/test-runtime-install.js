const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  RUNTIME_VERSION,
  buildRuntimeComponentManifest,
  ensureRuntimeInstalled,
  isRuntimeReady
} = require('../src/runtime');

async function main() {
  const root = path.join(__dirname, '..');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'clips-runtime-test-'));
  try {
    const runtime = path.join(temporary, 'runtime-install', `v${RUNTIME_VERSION}`);
    const vendor = path.join(root, 'vendor');
    const trustedComponents = buildRuntimeComponentManifest(vendor, runtime);
    const result = await ensureRuntimeInstalled(vendor, runtime, '', trustedComponents);
    assert.equal(result.installed, true);
    assert.equal(isRuntimeReady(runtime), true);
    assert.equal(fs.existsSync(path.join(runtime, 'libobs', 'bin', '64bit', 'clips-capture-host.exe')), true);
    assert.equal(fs.existsSync(path.join(runtime, 'libobs', 'bin', '64bit', 'obs64.exe')), false);
    assert.equal(fs.existsSync(path.join(runtime, 'libobs', 'obs-plugins', '64bit', 'obs-websocket.dll')), false);
    assert.equal(fs.existsSync(path.join(runtime, 'libobs', 'obs-plugins', '64bit', 'obs-filters.dll')), true);
    assert.equal(fs.existsSync(path.join(runtime, 'libobs', 'obs-plugins', '64bit', 'nv-filters.dll')), true);

    const migrationBase = path.join(temporary, 'runtime-migration');
    const previous = path.join(migrationBase, 'v1');
    const packagedResources = process.env.CLIPS_RUNTIME_RESOURCES;
    const slimResources = packagedResources
      ? path.resolve(packagedResources)
      : path.join(migrationBase, 'slim-resources');
    fs.mkdirSync(previous, { recursive: true });
    for (const name of ['obs-studio', 'ffmpeg', 'libmpv', 'mpv']) {
      fs.symlinkSync(path.join(root, 'vendor', name), path.join(previous, name), 'junction');
    }
    if (!packagedResources) {
      fs.mkdirSync(path.join(slimResources, 'capture-host'), { recursive: true });
      fs.copyFileSync(
        path.join(root, 'vendor', 'capture-host', 'clips-capture-host.exe'),
        path.join(slimResources, 'capture-host', 'clips-capture-host.exe')
      );
      fs.mkdirSync(path.join(slimResources, 'microphone-filters'), { recursive: true });
      fs.copyFileSync(
        path.join(root, 'vendor', 'libobs', 'obs-plugins', '64bit', 'obs-filters.dll'),
        path.join(slimResources, 'microphone-filters', 'obs-filters.dll')
      );
      fs.copyFileSync(
        path.join(root, 'vendor', 'libobs', 'obs-plugins', '64bit', 'nv-filters.dll'),
        path.join(slimResources, 'microphone-filters', 'nv-filters.dll')
      );
    }
    const migratedRuntime = path.join(migrationBase, `v${RUNTIME_VERSION}`);
    await ensureRuntimeInstalled(slimResources, migratedRuntime, '', trustedComponents);
    assert.equal(isRuntimeReady(migratedRuntime), true);
    assert.equal(fs.existsSync(path.join(migratedRuntime, 'libobs', 'bin', '64bit', 'obs64.exe')), false);
    assert.equal(fs.existsSync(path.join(migratedRuntime, 'libobs', 'obs-plugins', '64bit', 'obs-websocket.dll')), false);
    console.log(`Media runtime v${RUNTIME_VERSION} installs fresh and migrates from v1 without OBS Studio or OBS WebSocket.`);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
