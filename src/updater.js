const fs = require('fs');
let rawFs = fs;
try { rawFs = require('original-fs'); } catch {}
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const { verifyMetadata, verifyPackageMetadata } = require('../scripts/update-signature');
const UPDATE_PUBLIC_KEY = fs.readFileSync(path.join(__dirname, 'update-signing-public.pem'));

const execFileAsync = promisify(execFile);
const APP_EXECUTABLE = 'jss clips.exe';
const SEMVER = '\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?';
const PREPARATION_DIRECTORY = new RegExp(`^${SEMVER}\\.preparing(?:-.+)?$`);
const VERSION_DIRECTORY = new RegExp(`^(${SEMVER})(?:\\.app-[A-Za-z0-9-]+)?$`);
const RETRYABLE_FILE_ERRORS = new Set(['EACCES', 'EBUSY', 'ENOTEMPTY', 'EPERM']);
const DOWNLOAD_STREAMS = 8;
const MINIMUM_DOWNLOAD_PART_SIZE = 8 * 1024 * 1024;
const RANGE_DOWNLOAD_RETRIES = 2;
const RANGE_RETRY_DELAY_MS = 250;
const METADATA_TIMEOUT_MS = 30 * 1000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const STALE_PREPARATION_AGE_MS = 60 * 60 * 1000;

function updateRoot(app) {
  return path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'jss-clips');
}

function activeVersionPath(app) {
  return path.join(updateRoot(app), 'active-app.json');
}

function isVersionDirectory(name, version) {
  const candidate = String(name || '');
  return Boolean(parseVersion(version) && (
    candidate === version
    || (candidate.startsWith(`${version}.app-`) && /^[A-Za-z0-9-]+$/.test(candidate.slice(version.length + 5)))
  ));
}

function versionDirectory(app, version, directory = version) {
  if (!parseVersion(version) || !isVersionDirectory(directory, version)) {
    throw new Error('Invalid application version directory.');
  }
  return path.join(updateRoot(app), 'app-versions', directory);
}

function versionExecutable(app, version, directory = version) {
  return path.join(versionDirectory(app, version, directory), APP_EXECUTABLE);
}

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(value || ''));
  if (!match) return null;
  return { core: match.slice(1, 4).map(Number), prerelease: match[4]?.split('.') || [] };
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] > b.core[index] ? 1 : -1;
  }
  if (!a.prerelease.length || !b.prerelease.length) return a.prerelease.length === b.prerelease.length ? 0 : (a.prerelease.length ? -1 : 1);
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    if (a.prerelease[index] === undefined) return -1;
    if (b.prerelease[index] === undefined) return 1;
    if (a.prerelease[index] === b.prerelease[index]) continue;
    const aNumber = /^\d+$/.test(a.prerelease[index]) ? Number(a.prerelease[index]) : null;
    const bNumber = /^\d+$/.test(b.prerelease[index]) ? Number(b.prerelease[index]) : null;
    if (aNumber !== null && bNumber !== null) return aNumber > bNumber ? 1 : -1;
    if (aNumber !== null || bNumber !== null) return aNumber !== null ? -1 : 1;
    return a.prerelease[index] > b.prerelease[index] ? 1 : -1;
  }
  return 0;
}

function updateRelaunchArgs(args = process.argv.slice(1)) {
  return args.filter(argument => argument !== '--hidden');
}

function sha512Sync(filePath) {
  const hash = crypto.createHash('sha512');
  hash.update(rawFs.readFileSync(filePath));
  return hash.digest('base64');
}

function validateVersionPointer(app, active) {
  if (!active || !parseVersion(active.version)) return null;
  const directory = active.directory || active.version;
  if (!isVersionDirectory(directory, active.version)) return null;
  const root = versionDirectory(app, active.version, directory);
  const executable = path.join(root, APP_EXECUTABLE);
  const asar = path.join(root, 'resources', 'app.asar');
  try {
    const marker = JSON.parse(rawFs.readFileSync(path.join(root, '.clips-update.json'), 'utf8'));
    if (marker.version !== active.version
      || rawFs.statSync(executable).size <= 0
      || rawFs.statSync(asar).size <= 0
      || (marker.asarSha512 && sha512Sync(asar) !== marker.asarSha512)) return null;
    return {
      version: active.version,
      directory,
      executable,
      activatedAt: active.activatedAt,
      state: active.state === 'pending' ? 'pending' : 'confirmed',
      bootAttempts: Number.isSafeInteger(active.bootAttempts) && active.bootAttempts >= 0 ? active.bootAttempts : 0,
      previous: active.previous
    };
  } catch {
    return null;
  }
}

function readActivePointer(app) {
  try { return JSON.parse(fs.readFileSync(activeVersionPath(app), 'utf8')); }
  catch { return null; }
}

function readActiveVersion(app) {
  return validateVersionPointer(app, readActivePointer(app));
}

function writeActivePointerSync(app, value) {
  const pointer = activeVersionPath(app);
  fs.mkdirSync(path.dirname(pointer), { recursive: true });
  const temporary = `${pointer}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  try { fs.renameSync(temporary, pointer); }
  catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch {}
    throw error;
  }
}

function installedRollback(active) {
  const previous = active?.previous;
  if (!previous || previous.type !== 'installed'
    || !parseVersion(previous.version)
    || path.basename(String(previous.executable || '')).toLowerCase() !== APP_EXECUTABLE
    || !path.isAbsolute(previous.executable)) return null;
  try { return rawFs.statSync(previous.executable).size > 0 ? previous : null; }
  catch { return null; }
}

function rollbackActiveVersion(app, pointer = readActivePointer(app)) {
  const previous = validateVersionPointer(app, pointer?.previous);
  const installed = previous ? null : installedRollback(pointer);
  try {
    if (previous) {
      writeActivePointerSync(app, {
        version: previous.version,
        directory: previous.directory,
        activatedAt: previous.activatedAt,
        state: 'confirmed'
      });
    } else {
      fs.rmSync(activeVersionPath(app), { force: true });
    }
  } catch {
    return null;
  }
  return previous || installed;
}

function confirmActiveVersionBoot(app, currentExecutable = process.execPath) {
  const pointer = readActivePointer(app);
  const active = validateVersionPointer(app, pointer);
  if (!active || active.state !== 'pending'
    || path.resolve(currentExecutable).toLowerCase() !== path.resolve(active.executable).toLowerCase()) return false;
  writeActivePointerSync(app, {
    version: active.version,
    directory: active.directory,
    activatedAt: active.activatedAt,
    confirmedAt: new Date().toISOString(),
    state: 'confirmed'
  });
  return true;
}

function redirectToActiveVersion(app, { currentExecutable = process.execPath, spawnImpl = spawn } = {}) {
  if (!app.isPackaged) return false;
  const pointer = readActivePointer(app);
  let active = validateVersionPointer(app, pointer);
  let rollback = null;
  if (!active) rollback = rollbackActiveVersion(app, pointer);
  else if (active.state === 'pending' && active.bootAttempts > 0) {
    rollback = rollbackActiveVersion(app, pointer);
    active = null;
  }
  if (rollback) {
    if (path.resolve(currentExecutable).toLowerCase() === path.resolve(rollback.executable).toLowerCase()) return false;
    spawnImpl(rollback.executable, process.argv.slice(1), {
      cwd: path.dirname(rollback.executable), detached: true, windowsHide: false, stdio: 'ignore'
    }).unref();
    return true;
  }
  if (!active) return false;
  if (path.resolve(currentExecutable).toLowerCase() === path.resolve(active.executable).toLowerCase()) {
    if (active.state === 'pending') writeActivePointerSync(app, { ...pointer, bootAttempts: 1, bootStartedAt: new Date().toISOString() });
    return false;
  }
  if (compareVersions(active.version, app.getVersion()) <= 0) return false;
  spawnImpl(active.executable, process.argv.slice(1), {
    cwd: path.dirname(active.executable),
    detached: true,
    windowsHide: false,
    stdio: 'ignore'
  }).unref();
  return true;
}

async function sha512(filePath) {
  const hash = crypto.createHash('sha512');
  await new Promise((resolve, reject) => {
    const input = rawFs.createReadStream(filePath);
    input.on('data', chunk => hash.update(chunk));
    input.on('error', reject);
    input.on('end', resolve);
  });
  return hash.digest('base64');
}

function downloadRanges(size, streams = DOWNLOAD_STREAMS, minimumPartSize = MINIMUM_DOWNLOAD_PART_SIZE) {
  const count = Math.min(streams, Math.floor(size / minimumPartSize));
  if (count < 2) return [];
  const partSize = Math.ceil(size / count);
  return Array.from({ length: count }, (_value, index) => {
    const start = index * partSize;
    return { start, end: Math.min(size - 1, start + partSize - 1) };
  });
}

async function writeResponseBody(response, file, position, expectedSize, onBytes) {
  const reader = response.body.getReader();
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      if (received + chunk.length > expectedSize) {
        throw new Error('The update server returned too much data.');
      }
      await file.write(chunk, 0, chunk.length, position + received);
      received += chunk.length;
      onBytes(chunk.length);
    }
    if (received !== expectedSize) throw new Error('The update server returned an incomplete download.');
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  }
}

async function withFetchTimeout(fetchImpl, url, options, consume, timeoutMs = DOWNLOAD_TIMEOUT_MS) {
  const controller = new AbortController();
  const externalSignal = options?.signal;
  const abortFromExternal = () => controller.abort(externalSignal.reason);
  if (externalSignal?.aborted) abortFromExternal();
  else externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('The update request timed out.'));
  }, timeoutMs);
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    return await consume(response);
  } catch (error) {
    if (timedOut) throw new Error('The update request timed out.');
    if (externalSignal?.aborted) throw externalSignal.reason || error;
    throw error;
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener('abort', abortFromExternal);
  }
}

class RangeUnsupportedError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'RangeUnsupportedError';
    this.code = 'ERR_UPDATE_RANGES_UNSUPPORTED';
    Object.assign(this, details);
  }
}

function rangeErrorDetails(error) {
  return {
    code: error?.code,
    status: error?.status,
    contentRange: error?.contentRange,
    message: error?.message
  };
}

async function downloadRange(url, file, size, range, onBytes, fetchImpl, signal) {
  const { start, end } = range;
  await withFetchTimeout(fetchImpl, url, {
    cache: 'no-store',
    headers: {
      'Accept-Encoding': 'identity',
      Range: `bytes=${start}-${end}`
    },
    signal
  }, async response => {
    const rejectResponse = async error => {
      await response.body?.cancel(error).catch(() => {});
      throw error;
    };
    const contentRangeHeader = response.headers.get('content-range') || '';
    const contentRange = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRangeHeader);
    if (response.status === 200) {
      return rejectResponse(new RangeUnsupportedError('The update server ignored the byte range request.', {
        status: response.status,
        contentRange: contentRangeHeader,
        range: { start, end }
      }));
    }
    if (response.status !== 206) {
      const error = new Error(`Update range download failed (${response.status}).`);
      error.status = response.status;
      return rejectResponse(error);
    }
    if (!response.body) throw new Error('The update server returned an empty range response.');
    if (
      !contentRange
      || Number(contentRange[1]) !== start
      || Number(contentRange[2]) !== end
      || Number(contentRange[3]) !== size
    ) {
      const error = new Error('The update server returned an invalid Content-Range header.');
      error.status = response.status;
      error.contentRange = contentRangeHeader;
      return rejectResponse(error);
    }
    await writeResponseBody(response, file, start, end - start + 1, onBytes);
  });
}

async function downloadRangeWithRetries(url, file, size, range, onBytes, fetchImpl, signal, {
  retries,
  retryDelayMs,
  onDiagnostic
}) {
  const maximumAttempts = retries + 1;
  let unsupportedAttempts = 0;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    let attemptBytes = 0;
    try {
      await downloadRange(url, file, size, range, bytes => {
        attemptBytes += bytes;
        onBytes(bytes);
      }, fetchImpl, signal);
      if (attempt > 1) onDiagnostic('info', 'range retry succeeded', { range, attempt });
      return;
    } catch (error) {
      if (attemptBytes) onBytes(-attemptBytes);
      if (signal.aborted) throw signal.reason || error;
      if (error instanceof RangeUnsupportedError) unsupportedAttempts += 1;
      if (attempt === maximumAttempts) {
        const unsupported = unsupportedAttempts === maximumAttempts;
        onDiagnostic(unsupported ? 'warn' : 'error', 'range failed', {
          range,
          attempts: attempt,
          ...rangeErrorDetails(error)
        });
        if (unsupported) throw error;
        throw new Error(`Update range ${range.start}-${range.end} failed after ${attempt} attempts: ${error?.message || error}`, { cause: error });
      }
      onDiagnostic('warn', 'range retry scheduled', {
        range,
        failedAttempt: attempt,
        nextAttempt: attempt + 1,
        maximumAttempts,
        ...rangeErrorDetails(error)
      });
      if (retryDelayMs > 0) await new Promise(resolve => setTimeout(resolve, retryDelayMs * attempt));
    }
  }
}

async function downloadInRanges(url, archive, size, ranges, onBytes, fetchImpl, retryOptions) {
  const controller = new AbortController();
  const file = await fs.promises.open(archive, 'w');
  try {
    await file.truncate(size);
    const downloads = ranges.map(range => downloadRangeWithRetries(
      url, file, size, range, onBytes, fetchImpl, controller.signal, retryOptions
    ));
    try {
      await Promise.all(downloads);
    } catch (error) {
      controller.abort();
      await Promise.allSettled(downloads);
      throw error;
    }
  } finally {
    await file.close();
  }
}

async function downloadInOneStream(url, archive, size, onBytes, fetchImpl) {
  await withFetchTimeout(fetchImpl, url, {
    cache: 'no-store',
    headers: { 'Accept-Encoding': 'identity' }
  }, async response => {
    if (!response.ok || !response.body) throw new Error(`Update download failed (${response.status}).`);
    const file = await fs.promises.open(archive, 'w');
    try { await writeResponseBody(response, file, 0, size, onBytes); }
    finally { await file.close(); }
  });
}

async function downloadUpdateArchive(url, archive, size, onProgress = () => {}, {
  fetchImpl = fetch,
  streams = DOWNLOAD_STREAMS,
  minimumPartSize = MINIMUM_DOWNLOAD_PART_SIZE,
  rangeRetries = RANGE_DOWNLOAD_RETRIES,
  rangeRetryDelayMs = RANGE_RETRY_DELAY_MS,
  onDiagnostic = () => {}
} = {}) {
  const ranges = downloadRanges(size, streams, minimumPartSize);
  let received = 0;
  const onBytes = bytes => {
    received += bytes;
    onProgress(received);
  };
  if (ranges.length) {
    onDiagnostic('info', 'mode selected', {
      mode: 'parallel',
      streams: ranges.length,
      maximumAttemptsPerRange: rangeRetries + 1
    });
    try {
      await downloadInRanges(url, archive, size, ranges, onBytes, fetchImpl, {
        retries: rangeRetries,
        retryDelayMs: rangeRetryDelayMs,
        onDiagnostic
      });
      return;
    } catch (error) {
      if (!(error instanceof RangeUnsupportedError)) throw error;
      onDiagnostic('warn', 'fallback to single stream', {
        reason: error.message,
        status: error.status,
        contentRange: error.contentRange,
        range: error.range
      });
      received = 0;
      onProgress(0);
    }
  } else {
    onDiagnostic('info', 'mode selected', {
      mode: 'single',
      reason: 'archive is too small for multiple download ranges'
    });
  }
  await downloadInOneStream(url, archive, size, onBytes, fetchImpl);
}

function isPreparationDirectory(name) {
  return PREPARATION_DIRECTORY.test(String(name || ''));
}

async function removeWithRetries(target, { recursive = false } = {}) {
  for (let attempt = 0; attempt <= 8; attempt += 1) {
    try {
      await rawFs.promises.rm(target, { recursive, force: true });
      return;
    } catch (error) {
      if (!RETRYABLE_FILE_ERRORS.has(error?.code) || attempt === 8) throw error;
      await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
}

async function cleanupStalePreparations(versions, { protectedDirectories = [] } = {}) {
  let entries;
  try {
    entries = await rawFs.promises.readdir(versions, { withFileTypes: true });
  } catch {
    return;
  }
  const protectedNames = new Set(protectedDirectories.filter(Boolean));
  const stale = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isPreparationDirectory(entry.name) || protectedNames.has(entry.name)) continue;
    try {
      const stat = await rawFs.promises.stat(path.join(versions, entry.name));
      if (Date.now() - stat.mtimeMs >= STALE_PREPARATION_AGE_MS) stale.push(entry.name);
    } catch {}
  }
  await Promise.allSettled(stale.map(name => removeWithRetries(path.join(versions, name), { recursive: true })));
}

async function renameWithRetries(source, destination, {
  rename = rawFs.promises.rename,
  wait = delay => new Promise(resolve => setTimeout(resolve, delay)),
  attempts = 20
} = {}) {
  for (let attempt = 0; attempt <= attempts; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      if (!RETRYABLE_FILE_ERRORS.has(error?.code) || attempt === attempts) throw error;
      await wait(Math.min(500, 50 * (attempt + 1)));
    }
  }
}

async function promotePreparedDirectory(source, destination, {
  rename = rawFs.promises.rename,
  copy = rawFs.promises.cp,
  remove = removeWithRetries,
  stat = rawFs.promises.stat,
  wait = delay => new Promise(resolve => setTimeout(resolve, delay)), expectedAsarSha512 = ''
} = {}) {
  try {
    await renameWithRetries(source, destination, { rename, wait, attempts: 4 });
    return 'rename';
  } catch (error) {
    if (!RETRYABLE_FILE_ERRORS.has(error?.code)) throw error;
  }

  await remove(destination, { recursive: true }).catch(() => {});
  await copy(source, destination, { recursive: true, force: false, errorOnExist: true });
  const executable = path.join(destination, APP_EXECUTABLE);
  const asar = path.join(destination, 'resources', 'app.asar');
  if ((await stat(executable)).size <= 0 || (await stat(asar)).size <= 0) {
    await remove(destination, { recursive: true }).catch(() => {});
    throw new Error('The promoted update is incomplete.');
  }
  if (expectedAsarSha512 && await sha512(asar) !== expectedAsarSha512) {
    await remove(destination, { recursive: true }).catch(() => {});
    throw new Error('The promoted application package failed its integrity check.');
  }
  await remove(source, { recursive: true }).catch(() => {});
  return 'copy';
}

async function cleanupInvalidPreparedVersions(versions, { protectedDirectories = [] } = {}) {
  let entries;
  try { entries = await rawFs.promises.readdir(versions, { withFileTypes: true }); }
  catch { return; }
  const protectedNames = new Set(protectedDirectories.filter(Boolean));
  await Promise.allSettled(entries.filter(entry => (
    entry.isDirectory()
    && entry.name.includes('.app-')
    && !protectedNames.has(entry.name)
  )).map(async entry => {
    const directory = path.join(versions, entry.name);
    try {
      const marker = JSON.parse(await rawFs.promises.readFile(path.join(directory, '.clips-update.json'), 'utf8'));
      if (!parseVersion(marker.version)
        || !isVersionDirectory(entry.name, marker.version)
          || (await rawFs.promises.stat(path.join(directory, APP_EXECUTABLE))).size <= 0
          || (await rawFs.promises.stat(path.join(directory, 'resources', 'app.asar'))).size <= 0) throw new Error('invalid');
    } catch {
      await removeWithRetries(directory, { recursive: true });
    }
  }));
}

async function cleanupOldVersionDirectories(versions, {
  protectedDirectories = [],
  retain = 2
} = {}) {
  let entries;
  try {
    entries = await rawFs.promises.readdir(versions, { withFileTypes: true });
  } catch {
    return;
  }
  const protectedNames = new Set(protectedDirectories.filter(Boolean));
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !VERSION_DIRECTORY.test(entry.name)) continue;
    try {
      const stat = await rawFs.promises.stat(path.join(versions, entry.name));
      candidates.push({ name: entry.name, modified: stat.mtimeMs });
    } catch {
      // A concurrently removed version needs no further cleanup.
    }
  }
  candidates.sort((left, right) => right.modified - left.modified);
  const keep = new Set(protectedNames);
  for (const candidate of candidates) {
    if (keep.size >= Math.max(1, retain)) break;
    keep.add(candidate.name);
  }
  await Promise.allSettled(candidates
    .filter(candidate => !keep.has(candidate.name))
    .map(candidate => removeWithRetries(path.join(versions, candidate.name), { recursive: true })));
}

async function cleanupOldVersions(app) {
  const root = updateRoot(app);
  const versions = path.join(root, 'app-versions');
  const active = readActiveVersion(app);
  const protectedDirectories = active ? [active.directory] : [];
  const runningDirectory = path.basename(path.dirname(process.execPath));
  const runningParent = path.resolve(path.dirname(path.dirname(process.execPath)));
  if (runningParent.toLowerCase() === path.resolve(versions).toLowerCase()) {
    protectedDirectories.push(runningDirectory);
  }
  await cleanupInvalidPreparedVersions(versions, { protectedDirectories });
  await cleanupOldVersionDirectories(versions, { protectedDirectories, retain: 2 });
}

async function findPreparedUpdate(app, metadata) {
  const versions = path.join(updateRoot(app), 'app-versions');
  let entries;
  try {
    entries = await rawFs.promises.readdir(versions, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isVersionDirectory(entry.name, metadata.version)) continue;
    const directory = versionDirectory(app, metadata.version, entry.name);
    const executable = path.join(directory, APP_EXECUTABLE);
    const asar = path.join(directory, 'resources', 'app.asar');
    try {
      const prepared = JSON.parse(await rawFs.promises.readFile(
        path.join(directory, '.clips-update.json'), 'utf8'
      ));
      if (
        prepared.version === metadata.version
        && prepared.sha512 === metadata.sha512
        && rawFs.statSync(executable).size > 0
        && rawFs.statSync(asar).size > 0
        && (!metadata.asarSha512 || await sha512(asar) === metadata.asarSha512)
      ) {
        candidates.push({
          version: metadata.version,
          directory: entry.name,
          executable,
          preparedAt: Date.parse(prepared.preparedAt) || 0
        });
      }
    } catch {
      // An incomplete directory has no valid marker and can never be activated.
    }
  }
  candidates.sort((left, right) => right.preparedAt - left.preparedAt);
  return candidates[0] || null;
}

function validateMetadata(value) {
  if (!value || !parseVersion(value.version) || typeof value.sha512 !== 'string') {
    throw new Error('The update feed returned invalid metadata.');
  }
  if (String(value.url || '') !== `jss-clips-app-${value.version}-x64.zip`) {
    throw new Error('The update feed returned an invalid package name.');
  }
  const size = Number(value.size);
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new Error('The update feed returned an invalid package size.');
  }
  const asarSha512 = typeof value.asarSha512 === 'string' ? value.asarSha512 : '';
  return { version: value.version, url: value.url, sha512: value.sha512, size, ...(asarSha512 ? { asarSha512 } : {}) };
}

function authenticateMetadata(value, publicKey = UPDATE_PUBLIC_KEY) {
  if (!verifyMetadata(value, publicKey)) throw new Error('The update feed signature is invalid.');
  if (value?.asarSha512 && !verifyPackageMetadata(value, publicKey)) throw new Error('The update package signature is invalid.');
  return validateMetadata(value);
}

function preparedUpdateMatches(prepared, metadata) {
  return Boolean(prepared && metadata
    && prepared.version === metadata.version
    && prepared.url === metadata.url
    && prepared.sha512 === metadata.sha512
    && prepared.size === metadata.size);
}

function createStagedUpdater({ app, feedUrl, onState, logger, onDiagnostic = () => {}, resourcesPath = process.resourcesPath }) {
  let operation = null;
  let readyUpdate = null;
  let readyMetadata = null;

  const trace = (level, event, details = {}) => {
    const entry = { time: new Date().toISOString(), level, event, pid: process.pid, details };
    onDiagnostic(entry);
    logger?.[level]?.(`staged updater ${event}`, details);
  };
  const emit = next => { trace('info', 'state', next); onState(next); };
  const sevenZip = () => path.join(resourcesPath, 'tools', '7za.exe');
  const snapshot = async (label, directory) => {
    const inspect = async (api, file) => {
      try {
        const stat = await api.promises.stat(file);
        return { exists: true, size: stat.size, directory: stat.isDirectory(), modified: stat.mtime?.toISOString() };
      } catch (error) {
        return { exists: false, code: error?.code, message: error?.message };
      }
    };
    let resources = [];
    try { resources = (await rawFs.promises.readdir(path.join(directory, 'resources'))).slice(0, 40); }
    catch (error) { resources = [`<${error?.code || error}>`]; }
    trace('info', `snapshot ${label}`, {
      directory,
      executable: await inspect(rawFs, path.join(directory, APP_EXECUTABLE)),
      asarRaw: await inspect(rawFs, path.join(directory, 'resources', 'app.asar')),
      resources
    });
  };
  trace('info', 'created', { appVersion: app.getVersion(), feedUrl, executable: process.execPath, resourcesPath: process.resourcesPath, rawFilesystem: rawFs !== fs });
  const startupCleanup = (async () => {
    trace('info', 'startup cleanup begin');
    await cleanupOldVersions(app);
    trace('info', 'startup cleanup complete');
  })().catch(error => trace('warn', 'startup cleanup failed', { code: error?.code, message: error?.message, stack: error?.stack }));

  async function download(metadata) {
    const root = updateRoot(app);
    const downloads = path.join(root, 'app-downloads');
    const versions = path.join(root, 'app-versions');
    const operationId = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const archive = path.join(downloads, `${metadata.url}.${operationId}.download`);
    await rawFs.promises.mkdir(downloads, { recursive: true });
    await rawFs.promises.mkdir(versions, { recursive: true });
    await cleanupStalePreparations(versions);

    try {
      trace('info', 'download begin', { version: metadata.version, url: metadata.url, size: metadata.size, archive });
      let lastPercent = -1;
      await downloadUpdateArchive(`${feedUrl}/${metadata.url}`, archive, metadata.size, received => {
        const percent = Math.min(99, Math.floor(received / metadata.size * 100));
        if (percent !== lastPercent) {
          lastPercent = percent;
          emit({ status: 'downloading', version: metadata.version, percent, message: '' });
        }
      }, {
        onDiagnostic: (level, event, details) => trace(level, `download ${event}`, details)
      });
      emit({ status: 'preparing', version: metadata.version, percent: 100, message: 'Preparing update…' });
      trace('info', 'download complete', { archive, size: (await rawFs.promises.stat(archive)).size });
      const archiveHash = await sha512(archive);
      trace('info', 'archive hashed', { matches: archiveHash === metadata.sha512 });
      if (archiveHash !== metadata.sha512) {
        throw new Error('The downloaded update failed its integrity check.');
      }
      if (!rawFs.existsSync(sevenZip())) throw new Error('The bundled update extractor is missing.');
      let lastError;
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const attemptId = `${operationId}-try${attempt}`;
        const directoryName = `${metadata.version}.app-${attemptId}`;
        const preparationName = `${metadata.version}.preparing-${attemptId}`;
        const destination = path.join(versions, preparationName);
        const finalDestination = versionDirectory(app, metadata.version, directoryName);
        try {
          trace('info', 'extraction begin', { attempt, destination });
          const extraction = await execFileAsync(sevenZip(), ['x', '-y', `-o${destination}`, archive], {
            windowsHide: true,
            maxBuffer: 4 * 1024 * 1024
          });
          trace('info', 'extraction complete', { attempt, stdout: extraction.stdout, stderr: extraction.stderr });
          await snapshot(`after extraction attempt ${attempt}`, destination);
          const extractedExecutable = path.join(destination, APP_EXECUTABLE);
          const extractedAsar = path.join(destination, 'resources', 'app.asar');
          if (!rawFs.existsSync(extractedExecutable) || !rawFs.existsSync(extractedAsar)) throw new Error('The prepared update is incomplete.');
          const asarHash = metadata.asarSha512 ? await sha512(extractedAsar) : '';
          trace('info', 'asar hashed with original-fs', { attempt, matches: !metadata.asarSha512 || asarHash === metadata.asarSha512, size: rawFs.statSync(extractedAsar).size });
          if (metadata.asarSha512 && asarHash !== metadata.asarSha512) throw new Error('The extracted application package failed its integrity check.');
          await rawFs.promises.writeFile(path.join(destination, '.clips-update.json'), JSON.stringify({
            version: metadata.version,
            sha512: metadata.sha512,
            asarSha512: metadata.asarSha512,
            preparedAt: new Date().toISOString()
          }, null, 2));
          trace('info', 'promotion begin', { attempt, destination, finalDestination });
          const promotionStarted = Date.now();
          const promotionMethod = await promotePreparedDirectory(destination, finalDestination, { expectedAsarSha512: metadata.asarSha512 });
          trace('info', 'promotion complete', { attempt, method: promotionMethod, durationMs: Date.now() - promotionStarted });
          await snapshot(`after promotion attempt ${attempt}`, finalDestination);
          trace('info', 'preparation complete', { attempt, directoryName });
          return { version: metadata.version, directory: directoryName, executable: versionExecutable(app, metadata.version, directoryName) };
        } catch (error) {
          lastError = error;
          trace('error', 'preparation attempt failed', { attempt, destination, code: error?.code, errno: error?.errno, syscall: error?.syscall, path: error?.path, message: error?.message, stack: error?.stack });
          await snapshot(`failed attempt ${attempt}`, destination);
          await rawFs.promises.mkdir(destination, { recursive: true }).catch(() => {});
          await rawFs.promises.writeFile(path.join(destination, '.clips-failure.json'), JSON.stringify({
            time: new Date().toISOString(), attempt, code: error?.code, errno: error?.errno, syscall: error?.syscall,
            path: error?.path, message: error?.message, stack: error?.stack
          }, null, 2)).catch(() => {});
          if (attempt < 5) await new Promise(resolve => setTimeout(resolve, attempt * 500));
        }
      }
      throw lastError || new Error('Update preparation failed after five attempts.');
    } finally {
      await removeWithRetries(archive).catch(() => {});
    }
  }

  async function performCheck() {
    await startupCleanup;
    emit({ status: 'checking', message: '', percent: 0 });
    trace('info', 'metadata request begin', { url: `${feedUrl}/latest.json` });
    const metadata = await withFetchTimeout(fetch, `${feedUrl}/latest.json`, { cache: 'no-store' }, async response => {
      if (!response.ok) throw new Error(`Update check failed (${response.status}).`);
      return authenticateMetadata(await response.json());
    }, METADATA_TIMEOUT_MS);
    trace('info', 'metadata authenticated', { version: metadata.version, url: metadata.url, size: metadata.size, hasAsarHash: !!metadata.asarSha512 });
    if (compareVersions(metadata.version, app.getVersion()) <= 0) {
      readyUpdate = null;
      readyMetadata = null;
      emit({ status: 'idle', version: app.getVersion(), percent: 0, message: '' });
      return false;
    }
    readyUpdate = await findPreparedUpdate(app, metadata);
    trace('info', readyUpdate ? 'prepared update reused' : 'prepared update not found', readyUpdate || { version: metadata.version });
    if (!readyUpdate) readyUpdate = await download(metadata);
    readyMetadata = metadata;
    emit({ status: 'ready', version: metadata.version, percent: 100, message: 'Restart to update' });
    return true;
  }

  function check() {
    if (operation) return operation;
    operation = performCheck()
      .catch(error => {
        trace('error', 'check failed', { code: error?.code, errno: error?.errno, syscall: error?.syscall, path: error?.path, message: error?.message, stack: error?.stack });
        emit({ status: 'error', percent: 0, message: error?.message || String(error) });
        return false;
      })
      .finally(() => { operation = null; });
    return operation;
  }

  async function restart(beforeRestart = async () => {}) {
    trace('info', 'restart requested', { readyUpdate, hasMetadata: !!readyMetadata });
    if (!readyUpdate || !rawFs.existsSync(readyUpdate.executable)) {
      trace('error', 'restart rejected: executable missing', { readyUpdate });
      return false;
    }
    let currentMetadata;
    try {
      currentMetadata = await withFetchTimeout(fetch, `${feedUrl}/latest.json`, { cache: 'no-store' }, async response => {
        if (!response.ok) throw new Error(`Update confirmation failed (${response.status}).`);
        return authenticateMetadata(await response.json());
      }, METADATA_TIMEOUT_MS);
    } catch (error) {
      emit({ status: 'error', percent: 0, message: `Could not confirm this update is still available: ${error?.message || error}` });
      return false;
    }
    if (!preparedUpdateMatches(readyMetadata, currentMetadata)) {
      readyUpdate = null;
      readyMetadata = null;
      if (compareVersions(currentMetadata.version, app.getVersion()) > 0) {
        emit({ status: 'checking', version: currentMetadata.version, percent: 0, message: 'The previous update was withdrawn. Getting the replacement…' });
        operation = performCheck().finally(() => { operation = null; });
        await operation.catch(error => {
          emit({ status: 'error', percent: 0, message: error?.message || String(error) });
        });
      } else {
        emit({ status: 'withdrawn', version: app.getVersion(), percent: 0, message: 'This update was withdrawn and will not be installed.' });
      }
      return false;
    }
    await beforeRestart();
    trace('info', 'capture shutdown complete');
    const pointer = activeVersionPath(app);
    const previousActive = readActiveVersion(app);
    writeActivePointerSync(app, {
      version: readyUpdate.version,
      directory: readyUpdate.directory,
      activatedAt: new Date().toISOString(),
      state: 'pending',
      bootAttempts: 0,
      previous: previousActive ? {
        version: previousActive.version,
        directory: previousActive.directory,
        activatedAt: previousActive.activatedAt
      } : {
        type: 'installed',
        version: app.getVersion(),
        executable: process.execPath
      }
    });
    trace('info', 'active pointer written', { pointer, readyUpdate });
    app.isQuitting = true;
    app.relaunch({ execPath: readyUpdate.executable, args: updateRelaunchArgs() });
    trace('info', 'relaunch requested', { execPath: readyUpdate.executable, args: updateRelaunchArgs() });
    app.exit(0);
    return true;
  }

  return { check, restart };
}

module.exports = {
  compareVersions,
  cleanupOldVersionDirectories,
  cleanupStalePreparations,
  cleanupInvalidPreparedVersions,
  isPreparationDirectory,
  isVersionDirectory,
  validateMetadata,
  authenticateMetadata,
  preparedUpdateMatches,
  downloadRanges,
  downloadUpdateArchive,
  withFetchTimeout,
  renameWithRetries,
  promotePreparedDirectory,
  updateRelaunchArgs,
  readActiveVersion,
  rollbackActiveVersion,
  confirmActiveVersionBoot,
  redirectToActiveVersion,
  createStagedUpdater
};
