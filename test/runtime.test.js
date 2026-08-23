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
  buildRuntimeComponentManifest,
  ensureRuntimeInstalled
} = require('../src/runtime');

async function tamperWithoutChangingSize(filePath) {
  const trusted = await fs.promises.readFile(filePath);
  assert.ok(trusted.length > 0);
  const tampered = Buffer.from(trusted);
  tampered[0] = (tampered[0] + 1) % 256;
  await fs.promises.writeFile(filePath, tampered);
  assert.equal((await fs.promises.stat(filePath)).size, trusted.length);
  return trusted;
}

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
  const trustedComponents = buildRuntimeComponentManifest(resources, runtime);
  const readFileSync = fs.readFileSync.bind(fs);
  let binaryReads = 0;
  t.mock.method(fs, 'readFileSync', (filePath, ...args) => {
    if (requiredPaths.has(path.resolve(filePath).toLowerCase())) binaryReads += 1;
    return readFileSync(filePath, ...args);
  });

  const result = await ensureRuntimeInstalled(resources, runtime, '', trustedComponents);

  assert.deepEqual(result, { installed: false, root: runtime, ready: true });
  assert.equal(binaryReads, REQUIRED_FILES.length);
});

test('main-process hot paths use cached runtime readiness with setup failures isolated', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert.doesNotMatch(main, /\bisRuntimeReady\b/);
  assert.match(main, /let mediaRuntimeReady = !app\.isPackaged/);
  assert.match(main, /if \(!result\.ready\).*media runtime did not pass startup verification/is);
  const setupStart = main.indexOf('runtimeSetupPromise = ensureRuntimeInstalled');
  const windowStart = main.indexOf('createWindow();', setupStart);
  assert.ok(setupStart >= 0 && windowStart > setupStart);
  const setup = main.slice(setupStart, windowStart);
  assert.doesNotMatch(setup, /broadcast|stopLegacyBundledObs/);
  assert.match(main, /async function waitForMediaRuntime\(\) \{\s*await runtimeSetupPromise;/);
  assert.match(main, /mediaRuntimeError \|\| 'The Clips media runtime is not ready\.'/);
  assert.match(main, /const persistentHost = persistentRuntimeFile\([\s\S]*?'libmpv-2\.dll'[\s\S]*?\)/);
  assert.match(main, /persistentHost \|\| completeHost\(bundledHost\)/);
  const mpvPathStart = main.indexOf('function mpvPath()');
  const mpvPathEnd = main.indexOf('function mpvFullscreenScriptPath()', mpvPathStart);
  const mpvPathSource = main.slice(mpvPathStart, mpvPathEnd);
  assert.match(mpvPathSource, /persistentOptionalRuntimeFile\(path\.join\('mpv', 'mpv\.exe'\)\)/);
  assert.doesNotMatch(mpvPathSource, /path\.join\(persistentRuntimeRoot/);
  const optionalLookupStart = main.indexOf('function persistentOptionalRuntimeFile');
  const optionalLookupEnd = main.indexOf('async function waitForMediaRuntime', optionalLookupStart);
  const optionalLookupSource = main.slice(optionalLookupStart, optionalLookupEnd);
  assert.match(optionalLookupSource, /!app\.isPackaged \|\| !mediaRuntimeReady/);
  assert.doesNotMatch(optionalLookupSource, /mediaRuntimeReady\s*=/);
  assert.match(main, /async function startMpvSession[\s\S]*?await waitForMediaRuntime\(\)/);
  assert.match(main, /async function openRecording[\s\S]*?await waitForMediaRuntime\(\)/);
  assert.match(main, /ipcMain\.handle\('mpv:fullscreen', async[\s\S]*?await waitForMediaRuntime\(\)/);
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

test('a slim update authenticates and repairs supplemental runtime components', async (t) => {
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
  const trustedComponents = buildRuntimeComponentManifest(resources, runtime);
  const ensureTestRuntime = (version = applicationVersion) => (
    ensureRuntimeInstalled(resources, runtime, version, trustedComponents)
  );
  const result = await ensureTestRuntime();
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
  const runtimeManifest = path.join(runtime, 'runtime.json');
  const manifest = JSON.parse(await fs.promises.readFile(runtimeManifest, 'utf8'));
  assert.equal(manifest.applicationVersion, applicationVersion);
  assert.equal(manifest.supplementalSchema, 1);
  assert.deepEqual(Object.keys(manifest.supplementalFiles).sort(), [
    'libobs/bin/64bit/obs-amf-test.exe',
    'libobs/data/obs-plugins/nv-filters/model.bin',
    'libobs/data/obs-plugins/obs-filters/effect.json',
    'libobs/obs-plugins/64bit/nv-filters.dll',
    'libobs/obs-plugins/64bit/obs-filters.dll',
    'mpv/mpv.exe'
  ]);
  assert.deepEqual(manifest.files, trustedComponents.requiredFiles);
  assert.deepEqual(manifest.supplementalFiles, trustedComponents.supplementalFiles);
  for (const hash of Object.values(manifest.supplementalFiles)) assert.match(hash, /^[a-f0-9]{64}$/);

  const installedCaptureHost = path.join(runtime, 'libobs', 'bin', '64bit', 'clips-capture-host.exe');
  const installedAmfProbe = path.join(runtime, 'libobs', 'bin', '64bit', 'obs-amf-test.exe');
  const installedFilter = path.join(runtime, 'libobs', 'obs-plugins', '64bit', 'obs-filters.dll');
  const installedNvidiaFilter = path.join(runtime, 'libobs', 'obs-plugins', '64bit', 'nv-filters.dll');
  const installedFilterData = path.join(runtime, 'libobs', 'data', 'obs-plugins', 'obs-filters', 'effect.json');
  const installedNvidiaData = path.join(runtime, 'libobs', 'data', 'obs-plugins', 'nv-filters', 'model.bin');
  const installedMpv = path.join(runtime, 'mpv', 'mpv.exe');
  const outside = path.join(temporary, 'outside.bin');
  await fs.promises.writeFile(outside, 'must not be read through the manifest');
  const requiredPaths = new Set(REQUIRED_FILES.map(relative => path.resolve(runtime, relative).toLowerCase()));
  const supplementalPaths = new Set(Object.keys(manifest.supplementalFiles)
    .map(relative => path.resolve(runtime, ...relative.split('/')).toLowerCase()));
  const outsidePath = path.resolve(outside).toLowerCase();
  const readFileSync = fs.readFileSync.bind(fs);
  const copyFile = fs.promises.copyFile.bind(fs.promises);
  const writeFile = fs.promises.writeFile.bind(fs.promises);
  const runtimeManifestPrefix = path.resolve(runtimeManifest).toLowerCase();
  let binaryReads = 0;
  let supplementalReads = 0;
  let copyCalls = 0;
  let manifestWrites = 0;
  let outsideReads = 0;
  let corruptNextCopySource = '';
  t.mock.method(fs, 'readFileSync', (filePath, ...args) => {
    const resolved = path.resolve(filePath).toLowerCase();
    if (requiredPaths.has(resolved)) binaryReads += 1;
    if (supplementalPaths.has(resolved)) supplementalReads += 1;
    if (resolved === outsidePath) outsideReads += 1;
    return readFileSync(filePath, ...args);
  });
  t.mock.method(fs.promises, 'copyFile', async (...args) => {
    copyCalls += 1;
    await copyFile(...args);
    if (corruptNextCopySource
      && path.resolve(args[0]).toLowerCase() === path.resolve(corruptNextCopySource).toLowerCase()) {
      corruptNextCopySource = '';
      const copied = await fs.promises.readFile(args[1]);
      copied[0] = (copied[0] + 1) % 256;
      await writeFile(args[1], copied);
    }
  });
  t.mock.method(fs.promises, 'writeFile', (filePath, ...args) => {
    if (path.resolve(filePath).toLowerCase().startsWith(runtimeManifestPrefix)) manifestWrites += 1;
    return writeFile(filePath, ...args);
  });

  const secondStart = await ensureTestRuntime();

  assert.deepEqual(secondStart, { installed: false, root: runtime, ready: true });
  assert.equal(binaryReads, REQUIRED_FILES.length);
  assert.equal(supplementalReads, supplementalPaths.size);
  assert.equal(copyCalls, 0);
  assert.equal(manifestWrites, 0);

  const sourceTamperTargets = [
    bundledHost,
    path.join(bundledLibmpv, 'mpv-host.exe'),
    path.join(bundledLibmpv, 'libmpv-2.dll'),
    bundledMpv
  ];
  for (const [index, source] of sourceTamperTargets.entries()) {
    const manifestBeforeSourceTampering = await fs.promises.readFile(runtimeManifest);
    const trustedSource = await tamperWithoutChangingSize(source);
    binaryReads = 0;
    supplementalReads = 0;
    copyCalls = 0;
    manifestWrites = 0;

    await assert.rejects(
      ensureTestRuntime(`${applicationVersion}.source-tamper-${index}`),
      /packaged (?:required|supplemental) runtime file failed integrity verification/i
    );

    assert.equal(copyCalls, 0, source);
    assert.equal(manifestWrites, 0, source);
    assert.deepEqual(await fs.promises.readFile(runtimeManifest), manifestBeforeSourceTampering, source);
    await fs.promises.writeFile(source, trustedSource);
  }

  const legacyManifest = JSON.parse(await fs.promises.readFile(runtimeManifest, 'utf8'));
  delete legacyManifest.supplementalSchema;
  delete legacyManifest.supplementalFiles;
  await fs.promises.writeFile(runtimeManifest, JSON.stringify(legacyManifest));
  const trustedAmfProbe = await tamperWithoutChangingSize(installedAmfProbe);
  binaryReads = 0;
  supplementalReads = 0;
  copyCalls = 0;
  manifestWrites = 0;

  const migratedStart = await ensureTestRuntime();

  assert.equal(migratedStart.installed, true);
  assert.deepEqual(await fs.promises.readFile(installedAmfProbe), trustedAmfProbe);
  assert.equal(JSON.parse(await fs.promises.readFile(runtimeManifest, 'utf8')).supplementalSchema, 1);
  assert.ok(copyCalls > 0);
  assert.ok(manifestWrites > 0);

  const unsafeManifest = JSON.parse(await fs.promises.readFile(runtimeManifest, 'utf8'));
  unsafeManifest.supplementalFiles = { '../../outside.bin': '0'.repeat(64) };
  await fs.promises.writeFile(runtimeManifest, JSON.stringify(unsafeManifest));
  binaryReads = 0;
  supplementalReads = 0;
  copyCalls = 0;
  manifestWrites = 0;
  outsideReads = 0;

  const unsafeManifestRepair = await ensureTestRuntime();

  assert.equal(unsafeManifestRepair.installed, true);
  assert.equal(outsideReads, 0);
  assert.ok(copyCalls > 0);
  assert.ok(manifestWrites > 0);

  const trustedInstalledMpv = await tamperWithoutChangingSize(installedMpv);
  const poisonedManifest = JSON.parse(await fs.promises.readFile(runtimeManifest, 'utf8'));
  poisonedManifest.supplementalFiles['mpv/mpv.exe'] = crypto.createHash('sha256')
    .update(await fs.promises.readFile(installedMpv))
    .digest('hex');
  await fs.promises.writeFile(runtimeManifest, JSON.stringify(poisonedManifest));
  copyCalls = 0;
  manifestWrites = 0;

  const poisonedManifestRepair = await ensureTestRuntime();

  assert.equal(poisonedManifestRepair.installed, true);
  assert.deepEqual(await fs.promises.readFile(installedMpv), trustedInstalledMpv);
  assert.equal(
    JSON.parse(await fs.promises.readFile(runtimeManifest, 'utf8')).supplementalFiles['mpv/mpv.exe'],
    trustedComponents.supplementalFiles['mpv/mpv.exe']
  );
  assert.ok(copyCalls > 0);
  assert.ok(manifestWrites > 0);

  const trustedInstalledCaptureHost = await tamperWithoutChangingSize(installedCaptureHost);
  const poisonedRequiredManifest = JSON.parse(await fs.promises.readFile(runtimeManifest, 'utf8'));
  poisonedRequiredManifest.files['libobs/bin/64bit/clips-capture-host.exe'] = crypto.createHash('sha256')
    .update(await fs.promises.readFile(installedCaptureHost))
    .digest('hex');
  await fs.promises.writeFile(runtimeManifest, JSON.stringify(poisonedRequiredManifest));
  copyCalls = 0;
  manifestWrites = 0;

  const poisonedRequiredRepair = await ensureTestRuntime();

  assert.equal(poisonedRequiredRepair.installed, true);
  assert.deepEqual(await fs.promises.readFile(installedCaptureHost), trustedInstalledCaptureHost);
  assert.equal(
    JSON.parse(await fs.promises.readFile(runtimeManifest, 'utf8')).files['libobs/bin/64bit/clips-capture-host.exe'],
    trustedComponents.requiredFiles['libobs/bin/64bit/clips-capture-host.exe']
  );
  assert.ok(copyCalls > 0);
  assert.ok(manifestWrites > 0);

  await fs.promises.rm(installedAmfProbe);
  await fs.promises.truncate(installedFilter, 0);
  await fs.promises.rm(installedFilterData);
  await fs.promises.truncate(installedMpv, 0);
  binaryReads = 0;
  supplementalReads = 0;
  copyCalls = 0;
  manifestWrites = 0;

  const repairedStart = await ensureTestRuntime();

  assert.equal(repairedStart.installed, true);
  assert.equal(repairedStart.ready, true);
  assert.equal(await fs.promises.readFile(installedAmfProbe, 'utf8'), 'updated amf probe');
  assert.equal(await fs.promises.readFile(installedFilter, 'utf8'), 'updated microphone filters');
  assert.equal(await fs.promises.readFile(installedFilterData, 'utf8'), 'updated filter data');
  assert.equal(await fs.promises.readFile(installedMpv, 'utf8'), 'updated standalone mpv');
  assert.equal(binaryReads, REQUIRED_FILES.length * 2);
  assert.ok(copyCalls > 0);
  assert.ok(manifestWrites > 0);

  const tamperTargets = [
    installedAmfProbe,
    installedFilter,
    installedNvidiaFilter,
    installedFilterData,
    installedNvidiaData,
    installedMpv
  ];
  for (const target of tamperTargets) {
    const trusted = await tamperWithoutChangingSize(target);
    binaryReads = 0;
    supplementalReads = 0;
    copyCalls = 0;
    manifestWrites = 0;

    const tamperRepair = await ensureTestRuntime();

    assert.equal(tamperRepair.installed, true, target);
    assert.deepEqual(await fs.promises.readFile(target), trusted, target);
    assert.equal(binaryReads, REQUIRED_FILES.length * 2, target);
    assert.ok(copyCalls > 0, target);
    assert.ok(manifestWrites > 0, target);
  }

  const manifestBeforeCorruptCopy = await fs.promises.readFile(runtimeManifest);
  const mpvBeforeCorruptCopy = await tamperWithoutChangingSize(installedMpv);
  binaryReads = 0;
  supplementalReads = 0;
  copyCalls = 0;
  manifestWrites = 0;
  corruptNextCopySource = bundledMpv;

  await assert.rejects(ensureTestRuntime(), /installed supplemental runtime file failed integrity verification/i);

  assert.equal(corruptNextCopySource, '');
  assert.equal(manifestWrites, 0);
  assert.deepEqual(await fs.promises.readFile(runtimeManifest), manifestBeforeCorruptCopy);
  assert.notDeepEqual(await fs.promises.readFile(installedMpv), mpvBeforeCorruptCopy);

  const cleanRetry = await ensureTestRuntime();
  assert.equal(cleanRetry.installed, true);
  assert.deepEqual(await fs.promises.readFile(installedMpv), mpvBeforeCorruptCopy);
  assert.equal(JSON.parse(await fs.promises.readFile(runtimeManifest, 'utf8')).applicationVersion, applicationVersion);

  const manifestBeforeCorruptRequiredCopy = await fs.promises.readFile(runtimeManifest);
  const captureHostBeforeCorruptCopy = await tamperWithoutChangingSize(installedCaptureHost);
  copyCalls = 0;
  manifestWrites = 0;
  corruptNextCopySource = bundledHost;

  await assert.rejects(ensureTestRuntime(), /installed required runtime file failed integrity verification/i);

  assert.equal(corruptNextCopySource, '');
  assert.equal(manifestWrites, 0);
  assert.deepEqual(await fs.promises.readFile(runtimeManifest), manifestBeforeCorruptRequiredCopy);
  assert.notDeepEqual(await fs.promises.readFile(installedCaptureHost), captureHostBeforeCorruptCopy);

  const cleanRequiredRetry = await ensureTestRuntime();
  assert.equal(cleanRequiredRetry.installed, true);
  assert.deepEqual(await fs.promises.readFile(installedCaptureHost), captureHostBeforeCorruptCopy);

  binaryReads = 0;
  supplementalReads = 0;
  copyCalls = 0;
  manifestWrites = 0;
  const afterRepair = await ensureTestRuntime();
  assert.deepEqual(afterRepair, { installed: false, root: runtime, ready: true });
  assert.equal(binaryReads, REQUIRED_FILES.length);
  assert.equal(supplementalReads, supplementalPaths.size);
  assert.equal(copyCalls, 0);
  assert.equal(manifestWrites, 0);
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

  const trustedComponents = {
    schema: 1,
    requiredFiles: Object.fromEntries(REQUIRED_FILES.map(relative => [
      relative.replaceAll('\\', '/'),
      crypto.createHash('sha256').update(`expected ${relative}`).digest('hex')
    ])),
    supplementalFiles: {}
  };
  await assert.rejects(ensureRuntimeInstalled(resources, runtime, '', trustedComponents));
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
  const trustedComponents = buildRuntimeComponentManifest(resources, runtime);

  assert.equal(isRuntimeRepairableFromBundledComponents(resources, runtime), true);
  await ensureRuntimeInstalled(resources, runtime, '', trustedComponents);
  assert.equal(isRuntimeReady(runtime), true);

  await fs.promises.writeFile(path.join(runtime, 'ffmpeg', 'ffmpeg.exe'), 'untrusted corruption');
  assert.equal(isRuntimeRepairableFromBundledComponents(resources, runtime), false);
});
