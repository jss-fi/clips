const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, globalShortcut, nativeImage, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const crypto = require('crypto');
const { execFile, execFileSync, spawn } = require('child_process');
const { promisify } = require('util');
const { ObsController } = require('./obs');
const buildInfo = require('./build-info.json');
const { RUNTIME_VERSION, runtimeRoot, isRuntimeReady, ensureRuntimeInstalled } = require('./runtime');
const { redirectToActiveVersion, confirmActiveVersionBoot, createStagedUpdater } = require('./updater');
const { createTrayController } = require('./tray-controller');
const { MPV_QUIT_ON_FULLSCREEN_EXIT_SCRIPT, mpvFullscreenArgs } = require('./mpv-fullscreen');
const { createLogger, redactLogText } = require('./logger');
const { loadSettingsFile, normalizeSettingsUpdate, captureRestartRequired } = require('./settings');
const { configuredEndpoint, loadInstallationId, createTelemetry } = require('./telemetry');
const { parseProcessList } = require('./process-list');
const { candidateKey, updateCandidateHistory } = require('./game-candidates');
const { displayVersion } = require('./version');
const { LibraryMetadata, storageInsights, concatManifest } = require('./library');
const { createRecordingLibrary } = require('./recording-library');
const { createGateway, DEFAULT_GATEWAY_PORT } = require('./gateway');
const { createRecordingMediaServer } = require('./media-server');
const changelog = require('./changelog.json');

const legacyUserDataPath = path.join(app.getPath('appData'), 'Clippy');
app.setPath('userData', path.join(app.getPath('appData'), 'Clips'));
const redirectedToActiveVersion = redirectToActiveVersion(app);
const gotSingleInstanceLock = !redirectedToActiveVersion && app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) app.quit();

const execFileAsync = promisify(execFile);
let releaseConfig = {};
try { releaseConfig = require('./release-config.json'); } catch {}
const DEFAULT_UPDATE_URL = String(releaseConfig.updateUrl || '');
const DEFAULT_NVAFX_SDK_DIR = 'C:\\Program Files\\NVIDIA Corporation\\NVIDIA Audio Effects SDK';
if (!process.env.NVAFX_SDK_DIR && fs.existsSync(path.join(DEFAULT_NVAFX_SDK_DIR, 'NVAudioEffects.dll'))) {
  // Staged updates relaunch from the old process, which does not inherit newly
  // installed machine environment variables until the next Windows sign-in.
  process.env.NVAFX_SDK_DIR = DEFAULT_NVAFX_SDK_DIR;
}
const persistentRuntimeRoot = runtimeRoot(process.env.LOCALAPPDATA || app.getPath('userData'));
const DEFAULTS = {
  recordingsFolder: path.join(os.homedir(), 'Videos', 'Clips'),
  retentionDays: 1, storageCleanupMode: 'disk', maxDiskUsagePercent: 80, maxRawRecordingGigabytes: 250,
  gameExecutables: [], ignoredGameExecutables: [], audioExecutables: ['Discord.exe'],
  autoRecord: true, startWithWindows: true, clipHotkey: 'CommandOrControl+Shift+F10', markerHotkey: 'CommandOrControl+Shift+F9',
  gameProfiles: {},
  pollSeconds: 5, stopDelaySeconds: 20, clipLengthSeconds: 60, instantReplay: false, instantReplayLengthSeconds: 300,
  obsRecordingQuality: 'HQ', obsEncoder: 'auto', obsResolution: '1920x1080', obsFps: 60, obsFormat: 'mkv',
  microphoneDeviceId: 'disabled', microphoneVolumePercent: 100, microphoneNoiseGateDb: -40,
  microphoneNvidiaNoiseRemoval: true,
  trimBitrate: 'original',
  desktopWindow: true,
  nightlyUpdates: false, telemetryMode: 'pending'
};

let win, toastWin, settings, monitorTimer, monitorPromise, monitorRerunRequested = false, stopTimer, toastHideTimer, toastRecoveryTimer, microphoneVolumePersistTimer, connectPromise, autoRecordSuppressed = false, lastError = '', activeGames = [], runningApps = [], lastClip = '', sessionDate = '', toastReady = false, pendingToast = null;
let settingsRecoveryWarning = '';
let settingsPersistenceBlocked = false;
let mpvProcess = null, mpvSocket = null, mpvBuffer = '', mpvRequestId = 0;
let mpvFrameBuffer = Buffer.alloc(0);
const mpvRequests = new Map();
const thumbnailPromises = new Map();
let thumbnailQueue = Promise.resolve();
let updateState = { status: 'idle', version: app.getVersion(), percent: 0, message: '', configured: false };
let updateCheckTimer = null;
let updateCheckTimeout = null;
let updateConfigurationGeneration = 0;
let stagedUpdater = null;
const updateDiagnostics = [];
let runtimeSetupPromise = Promise.resolve();
const logger = createLogger({ directory: path.join(app.getPath('userData'), 'logs') });
const trayController = createTrayController({ getWindow: () => win });
const telemetryEndpoint = configuredEndpoint();
let telemetry = null;
let systemInformation = null;
let previousCaptureHealth = null;
const gameCandidateHistory = new Map();
let pendingGameCandidate = null;
const ADD_GAME_HOTKEY = 'CommandOrControl+Shift+F11';
const IGNORE_GAME_HOTKEY = 'CommandOrControl+Shift+F12';
let libraryMetadata = null;
let microphoneListPromise = null;
const gatewayTokenPath = path.join(app.getPath('userData'), 'browser-gateway.json');
function loadGatewayToken() {
  try {
    const token = String(JSON.parse(fs.readFileSync(gatewayTokenPath, 'utf8')).token || '');
    if (/^[A-Za-z0-9_-]{43}$/.test(token)) return token;
  } catch {}
  const token = crypto.randomBytes(32).toString('base64url');
  fs.mkdirSync(path.dirname(gatewayTokenPath), { recursive: true });
  fs.writeFileSync(gatewayTokenPath, `${JSON.stringify({ token }, null, 2)}\n`, { mode: 0o600 });
  return token;
}
const gatewayToken = loadGatewayToken();
let gateway = null;
let gatewayReady = false;
let sessionStartedAt = 0;
let sessionMarkers = [];
let sessionGame = '';
let lastCaptureWarningTime = 0;
let captureWarningWindow = { startedAt: 0, renderingLag: 0, encoderDrops: 0 };
let lastProblemOverlay = { message: '', time: 0 };
const obs = new ObsController(() => broadcast(), logger);
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
const recordingLibrary = createRecordingLibrary({
  getSettings: () => settings,
  getMetadata: () => libraryMetadata,
  favoritesPath: () => path.join(app.getPath('userData'), 'favorites.json'),
  onDelete: async filePath => {
    libraryMetadata?.remove(filePath);
    thumbnailPromises.delete(filePath);
    recordingMediaServer.invalidate(filePath);
    try {
      const stat = await fs.promises.stat(filePath);
      const key = crypto.createHash('sha256').update(`${filePath}:${stat.size}:${stat.mtimeMs}`).digest('hex').slice(0, 24);
      await fs.promises.rm(path.join(app.getPath('userData'), 'thumbnail-cache-v2', `${key}.jpg`), { force: true });
    } catch {}
  }
});
const { isRawRecordingName } = recordingLibrary;
const cleanupStorage = () => recordingLibrary.cleanupStorage(ensureDirectory);
const STORAGE_CLEANUP_INTERVAL_MS = 60 * 1000;
let lastStorageCleanupAt = 0;
async function cleanupStorageOnSchedule(force = false) {
  const now = Date.now();
  if (!force && now - lastStorageCleanupAt < STORAGE_CLEANUP_INTERVAL_MS) return;
  lastStorageCleanupAt = now;
  await cleanupStorage();
}
const recentRecordings = () => recordingLibrary.recentRecordings();
const archivedRecordings = () => recordingLibrary.archivedRecordings();
const validateRecordingPath = filePath => recordingLibrary.validatePath(filePath);
const recordingMediaServer = createRecordingMediaServer({
  validatePath: validateRecordingPath,
  ffmpegPath,
  execFile: execFileAsync,
  spawn,
  logger
});
function captureRuntimeRoot() {
  return app.isPackaged ? persistentRuntimeRoot : path.join(__dirname, '..', 'vendor');
}
function captureHostPath() {
  return path.join(captureRuntimeRoot(), 'libobs', 'bin', '64bit', 'clips-capture-host.exe');
}
async function stopLegacyBundledObs() {
  if (!app.isPackaged) return;
  const legacyRoot = path.resolve(path.dirname(persistentRuntimeRoot), 'v1', 'obs-studio').toLowerCase();
  const script = "Get-CimInstance Win32_Process -Filter \"Name='obs64.exe'\" | Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress";
  let processes = [];
  try {
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      encoding: 'utf8'
    }).trim();
    if (output) {
      const parsed = JSON.parse(output);
      processes = Array.isArray(parsed) ? parsed : [parsed];
    }
  } catch {}
  const legacy = processes.filter(processInfo => {
    const executable = path.resolve(String(processInfo.ExecutablePath || '')).toLowerCase();
    return executable === path.join(legacyRoot, 'bin', '64bit', 'obs64.exe');
  });
  for (const processInfo of legacy) {
    await execFileAsync('taskkill.exe', ['/PID', String(processInfo.ProcessId), '/T'], {
      windowsHide: true
    }).catch(() => {});
  }
}
function ffmpegPath() {
  const persistent = path.join(persistentRuntimeRoot, 'ffmpeg', 'ffmpeg.exe');
  if (app.isPackaged && isRuntimeReady(persistentRuntimeRoot)) return persistent;
  const bundled = path.join(process.resourcesPath, 'ffmpeg', 'ffmpeg.exe');
  if (app.isPackaged && fs.existsSync(bundled)) return bundled;
  const staged = path.join(__dirname, '..', 'vendor', 'ffmpeg', 'ffmpeg.exe');
  return fs.existsSync(staged) ? staged : '';
}
function mpvPath() {
  const candidates = [
    path.join(persistentRuntimeRoot, 'mpv', 'mpv.exe'),
    path.join(process.resourcesPath, 'mpv', 'mpv.exe'),
    path.join(__dirname, '..', 'vendor', 'mpv', 'mpv.exe')
  ];
  return candidates.find(candidate => candidate && fs.existsSync(candidate)) || '';
}
function mpvFullscreenScriptPath() {
  const directory = path.join(app.getPath('userData'), 'mpv');
  const scriptPath = path.join(directory, 'quit-on-fullscreen-exit.lua');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(scriptPath, MPV_QUIT_ON_FULLSCREEN_EXIT_SCRIPT);
  return scriptPath;
}
function loadSettings() {
  const loaded = loadSettingsFile({
    currentPath: settingsPath(),
    legacyPath: path.join(legacyUserDataPath, 'settings.json'),
    defaults: DEFAULTS
  });
  settingsRecoveryWarning = loaded.warning;
  settingsPersistenceBlocked = loaded.persistenceBlocked;
  if (loaded.warning) logger.warn('settings recovery used defaults', {
    path: loaded.sourcePath,
    backupPath: loaded.backupPath,
    message: loaded.error?.message,
    backupError: loaded.backupError?.message
  });
  return loaded.settings;
}
function persist() {
  if (settingsPersistenceBlocked) {
    logger.warn('settings persistence skipped to preserve an unreadable settings file', { path: settingsPath() });
    return false;
  }
  const target = settingsPath();
  const temporary = `${target}.working`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const stored = { ...settings };
  fs.writeFileSync(temporary, `${JSON.stringify(stored, null, 2)}\n`);
  fs.renameSync(temporary, target);
  return true;
}
function ensureDirectory(folder) {
  if (fs.existsSync(folder)) {
    if (!fs.statSync(folder).isDirectory()) throw new Error(`Storage path is not a folder: ${folder}`);
    return;
  }
  fs.mkdirSync(folder, { recursive: true });
}
function todayFolder() {
  const date = new Date().toLocaleDateString('sv-SE');
  const folder = path.join(settings.recordingsFolder, date);
  ensureDirectory(folder);
  return folder;
}
function todayKey() { return new Date().toLocaleDateString('sv-SE'); }
async function startSession({ recording = true, replayLengthSeconds = 0 } = {}) {
  const profile = settings.gameProfiles?.[activeGames[0]?.toLowerCase()] || {};
  const captureSettings = { ...settings,
    obsRecordingQuality: profile.quality || settings.obsRecordingQuality,
    obsResolution: profile.resolution || settings.obsResolution,
    obsFps: profile.fps || settings.obsFps,
    clipLengthSeconds: replayLengthSeconds || profile.clipLengthSeconds || settings.clipLengthSeconds };
  if (!await tryConnect(captureSettings)) throw new Error(lastError || 'The Clips capture engine could not start.');
  if (obs.settings && ['obsRecordingQuality', 'obsEncoder', 'obsResolution', 'obsFps', 'obsFormat', 'clipLengthSeconds']
    .some(key => obs.settings[key] !== captureSettings[key])) {
    await obs.applyRecordingSettings({
      quality: captureSettings.obsRecordingQuality,
      encoder: captureSettings.obsEncoder,
      resolution: captureSettings.obsResolution,
      fps: captureSettings.obsFps,
      format: captureSettings.obsFormat,
      clipLengthSeconds: captureSettings.clipLengthSeconds
    });
  }
  await cleanupStorageOnSchedule(true);
  const wantedAudio = new Set([...(profile.audioExecutables || settings.audioExecutables), ...activeGames].map(name => name.toLowerCase()));
  const outputDirectory = todayFolder();
  const audioApplications = runningApps.filter(app => wantedAudio.has(app.name.toLowerCase()));
  logger.info('starting capture session', {
    outputDirectory,
    microphoneDeviceId: settings.microphoneDeviceId,
    activeGames,
    audioApplications: audioApplications.map(application => application.name)
  });
  await obs.configureApplicationAudio(audioApplications);
  await obs.startSession(
    outputDirectory,
    activeGames,
    profile.microphoneDeviceId || settings.microphoneDeviceId,
    settings.microphoneVolumePercent,
    settings.microphoneNoiseGateDb,
    settings.microphoneNvidiaNoiseRemoval,
    recording
  );
  sessionDate = todayKey();
  sessionStartedAt = recording ? Date.now() : 0;
  sessionMarkers = recording ? [] : sessionMarkers;
  sessionGame = activeGames[0] || 'Desktop capture';
  if (recording) showOverlayToast('Recording started', 'recording');
}

async function startInstantReplay() {
  await startSession({ recording: false, replayLengthSeconds: settings.instantReplayLengthSeconds });
}
async function finalizeSessionMetadata() {
  if (sessionMarkers.length || sessionGame) {
    const candidates = (await recentRecordings()).filter(item => item.kind === 'recording').sort((a, b) => b.modified.localeCompare(a.modified));
    if (candidates[0]) libraryMetadata.update(candidates[0].path, { markers: sessionMarkers, game: sessionGame });
  }
  sessionMarkers = []; sessionStartedAt = 0; sessionGame = '';
}
async function previewPath(filePath) {
  const sourcePath = validateRecordingPath(filePath);
  if (path.extname(sourcePath).toLowerCase() === '.mp4') return sourcePath;
  const stat = fs.statSync(sourcePath);
  const cacheFolder = path.join(app.getPath('userData'), 'preview-cache');
  fs.mkdirSync(cacheFolder, { recursive: true });
  const key = crypto.createHash('sha256').update(`${sourcePath}:${stat.size}:${stat.mtimeMs}`).digest('hex').slice(0, 24);
  const outputPath = path.join(cacheFolder, `${key}.mp4`);
  if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) return outputPath;
  const temporaryPath = `${outputPath}.working.mp4`;
  const executable = ffmpegPath();
  if (!fs.existsSync(executable)) throw new Error('FFmpeg is missing from this Clips build.');
  try {
    try {
      await execFileAsync(executable, [
        '-hide_banner', '-loglevel', 'error', '-y', '-i', sourcePath,
        '-map', '0:v:0', '-map', '0:a?', '-c', 'copy', '-movflags', '+faststart', temporaryPath
      ], { windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
    } catch {
      fs.rmSync(temporaryPath, { force: true });
      await execFileAsync(executable, [
        '-hide_banner', '-loglevel', 'error', '-y', '-i', sourcePath,
        '-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast',
        '-crf', '21', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', temporaryPath
      ], { windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
    }
    fs.renameSync(temporaryPath, outputPath);
    return outputPath;
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw new Error(error.stderr?.trim() || 'Could not create a playable preview.');
  }
}
async function recordingThumbnail(filePath) {
  const sourcePath = validateRecordingPath(filePath);
  const stat = fs.statSync(sourcePath);
  const cacheFolder = path.join(app.getPath('userData'), 'thumbnail-cache-v2');
  fs.mkdirSync(cacheFolder, { recursive: true });
  const key = crypto.createHash('sha256').update(`${sourcePath}:${stat.size}:${stat.mtimeMs}`).digest('hex').slice(0, 24);
  const outputPath = path.join(cacheFolder, `${key}.jpg`);
  const readThumbnail = () => `data:image/jpeg;base64,${fs.readFileSync(outputPath).toString('base64')}`;
  if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) return readThumbnail();
  if (thumbnailPromises.has(sourcePath)) return thumbnailPromises.get(sourcePath);
  const job = thumbnailQueue.then(async () => {
    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) return readThumbnail();
    const executable = ffmpegPath();
    if (!fs.existsSync(executable)) return '';
    const temporaryPath = `${outputPath}.working.jpg`;
    try {
      const renderThumbnail = (filters, seek = true) => execFileAsync(executable, [
        '-hide_banner', '-loglevel', 'error', '-y', ...(seek ? ['-ss', '1'] : []), '-i', sourcePath,
        '-frames:v', '1', '-vf', filters,
        '-q:v', '3', '-strict', 'unofficial', temporaryPath
      ], { windowsHide: true, maxBuffer: 5 * 1024 * 1024 });
      const scale = 'scale=640:360:force_original_aspect_ratio=increase,crop=640:360';
      try {
        await renderThumbnail(scale);
        if (!fs.existsSync(temporaryPath) || !fs.statSync(temporaryPath).size) throw new Error('No visible frame found.');
      } catch {
        fs.rmSync(temporaryPath, { force: true });
        await renderThumbnail(scale, false);
      }
      fs.renameSync(temporaryPath, outputPath);
      return readThumbnail();
    } catch {
      fs.rmSync(temporaryPath, { force: true });
      return '';
    }
  });
  thumbnailQueue = job.catch(() => '');
  thumbnailPromises.set(sourcePath, job);
  try {
    return await job;
  } finally {
    thumbnailPromises.delete(sourcePath);
  }
}
async function recordingMediaUrl(filePath, requestedStartSeconds = 0) {
  return recordingMediaServer.createStreamUrl(filePath, requestedStartSeconds);
}
function closeMpvSession() {
  const child = mpvProcess;
  if (child?.stdin?.writable) child.stdin.write(`quit\t0\n`);
  if (child && !child.killed) setTimeout(() => { if (!child.killed) child.kill(); }, 500);
  mpvProcess = null;
  for (const pending of mpvRequests.values()) pending.reject(new Error('MPV closed.'));
  mpvRequests.clear();
}
function handleMpvData(chunk) {
  mpvBuffer += chunk.toString();
  let newline;
  while ((newline = mpvBuffer.indexOf('\n')) >= 0) {
    const line = mpvBuffer.slice(0, newline).replace(/\r$/, '');
    mpvBuffer = mpvBuffer.slice(newline + 1);
    const fields = line.split('\t');
    const requestId = Number(fields[0]);
    if (!requestId || !mpvRequests.has(requestId)) continue;
    const pending = mpvRequests.get(requestId);
    mpvRequests.delete(requestId);
    pending.resolve(fields.slice(1));
  }
}
function handleMpvFrames(chunk) {
  mpvFrameBuffer = Buffer.concat([mpvFrameBuffer, chunk]);
  while (mpvFrameBuffer.length >= 12) {
    const width = mpvFrameBuffer.readUInt32LE(0);
    const height = mpvFrameBuffer.readUInt32LE(4);
    const size = mpvFrameBuffer.readUInt32LE(8);
    if (!width || !height || size !== width * height * 4 || size > 16 * 1024 * 1024) {
      mpvFrameBuffer = Buffer.alloc(0);
      return;
    }
    if (mpvFrameBuffer.length < 12 + size) return;
    const pixels = mpvFrameBuffer.subarray(12, 12 + size);
    if (win && !win.isDestroyed()) win.webContents.send('mpv:frame', { width, height, pixels });
    mpvFrameBuffer = mpvFrameBuffer.subarray(12 + size);
  }
}
function mpvCommand(command, ...args) {
  if (!mpvProcess?.stdin?.writable) return Promise.reject(new Error('MPV preview is not running.'));
  const requestId = ++mpvRequestId;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      mpvRequests.delete(requestId);
      reject(new Error('MPV did not respond.'));
    }, 3000);
    mpvRequests.set(requestId, {
      resolve: value => { clearTimeout(timeout); resolve(value); },
      reject: error => { clearTimeout(timeout); reject(error); }
    });
    mpvProcess.stdin.write(`${[command, requestId, ...args].join('\t')}\n`);
  });
}
function setMpvBounds(bounds) {
  if (!mpvProcess?.stdin?.writable) return;
  mpvCommand('bounds', Math.round(bounds.x || 0), Math.round(bounds.y || 0), Math.round(bounds.width || 1), Math.round(bounds.height || 1)).catch(() => {});
}
async function setMpvAudioMix(requestedAdjustments) {
  const adjustments = (Array.isArray(requestedAdjustments) ? requestedAdjustments : [])
    .map(adjustment => ({
      index: Number(adjustment?.index),
      volume: Math.min(2, Math.max(0, Number(adjustment?.volume) || 0))
    }))
    .filter(adjustment => Number.isInteger(adjustment.index) && adjustment.index >= 0 && adjustment.index < 32);
  if (!adjustments.length) return mpvCommand('audio-reset');
  const inputs = adjustments.map((adjustment, index) =>
    `[aid${adjustment.index + 1}]volume=${adjustment.volume.toFixed(2)}[live${index}]`);
  const output = adjustments.length === 1
    ? `[live0]anull[ao]`
    : `${adjustments.map((_, index) => `[live${index}]`).join('')}amix=inputs=${adjustments.length}:duration=longest:normalize=0[ao]`;
  const response = await mpvCommand('audio-mix', `${inputs.join(';')};${output}`);
  if (response[0] === 'error') throw new Error(response[1] || 'Could not update the live audio mix.');
  return true;
}
async function startMpvSession(filePath, bounds) {
  const target = validateRecordingPath(filePath);
  const persistentHost = path.join(persistentRuntimeRoot, 'libmpv', 'mpv-host.exe');
  const bundledHost = path.join(process.resourcesPath, 'libmpv', 'mpv-host.exe');
  const executable = app.isPackaged
    ? (isRuntimeReady(persistentRuntimeRoot) ? persistentHost : bundledHost)
    : path.join(__dirname, '..', 'vendor', 'libmpv', 'mpv-host.exe');
  if (!fs.existsSync(executable)) throw new Error('The native libmpv host is missing from this build.');
  closeMpvSession();
  const handle = win.getNativeWindowHandle();
  const parentId = handle.length >= 8 ? handle.readBigUInt64LE(0).toString() : String(handle.readUInt32LE(0));
  mpvProcess = spawn(executable, [
    parentId, String(Math.round(bounds.x || 0)), String(Math.round(bounds.y || 0)),
    String(Math.round(bounds.width || 1)), String(Math.round(bounds.height || 1)), target
  ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], cwd: path.dirname(executable) });
  const child = mpvProcess;
  mpvBuffer = '';
  mpvFrameBuffer = Buffer.alloc(0);
  child.stdout.on('data', handleMpvFrames);
  child.stderr.on('data', handleMpvData);
  mpvProcess.once('exit', () => {
    if (mpvProcess !== child) return;
    mpvProcess = null;
  });
  let duration = 0;
  for (let attempt = 0; attempt < 40 && !duration; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 100));
    if (!mpvProcess || child.exitCode != null) {
      throw new Error(`Native libmpv host exited with code ${child.exitCode}.`);
    }
    const status = await mpvCommand('status');
    duration = Number(status[1]) || 0;
  }
  return { duration };
}
async function mpvStatus() {
  if (!mpvProcess) return { running: false, duration: 0, currentTime: 0, paused: true };
  const status = await mpvCommand('status');
  return {
    running: true,
    duration: Number(status[1]) || 0,
    currentTime: Number(status[2]) || 0,
    paused: Number(status[3]) !== 0
  };
}
function availableTrimPath(sourcePath) {
  const extension = path.extname(sourcePath);
  const base = sourcePath.slice(0, -extension.length);
  let candidate = `${base}-trimmed${extension}`;
  let suffix = 2;
  while (fs.existsSync(candidate)) candidate = `${base}-trimmed-${suffix++}${extension}`;
  return candidate;
}
function availableMixedPath(sourcePath) {
  const extension = path.extname(sourcePath);
  const base = sourcePath.slice(0, -extension.length);
  let candidate = `${base}-mixed${extension}`;
  let suffix = 2;
  while (fs.existsSync(candidate)) candidate = `${base}-mixed-${suffix++}${extension}`;
  return candidate;
}
async function recordingAudioTracks(filePath) {
  const sourcePath = validateRecordingPath(filePath);
  const executable = ffmpegPath();
  if (!fs.existsSync(executable)) throw new Error('FFmpeg is missing from this Clips build.');
  const { stderr = '' } = await execFileAsync(executable, [
    '-hide_banner', '-i', sourcePath, '-t', '0', '-map', '0:a?', '-f', 'null', '-'
  ], { windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
  const tracks = [];
  let currentTrack = null;
  for (const line of stderr.split(/\r?\n/)) {
    if (/^Stream mapping:/.test(line)) break;
    const match = line.match(/^\s*Stream #0:(\d+)(?:\([^)]*\))?(?:\[[^\]]+\])?: Audio:\s*([^,]+)/);
    if (match) {
      currentTrack = { index: tracks.length, streamIndex: Number(match[1]), codec: match[2].trim(), label: `Audio track ${tracks.length + 1}`, kind: 'track' };
      tracks.push(currentTrack);
      continue;
    }
    const title = currentTrack && line.match(/^\s*title\s*:\s*(.+?)\s*$/i);
    if (title) {
      currentTrack.label = title[1];
      currentTrack.kind = title[1].toLowerCase() === 'combined' ? 'combined' : 'stem';
    } else if (/^\s*Stream #/.test(line)) {
      currentTrack = null;
    }
  }
  return tracks;
}
async function mixRecordingAudio(filePath, requestedAdjustments, replace) {
  const sourcePath = validateRecordingPath(filePath);
  const tracks = await recordingAudioTracks(sourcePath);
  if (!tracks.length) throw new Error('This clip has no audio tracks.');
  const adjustmentMap = new Map((Array.isArray(requestedAdjustments) ? requestedAdjustments : []).map(adjustment => [
    Number(adjustment?.index), Math.min(2, Math.max(0, Number(adjustment?.volume) || 0))
  ]));
  const volumeFor = track => adjustmentMap.has(track.index) ? adjustmentMap.get(track.index) : 1;
  const executable = ffmpegPath();
  const extension = path.extname(sourcePath);
  const outputPath = replace ? sourcePath : availableMixedPath(sourcePath);
  const temporaryPath = `${sourcePath.slice(0, -extension.length)}.mixing-${crypto.randomUUID()}${extension}`;
  const hasCombinedTrack = tracks.length > 1 && tracks[0].kind === 'combined';
  const editableTracks = hasCombinedTrack ? tracks.slice(1) : tracks;
  const filters = [];
  const audioMaps = [];
  const metadataArgs = [];
  if (hasCombinedTrack) {
    editableTracks.forEach((track, index) => {
      filters.push(`[0:a:${track.index}]volume=${volumeFor(track).toFixed(2)},asplit=2[mix${index}][stem${index}]`);
    });
    filters.push(`${editableTracks.map((_, index) => `[mix${index}]`).join('')}amix=inputs=${editableTracks.length}:duration=longest:normalize=0[combined]`);
    audioMaps.push('-map', '[combined]', ...editableTracks.flatMap((_, index) => ['-map', `[stem${index}]`]));
    ['Combined', ...editableTracks.map(track => track.label)].forEach((label, index) => {
      metadataArgs.push(`-metadata:s:a:${index}`, `title=${label}`);
    });
  } else {
    editableTracks.forEach((track, index) => {
      filters.push(`[0:a:${track.index}]volume=${volumeFor(track).toFixed(2)}[audio${index}]`);
      audioMaps.push('-map', `[audio${index}]`);
      metadataArgs.push(`-metadata:s:a:${index}`, `title=${track.label}`);
    });
  }
  const mapArgs = ['-map', '0', '-map', '-0:a', ...audioMaps];
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(executable, [
        '-hide_banner', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats', '-y', '-i', sourcePath,
        '-filter_complex', filters.join(';'), ...mapArgs, '-map_metadata', '0', ...metadataArgs,
        '-disposition:a:0', 'default', '-c', 'copy', '-c:a', 'aac', '-b:a', '192k', temporaryPath
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let progressBuffer = '', errorText = '';
      child.stdout.on('data', chunk => {
        progressBuffer += chunk.toString();
        const lines = progressBuffer.split(/\r?\n/);
        progressBuffer = lines.pop() || '';
        for (const line of lines) {
          const match = line.match(/^progress=(continue|end)$/);
          if (match) {
            const progress = { complete: match[1] === 'end' };
            if (win && !win.isDestroyed()) win.webContents.send('audio:mix-progress', progress);
            gateway?.emit('audio-mix-progress', progress);
          }
        }
      });
      child.stderr.on('data', chunk => { errorText += chunk.toString(); });
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(errorText.trim() || `FFmpeg exited with code ${code}.`)));
    });
    if (replace) {
      const backupPath = `${sourcePath}.audio-backup`;
      fs.renameSync(sourcePath, backupPath);
      try {
        fs.renameSync(temporaryPath, sourcePath);
        fs.rmSync(backupPath, { force: true });
      } catch (error) {
        if (fs.existsSync(backupPath) && !fs.existsSync(sourcePath)) fs.renameSync(backupPath, sourcePath);
        throw error;
      }
    } else {
      fs.renameSync(temporaryPath, outputPath);
    }
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw new Error(error.stderr?.trim() || error.message || 'FFmpeg could not update this clip.');
  }
  thumbnailPromises.delete(sourcePath);
  return outputPath;
}
function normalizeTrimBitrate(value) {
  return ['6M', '12M', '18M'].includes(value) ? value : 'original';
}
async function trimRecording(filePath, startSeconds, endSeconds, requestedBitrate) {
  const sourcePath = validateRecordingPath(filePath);
  const start = Number(startSeconds);
  const end = Number(endSeconds);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
    throw new Error('Choose an end time after the start time.');
  }
  const executable = ffmpegPath();
  if (!fs.existsSync(executable)) throw new Error('FFmpeg is missing from this Clips build.');
  const outputPath = availableTrimPath(sourcePath);
  const duration = end - start;
  const bitrate = normalizeTrimBitrate(requestedBitrate ?? settings.trimBitrate);
  const codecArgs = bitrate === 'original'
    ? ['-map', '0:v:0', '-map', '0:a?', '-c', 'copy']
    : [
        '-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast',
        '-b:v', bitrate, '-minrate', bitrate, '-maxrate', bitrate,
        '-bufsize', `${Number.parseInt(bitrate, 10) * 2}M`, '-x264-params', 'nal-hrd=cbr:force-cfr=1',
        '-c:a', 'aac', '-b:a', '192k'
      ];
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(executable, [
        '-hide_banner', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats',
        '-ss', String(start), '-i', sourcePath, '-t', String(duration),
        ...codecArgs, outputPath
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let progressBuffer = '', errorText = '';
      child.stdout.on('data', chunk => {
        progressBuffer += chunk.toString();
        const lines = progressBuffer.split(/\r?\n/);
        progressBuffer = lines.pop() || '';
        for (const line of lines) {
          const match = line.match(/^out_time_us=(\d+)$/);
          if (match) {
            const percent = Math.min(100, Number(match[1]) / 1000000 / duration * 100);
            const progress = { percent, seconds: Number(match[1]) / 1000000, duration };
            if (win && !win.isDestroyed()) win.webContents.send('trim:progress', progress);
            gateway?.emit('trim-progress', progress);
          }
        }
      });
      child.stderr.on('data', chunk => { errorText += chunk.toString(); });
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(errorText.trim() || `FFmpeg exited with code ${code}.`)));
    });
    const complete = { percent: 100, seconds: duration, duration };
    if (win && !win.isDestroyed()) win.webContents.send('trim:progress', complete);
    gateway?.emit('trim-progress', complete);
  } catch (error) {
    fs.rmSync(outputPath, { force: true });
    throw new Error(error.stderr?.trim() || 'FFmpeg could not trim this recording.');
  }
  return outputPath;
}
async function processes() {
  const script = `Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class ClipsProcessWindow {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out ClipsWindowRect rect);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern bool GetMonitorInfo(IntPtr monitor, ref ClipsMonitorInfo info);
}
public struct ClipsWindowRect {
  public int Left;
  public int Top;
  public int Right;
  public int Bottom;
}
public struct ClipsMonitorInfo {
  public int Size;
  public ClipsWindowRect Monitor;
  public ClipsWindowRect Work;
  public uint Flags;
}
'@
Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object {
  try {
    $processPath = $null
    try { $processPath = $_.Path } catch {}
    $windowClass = New-Object System.Text.StringBuilder 256
    [ClipsProcessWindow]::GetClassName($_.MainWindowHandle, $windowClass, 256) | Out-Null
    $windowRect = New-Object ClipsWindowRect
    $hasBounds = [ClipsProcessWindow]::GetWindowRect($_.MainWindowHandle, [ref]$windowRect)
    $monitorInfo = New-Object ClipsMonitorInfo
    $monitorInfo.Size = [Runtime.InteropServices.Marshal]::SizeOf($monitorInfo)
    $monitor = [ClipsProcessWindow]::MonitorFromWindow($_.MainWindowHandle, 2)
    $hasMonitor = $monitor -ne [IntPtr]::Zero -and [ClipsProcessWindow]::GetMonitorInfo($monitor, [ref]$monitorInfo)
    $isFullscreen = $hasBounds -and $hasMonitor -and
      [Math]::Abs($windowRect.Left - $monitorInfo.Monitor.Left) -le 2 -and
      [Math]::Abs($windowRect.Top - $monitorInfo.Monitor.Top) -le 2 -and
      [Math]::Abs($windowRect.Right - $monitorInfo.Monitor.Right) -le 2 -and
      [Math]::Abs($windowRect.Bottom - $monitorInfo.Monitor.Bottom) -le 2
    [pscustomobject]@{
      name = $_.ProcessName + '.exe'
      path = $processPath
      title = $_.MainWindowTitle
      windowClass = $windowClass.ToString()
      isFullscreen = $isFullscreen
      bounds = if ($hasBounds) { [pscustomobject]@{
        x = $windowRect.Left
        y = $windowRect.Top
        width = $windowRect.Right - $windowRect.Left
        height = $windowRect.Bottom - $windowRect.Top
      }} else { $null }
    }
  } catch {}
  } | Sort-Object name -Unique | ConvertTo-Json -Compress`;
  const encodedScript = Buffer.from(script, 'utf16le').toString('base64');
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let stdout = '';
    try {
      ({ stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedScript], { windowsHide: true }));
      return parseProcessList(stdout);
    } catch (error) {
      logger.warn('process list refresh attempt failed', { attempt, bytes: Buffer.byteLength(stdout || ''), message: error.message });
      if (attempt === 2) {
        logger.warn('process list refresh failed; retaining the previous snapshot', { applications: runningApps.length });
        return runningApps;
      }
    }
  }
  return runningApps;
}
async function monitor() {
  try {
    await cleanupStorageOnSchedule();
    const running = await processes();
    runningApps = running;
    const candidates = updateCandidateHistory(
      gameCandidateHistory,
      running,
      settings.gameExecutables,
      settings.ignoredGameExecutables
    );
    if (!pendingGameCandidate && candidates[0]) {
      pendingGameCandidate = candidates[0];
      showGameCandidatePrompt();
    }
    const wanted = new Set(settings.gameExecutables.map(x => x.toLowerCase()));
    activeGames = running.filter(p => wanted.has(p.name.toLowerCase())).map(p => p.name);
    const captureStatus = await obs.status();
    inspectCaptureHealth(captureStatus);
    if (!activeGames.length) {
      autoRecordSuppressed = false;
      lastGameDisplayId = null;
    }
    if (settings.autoRecord && activeGames.length && !autoRecordSuppressed) {
      clearTimeout(stopTimer); stopTimer = null;
      if (captureStatus.recording && sessionDate && sessionDate !== todayKey()) {
        await obs.stopSession();
        await startSession();
      } else if (!captureStatus.recording) {
        if (captureStatus.replayBuffer) await obs.stopSession();
        await startSession();
      }
    } else if (settings.autoRecord && !activeGames.length && !stopTimer && captureStatus.recording) {
      stopTimer = setTimeout(async () => {
        stopTimer = null;
        if (!activeGames.length) {
          await obs.stopSession().catch(setError);
          await finalizeSessionMetadata();
          sessionDate = '';
          if (settings.instantReplay) await startInstantReplay().catch(setError);
          else await obs.disconnect().catch(() => {});
        }
      }, settings.stopDelaySeconds * 1000);
    } else if (settings.instantReplay && !captureStatus.recording && captureStatus.replayBuffer && sessionDate && sessionDate !== todayKey()) {
      await obs.stopSession();
      await startInstantReplay();
    } else if (settings.instantReplay && !captureStatus.recording && !captureStatus.replayBuffer) {
      await startInstantReplay();
    } else if (!settings.instantReplay && !captureStatus.recording && captureStatus.replayBuffer) {
      await obs.stopSession();
      await obs.disconnect().catch(() => {});
    }
    lastError = settingsRecoveryWarning;
  } catch (error) { setError(error); }
  broadcast();
}
function inspectCaptureHealth(status) {
  if (!status.recording) {
    previousCaptureHealth = null;
    captureWarningWindow = { startedAt: 0, renderingLag: 0, encoderDrops: 0 };
    return;
  }
  const current = {
    rendered: Number(status.renderedFrames) || 0,
    lagged: Number(status.laggedFrames) || 0,
    output: Number(status.outputFrames) || 0,
    dropped: Number(status.droppedFrames) || 0
  };
  const previous = previousCaptureHealth;
  previousCaptureHealth = current;
  if (!previous || current.rendered < previous.rendered || current.output < previous.output) return;
  const renderingLag = Math.max(0, current.lagged - previous.lagged);
  const encoderDrops = Math.max(0, current.dropped - previous.dropped);
  if (!renderingLag && !encoderDrops) return;
  const now = Date.now();
  if (!captureWarningWindow.startedAt || now - captureWarningWindow.startedAt > 60000) {
    captureWarningWindow = { startedAt: now, renderingLag: 0, encoderDrops: 0 };
  }
  captureWarningWindow.renderingLag += renderingLag;
  captureWarningWindow.encoderDrops += encoderDrops;
  const noticeableBurst = renderingLag >= 6 || encoderDrops >= 3;
  const noticeableSustainedLoss = captureWarningWindow.renderingLag >= 12 || captureWarningWindow.encoderDrops >= 6;
  logger.warn('capture frame drops detected', { renderingLag, encoderDrops, warning: noticeableBurst || noticeableSustainedLoss });
  if (!noticeableBurst && !noticeableSustainedLoss) return;
  if (now - lastCaptureWarningTime < 60000) return;
  lastCaptureWarningTime = now;
  const windowRenderingLag = captureWarningWindow.renderingLag;
  const windowEncoderDrops = captureWarningWindow.encoderDrops;
  captureWarningWindow = { startedAt: now, renderingLag: 0, encoderDrops: 0 };
  const frames = windowRenderingLag + windowEncoderDrops;
  const detail = windowRenderingLag && windowEncoderDrops
    ? 'The GPU and video encoder could not keep up. Try lowering resolution, quality, or FPS.'
    : windowRenderingLag
      ? 'The GPU could not render in time. Close GPU-heavy apps or lower resolution/FPS.'
      : 'The video encoder could not keep up. Try lowering quality, resolution, or FPS.';
  displayOverlayToast({ message: `${frames} recording frame${frames === 1 ? '' : 's'} dropped`, detail, kind: 'warning' });
}
function setError(error) {
  lastError = error?.message || String(error);
  logger.error('application error', { message: lastError, stack: error?.stack });
  telemetry?.reportError(error).catch(() => {});
  const now = Date.now();
  if (lastProblemOverlay.message !== lastError || now - lastProblemOverlay.time >= 60000) {
    lastProblemOverlay = { message: lastError, time: now };
    const detail = lastError.length > 180 ? `${lastError.slice(0, 177)}…` : lastError;
    displayOverlayToast({ message: 'Clips ran into a problem', detail, kind: 'error' });
  }
  broadcast();
}
async function tryConnect(captureSettings = settings) {
  if (obs.connected) return true;
  if (connectPromise) return connectPromise;
  connectPromise = (async () => {
    try {
      await runtimeSetupPromise;
      const executable = captureHostPath();
      if (!fs.existsSync(executable)) throw new Error('The bundled Clips capture engine is missing.');
      await obs.connect({
        executable,
        runtimeRoot: captureRuntimeRoot(),
        configRoot: path.join(app.getPath('userData'), 'capture-host'),
        settings: captureSettings
      });
      lastError = '';
      return true;
    } catch (error) {
      setError(error);
      return false;
    } finally {
      connectPromise = null;
    }
  })();
  return connectPromise;
}
async function detectAvailableEncoders() {
  const wasConnected = obs.connected;
  if (!await tryConnect()) return;
  logger.info('video encoders detected', {
    available: obs.availableEncoders.map(encoder => encoder.id),
    selected: obs.selectedEncoder
  });
  if (!wasConnected && !obs.lastStatus.recording && !obs.lastStatus.replayBuffer) {
    await obs.disconnect().catch(() => {});
  }
}
async function state() {
  const [recordings, archived] = await Promise.all([recentRecordings(), archivedRecordings()]);
  return { settings, obs: await obs.status(), availableEncoders: obs.availableEncoders, selectedEncoder: obs.selectedEncoder,
    activeGames, autoRecordSuppressed, recordings, archivedRecordings: archived,
    sessionMarkers, storage: storageInsights(settings.recordingsFolder, [...recordings, ...archived]), lastError, lastClip,
    captureEngineInstalled: fs.existsSync(captureHostPath()), app: { version: displayVersion(app.getVersion()), buildTime: buildInfo.buildTime, runtimeVersion: RUNTIME_VERSION, runtimeReady: app.isPackaged ? isRuntimeReady(persistentRuntimeRoot) : fs.existsSync(captureHostPath()), changelog }, telemetry: { configured: !!telemetryEndpoint, mode: settings.telemetryMode }, update: updateState };
}

async function collectSystemInformation() {
  let gpu = 'Unknown';
  try {
    const info = await app.getGPUInfo('basic');
    gpu = info.gpuDevice?.find(device => device.active)?.deviceString || info.gpuDevice?.[0]?.deviceString || 'Unknown';
  } catch {}
  return {
    platform: process.platform,
    architecture: process.arch,
    windowsRelease: os.release(),
    cpu: os.cpus()[0]?.model || 'Unknown',
    gpu,
    ramGiB: Math.round(os.totalmem() / 1024 ** 3)
  };
}

async function requestTelemetryPreference() {
  if (!telemetryEndpoint || settings.telemetryMode !== 'pending') return;
  const result = await dialog.showMessageBox({
    type: 'question',
    title: 'Help improve Clips?',
    message: 'Choose what Clips may send',
    detail: 'Diagnostics sends anonymous system specs and a sanitized log excerpt only when an error occurs. Version only sends a random installation ID and Clips/runtime versions. You can change this later in Settings.',
    buttons: ['Diagnostics and error logs', 'Version only', 'Nothing'],
    defaultId: 1,
    cancelId: 2,
    noLink: true
  });
  settings.telemetryMode = ['diagnostics', 'version', 'off'][result.response] || 'off';
  persist();
}

function configureTelemetry({ sendStartup = false } = {}) {
  telemetry = null;
  if (!telemetryEndpoint || !['diagnostics', 'version'].includes(settings.telemetryMode)) return;
  const installationId = loadInstallationId(path.join(app.getPath('userData'), 'telemetry.json'));
  telemetry = createTelemetry({
    endpoint: telemetryEndpoint,
    mode: settings.telemetryMode,
    installationId,
    appVersion: app.getVersion(),
    runtimeVersion: RUNTIME_VERSION,
    system: systemInformation,
    logger,
    redact: [app.getPath('userData'), os.homedir(), settings.recordingsFolder]
  });
  if (sendStartup) telemetry.sendStartup().catch(() => {});
}
function showMainWindow() {
  trayController.showWindow();
}
function webAppLaunchUrl() {
  const url = new URL(`http://127.0.0.1:${DEFAULT_GATEWAY_PORT}/app/`);
  url.hash = new URLSearchParams({ gateway: gatewayToken, port: String(DEFAULT_GATEWAY_PORT) }).toString();
  return url.toString();
}
async function focusConnectedBrowserTab({ refresh = false, foreground = true } = {}) {
  const refreshLiteral = refresh ? '$true' : '$false';
  const foregroundLiteral = foreground ? '$true' : '$false';
  const script = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ClipsBrowserFocus {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
'@
$browserNames = @('chrome', 'msedge', 'firefox', 'brave', 'vivaldi', 'opera')
$refresh = ${refreshLiteral}
$foreground = ${foregroundLiteral}
$root = [System.Windows.Automation.AutomationElement]::RootElement
$windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
foreach ($window in $windows) {
  try {
    $process = Get-Process -Id $window.Current.ProcessId -ErrorAction Stop
    if ($browserNames -notcontains $process.ProcessName.ToLowerInvariant()) { continue }
    $tabs = $window.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::TabItem
      )
    )
    foreach ($tab in $tabs) {
      if ($tab.Current.Name -notmatch '^Clips(?:$|[ —-])') { continue }
      $pattern = $null
      if ($tab.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) {
        ([System.Windows.Automation.SelectionItemPattern]$pattern).Select()
      }
      if ($foreground -or $refresh) {
        [ClipsBrowserFocus]::ShowWindow($process.MainWindowHandle, 9) | Out-Null
        [ClipsBrowserFocus]::SetForegroundWindow($process.MainWindowHandle) | Out-Null
      }
      if ($refresh) {
        Start-Sleep -Milliseconds 100
        (New-Object -ComObject WScript.Shell).SendKeys('^r')
      }
      [pscustomobject]@{ focused = $true; browser = $process.ProcessName } | ConvertTo-Json -Compress
      exit 0
    }
  } catch {}
}
[pscustomobject]@{ focused = $false } | ConvertTo-Json -Compress
`;
  const encodedScript = Buffer.from(script, 'utf16le').toString('base64');
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedScript], {
      windowsHide: true,
      timeout: 5000
    });
    const result = JSON.parse(stdout.trim() || '{}');
    logger.info('browser UI focus requested', { focused: !!result.focused, browser: result.browser || '' });
    return !!result.focused;
  } catch (error) {
    logger.warn('could not focus existing browser tab', { message: error.message });
    return false;
  }
}
let browserUiRefreshPending = false;
function refreshStaleBrowserUi(details) {
  if (browserUiRefreshPending) return;
  browserUiRefreshPending = true;
  logger.info('refreshing stale browser UI', details);
  setTimeout(async () => {
    await focusConnectedBrowserTab({ refresh: true, foreground: false });
    setTimeout(() => { browserUiRefreshPending = false; }, 2000);
  }, 250);
}
async function openWebUi() {
  if (!gatewayReady) {
    showMainWindow();
    return false;
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (gateway?.hasEventClients()) {
      gateway.emit('activate-ui', { requestedAt: Date.now() });
      await focusConnectedBrowserTab();
      return true;
    }
    if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 250));
  }
  return shell.openExternal(webAppLaunchUrl()).catch(error => {
    logger.warn('could not open browser UI', { message: error.message });
    showMainWindow();
  });
}
function openPreferredUi() {
  return settings?.desktopWindow === false ? openWebUi() : showMainWindow();
}
function hasVisibleStateConsumer() {
  return !!(win && !win.isDestroyed() && win.isVisible()) || !!gateway?.hasEventClients();
}
async function broadcast(currentState = null, { force = false } = {}) {
  if (!currentState && !force && !hasVisibleStateConsumer()) {
    trayController.update((await obs.status()).recording);
    return null;
  }
  currentState ||= await state();
  trayController.update(currentState.obs.recording);
  if (win && !win.isDestroyed()) win.webContents.send('state', currentState);
  gateway?.emit('state', currentState);
  return currentState;
}
function setUpdateState(next) {
  updateState = { ...updateState, ...next, ...(next.version ? { version: displayVersion(next.version) } : {}) };
  broadcast().catch(() => {});
}
function recordUpdateDiagnostic(entry) {
  updateDiagnostics.push(entry);
  if (updateDiagnostics.length > 250) updateDiagnostics.shift();
}
function copyUpdateDiagnostics() {
  const header = {
    appVersion: app.getVersion(),
    displayedVersion: displayVersion(app.getVersion()),
    packaged: app.isPackaged,
    channel: settings?.nightlyUpdates ? 'nightly' : 'stable',
    feedUrl: updateFeedUrl(),
    updateState,
    executable: process.execPath
  };
  const text = redactLogText(`${JSON.stringify(header, null, 2)}\n\n${updateDiagnostics.map(entry => JSON.stringify(entry)).join('\n')}`);
  clipboard.writeText(text);
  logger.info('updater diagnostics copied', { entries: updateDiagnostics.length });
  return true;
}
function updateFeedUrl() {
  if (process.env.CLIPS_UPDATE_URL) return String(process.env.CLIPS_UPDATE_URL).trim().replace(/\/+$/, '');
  const configuredUrl = DEFAULT_UPDATE_URL.trim().replace(/\/+$/, '');
  if (!app.isPackaged) return '';
  return settings?.nightlyUpdates ? configuredUrl : `${configuredUrl}/stable`;
}
function configureUpdates() {
  clearTimeout(updateCheckTimeout);
  clearInterval(updateCheckTimer);
  updateCheckTimeout = null;
  updateCheckTimer = null;
  stagedUpdater = null;
  const generation = ++updateConfigurationGeneration;
  updateState = {
    status: 'idle',
    version: displayVersion(app.getVersion()),
    percent: 0,
    message: '',
    configured: false
  };
  if (process.env.CLIPS_UPDATE_MOCK === '1') {
    updateState.configured = true;
    updateCheckTimeout = setTimeout(() => {
      if (generation === updateConfigurationGeneration) setUpdateState({
        status: 'ready',
        version: `${app.getVersion()}-local`,
        percent: 100,
        message: 'Local update ready'
      });
    }, 900);
    return;
  }
  if (!app.isPackaged) return;
  const updateUrl = updateFeedUrl();
  if (!updateUrl) return;
  updateState.configured = true;
  stagedUpdater = createStagedUpdater({
    app,
    feedUrl: updateUrl,
    logger,
    onDiagnostic: recordUpdateDiagnostic,
    onState: next => {
      if (generation === updateConfigurationGeneration) setUpdateState(next);
    }
  });
  const check = () => stagedUpdater?.check();
  updateCheckTimeout = setTimeout(check, 3000);
  updateCheckTimer = setInterval(check, 15 * 60 * 1000);
}
function monitorDelayMs() {
  const configured = Math.max(2, Number(settings.pollSeconds) || 5) * 1000;
  return activeGames.length || obs.lastStatus.recording || settings.instantReplay ? configured : Math.max(10000, configured);
}
function scheduleNextMonitor() {
  clearTimeout(monitorTimer);
  monitorTimer = setTimeout(scheduleMonitor, monitorDelayMs());
}
function scheduleMonitor() {
  clearTimeout(monitorTimer);
  monitorTimer = null;
  if (monitorPromise) {
    monitorRerunRequested = true;
    return monitorPromise;
  }
  monitorPromise = monitor().finally(() => {
    monitorPromise = null;
    if (monitorRerunRequested) {
      monitorRerunRequested = false;
      scheduleMonitor();
    } else {
      scheduleNextMonitor();
    }
  });
  return monitorPromise;
}
function addTimelineMarker() {
  if (!sessionStartedAt || !obs.lastStatus.recording) return;
  sessionMarkers.push({ id: crypto.randomUUID(), time: Math.max(0, (Date.now() - sessionStartedAt) / 1000), label: '' });
  showOverlayToast(`Marker ${sessionMarkers.length} saved`, 'clip-saved'); broadcast();
}
function registerHotkey() {
  globalShortcut.unregisterAll();
  if (settings.clipHotkey) globalShortcut.register(settings.clipHotkey, () => saveClip());
  if (settings.markerHotkey && settings.markerHotkey !== settings.clipHotkey) globalShortcut.register(settings.markerHotkey, addTimelineMarker);
  if (!globalShortcut.register(ADD_GAME_HOTKEY, () => resolveGameCandidate(true)))
    logger.warn('new game add shortcut could not be registered', { shortcut: ADD_GAME_HOTKEY });
  if (!globalShortcut.register(IGNORE_GAME_HOTKEY, () => resolveGameCandidate(false)))
    logger.warn('new game ignore shortcut could not be registered', { shortcut: IGNORE_GAME_HOTKEY });
}
function showGameCandidatePrompt() {
  if (!pendingGameCandidate) return;
  displayOverlayToast({
    message: `New game? ${pendingGameCandidate.name}`,
    detail: 'Ctrl+Shift+F11 Add  ·  Ctrl+Shift+F12 Ignore',
    kind: 'game-candidate'
  });
}
function resolveGameCandidate(add) {
  const candidate = pendingGameCandidate;
  if (!candidate) return;
  pendingGameCandidate = null;
  const key = candidateKey(candidate);
  gameCandidateHistory.delete(key);
  const target = add ? settings.gameExecutables : settings.ignoredGameExecutables;
  if (!target.some(name => String(name).toLowerCase() === key)) target.push(candidate.name);
  persist();
  showOverlayToast(add ? `${candidate.name} added` : `${candidate.name} ignored`, add ? 'recording' : 'recording-stopped');
  broadcast();
  scheduleMonitor();
}
async function saveClip() {
  try {
    const before = new Set((await recentRecordings()).map(item => item.path));
    await obs.saveClip();
    let savedReplay = null;
    for (let attempt = 0; attempt < 10 && !savedReplay; attempt++) {
      savedReplay = (await recentRecordings()).find(item => item.kind === 'replay' && !before.has(item.path));
      if (!savedReplay) await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (savedReplay && sessionGame) libraryMetadata.update(savedReplay.path, { game: sessionGame });
    lastClip = new Date().toISOString(); lastError = ''; showOverlayToast('Clip saved', 'clip-saved');
  } catch (e) { setError(e); }
  return broadcast(null, { force: true });
}

let lastGameDisplayId = null;
function overlayDisplay() {
  const wanted = new Set(activeGames.map(name => name.toLowerCase()));
  const gameWindow = runningApps
    .filter(item => wanted.has(item.name.toLowerCase()) && item.bounds
      && Number.isFinite(item.bounds.x) && Number.isFinite(item.bounds.y)
      && item.bounds.x > -30000 && item.bounds.y > -30000
      && item.bounds.width > 0 && item.bounds.height > 0)
    .sort((a, b) => (b.bounds.width * b.bounds.height) - (a.bounds.width * a.bounds.height))[0];
  if (gameWindow) {
    const display = screen.getDisplayMatching(gameWindow.bounds);
    lastGameDisplayId = display.id;
    return display;
  }
  if (activeGames.length && lastGameDisplayId != null) {
    const previousDisplay = screen.getAllDisplays().find(display => display.id === lastGameDisplayId);
    if (previousDisplay) return previousDisplay;
  }
  return screen.getPrimaryDisplay();
}
function positionOverlayWindow() {
  if (!toastWin || toastWin.isDestroyed()) return;
  const display = overlayDisplay();
  const [width] = toastWin.getSize();
  toastWin.setPosition(
    Math.round(display.bounds.x + (display.bounds.width - width) / 2),
    display.bounds.y,
    false
  );
  return display;
}
function reinforceOverlayTopmost() {
  if (!toastWin || toastWin.isDestroyed()) return;
  toastWin.setAlwaysOnTop(true, 'screen-saver', 1);
  toastWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (toastWin.isVisible()) toastWin.moveTop();
}
function displayOverlayToast(toast) {
  if (!toastWin || toastWin.isDestroyed() || !toastReady) { pendingToast = toast; return; }
  clearTimeout(toastHideTimer);
  const display = positionOverlayWindow();
  reinforceOverlayTopmost();
  toastWin.showInactive();
  reinforceOverlayTopmost();
  toastWin.webContents.send('toast:show', toast);
  logger.info('overlay toast shown', { kind: toast.kind, displayId: display?.id, bounds: toastWin.getBounds(), alwaysOnTop: toastWin.isAlwaysOnTop() });
  if (toast.kind === 'game-candidate') return;
  const visibleDuration = toast.kind === 'warning' || toast.kind === 'error'
    ? 6000
    : toast.kind === 'recording' || toast.kind === 'recording-stopped' ? 1350 : 1000;
  toastHideTimer = setTimeout(() => {
    if (!toastWin || toastWin.isDestroyed()) return;
    if (pendingGameCandidate) showGameCandidatePrompt();
    else toastWin.webContents.send('toast:hide');
  }, visibleDuration);
}
function showOverlayToast(message, kind) { displayOverlayToast({ message, kind }); }
function recoverOverlayWindow(reason, failedWindow = toastWin) {
  if (failedWindow !== toastWin) return;
  logger.warn('overlay window recovery scheduled', { reason });
  toastReady = false;
  clearTimeout(toastRecoveryTimer);
  if (toastWin && !toastWin.isDestroyed()) toastWin.destroy();
  if (app.isQuitting) return;
  toastRecoveryTimer = setTimeout(() => {
    toastRecoveryTimer = null;
    if (!toastWin || toastWin.isDestroyed()) createOverlayWindow();
  }, 250);
}
function createOverlayWindow() {
  clearTimeout(toastRecoveryTimer);
  toastRecoveryTimer = null;
  const overlayWindow = new BrowserWindow({
    show: false,
    // The extra transparent margin gives the landing shockwave room to travel
    // sideways without growing into a large screen-covering overlay.
    width: 600,
    // Multi-line health and error details need more room than the original
    // one-line recording toast. The window is transparent and click-through.
    height: 260,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'overlay-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  toastWin = overlayWindow;
  toastWin.setIgnoreMouseEvents(true);
  reinforceOverlayTopmost();
  toastWin.webContents.on('did-finish-load', () => {
    toastReady = true;
    logger.info('overlay window ready', { bounds: toastWin.getBounds(), alwaysOnTop: toastWin.isAlwaysOnTop() });
    if (pendingToast) { const toast = pendingToast; pendingToast = null; displayOverlayToast(toast); }
  });
  toastWin.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (isMainFrame) recoverOverlayWindow(`load failed (${code} ${description}) for ${url}`, overlayWindow);
  });
  toastWin.webContents.on('render-process-gone', (_event, details) => recoverOverlayWindow(`renderer exited (${details.reason}, code ${details.exitCode})`, overlayWindow));
  toastWin.on('unresponsive', () => recoverOverlayWindow('renderer became unresponsive', overlayWindow));
  toastWin.on('closed', () => {
    if (toastWin === overlayWindow) { toastWin = null; toastReady = false; }
  });
  toastWin.loadFile(path.join(__dirname, 'overlay.html')).catch(error => recoverOverlayWindow(`load rejected: ${error.message}`, overlayWindow));
}

const titleBarAppearance = {
  normal: { color: '#0a0a0a', symbolColor: '#a1a1aa', height: 52 },
  modal: { color: '#030303', symbolColor: '#3f3f42', height: 52 }
};

function createWindow() {
  const hidden = process.argv.includes('--hidden');
  win = new BrowserWindow({
    icon: path.join(__dirname, '..', 'assets', 'app-icon.ico'),
    show: !hidden && settings.desktopWindow !== false,
    width: 1160,
    height: 780,
    minWidth: 900,
    minHeight: 650,
    backgroundColor: '#0a0a0a',
    title: 'jss/clips',
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarAppearance.normal,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.setMenuBarVisibility(false); win.loadFile(path.join(__dirname, 'index.html'));
  win.on('close', e => { if (!app.isQuitting) { e.preventDefault(); win.hide(); } });
}

async function installUpdate() {
  if (updateState.status !== 'ready') return false;
  if (process.env.CLIPS_UPDATE_MOCK === '1' && !app.isPackaged) {
    app.isQuitting = true;
    app.relaunch();
    app.exit(0);
    return true;
  }
  return stagedUpdater?.restart(async () => {
    const capture = await obs.status();
    if (capture.recording || capture.replayBuffer) {
      await obs.stopSession().catch(error => logger.warn('capture stop before update failed', { message: error.message }));
      sessionDate = '';
    }
    await obs.disconnect().catch(error => logger.warn('capture shutdown before update failed', { message: error.message }));
  }) || false;
}

function checkForUpdates() {
  if (!app.isPackaged || !updateFeedUrl() || ['checking', 'downloading', 'preparing', 'ready'].includes(updateState.status)) return false;
  stagedUpdater?.check();
  return true;
}

async function reconnectCapture() {
  try {
    const current = await obs.status();
    if (current.recording) throw new Error('Stop recording before reconnecting the capture engine.');
    if (obs.connected) await obs.disconnect();
    await tryConnect();
    if (obs.connected && !activeGames.length) await obs.disconnect();
  } catch (error) {
    setError(error);
  }
  return state();
}

async function saveSettings(next, { openWebOnDisable = true } = {}) {
  const previous = settings;
  let settingsCommitted = false;
  clearTimeout(stopTimer); stopTimer = null;
  clearTimeout(monitorTimer);
  try {
    const updated = normalizeSettingsUpdate(previous, next);
    ensureDirectory(updated.recordingsFolder);
    const nightlyUpdatesChanged = updated.nightlyUpdates !== previous.nightlyUpdates;
    const telemetryModeChanged = updated.telemetryMode !== previous.telemetryMode;
    const desktopWindowChanged = updated.desktopWindow !== previous.desktopWindow;
    const recordingSettingsChanged = ['obsRecordingQuality', 'obsEncoder', 'obsResolution', 'obsFps', 'obsFormat', 'clipLengthSeconds']
      .some(key => updated[key] !== previous[key]);
    const idleReplayLengthChanged = updated.instantReplayLengthSeconds !== previous.instantReplayLengthSeconds;
    const microphoneVolumeChanged = updated.microphoneVolumePercent !== previous.microphoneVolumePercent;
    const microphoneNoiseGateChanged = updated.microphoneNoiseGateDb !== previous.microphoneNoiseGateDb;
    const microphoneNvidiaNoiseRemovalChanged = updated.microphoneNvidiaNoiseRemoval !== previous.microphoneNvidiaNoiseRemoval;
    const currentCapture = await obs.status();
    const restartCapture = ((currentCapture.recording || currentCapture.replayBuffer)
      && captureRestartRequired(previous, updated))
      || (!currentCapture.recording && currentCapture.replayBuffer && idleReplayLengthChanged);
    if (restartCapture) {
      logger.info('restarting capture to apply settings', {
        previousFolder: previous.recordingsFolder,
        recordingsFolder: updated.recordingsFolder,
        previousMicrophone: previous.microphoneDeviceId,
        microphoneDeviceId: updated.microphoneDeviceId
      });
      await obs.stopSession();
      sessionDate = '';
    }
    settings = updated;
    if (!persist()) throw new Error(settingsRecoveryWarning || 'Settings could not be saved.');
    if (updated.recordingsFolder !== previous.recordingsFolder) libraryMetadata = new LibraryMetadata(path.join(app.getPath('userData'), 'library.json'), updated.recordingsFolder);
    settingsCommitted = true;
    logger.info('settings saved', {
      recordingsFolder: settings.recordingsFolder,
      microphoneDeviceId: settings.microphoneDeviceId,
      desktopWindow: settings.desktopWindow,
      restartCapture
    });
    app.setLoginItemSettings({ openAtLogin: !!settings.startWithWindows, args: ['--hidden'] });
    registerHotkey();
    if (nightlyUpdatesChanged) configureUpdates();
    if (telemetryModeChanged) configureTelemetry({ sendStartup: true });
    if (obs.connected && recordingSettingsChanged) {
      await obs.applyRecordingSettings({
        quality: settings.obsRecordingQuality,
        encoder: settings.obsEncoder,
        resolution: settings.obsResolution,
        fps: settings.obsFps,
        format: settings.obsFormat,
        clipLengthSeconds: settings.clipLengthSeconds
      });
    }
    if (obs.connected && microphoneVolumeChanged) await obs.setMicrophoneVolume(settings.microphoneVolumePercent);
    if (obs.connected && microphoneNoiseGateChanged) await obs.setMicrophoneNoiseGate(settings.microphoneNoiseGateDb);
    if (obs.connected && microphoneNvidiaNoiseRemovalChanged) await obs.setMicrophoneNvidiaNoiseRemoval(settings.microphoneNvidiaNoiseRemoval);
    if (restartCapture) await startSession({ recording: currentCapture.recording,
      replayLengthSeconds: currentCapture.recording ? 0 : settings.instantReplayLengthSeconds });
    lastError = settingsRecoveryWarning;
    if (desktopWindowChanged) {
      setImmediate(() => {
        if (settings.desktopWindow === false) {
          win?.hide();
          if (openWebOnDisable) openWebUi();
        } else {
          showMainWindow();
        }
      });
    }
  } catch (error) {
    if (!settingsCommitted) settings = previous;
    setError(error);
  } finally {
    scheduleMonitor();
  }
  return state();
}

async function toggleRecording() {
  try {
    const output = await obs.status();
    if (output.recording) {
      autoRecordSuppressed = activeGames.length > 0;
      await obs.stopSession();
      await finalizeSessionMetadata();
      if (settings.instantReplay) {
        await startInstantReplay();
      } else {
        sessionDate = '';
        await obs.disconnect();
      }
      showOverlayToast('Recording stopped', 'recording-stopped');
    } else {
      autoRecordSuppressed = false;
      if (output.replayBuffer) await obs.stopSession();
      await startSession();
    }
  } catch (error) { setError(error); }
  return state();
}

function openRecording(filePath) {
  const target = validateRecordingPath(filePath);
  const executable = mpvPath();
  if (!executable) throw new Error('Bundled MPV is missing from this Clips build.');
  spawn(executable, ['--force-window=yes', target], { detached: true, windowsHide: false, stdio: 'ignore' }).unref();
  return true;
}

async function setRecordingFavorite(filePath, favorite) {
  const target = validateRecordingPath(filePath);
  recordingLibrary.setFavorite(target, favorite);
  return broadcast(null, { force: true });
}

async function updateRecordingMetadata(filePath, change) {
  const target = validateRecordingPath(filePath);
  libraryMetadata.update(target, change || {});
  return broadcast(null, { force: true });
}

async function stitchRecordings(filePaths) {
  const targets = [...new Set((filePaths || []).map(validateRecordingPath))];
  if (targets.length < 2) throw new Error('Select at least two clips to stitch.');
  const manifest = path.join(app.getPath('temp'), `clips-stitch-${crypto.randomUUID()}.txt`);
  const extension = path.extname(targets[0]);
  const outputPath = path.join(todayFolder(), `Compilation-${Date.now()}${extension}`);
  fs.writeFileSync(manifest, concatManifest(targets));
  try { await execFileAsync(ffmpegPath(), ['-hide_banner', '-y', '-f', 'concat', '-safe', '0', '-i', manifest, '-map', '0', '-c', 'copy', outputPath], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }); }
  catch (error) { throw new Error(error.stderr?.trim() || 'FFmpeg could not stitch these clips. Clips must use compatible formats.'); }
  finally { fs.rmSync(manifest, { force: true }); }
  const games = [...new Set(targets.map(target => libraryMetadata.get(target).game).filter(Boolean))];
  libraryMetadata.update(outputPath, { title: 'Compilation', tags: ['compilation'], game: games.length === 1 ? games[0] : '' });
  return { outputPath, state: await broadcast(null, { force: true }) };
}

async function deleteRecordings(filePaths) {
  const targets = [...new Set((Array.isArray(filePaths) ? filePaths : [filePaths]).map(validateRecordingPath))];
  const captureStatus = await obs.status();
  if (captureStatus.recording && targets.some(target => path.dirname(target) === path.join(settings.recordingsFolder, todayKey()) && isRawRecordingName(path.basename(target)))) {
    throw new Error('Stop the active recording before deleting today\'s full recording.');
  }
  for (const target of targets) {
    libraryMetadata.remove(target);
    fs.rmSync(target, { force: true });
    recordingLibrary.setFavorite(target, false, { persist: false });
    thumbnailPromises.delete(target);
    recordingMediaServer.invalidate(target);
  }
  recordingLibrary.persistFavorites();
  return broadcast(null, { force: true });
}

async function listMicrophones() {
  if (microphoneListPromise) return microphoneListPromise;
  microphoneListPromise = (async () => {
    const wasConnected = obs.connected;
    if (!wasConnected && !await tryConnect()) return [];
    try { return await obs.microphones(); }
    finally {
      if (!wasConnected && !obs.lastStatus.recording) await obs.disconnect().catch(() => {});
    }
  })();
  try { return await microphoneListPromise; }
  finally { microphoneListPromise = null; }
}

async function trimRecordingAction(filePath, startSeconds, endSeconds, bitrate) {
  const target = validateRecordingPath(filePath);
  const outputPath = await trimRecording(target, startSeconds, endSeconds, bitrate);
  const sourceMetadata = libraryMetadata.get(target);
  if (sourceMetadata.game || sourceMetadata.tags?.length) libraryMetadata.update(outputPath, { game: sourceMetadata.game, tags: sourceMetadata.tags });
  return { outputPath, state: await state() };
}

async function mixRecordingAction(filePath, adjustments, replace) {
  const target = validateRecordingPath(filePath);
  const captureStatus = await obs.status();
  if (replace && captureStatus.recording && path.dirname(target) === path.join(settings.recordingsFolder, todayKey()) && isRawRecordingName(path.basename(target))) {
    throw new Error('Stop the active recording before saving audio changes to it. You can still save a new clip.');
  }
  const outputPath = await mixRecordingAudio(target, adjustments, !!replace);
  return { outputPath, state: await broadcast(null, { force: true }) };
}

async function chooseFolder() {
  const result = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return result.canceled ? null : result.filePaths[0];
}

async function gatewayInvoke(method, args) {
  const actions = {
    getState: () => state(),
    installUpdate,
    checkForUpdates,
    beginHotkeyCapture: () => { globalShortcut.unregisterAll(); return true; },
    cancelHotkeyCapture: () => { registerHotkey(); return true; },
    connect: reconnectCapture,
    saveSettings: () => saveSettings(args[0], { openWebOnDisable: false }),
    toggleRecording,
    saveClip,
    openFolder: () => shell.openPath(todayFolder()),
    openLibraryFolder: () => { ensureDirectory(settings.recordingsFolder); return shell.openPath(settings.recordingsFolder); },
    openRecording: () => openRecording(args[0]),
    getRecordingThumbnail: () => recordingThumbnail(args[0]),
    setRecordingFavorite: () => setRecordingFavorite(args[0], args[1]),
    updateRecordingMetadata: () => updateRecordingMetadata(args[0], args[1]),
    stitchRecordings: () => stitchRecordings(args[0]),
    deleteRecordings: () => deleteRecordings(args[0]),
    getRecordingMedia: () => recordingMediaUrl(args[0], args[1]),
    listMicrophones,
    microphoneLevel: () => obs.microphoneLevel(),
    trimRecording: () => trimRecordingAction(args[0], args[1], args[2], args[3]),
    getAudioTracks: () => recordingAudioTracks(args[0]),
    mixRecordingAudio: () => mixRecordingAction(args[0], args[1], args[2]),
    chooseFolder,
    openLogs: () => { shell.showItemInFolder(logger.filePath); return true; },
    copyUpdateDiagnostics,
    listProcesses: processes
  };
  if (!Object.hasOwn(actions, method)) throw new Error('This Clips action is not available in the browser.');
  return actions[method]();
}

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return;
  systemInformation = await collectSystemInformation();
  logger.info('system information', systemInformation);
  settings = loadSettings();
  libraryMetadata = new LibraryMetadata(path.join(app.getPath('userData'), 'library.json'), settings.recordingsFolder);
  recordingLibrary.loadFavorites();
  if (!settingsRecoveryWarning || !fs.existsSync(settingsPath())) persist();
  if (settingsRecoveryWarning) lastError = settingsRecoveryWarning;
  logger.info('application ready', {
    version: app.getVersion(),
    packaged: app.isPackaged,
    settingsPath: settingsPath(),
    recordingsFolder: settings.recordingsFolder,
    microphoneDeviceId: settings.microphoneDeviceId
  });
  await requestTelemetryPreference();
  configureTelemetry({ sendStartup: true });
  app.setLoginItemSettings({ openAtLogin: !!settings.startWithWindows, args: ['--hidden'] });
  createWindow(); createOverlayWindow(); registerHotkey(); configureUpdates();
  gateway = createGateway({
    token: gatewayToken,
    invoke: gatewayInvoke,
    logger,
    allowedOrigins: [
      `http://127.0.0.1:${DEFAULT_GATEWAY_PORT}`,
      ...(!app.isPackaged ? ['http://127.0.0.1:8787', 'http://localhost:8787'] : [])
    ],
    webAssets: {
      index: path.join(__dirname, 'index.html'),
      styles: path.join(__dirname, 'styles.css'),
      renderer: path.join(__dirname, 'renderer.js'),
      changelog: path.join(__dirname, 'changelog.json'),
      web: path.join(__dirname, '..', 'clips-worker', 'src', 'web.js')
    },
    uiVersion: displayVersion(app.getVersion()),
    onStaleUi: refreshStaleBrowserUi,
    approvePairing: async ({ origin, clientName }) => {
      if (origin === `http://127.0.0.1:${DEFAULT_GATEWAY_PORT}`) return true;
      const options = {
        type: 'question',
        title: 'Connect browser to Clips?',
        message: 'Allow the Clips website to control this app?',
        detail: `${clientName} at ${origin} will be able to view your library, change settings, and control recording while Clips is running.`,
        buttons: ['Allow', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        noLink: true
      };
      const result = win?.isVisible()
        ? await dialog.showMessageBox(win, options)
        : await dialog.showMessageBox(options);
      return result.response === 0;
    }
  });
  try {
    await Promise.all([recordingMediaServer.start(), gateway.start()]);
    gatewayReady = true;
    logger.info('web gateway ready', { port: DEFAULT_GATEWAY_PORT });
  } catch (error) {
    gatewayReady = false;
    setError(new Error(`Browser gateway could not start: ${error.message}`));
  }
  if (app.isPackaged) {
    runtimeSetupPromise = ensureRuntimeInstalled(process.resourcesPath, persistentRuntimeRoot)
      .then(stopLegacyBundledObs)
      .then(() => broadcast())
      .catch(error => setError(new Error(`Media runtime setup failed: ${error.message}`)));
  }
  await runtimeSetupPromise;
  await detectAvailableEncoders();
  scheduleMonitor();
  trayController.create({
    openPreferredUi,
    saveClip,
    quit: () => { app.isQuitting = true; app.quit(); }
  });
  broadcast();
  if (!process.argv.includes('--hidden') && settings.desktopWindow === false) openWebUi();
  try {
    if (confirmActiveVersionBoot(app)) logger.info('updated application boot confirmed', { version: app.getVersion() });
  } catch (error) {
    setError(new Error(`Could not confirm the updated application startup: ${error.message}`));
  }
});
app.on('second-instance', openPreferredUi);
process.on('uncaughtExceptionMonitor', error => { logger.error('uncaught exception', { message: error.message, stack: error.stack }); telemetry?.reportError(error).catch(() => {}); });
process.on('unhandledRejection', error => { logger.error('unhandled rejection', { message: error?.message || String(error), stack: error?.stack }); telemetry?.reportError(error).catch(() => {}); });
app.on('will-quit', () => { logger.info('application quitting'); if (microphoneVolumePersistTimer) persist(); logger.maintain(); clearTimeout(toastHideTimer); clearTimeout(toastRecoveryTimer); clearTimeout(microphoneVolumePersistTimer); clearTimeout(monitorTimer); clearTimeout(updateCheckTimeout); clearInterval(updateCheckTimer); obs.disconnect().catch(() => {}); closeMpvSession(); recordingMediaServer.close(); gateway?.close(); globalShortcut.unregisterAll(); });

ipcMain.handle('state:get', state);
ipcMain.handle('update:install', installUpdate);
ipcMain.handle('update:check', checkForUpdates);
ipcMain.handle('update:copy-diagnostics', copyUpdateDiagnostics);
ipcMain.handle('hotkey:capture-start', () => {
  globalShortcut.unregisterAll();
  return true;
});
ipcMain.handle('hotkey:capture-cancel', () => {
  registerHotkey();
  return true;
});
ipcMain.handle('capture:connect', reconnectCapture);
ipcMain.handle('settings:save', (_event, next) => saveSettings(next));
ipcMain.handle('recording:toggle', toggleRecording);
ipcMain.handle('clip:save', saveClip);
ipcMain.handle('folder:open', () => shell.openPath(todayFolder()));
ipcMain.handle('folder:open-root', () => { ensureDirectory(settings.recordingsFolder); return shell.openPath(settings.recordingsFolder); });
ipcMain.handle('recording:open', (_event, filePath) => openRecording(filePath));
ipcMain.handle('recording:thumbnail', (_event, filePath) => recordingThumbnail(filePath));
ipcMain.handle('recording:favorite', (_event, filePath, favorite) => setRecordingFavorite(filePath, favorite));
ipcMain.handle('recording:metadata', (_event, filePath, change) => updateRecordingMetadata(filePath, change));
ipcMain.handle('recording:stitch', (_event, filePaths) => stitchRecordings(filePaths));
ipcMain.handle('recording:delete', (_event, filePaths) => deleteRecordings(filePaths));
ipcMain.handle('mpv:start', (_event, filePath, bounds) => startMpvSession(filePath, bounds));
ipcMain.handle('mpv:bounds', (_event, bounds) => setMpvBounds(bounds));
ipcMain.handle('mpv:status', () => mpvStatus());
ipcMain.handle('mpv:seek', (_event, seconds) => mpvCommand('seek', Math.max(0, Number(seconds) || 0)));
ipcMain.handle('mpv:toggle', () => mpvCommand('toggle'));
ipcMain.handle('mpv:pause', (_event, paused = true) => mpvCommand('pause', paused ? 1 : 0));
ipcMain.handle('mpv:volume', (_event, volume) => mpvCommand('volume', Math.min(100, Math.max(0, Number(volume) || 0))));
ipcMain.handle('mpv:audio-mix', (_event, adjustments) => setMpvAudioMix(adjustments));
ipcMain.handle('mpv:close', () => closeMpvSession());
ipcMain.handle('mpv:fullscreen', (_event, filePath) => {
  const target = validateRecordingPath(filePath);
  const executable = mpvPath();
  if (!executable) throw new Error('Bundled MPV is missing from this Clips build.');
  const fullscreenPlayer = spawn(executable, mpvFullscreenArgs(mpvFullscreenScriptPath(), target), {
    detached: true,
    windowsHide: false,
    stdio: 'ignore'
  });
  fullscreenPlayer.once('exit', showMainWindow);
  fullscreenPlayer.unref();
  return true;
});
ipcMain.handle('capture:microphones', listMicrophones);
ipcMain.on('capture:microphone-volume-set', (_event, requestedPercent) => {
  const percent = Math.min(200, Math.max(0, Math.round(Number(requestedPercent) || 0)));
  settings = { ...settings, microphoneVolumePercent: percent };
  clearTimeout(microphoneVolumePersistTimer);
  microphoneVolumePersistTimer = setTimeout(() => {
    microphoneVolumePersistTimer = null;
    persist();
    logger.info('microphone volume persisted', { microphoneVolumePercent: percent });
  }, 120);
  logger.info('microphone volume input', { microphoneVolumePercent: percent });
  obs.setMicrophoneVolume(percent)
    .then(() => { lastError = ''; })
    .catch(setError);
});
ipcMain.on('capture:microphone-noise-gate-set', (_event, requestedDb) => {
  const thresholdDb = Math.min(-5, Math.max(-60, Math.round(Number(requestedDb) || -40)));
  settings = { ...settings, microphoneNoiseGateDb: thresholdDb };
  clearTimeout(microphoneVolumePersistTimer);
  microphoneVolumePersistTimer = setTimeout(() => { microphoneVolumePersistTimer = null; persist(); }, 120);
  obs.setMicrophoneNoiseGate(thresholdDb).catch(setError);
});
ipcMain.handle('capture:microphone-level', async () => obs.microphoneLevel());
ipcMain.on('capture:microphone-nvidia-noise-removal-set', (_event, enabled) => {
  settings = { ...settings, microphoneNvidiaNoiseRemoval: !!enabled };
  persist();
  obs.setMicrophoneNvidiaNoiseRemoval(!!enabled).catch(setError);
});
ipcMain.on('renderer:log', (_event, level, message) => {
  const write = level === 'error' ? logger.error : logger.warn;
  write('renderer event', { message: String(message || '') });
});
ipcMain.handle('window:modal-appearance', (event, active) => {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  if (senderWindow === win) senderWindow.setTitleBarOverlay(active ? titleBarAppearance.modal : titleBarAppearance.normal);
});
ipcMain.handle('recording:trim', (_event, filePath, startSeconds, endSeconds, bitrate) => trimRecordingAction(filePath, startSeconds, endSeconds, bitrate));
ipcMain.handle('recording:audio-tracks', (_event, filePath) => recordingAudioTracks(filePath));
ipcMain.handle('recording:audio-mix', (_event, filePath, adjustments, replace) => mixRecordingAction(filePath, adjustments, replace));
ipcMain.handle('folder:choose', chooseFolder);
ipcMain.handle('logs:open', () => shell.showItemInFolder(logger.filePath));
ipcMain.handle('processes:list', processes);
