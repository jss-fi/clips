const fs = require('fs');
const path = require('path');

const VIDEO_EXTENSION = /\.(mkv|mp4|mov|webm|flv)$/i;
const DAY_FOLDER = /^\d{4}-\d{2}-\d{2}$/;

function isRawRecordingName(name) {
  return VIDEO_EXTENSION.test(name)
    && !/^Replay(?:[ _-]|$)/i.test(name)
    && !/^Compilation-/i.test(name)
    && !/-(?:trimmed|mixed)(?:-\d+)?(?=\.[^.]+$)/i.test(name);
}

function createRecordingLibrary({ getSettings, getMetadata, favoritesPath, onDelete = () => {}, today = () => new Date().toLocaleDateString('sv-SE') }) {
  let favoriteKeys = new Set();
  const archivedDayCache = new Map();
  const root = () => path.resolve(getSettings().recordingsFolder);
  const recordingKey = filePath => {
    const relative = path.relative(root(), path.resolve(String(filePath || '')));
    if (relative.startsWith('..') || path.isAbsolute(relative)) return '';
    return relative.replace(/\\/g, '/').toLowerCase();
  };
  const isFavorite = filePath => favoriteKeys.has(recordingKey(filePath));
  const isContainedRealPath = filePath => {
    try {
      const realRoot = fs.realpathSync(root());
      const realTarget = fs.realpathSync(filePath);
      const relative = path.relative(realRoot, realTarget);
      return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
    } catch { return false; }
  };
  const isContainedRealPathAsync = async filePath => {
    try {
      const [realRoot, realTarget] = await Promise.all([fs.promises.realpath(root()), fs.promises.realpath(filePath)]);
      const relative = path.relative(realRoot, realTarget);
      return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
    } catch { return false; }
  };
  const enrich = recording => {
    const metadata = getMetadata()?.get(recording.path) || {};
    return { ...recording, ...metadata, title: metadata.title || recording.name, tags: metadata.tags || [], markers: metadata.markers || [], game: metadata.game || '' };
  };
  const persistFavorites = () => {
    const target = favoritesPath();
    const temporary = `${target}.working`;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(temporary, `${JSON.stringify([...favoriteKeys].sort(), null, 2)}\n`);
    fs.renameSync(temporary, target);
  };
  const recordingFilesByAge = async ({ beforeToday = false } = {}) => {
    try { await fs.promises.access(root()); } catch { return []; }
    const files = [];
    for (const day of await fs.promises.readdir(root(), { withFileTypes: true })) {
      if (!day.isDirectory() || !DAY_FOLDER.test(day.name) || (beforeToday && day.name >= today())) continue;
      const dayFolder = path.join(root(), day.name);
      if (!await isContainedRealPathAsync(dayFolder)) continue;
      for (const recording of await fs.promises.readdir(dayFolder, { withFileTypes: true })) {
        if (!recording.isFile() || !isRawRecordingName(recording.name)) continue;
        const filePath = path.join(dayFolder, recording.name);
        if (!await isContainedRealPathAsync(filePath)) continue;
        const stat = await fs.promises.stat(filePath);
        files.push({ path: filePath, modified: stat.mtimeMs, bytes: stat.size, favorite: isFavorite(filePath) });
      }
    }
    return files.sort((a, b) => a.modified - b.modified);
  };
  const diskUsagePercent = async () => {
    const stats = await fs.promises.statfs(root());
    return stats.blocks ? ((stats.blocks - stats.bavail) / stats.blocks) * 100 : 0;
  };

  return {
    loadFavorites() {
      try { favoriteKeys = new Set(JSON.parse(fs.readFileSync(favoritesPath(), 'utf8')).map(String)); }
      catch { favoriteKeys = new Set(); }
    },
    setFavorite(filePath, favorite, { persist = true } = {}) {
      const key = recordingKey(filePath);
      if (favorite) favoriteKeys.add(key); else favoriteKeys.delete(key);
      if (persist) persistFavorites();
    },
    persistFavorites,
    isRawRecordingName,
    async cleanupStorage(ensureDirectory) {
      const settings = getSettings();
      ensureDirectory(settings.recordingsFolder);
      if (settings.storageCleanupMode === 'disk') {
        const limit = Math.min(99, Math.max(1, Number(settings.maxDiskUsagePercent) || 80));
        const rawLimit = Math.max(1, Number(settings.maxRawRecordingGigabytes) || 250) * 1024 ** 3;
        const recordings = await recordingFilesByAge();
        let rawBytes = recordings.reduce((total, recording) => total + recording.bytes, 0);
        const isOverLimit = async () => await diskUsagePercent() >= limit || rawBytes > rawLimit;
        if (!await isOverLimit()) return;
        for (const recording of recordings.filter(item => path.basename(path.dirname(item.path)) < today())) {
          if (recording.favorite) continue;
          await onDelete(recording.path);
          fs.rmSync(recording.path, { force: true });
          rawBytes = Math.max(0, rawBytes - recording.bytes);
          favoriteKeys.delete(recordingKey(recording.path));
          if (!await isOverLimit()) break;
        }
        persistFavorites();
        return;
      }
      const cutoff = new Date(`${today()}T00:00:00`);
      cutoff.setDate(cutoff.getDate() - (settings.retentionDays - 1));
      for (const day of await fs.promises.readdir(root(), { withFileTypes: true })) {
        if (!day.isDirectory() || !DAY_FOLDER.test(day.name) || new Date(`${day.name}T00:00:00`) >= cutoff) continue;
        const dayFolder = path.join(root(), day.name);
        if (!await isContainedRealPathAsync(dayFolder)) continue;
        for (const recording of await fs.promises.readdir(dayFolder, { withFileTypes: true })) {
          if (!recording.isFile() || !isRawRecordingName(recording.name)) continue;
          const filePath = path.join(dayFolder, recording.name);
          if (!isFavorite(filePath) && await isContainedRealPathAsync(filePath)) {
            await onDelete(filePath);
            await fs.promises.rm(filePath, { force: true });
            favoriteKeys.delete(recordingKey(filePath));
          }
        }
      }
      persistFavorites();
    },
    async recentRecordings() {
      const dayFolder = path.join(root(), today());
      if (!await isContainedRealPathAsync(dayFolder)) return [];
      const items = await fs.promises.readdir(dayFolder, { withFileTypes: true });
      const recordings = await Promise.all(items.filter(item => item.isFile() && VIDEO_EXTENSION.test(item.name)).map(async item => {
        const filePath = path.join(dayFolder, item.name); if (!await isContainedRealPathAsync(filePath)) return null;
        const stat = await fs.promises.stat(filePath); return enrich({ name: item.name, path: filePath, bytes: stat.size, modified: stat.mtime.toISOString(), kind: /^Replay(?:[ _-]|$)/i.test(item.name) ? 'replay' : 'recording', favorite: isFavorite(filePath) });
      }));
      return recordings.filter(Boolean)
        .sort((a, b) => Number(b.favorite) - Number(a.favorite) || b.modified.localeCompare(a.modified)).slice(0, 24);
    },
    async archivedRecordings() {
      try { await fs.promises.access(root()); } catch { return []; }
      const recordings = [];
      const activeDays = new Set();
      for (const day of await fs.promises.readdir(root(), { withFileTypes: true })) {
        if (!day.isDirectory() || !DAY_FOLDER.test(day.name) || day.name === today()) continue;
        const dayFolder = path.join(root(), day.name);
        if (!await isContainedRealPathAsync(dayFolder)) continue;
        activeDays.add(day.name);
        const directoryStat = await fs.promises.stat(dayFolder);
        let cached = archivedDayCache.get(day.name);
        if (!cached || cached.folder !== dayFolder || cached.modified !== directoryStat.mtimeMs) {
          const items = [];
          for (const item of await fs.promises.readdir(dayFolder, { withFileTypes: true })) {
            if (!item.isFile() || !VIDEO_EXTENSION.test(item.name)) continue;
            const filePath = path.join(dayFolder, item.name);
            if (!await isContainedRealPathAsync(filePath)) continue;
            const stat = await fs.promises.stat(filePath);
            items.push({ name: item.name, path: filePath, bytes: stat.size, modified: stat.mtime.toISOString(), day: day.name, kind: /^Replay(?:[ _-]|$)/i.test(item.name) ? 'replay' : 'recording' });
          }
          cached = { folder: dayFolder, modified: directoryStat.mtimeMs, items };
          archivedDayCache.set(day.name, cached);
        }
        recordings.push(...cached.items.map(item => enrich({ ...item, favorite: isFavorite(item.path) })));
      }
      for (const day of archivedDayCache.keys()) if (!activeDays.has(day)) archivedDayCache.delete(day);
      return recordings.sort((a, b) => b.day.localeCompare(a.day) || b.modified.localeCompare(a.modified));
    },
    validatePath(filePath) {
      const target = path.resolve(String(filePath || ''));
      const relative = path.relative(root(), target);
      if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(target) || !fs.statSync(target).isFile() || !isContainedRealPath(target)) throw new Error('Recording no longer exists.');
      return target;
    }
  };
}

module.exports = { createRecordingLibrary, isRawRecordingName };
