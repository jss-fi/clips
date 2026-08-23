const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {
  RUNTIME_VERSION,
  REQUIRED_FILES,
  hasRequiredRuntimeFiles,
  isRuntimeReady,
  isRuntimeRepairableFromBundledComponents,
  ensureRuntimeInstalled
} = require('../src/runtime');

test('a ready runtime is hashed only once during startup', async t => {
  const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'clips-runtime-ready-test-'));
  t.after(() => fs.promises.rm(temporary, { recursive: true, force: true }));
  const resources = path.join(temporary, 'resources');
  const runtime = path.join(temporary, `v${RUNTIME_VERSION}`);
  const hashes = {};
  const requiredPaths = new Set();
  for (const relative of REQUIRED_FILES) {
    const target = path.join(runtime, relative);
    const contents = `installed ${relative}`;
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, contents);
    hashes[relative.replaceAll('\\', '/')] = crypto.createHash('sha256').update(contents).digest('hex');
    requiredPaths.add(path.resolve(target).toLowerCase());
  }
  await fs.promises.writeFile(path.join(runtime, 'runtime.json'), JSON.stringify({
    version: RUNTIME_VERSION,
    files: hashes
  }));
  const readFileSync = fs.readFileSync.bind(fs);
  let binaryReads = 0;
  t.mock.method(fs, 'readFileSync', (filePath, ...args) => {
    if (requiredPaths.has(path.resolve(filePath).toLowerCase())) binaryReads += 1;
    return readFileSync(filePath, ...args);
  });

  const result = await ensureRuntimeInstalled(resources, runtime);

  assert.deepEqual(result, { installed: false, root: runtime, ready: true });
  assert.equal(binaryReads, REQUIRED_FILES.length);
});

test('main-process hot paths use cached runtime readiness with setup failures isolated', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert.doesNotMatch(main, /\bisRuntimeReady\b/);
  assert.match(main, /let mediaRuntimeReady = !app\.isPackaged/);
  assert.match(main, /if \(!result\.ready\).*media runtime did not pass startup verification/is);
  const setupStart = main.indexOf('runtimeSetupPromise = ensureRuntimeInstalled');
  const setupEnd = main.indexOf('await runtimeSetupPromise;', setupStart);
  assert.ok(setupStart >= 0 && setupEnd > setupStart);
  const setup = main.slice(setupStart, setupEnd);
  assert.doesNotMatch(setup, /broadcast|stopLegacyBundledObs/);
  assert.match(main, /await runtimeSetupPromise;\s*if \(!app\.isPackaged \|\| mediaRuntimeReady\)/);
  assert.match(main, /mediaRuntimeError \|\| 'The Clips media runtime is not ready\.'/);
  assert.match(main, /const persistentHost = persistentRuntimeFile\([\s\S]*?'libmpv-2\.dll'[\s\S]*?\)/);
  assert.match(main, /persistentHost \|\| completeHost\(bundledHost\)/);
});

test('cheap runtime checks reject missing and empty required files', async t => {
  const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'clips-runtime-presence-test-'));
  t.after(() => fs.promises.rm(temporary, { recursive: true, force: true }));
  for (const relative of REQUIRED_FILES) {
    const target = path.join(temporary, relative);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, 'installed');
  }
  assert.equal(hasRequiredRuntimeFiles(temporary), true);

  const host = path.join(temporary, 'libmpv', 'mpv-host.exe');
  await fs.promises.truncate(host, 0);
  assert.equal(hasRequiredRuntimeFiles(temporary), false);
  await fs.promises.writeFile(host, 'installed');

  await fs.promises.rm(path.join(temporary, 'libmpv', 'libmpv-2.dll'));
  assert.equal(hasRequiredRuntimeFiles(temporary), false);
});

test('a slim update refreshes native hosts in an otherwise-ready runtime', async (t) => {
  const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'clips-runtime-test-'));
  t.after(() => fs.promises.rm(temporary, { recursive: true, force: true }));
  const resources = path.join(temporary, 'resources');
  const runtime = path.join(temporary, `v${RUNTIME_VERSION}`);

  for (const relative of REQUIRED_FILES) {
    const target = path.join(runtime, relative);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, 'installed');
  }
  await fs.promises.writeFile(path.join(runtime, 'runtime.json'), JSON.stringify({
    version: RUNTIME_VERSION
  }));

  const bundledHost = path.join(resources, 'capture-host', 'clips-capture-host.exe');
  await fs.promises.mkdir(path.dirname(bundledHost), { recursive: true });
  await fs.promises.writeFile(bundledHost, 'updated capture host');
  const bundledAmfProbe = path.join(resources, 'encoder-probes', 'obs-amf-test.exe');
  await fs.promises.mkdir(path.dirname(bundledAmfProbe), { recursive: true });
  await fs.promises.writeFile(bundledAmfProbe, 'updated amf probe');
  const bundledFilters = path.join(resources, 'microphone-filters', 'obs-filters.dll');
  await fs.promises.mkdir(path.dirname(bundledFilters), { recursive: true });
  await fs.promises.writeFile(bundledFilters, 'updated microphone filters');
  await fs.promises.writeFile(path.join(resources, 'microphone-filters', 'nv-filters.dll'), 'updated nvidia filters');
  await fs.promises.mkdir(path.join(resources, 'microphone-filters', 'data'), { recursive: true });
  await fs.promises.writeFile(path.join(resources, 'microphone-filters', 'data', 'effect.json'), 'updated filter data');
  await fs.promises.mkdir(path.join(resources, 'microphone-filters', 'nv-data'), { recursive: true });
  await fs.promises.writeFile(path.join(resources, 'microphone-filters', 'nv-data', 'model.bin'), 'updated nvidia data');
  const bundledLibmpv = path.join(resources, 'libmpv');
  await fs.promises.mkdir(bundledLibmpv, { recursive: true });
  await fs.promises.writeFile(path.join(bundledLibmpv, 'mpv-host.exe'), 'updated mpv host');
  await fs.promises.writeFile(path.join(bundledLibmpv, 'libmpv-2.dll'), 'updated mpv library');
  const bundledMpv = path.join(resources, 'mpv', 'mpv.exe');
  await fs.promises.mkdir(path.dirname(bundledMpv), { recursive: true });
  await fs.promises.writeFile(bundledMpv, 'updated standalone mpv');

  const applicationVersion = '0.6.0-nightly.test';
  const result = await ensureRuntimeInstalled(resources, runtime, applicationVersion);
  assert.equal(result.installed, true);
  assert.equal(result.ready, true);
  assert.equal(
    await fs.promises.readFile(
      path.join(runtime, 'libobs', 'bin', '64bit', 'clips-capture-host.exe'),
      'utf8'
    ),
    'updated capture host'
  );
  assert.equal(
    await fs.promises.readFile(path.join(runtime, 'libobs', 'bin', '64bit', 'obs-amf-test.exe'), 'utf8'),
    'updated amf probe'
  );
  assert.equal(
    await fs.promises.readFile(path.join(runtime, 'libmpv', 'mpv-host.exe'), 'utf8'),
    'updated mpv host'
  );
  assert.equal(
    await fs.promises.readFile(path.join(runtime, 'libmpv', 'libmpv-2.dll'), 'utf8'),
    'updated mpv library'
  );
  assert.equal(
    await fs.promises.readFile(path.join(runtime, 'libobs', 'obs-plugins', '64bit', 'obs-filters.dll'), 'utf8'),
    'updated microphone filters'
  );
  assert.equal(
    await fs.promises.readFile(path.join(runtime, 'libobs', 'obs-plugins', '64bit', 'nv-filters.dll'), 'utf8'),
    'updated nvidia filters'
  );
  assert.equal(
    await fs.promises.readFile(path.join(runtime, 'libobs', 'data', 'obs-plugins', 'obs-filters', 'effect.json'), 'utf8'),
    'updated filter data'
  );
  assert.equal(await fs.promises.readFile(path.join(runtime, 'mpv', 'mpv.exe'), 'utf8'), 'updated standalone mpv');
  assert.equal(isRuntimeReady(runtime), true);
  assert.equal(
    JSON.parse(await fs.promises.readFile(path.join(runtime, 'runtime.json'), 'utf8')).applicationVersion,
    applicationVersion
  );

  const requiredPaths = new Set(REQUIRED_FILES.map(relative => path.resolve(runtime, relative).toLowerCase()));
  const readFileSync = fs.readFileSync.bind(fs);
  const copyFile = fs.promises.copyFile.bind(fs.promises);
  let binaryReads = 0;
  let copyCalls = 0;
  t.mock.method(fs, 'readFileSync', (filePath, ...args) => {
    if (requiredPaths.has(path.resolve(filePath).toLowerCase())) binaryReads += 1;
    return readFileSync(filePath, ...args);
  });
  t.mock.method(fs.promises, 'copyFile', (...args) => {
    copyCalls += 1;
    return copyFile(...args);
  });

  const secondStart = await ensureRuntimeInstalled(resources, runtime, applicationVersion);

  assert.deepEqual(secondStart, { installed: false, root: runtime, ready: true });
  assert.equal(binaryReads, REQUIRED_FILES.length);
  assert.equal(copyCalls, 0);

  const installedAmfProbe = path.join(runtime, 'libobs', 'bin', '64bit', 'obs-amf-test.exe');
  const installedFilter = path.join(runtime, 'libobs', 'obs-plugins', '64bit', 'obs-filters.dll');
  const installedFilterData = path.join(runtime, 'libobs', 'data', 'obs-plugins', 'obs-filters', 'effect.json');
  const installedMpv = path.join(runtime, 'mpv', 'mpv.exe');
  await fs.promises.rm(installedAmfProbe);
  await fs.promises.truncate(installedFilter, 0);
  await fs.promises.rm(installedFilterData);
  await fs.promises.truncate(installedMpv, 0);
  binaryReads = 0;
  copyCalls = 0;

  const repairedStart = await ensureRuntimeInstalled(resources, runtime, applicationVersion);

  assert.equal(repairedStart.installed, true);
  assert.equal(repairedStart.ready, true);
  assert.equal(await fs.promises.readFile(installedAmfProbe, 'utf8'), 'updated amf probe');
  assert.equal(await fs.promises.readFile(installedFilter, 'utf8'), 'updated microphone filters');
  assert.equal(await fs.promises.readFile(installedFilterData, 'utf8'), 'updated filter data');
  assert.equal(await fs.promises.readFile(installedMpv, 'utf8'), 'updated standalone mpv');
  assert.equal(binaryReads, REQUIRED_FILES.length * 2);
  assert.ok(copyCalls > 0);

  binaryReads = 0;
  copyCalls = 0;
  const afterRepair = await ensureRuntimeInstalled(resources, runtime, applicationVersion);
  assert.deepEqual(afterRepair, { installed: false, root: runtime, ready: true });
  assert.equal(binaryReads, REQUIRED_FILES.length);
  assert.equal(copyCalls, 0);
});

test('a failed runtime installation leaves the existing runtime untouched', async (t) => {
  const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'clips-runtime-test-'));
  t.after(() => fs.promises.rm(temporary, { recursive: true, force: true }));
  const resources = path.join(temporary, 'resources');
  const runtime = path.join(temporary, `v${RUNTIME_VERSION}`);
  await fs.promises.mkdir(runtime, { recursive: true });
  await fs.promises.writeFile(path.join(runtime, 'keep.txt'), 'previous runtime');

  await fs.promises.mkdir(path.join(resources, 'libobs', 'bin', '64bit'), { recursive: true });
  await fs.promises.writeFile(path.join(resources, 'libobs', 'bin', '64bit', 'obs.dll'), 'partial');
  await fs.promises.mkdir(path.join(resources, 'ffmpeg'), { recursive: true });
  await fs.promises.writeFile(path.join(resources, 'ffmpeg', 'ffmpeg.exe'), 'ffmpeg');
  await fs.promises.mkdir(path.join(resources, 'libmpv'), { recursive: true });
  await fs.promises.writeFile(path.join(resources, 'libmpv', 'mpv-host.exe'), 'host');
  await fs.promises.writeFile(path.join(resources, 'libmpv', 'libmpv-2.dll'), 'library');

  await assert.rejects(ensureRuntimeInstalled(resources, runtime));
  assert.equal(await fs.promises.readFile(path.join(runtime, 'keep.txt'), 'utf8'), 'previous runtime');
  assert.equal(fs.existsSync(path.join(runtime, 'libobs')), false);
  assert.deepEqual(
    (await fs.promises.readdir(temporary)).filter(name => name.includes('.install-')),
    []
  );
});

test('runtime hashes detect corruption while legacy manifests remain compatible', async (t) => {
  const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'clips-runtime-test-'));
  t.after(() => fs.promises.rm(temporary, { recursive: true, force: true }));
  for (const relative of REQUIRED_FILES) {
    const target = path.join(temporary, relative);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, 'installed');
  }
  await fs.promises.writeFile(path.join(temporary, 'runtime.json'), JSON.stringify({
    version: RUNTIME_VERSION
  }));
  assert.equal(isRuntimeReady(temporary), true);

  const relative = REQUIRED_FILES[0];
  await fs.promises.writeFile(path.join(temporary, 'runtime.json'), JSON.stringify({
    version: RUNTIME_VERSION,
    files: { [relative.replaceAll('\\', '/')]: 'invalid-hash' }
  }));
  assert.equal(isRuntimeReady(temporary), false);
});

test('a slim update repairs a stale manifest only for its matching bundled component', async t => {
  const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'clips-runtime-repair-test-'));
  t.after(() => fs.promises.rm(temporary, { recursive: true, force: true }));
  const resources = path.join(temporary, 'resources');
  const runtime = path.join(temporary, `v${RUNTIME_VERSION}`);
  for (const relative of REQUIRED_FILES) {
    const target = path.join(runtime, relative);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, `installed ${relative}`);
  }
  await fs.promises.mkdir(path.join(resources, 'capture-host'), { recursive: true });
  const installedHost = path.join(runtime, 'libobs', 'bin', '64bit', 'clips-capture-host.exe');
  await fs.promises.copyFile(installedHost, path.join(resources, 'capture-host', 'clips-capture-host.exe'));
  await fs.promises.writeFile(path.join(runtime, 'runtime.json'), JSON.stringify({
    version: RUNTIME_VERSION,
    files: Object.fromEntries(REQUIRED_FILES.map(relative => [
      relative.replaceAll('\\', '/'),
      relative.endsWith('clips-capture-host.exe') ? 'previous-host-hash' : undefined
    ]))
  }));

  assert.equal(isRuntimeRepairableFromBundledComponents(resources, runtime), true);
  await ensureRuntimeInstalled(resources, runtime);
  assert.equal(isRuntimeReady(runtime), true);

  await fs.promises.writeFile(path.join(runtime, 'ffmpeg', 'ffmpeg.exe'), 'untrusted corruption');
  assert.equal(isRuntimeRepairableFromBundledComponents(resources, runtime), false);
});
