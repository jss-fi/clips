const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const runtimeAbi = require('./runtime-abi.json');
const buildInfo = require('./build-info.json');

const RUNTIME_VERSION = 2;
if (runtimeAbi.runtimeVersion !== RUNTIME_VERSION) throw new Error('The packaged runtime ABI does not match this application.');
const LIBOBS_BIN_FILES = [
  'obs.dll',
  'libobs-d3d11.dll',
  'libobs-winrt.dll',
  'avcodec-61.dll',
  'avdevice-61.dll',
  'avfilter-10.dll',
  'avformat-61.dll',
  'avutil-59.dll',
  'swresample-5.dll',
  'swscale-8.dll',
  'w32-pthreads.dll',
  'zlib.dll',
  'libcurl.dll',
  'librist.dll',
  'srt.dll',
  'libx264-164.dll',
  'obs-ffmpeg-mux.exe',
  'obs-amf-test.exe',
  'obs-nvenc-test.exe',
  'obs-qsv-test.exe'
];
const LIBOBS_PLUGINS = [
  'win-capture',
  'win-wasapi',
  'obs-ffmpeg',
  'obs-x264',
  'obs-nvenc',
  'obs-qsv11',
  'coreaudio-encoder',
  'obs-filters',
  'nv-filters'
];
const REQUIRED_FILES = [
  path.join('libobs', 'bin', '64bit', 'obs.dll'),
  path.join('libobs', 'bin', '64bit', 'clips-capture-host.exe'),
  path.join('libobs', 'obs-plugins', '64bit', 'win-capture.dll'),
  path.join('libobs', 'obs-plugins', '64bit', 'win-wasapi.dll'),
  path.join('libobs', 'obs-plugins', '64bit', 'obs-ffmpeg.dll'),
  path.join('ffmpeg', 'ffmpeg.exe'),
  path.join('libmpv', 'mpv-host.exe'),
  path.join('libmpv', 'libmpv-2.dll')
];
const REQUIRED_KEYS = REQUIRED_FILES.map(relative => relative.replaceAll('\\', '/'));
const BUNDLED_REQUIRED_REPLACEMENTS = new Map([
  ['libobs/bin/64bit/clips-capture-host.exe', path.join('capture-host', 'clips-capture-host.exe')],
  ['libmpv/mpv-host.exe', path.join('libmpv', 'mpv-host.exe')],
  ['libmpv/libmpv-2.dll', path.join('libmpv', 'libmpv-2.dll')]
]);
const SUPPLEMENTAL_SCHEMA = 1;
const RETRYABLE_COPY_ERRORS = new Set(['EACCES', 'EBUSY', 'EPERM']);

async function copyFileWithRetries(source, destination) {
  for (let attempt = 0; attempt <= 20; attempt += 1) {
    try {
      await fs.promises.copyFile(source, destination);
      return;
    } catch (error) {
      if (!RETRYABLE_COPY_ERRORS.has(error?.code) || attempt === 20) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.min(500, 50 * (attempt + 1))));
    }
  }
}

function runtimeRoot(localAppData) {
  return path.join(localAppData, 'jss-clips', 'runtime', `v${RUNTIME_VERSION}`);
}

function manifestPath(root) {
  return path.join(root, 'runtime.json');
}

function fileSha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function runtimeHashes(root, trustedFiles = null) {
  return Object.fromEntries(REQUIRED_FILES.map((relative, index) => {
    const key = REQUIRED_KEYS[index];
    const actual = fileSha256(path.join(root, relative));
    if (trustedFiles && actual !== trustedFiles[key]) {
      throw new Error(`Installed required runtime file failed integrity verification: ${key}`);
    }
    return [key, trustedFiles?.[key] || actual];
  }));
}

function isNonEmptyFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

function hasRequiredRuntimeFiles(root) {
  return REQUIRED_FILES.every(relative => isNonEmptyFile(path.join(root, relative)));
}

function normalizedRuntimePath(relative) {
  const normalized = relative.replaceAll('\\', '/');
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split('/').includes('..')) {
    throw new Error(`Invalid supplemental runtime path: ${relative}`);
  }
  return normalized;
}

function firstRuntimeSource(candidates, type, label = 'supplemental runtime') {
  for (const candidate of candidates) {
    let stat;
    try { stat = fs.lstatSync(candidate); }
    catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    const valid = type === 'directory' ? stat.isDirectory() : stat.isFile();
    if (!valid) throw new Error(`Packaged ${label} ${type} is invalid: ${candidate}`);
    return candidate;
  }
  return '';
}

function supplementalTreeEntries(source, relativeRoot, entries) {
  const children = fs.readdirSync(source, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const child of children) {
    const sourceEntry = path.join(source, child.name);
    const relative = normalizedRuntimePath(path.join(relativeRoot, child.name));
    if (child.isDirectory()) supplementalTreeEntries(sourceEntry, relative, entries);
    else if (child.isFile()) entries.push({ source: sourceEntry, relative });
    else throw new Error(`Packaged supplemental runtime entry is not a regular file: ${sourceEntry}`);
  }
}

function supplementalInventory(resourcesPath, root) {
  const fullLibobs = path.join(resourcesPath, 'libobs');
  const previousLibobs = path.join(path.dirname(root), 'v1', 'obs-studio');
  const microphoneFilters = path.join(resourcesPath, 'microphone-filters');
  const files = [];
  const trees = [];
  const addFile = (candidates, relative) => {
    const source = firstRuntimeSource(candidates, 'file');
    if (source) files.push({ source, relative: normalizedRuntimePath(relative) });
  };
  const addTree = (candidates, relative) => {
    const source = firstRuntimeSource(candidates, 'directory');
    if (!source) return;
    const entries = [];
    supplementalTreeEntries(source, normalizedRuntimePath(relative), entries);
    trees.push({ source, relative: normalizedRuntimePath(relative), entries });
  };

  addFile([
    path.join(resourcesPath, 'encoder-probes', 'obs-amf-test.exe'),
    path.join(fullLibobs, 'bin', '64bit', 'obs-amf-test.exe'),
    path.join(previousLibobs, 'bin', '64bit', 'obs-amf-test.exe')
  ], path.join('libobs', 'bin', '64bit', 'obs-amf-test.exe'));
  for (const name of ['obs-filters.dll', 'nv-filters.dll']) {
    addFile([
      path.join(microphoneFilters, name),
      path.join(fullLibobs, 'obs-plugins', '64bit', name),
      path.join(previousLibobs, 'obs-plugins', '64bit', name)
    ], path.join('libobs', 'obs-plugins', '64bit', name));
  }
  addTree([
    path.join(microphoneFilters, 'data'),
    path.join(fullLibobs, 'data', 'obs-plugins', 'obs-filters'),
    path.join(previousLibobs, 'data', 'obs-plugins', 'obs-filters')
  ], path.join('libobs', 'data', 'obs-plugins', 'obs-filters'));
  addTree([
    path.join(microphoneFilters, 'nv-data'),
    path.join(fullLibobs, 'data', 'obs-plugins', 'nv-filters'),
    path.join(previousLibobs, 'data', 'obs-plugins', 'nv-filters')
  ], path.join('libobs', 'data', 'obs-plugins', 'nv-filters'));
  addFile([
    path.join(resourcesPath, 'mpv', 'mpv.exe'),
    path.join(path.dirname(root), 'v1', 'mpv', 'mpv.exe')
  ], path.join('mpv', 'mpv.exe'));

  const entries = [...files, ...trees.flatMap(tree => tree.entries)]
    .sort((left, right) => left.relative.localeCompare(right.relative));
  const destinations = new Set();
  for (const entry of entries) {
    if (destinations.has(entry.relative)) {
      throw new Error(`Duplicate supplemental runtime destination: ${entry.relative}`);
    }
    destinations.add(entry.relative);
  }
  return { files, trees, entries };
}

function requiredSourceInventory(resourcesPath, root) {
  const fullLibobs = path.join(resourcesPath, 'libobs');
  const previousRoot = path.join(path.dirname(root), 'v1');
  const previousLibobs = path.join(previousRoot, 'obs-studio');
  const installedLibobs = path.join(root, 'libobs');
  const sources = new Map();
  const add = (relative, candidates) => {
    const source = firstRuntimeSource(candidates, 'file', 'required runtime');
    if (!source) throw new Error(`Packaged required runtime file is missing: ${normalizedRuntimePath(relative)}`);
    sources.set(normalizedRuntimePath(relative), source);
  };

  add(path.join('libobs', 'bin', '64bit', 'obs.dll'), [
    path.join(fullLibobs, 'bin', '64bit', 'obs.dll'),
    path.join(previousLibobs, 'bin', '64bit', 'obs.dll'),
    path.join(installedLibobs, 'bin', '64bit', 'obs.dll')
  ]);
  add(path.join('libobs', 'bin', '64bit', 'clips-capture-host.exe'), [
    path.join(resourcesPath, 'capture-host', 'clips-capture-host.exe'),
    path.join(fullLibobs, 'bin', '64bit', 'clips-capture-host.exe'),
    path.join(previousLibobs, 'bin', '64bit', 'clips-capture-host.exe'),
    path.join(installedLibobs, 'bin', '64bit', 'clips-capture-host.exe')
  ]);
  for (const name of ['win-capture.dll', 'win-wasapi.dll', 'obs-ffmpeg.dll']) {
    add(path.join('libobs', 'obs-plugins', '64bit', name), [
      path.join(fullLibobs, 'obs-plugins', '64bit', name),
      path.join(previousLibobs, 'obs-plugins', '64bit', name),
      path.join(installedLibobs, 'obs-plugins', '64bit', name)
    ]);
  }
  add(path.join('ffmpeg', 'ffmpeg.exe'), [
    path.join(resourcesPath, 'ffmpeg', 'ffmpeg.exe'),
    path.join(previousRoot, 'ffmpeg', 'ffmpeg.exe'),
    path.join(root, 'ffmpeg', 'ffmpeg.exe')
  ]);
  for (const name of ['mpv-host.exe', 'libmpv-2.dll']) {
    add(path.join('libmpv', name), [
      path.join(resourcesPath, 'libmpv', name),
      path.join(previousRoot, 'libmpv', name),
      path.join(root, 'libmpv', name)
    ]);
  }
  return REQUIRED_KEYS.map(relative => ({ relative, source: sources.get(relative) }));
}

function buildRuntimeComponentManifest(resourcesPath, root) {
  const required = requiredSourceInventory(resourcesPath, root);
  const inventory = supplementalInventory(resourcesPath, root);
  return {
    schema: SUPPLEMENTAL_SCHEMA,
    requiredFiles: Object.fromEntries(required.map(entry => [entry.relative, fileSha256(entry.source)])),
    supplementalFiles: Object.fromEntries(inventory.entries.map(entry => [entry.relative, fileSha256(entry.source)]))
  };
}

function trustedRequiredFiles(trustedManifest = buildInfo.runtimeComponents) {
  const files = trustedManifest?.requiredFiles;
  const expected = [...REQUIRED_KEYS].sort((left, right) => left.localeCompare(right));
  const recorded = files && typeof files === 'object' && !Array.isArray(files)
    ? Object.keys(files).sort((left, right) => left.localeCompare(right))
    : [];
  if (trustedManifest?.schema !== SUPPLEMENTAL_SCHEMA
    || !files
    || typeof files !== 'object'
    || Array.isArray(files)
    || expected.length !== recorded.length
    || expected.some((relative, index) => relative !== recorded[index])) {
    throw new Error('The packaged required runtime manifest is invalid.');
  }
  for (const relative of REQUIRED_KEYS) {
    if (!/^[a-f0-9]{64}$/.test(files[relative])) {
      throw new Error(`The packaged required runtime hash is invalid: ${relative}`);
    }
  }
  return files;
}

function trustedSupplementalFiles(inventory, trustedManifest = buildInfo.runtimeComponents) {
  if (trustedManifest?.schema !== SUPPLEMENTAL_SCHEMA
    || !trustedManifest.supplementalFiles
    || typeof trustedManifest.supplementalFiles !== 'object'
    || Array.isArray(trustedManifest.supplementalFiles)) {
    throw new Error('The packaged supplemental runtime manifest is invalid.');
  }
  const expected = inventory.entries.map(entry => entry.relative);
  const recorded = Object.keys(trustedManifest.supplementalFiles).sort((left, right) => left.localeCompare(right));
  if (expected.length !== recorded.length
    || expected.some((relative, index) => relative !== recorded[index])) {
    throw new Error('The packaged supplemental runtime manifest does not match its component inventory.');
  }
  for (const relative of expected) {
    if (!/^[a-f0-9]{64}$/.test(trustedManifest.supplementalFiles[relative])) {
      throw new Error(`The packaged supplemental runtime hash is invalid: ${relative}`);
    }
  }
  return trustedManifest.supplementalFiles;
}

function verifyRequiredSources(entries, trustedFiles) {
  for (const entry of entries) {
    if (fileSha256(entry.source) !== trustedFiles[entry.relative]) {
      throw new Error(`Packaged required runtime file failed integrity verification: ${entry.relative}`);
    }
  }
}

function verifyBundledRequiredReplacements(resourcesPath, trustedFiles) {
  for (const [relative, bundledRelative] of BUNDLED_REQUIRED_REPLACEMENTS) {
    const source = path.join(resourcesPath, bundledRelative);
    if (!fs.existsSync(source)) continue;
    const stat = fs.lstatSync(source);
    if (!stat.isFile() || fileSha256(source) !== trustedFiles[relative]) {
      throw new Error(`Packaged required runtime file failed integrity verification: ${relative}`);
    }
  }
}

function verifySupplementalSources(inventory, trustedFiles) {
  for (const entry of inventory.entries) {
    let stat;
    try { stat = fs.lstatSync(entry.source); }
    catch (error) {
      throw new Error(`Packaged supplemental runtime file is missing: ${entry.relative}`, { cause: error });
    }
    if (!stat.isFile() || fileSha256(entry.source) !== trustedFiles[entry.relative]) {
      throw new Error(`Packaged supplemental runtime file failed integrity verification: ${entry.relative}`);
    }
  }
}

function supplementalComponentsInstalled(root, inventory, manifest, trustedFiles) {
  if (manifest?.supplementalSchema !== SUPPLEMENTAL_SCHEMA
    || !manifest.supplementalFiles
    || typeof manifest.supplementalFiles !== 'object'
    || Array.isArray(manifest.supplementalFiles)) return false;
  const expected = inventory.entries.map(entry => entry.relative);
  const recorded = Object.keys(manifest.supplementalFiles).sort((left, right) => left.localeCompare(right));
  if (expected.length !== recorded.length
    || expected.some((relative, index) => relative !== recorded[index])) return false;
  try {
    return inventory.entries.every(entry => {
      const recordedHash = manifest.supplementalFiles[entry.relative];
      const trustedHash = trustedFiles[entry.relative];
      const installed = path.join(root, ...entry.relative.split('/'));
      return recordedHash === trustedHash
        && fs.lstatSync(installed).isFile()
        && fileSha256(installed) === trustedHash;
    });
  } catch {
    return false;
  }
}

function verifiedSupplementalHashes(root, inventory, trustedFiles) {
  return Object.fromEntries(inventory.entries.map(entry => {
    const installed = path.join(root, ...entry.relative.split('/'));
    if (!fs.lstatSync(installed).isFile()) {
      throw new Error(`Installed supplemental runtime file is invalid: ${entry.relative}`);
    }
    const trustedHash = trustedFiles[entry.relative];
    if (fileSha256(installed) !== trustedHash) {
      throw new Error(`Installed supplemental runtime file failed integrity verification: ${entry.relative}`);
    }
    return [entry.relative, trustedHash];
  }));
}

function readRuntimeManifest(root) {
  try { return JSON.parse(fs.readFileSync(manifestPath(root), 'utf8')); }
  catch { return null; }
}

async function writeRuntimeManifest(
  root,
  applicationVersion = '',
  inventory = { entries: [] },
  trustedRequired = null,
  trustedSupplemental = {}
) {
  const destination = manifestPath(root);
  const staged = `${destination}.install-${process.pid}-${crypto.randomUUID()}`;
  const contents = `${JSON.stringify({
    version: RUNTIME_VERSION,
    installedAt: new Date().toISOString(),
    ...(applicationVersion ? { applicationVersion } : {}),
    files: runtimeHashes(root, trustedRequired),
    supplementalSchema: SUPPLEMENTAL_SCHEMA,
    supplementalFiles: verifiedSupplementalHashes(root, inventory, trustedSupplemental)
  }, null, 2)}\n`;
  try {
    await fs.promises.writeFile(staged, contents);
    await replacePathAtomically(staged, destination);
  } finally {
    await fs.promises.rm(staged, { force: true });
  }
}

function isRuntimeReady(root, trustedFiles = null) {
  try {
    const manifest = readRuntimeManifest(root);
    return manifest.version === RUNTIME_VERSION
      && REQUIRED_FILES.every((relative, index) => {
        const file = path.join(root, relative);
        if (fs.statSync(file).size <= 0) return false;
        const key = REQUIRED_KEYS[index];
        const recordedHash = manifest.files?.[key];
        const expectedHash = trustedFiles?.[key] || recordedHash;
        if (trustedFiles && recordedHash !== expectedHash) return false;
        return !expectedHash || fileSha256(file) === expectedHash;
      });
  } catch {
    return false;
  }
}

function isRuntimeRepairableFromBundledComponents(resourcesPath, root, trustedFiles = null) {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath(root), 'utf8'));
    if (manifest.version !== RUNTIME_VERSION) return false;
    return REQUIRED_FILES.every((relative, index) => {
      const installed = path.join(root, relative);
      if (fs.statSync(installed).size <= 0) return false;
      const key = REQUIRED_KEYS[index];
      const expectedHash = trustedFiles?.[key] || manifest.files?.[key];
      const installedHash = fileSha256(installed);
      if (!expectedHash || installedHash === expectedHash) return true;
      const bundledRelative = BUNDLED_REQUIRED_REPLACEMENTS.get(key);
      if (!bundledRelative) return false;
      const bundled = path.join(resourcesPath, bundledRelative);
      const bundledHash = fs.statSync(bundled).size > 0 && fileSha256(bundled);
      return trustedFiles ? bundledHash === expectedHash : bundledHash === installedHash;
    });
  } catch {
    return false;
  }
}

async function replacePathAtomically(staged, destination) {
  const backup = `${destination}.backup-${process.pid}-${crypto.randomUUID()}`;
  let movedExisting = false;
  try {
    if (fs.existsSync(destination)) {
      await fs.promises.rename(destination, backup);
      movedExisting = true;
    }
    await fs.promises.rename(staged, destination);
    if (movedExisting) {
      // The new runtime is already live. A transient antivirus lock on the
      // rollback copy must not turn a successful installation into a failure.
      await fs.promises.rm(backup, { recursive: true, force: true }).catch(() => {});
    }
  } catch (error) {
    if (movedExisting && !fs.existsSync(destination) && fs.existsSync(backup)) {
      await fs.promises.rename(backup, destination);
    }
    throw error;
  }
}

async function copyFileAtomically(source, destination) {
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  const staged = `${destination}.install-${process.pid}-${crypto.randomUUID()}`;
  try {
    await copyFileWithRetries(source, staged);
    if ((await fs.promises.stat(staged)).size <= 0) throw new Error(`Runtime file is empty: ${source}`);
    await replacePathAtomically(staged, destination);
  } finally {
    await fs.promises.rm(staged, { force: true });
  }
}

async function copySupplementalTreeAtomically(tree, destination) {
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  const staged = `${destination}.install-${process.pid}-${crypto.randomUUID()}`;
  try {
    await fs.promises.mkdir(staged, { recursive: true });
    for (const entry of tree.entries) {
      const relative = entry.relative.slice(tree.relative.length + 1);
      const stagedFile = path.join(staged, ...relative.split('/'));
      await fs.promises.mkdir(path.dirname(stagedFile), { recursive: true });
      await copyFileWithRetries(entry.source, stagedFile);
    }
    await replacePathAtomically(staged, destination);
  } finally {
    await fs.promises.rm(staged, { recursive: true, force: true });
  }
}

async function copyPrivateLibobs(source, destination) {
  const sourceBin = path.join(source, 'bin', '64bit');
  const sourcePlugins = path.join(source, 'obs-plugins', '64bit');
  const sourceData = path.join(source, 'data');
  const destinationBin = path.join(destination, 'bin', '64bit');
  const destinationPlugins = path.join(destination, 'obs-plugins', '64bit');
  const destinationData = path.join(destination, 'data');
  await fs.promises.mkdir(destinationBin, { recursive: true });
  await fs.promises.mkdir(destinationPlugins, { recursive: true });
  await fs.promises.mkdir(destinationData, { recursive: true });
  for (const name of LIBOBS_BIN_FILES) {
    await fs.promises.copyFile(path.join(sourceBin, name), path.join(destinationBin, name));
  }
  for (const name of LIBOBS_PLUGINS) {
    await copyFileWithRetries(
      path.join(sourcePlugins, `${name}.dll`),
      path.join(destinationPlugins, `${name}.dll`)
    );
    const pluginData = path.join(sourceData, 'obs-plugins', name);
    if (fs.existsSync(pluginData)) {
      await fs.promises.cp(
        pluginData,
        path.join(destinationData, 'obs-plugins', name),
        { recursive: true, force: true }
      );
    }
  }
  await fs.promises.cp(
    path.join(sourceData, 'libobs'),
    path.join(destinationData, 'libobs'),
    { recursive: true, force: true }
  );
}

async function ensureRuntimeInstalled(
  resourcesPath,
  root,
  applicationVersion = '',
  trustedRuntimeManifest = buildInfo.runtimeComponents
) {
  applicationVersion = String(applicationVersion || '');
  const installedManifest = readRuntimeManifest(root);
  const installedApplicationVersion = installedManifest?.applicationVersion || '';
  const supplemental = supplementalInventory(resourcesPath, root);
  const trustedRequired = trustedRequiredFiles(trustedRuntimeManifest);
  const trustedSupplemental = trustedSupplementalFiles(supplemental, trustedRuntimeManifest);
  let packageSourcesVerified = false;
  const verifySources = () => {
    if (packageSourcesVerified) return;
    verifyBundledRequiredReplacements(resourcesPath, trustedRequired);
    verifySupplementalSources(supplemental, trustedSupplemental);
    packageSourcesVerified = true;
  };
  let installed = false;
  let rebuilt = false;
  let requiredComponentsNeedRefresh = false;
  let ready = isRuntimeReady(root, trustedRequired);
  if (!ready && isRuntimeRepairableFromBundledComponents(resourcesPath, root, trustedRequired)) {
    installed = true;
    requiredComponentsNeedRefresh = true;
    ready = true;
  }
  if (!ready) {
    verifySources();
    const previousRoot = path.join(path.dirname(root), 'v1');
    const componentSource = name => {
      const bundled = path.join(resourcesPath, name);
      if (fs.existsSync(bundled)) return bundled;
      const previous = path.join(previousRoot, name);
      return fs.existsSync(previous) ? previous : '';
    };
    const bundledLibobs = path.join(resourcesPath, 'libobs');
    const previousObs = path.join(previousRoot, 'obs-studio');
    const obsSource = fs.existsSync(bundledLibobs)
      ? bundledLibobs
      : (fs.existsSync(previousObs) ? previousObs : '');
    const ffmpegSource = componentSource('ffmpeg');
    const libmpvSource = componentSource('libmpv');
    if (!obsSource || !ffmpegSource || !libmpvSource) {
      throw new Error('The bundled media runtime and its previous installed version are incomplete.');
    }
    const requiredSources = requiredSourceInventory(resourcesPath, root);
    verifyRequiredSources(requiredSources, trustedRequired);
    const requiredSource = relative => requiredSources.find(entry => entry.relative === relative).source;

    await fs.promises.mkdir(path.dirname(root), { recursive: true });
    const stagedRoot = path.join(path.dirname(root), `.v${RUNTIME_VERSION}.install-${process.pid}-${crypto.randomUUID()}`);
    try {
      await copyPrivateLibobs(obsSource, path.join(stagedRoot, 'libobs'));
      await fs.promises.copyFile(
        requiredSource('libobs/bin/64bit/clips-capture-host.exe'),
        path.join(stagedRoot, 'libobs', 'bin', '64bit', 'clips-capture-host.exe')
      );
      await fs.promises.mkdir(path.join(stagedRoot, 'ffmpeg'), { recursive: true });
      await fs.promises.copyFile(
        requiredSource('ffmpeg/ffmpeg.exe'),
        path.join(stagedRoot, 'ffmpeg', 'ffmpeg.exe')
      );
      await fs.promises.mkdir(path.join(stagedRoot, 'libmpv'), { recursive: true });
      await Promise.all([
        fs.promises.copyFile(
          requiredSource('libmpv/mpv-host.exe'),
          path.join(stagedRoot, 'libmpv', 'mpv-host.exe')
        ),
        fs.promises.copyFile(
          requiredSource('libmpv/libmpv-2.dll'),
          path.join(stagedRoot, 'libmpv', 'libmpv-2.dll')
        )
      ]);
      for (const relative of REQUIRED_FILES) {
        const installedFile = path.join(stagedRoot, relative);
        if (!fs.existsSync(installedFile) || fs.statSync(installedFile).size <= 0) {
          throw new Error(`Installed media runtime is incomplete: ${relative}`);
        }
      }
      await writeRuntimeManifest(stagedRoot);
      await replacePathAtomically(stagedRoot, root);
    } finally {
      await fs.promises.rm(stagedRoot, { recursive: true, force: true });
    }
    installed = true;
    rebuilt = true;
    ready = true;
  }

  // Application-only packages can carry corrected native components without a
  // runtime ABI bump. Apply each package's components once, then use the
  // manifest revision to avoid recopying and rehashing them on every launch.
  const refreshBundledComponents = rebuilt
    || requiredComponentsNeedRefresh
    || !applicationVersion
    || installedApplicationVersion !== applicationVersion
    || !supplementalComponentsInstalled(root, supplemental, installedManifest, trustedSupplemental);

  // Authenticate every package source before mutating any installed component.
  if (refreshBundledComponents) verifySources();

  // Slim application updates can ship a corrected native capture host without
  // redownloading the complete OBS runtime. Refresh it even when the runtime
  // version itself is already installed.
  const bundledCaptureHost = path.join(resourcesPath, 'capture-host', 'clips-capture-host.exe');
  const installedCaptureHost = path.join(root, 'libobs', 'bin', '64bit', 'clips-capture-host.exe');
  if (refreshBundledComponents && fs.existsSync(bundledCaptureHost)) {
    await fs.promises.mkdir(path.dirname(installedCaptureHost), { recursive: true });
    await copyFileAtomically(bundledCaptureHost, installedCaptureHost);
    installed = true;
  }

  // Supplemental helpers, filters, filter data, and standalone MPV are
  // refreshed from the same allowlisted inventory used for manifest checks.
  if (refreshBundledComponents) {
    for (const entry of supplemental.files) {
      await copyFileAtomically(
        entry.source,
        path.join(root, ...entry.relative.split('/'))
      );
    }
    for (const tree of supplemental.trees) {
      await copySupplementalTreeAtomically(
        tree,
        path.join(root, ...tree.relative.split('/'))
      );
    }
    if (supplemental.files.length || supplemental.trees.length) installed = true;
  }

  // Refresh the embedded player host and its matching library as part of slim
  // application updates so new player commands work without a bootstrap reinstall.
  const bundledLibmpv = path.join(resourcesPath, 'libmpv');
  const installedLibmpv = path.join(root, 'libmpv');
  const bundledMpvHost = path.join(bundledLibmpv, 'mpv-host.exe');
  const bundledMpvLibrary = path.join(bundledLibmpv, 'libmpv-2.dll');
  if (refreshBundledComponents && fs.existsSync(bundledMpvHost) && fs.existsSync(bundledMpvLibrary)) {
    const stagedLibmpv = `${installedLibmpv}.install-${process.pid}-${crypto.randomUUID()}`;
    try {
      await fs.promises.mkdir(stagedLibmpv, { recursive: true });
      await Promise.all([
        fs.promises.copyFile(bundledMpvHost, path.join(stagedLibmpv, 'mpv-host.exe')),
        fs.promises.copyFile(bundledMpvLibrary, path.join(stagedLibmpv, 'libmpv-2.dll'))
      ]);
      if ((await fs.promises.stat(path.join(stagedLibmpv, 'mpv-host.exe'))).size <= 0
        || (await fs.promises.stat(path.join(stagedLibmpv, 'libmpv-2.dll'))).size <= 0) {
        throw new Error('The bundled libmpv runtime is incomplete.');
      }
      await replacePathAtomically(stagedLibmpv, installedLibmpv);
    } finally {
      await fs.promises.rm(stagedLibmpv, { recursive: true, force: true });
    }
    installed = true;
  }

  if (!ready || !hasRequiredRuntimeFiles(root)) {
    throw new Error('The installed media runtime is incomplete.');
  }
  if (installed || (applicationVersion && refreshBundledComponents)) {
    await writeRuntimeManifest(root, applicationVersion, supplemental, trustedRequired, trustedSupplemental);
  }
  return { installed, root, ready: true };
}

module.exports = {
  RUNTIME_VERSION,
  REQUIRED_FILES,
  runtimeRoot,
  hasRequiredRuntimeFiles,
  isRuntimeReady,
  isRuntimeRepairableFromBundledComponents,
  buildRuntimeComponentManifest,
  ensureRuntimeInstalled
};
