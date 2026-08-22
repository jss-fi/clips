let state;
let editingPath = "";
let trimStart = 0;
let trimEnd = 0;
let draggingHandle = "";
let draggingPlayhead = false;
let mpvDuration = 0;
let mpvCurrentTime = 0;
let mpvPaused = true;
let mpvPollTimer = null;
let editorMode = "trim";
let mixingPath = "";
let mixerLoadedPath = "";
let liveMixTimer = null;
let libraryQuery = "";
let librarySort = "newest";
const ARCHIVE_PAGE_SIZE = 120;
const THUMBNAIL_CACHE_LIMIT = 160;
let archiveVisibleCount = ARCHIVE_PAGE_SIZE;
let renderedSettingsJson = "";
let renderedLibraryJson = "";
const shortTimeFormatter = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const archiveDateFormatter = new Intl.DateTimeFormat(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
const megabyteFormatter = new Intl.NumberFormat(undefined, { style: "unit", unit: "megabyte", maximumFractionDigits: 1 });
const gigabyteFormatter = new Intl.NumberFormat(undefined, { style: "unit", unit: "gigabyte", maximumFractionDigits: 1 });
const formatBytes = bytes => bytes >= 1073741824
  ? gigabyteFormatter.format(bytes / 1073741824)
  : megabyteFormatter.format(bytes / 1048576);
const recordingDetails = recording => {
  const time = shortTimeFormatter.format(new Date(recording.modified));
  const markers = recording.markers?.length ? ` · ${recording.markers.length} marker${recording.markers.length === 1 ? "" : "s"}` : "";
  return `${time} · ${formatBytes(recording.bytes)}${markers}`;
};
const playerIcons = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>',
  fullscreen: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5v2H6v3zm11-5h5v5h-2V6h-3zM6 15v3h3v2H4v-5zm12 0h2v5h-5v-2h3z"/></svg>',
};
const thumbnailCache = new Map();
const recentDetailElements = new Map();
function cacheThumbnail(filePath, thumbnail) {
  thumbnailCache.delete(filePath);
  thumbnailCache.set(filePath, thumbnail);
  while (thumbnailCache.size > THUMBNAIL_CACHE_LIMIT) {
    thumbnailCache.delete(thumbnailCache.keys().next().value);
  }
}
const selectedRecordingPaths = new Set();
let pendingDeletePaths = [];
const thumbnailObserver = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (!entry.isIntersecting) return;
    thumbnailObserver.unobserve(entry.target);
    requestRecordingThumbnail(entry.target);
  });
}, { rootMargin: "40px" });
const $ = (id) => document.getElementById(id);
const formatTimestamp = (totalSeconds) => {
  const safe = Math.max(0, Number(totalSeconds) || 0);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${seconds.toFixed(2).padStart(5, "0")}`;
};
const shortTimestamp = (seconds) => formatTimestamp(seconds).replace(/^00:/, "");
const parseTimestamp = (value) => {
  const parts = String(value).trim().split(":");
  if (parts.length < 1 || parts.length > 3 || parts.some(part => part === "" || !Number.isFinite(Number(part)))) return NaN;
  const numbers = parts.map(Number);
  if (numbers.some(number => number < 0)) return NaN;
  if (parts.length === 3 && (numbers[1] >= 60 || numbers[2] >= 60)) return NaN;
  if (parts.length === 2 && numbers[1] >= 60) return NaN;
  return parts.length === 3 ? numbers[0] * 3600 + numbers[1] * 60 + numbers[2]
    : parts.length === 2 ? numbers[0] * 60 + numbers[1] : numbers[0];
};
const acceleratorLabel = {
  CommandOrControl: "Ctrl",
  Super: "Win",
  Return: "Enter",
  Up: "Arrow Up",
  Down: "Arrow Down",
  Left: "Arrow Left",
  Right: "Arrow Right",
};
const formatAccelerator = (accelerator, separator = " + ") =>
  String(accelerator || "")
    .split("+")
    .filter(Boolean)
    .map((token) => acceleratorLabel[token] || token)
    .join(separator);
const modifierTokens = ["CommandOrControl", "Alt", "Shift", "Super"];
const modifierCodeToken = (code) => {
  if (code.startsWith("Control")) return "CommandOrControl";
  if (code.startsWith("Alt")) return "Alt";
  if (code.startsWith("Shift")) return "Shift";
  if (code.startsWith("Meta")) return "Super";
  return "";
};
const acceleratorKeyToken = (event) => {
  const { code, key } = event;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  const named = {
    Space: "Space",
    Tab: "Tab",
    Backspace: "Backspace",
    Delete: "Delete",
    Insert: "Insert",
    Enter: "Return",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
  };
  if (named[code]) return named[code];
  const punctuation = {
    "+": "Plus",
    "-": "-",
    "=": "=",
    ",": ",",
    ".": ".",
    "/": "/",
    ";": ";",
    "'": "'",
    "[": "[",
    "]": "]",
    "\\": "\\",
    "`": "`",
  };
  return punctuation[key] || "";
};
const values = () => ({
  recordingsFolder: $("folder").value,
  retentionDays: Number($("days").value),
  storageCleanupMode: $("cleanup-mode").value,
  maxDiskUsagePercent: Number($("disk-percent").value),
  maxRawRecordingGigabytes: Number($("raw-gigabytes").value),
  clipLengthSeconds: Number($("clip-length").value),
  instantReplay: $("instant-replay").checked,
  instantReplayLengthSeconds: Number($("instant-replay-length").value),
  clipHotkey: $("hotkey").dataset.accelerator ?? "",
  markerHotkey: $("marker-hotkey").dataset.accelerator ?? "",
  stopDelaySeconds: Number($("delay").value),
  autoRecord: $("auto").checked,
  startWithWindows: $("startup").checked,
  obsRecordingQuality: $("recording-quality").value,
  obsEncoder: $("encoder").value,
  obsResolution: $("resolution").value,
  obsFps: Number($("fps").value),
  obsFormat: $("format").value,
  microphoneDeviceId: $("microphone").value,
  microphoneVolumePercent: Number($("microphone-volume").value),
  microphoneNoiseGateDb: Number($("microphone-noise-gate").value),
  microphoneNvidiaNoiseRemoval: $("microphone-nvidia-noise-removal").checked,
  audioExecutables: state.settings.audioExecutables,
  gameExecutables: state.settings.gameExecutables,
  ignoredGameExecutables: state.settings.ignoredGameExecutables || [],
  gameProfiles: state.settings.gameProfiles || {},
  trimBitrate: $("trim-bitrate").value,
  desktopWindow: $("desktop-window").checked,
  nightlyUpdates: $("nightly-updates").checked,
  telemetryMode: $("telemetry-mode").value,
});
function restoreMicrophoneSelection(selectedId) {
  const select = $("microphone");
  const wanted = String(selectedId || "disabled");
  if (![...select.options].some(option => option.value === wanted)) {
    select.add(new Option(wanted === "disabled" ? "Off" : "Saved microphone (loading…)", wanted));
  }
  select.value = wanted;
}
function renderEncoders(encoders, selectedId, activeId) {
  const select = $("encoder");
  const available = Array.isArray(encoders) ? encoders : [];
  const signature = JSON.stringify({ available, activeId });
  if (select.dataset.encoders === signature) return;
  select.dataset.encoders = signature;
  select.replaceChildren(new Option(activeId ? `Automatic (${available.find(item => item.id === activeId)?.name || activeId})` : "Automatic", "auto"));
  for (const encoder of available) select.add(new Option(encoder.name, encoder.id));
  select.value = available.some(encoder => encoder.id === selectedId) ? selectedId : "auto";
}
function render(s, fill = false, refreshLibrary = false) {
  state = s;
  renderEncoders(s.availableEncoders, s.settings.obsEncoder, s.selectedEncoder);
  const updateReady = s.update?.status === "ready";
  $("update-button").classList.toggle("hidden", !updateReady);
  if (!updateReady) {
    $("update-button").disabled = false;
    $("update-button").classList.remove("restarting");
  }
  if (updateReady) {
    const label = `Restart to install Clips ${s.update.version}`;
    $("update-button").setAttribute("aria-label", label);
    $("update-button").title = label;
  }
  $("about-version").textContent = `v${s.app?.version || "—"}`;
  $("about-build-time").textContent = s.app?.buildTime
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(s.app.buildTime))
    : "Unknown";
  $("about-runtime").textContent = s.app?.runtimeReady
    ? `v${s.app.runtimeVersion} · Ready`
    : `v${s.app?.runtimeVersion || "—"} · Installing…`;
  const updateStatus = {
    checking: "Checking for updates…",
    downloading: `Downloading ${s.update?.version || "update"}… ${s.update?.percent || 0}%`,
    preparing: s.update?.message || `Preparing ${s.update?.version || "update"}…`,
    ready: `${s.update?.version || "Update"} is downloaded and ready to restart.`,
    error: s.update?.message || "The update check failed.",
    withdrawn: s.update?.message || "This update was withdrawn and will not be installed.",
    idle: s.update?.configured ? "You’re up to date." : "Nightly updates are off.",
  };
  $("about-update-status").textContent = updateStatus[s.update?.status] || updateStatus.idle;
  const checkButton = $("check-updates");
  const updateBusyOrReady = ["checking", "downloading", "preparing", "ready"].includes(s.update?.status);
  checkButton.disabled = updateBusyOrReady;
  checkButton.textContent = ({ checking: "Checking…", downloading: "Downloading…", preparing: "Preparing…", ready: "Update ready" })[s.update?.status] || "Check now";
  $("telemetry-mode").disabled = !s.telemetry?.configured;
  $("telemetry-status").textContent = s.telemetry?.configured
    ? "The choice applies immediately and can be changed at any time."
    : "Telemetry is not configured in this build; no data can be sent.";
  renderChangelog(s.app?.changelog || [], !!s.settings?.nightlyUpdates);
  const online = s.obs.connected;
  $("connection").textContent = online ? "Capture engine ready" : "Capture engine offline";
  $("connection-dot").classList.toggle("online", online);
  $("record-indicator").classList.toggle("live", s.obs.recording);
  $("record").textContent = s.obs.recording
    ? "Stop recording"
    : "Start recording";
  $("status").textContent = s.obs.recording
    ? "Recording"
    : s.obs.replayBuffer
      ? "Instant replay ready"
    : s.activeGames.length
      ? "Game detected"
      : "Waiting for a game";
  $("detail").textContent = s.activeGames.length
    ? s.activeGames.join(", ")
    : "Monitoring configured games";
  $("error").textContent = s.lastError
    ? s.lastError.includes("Stop recording")
        ? s.lastError
      : /EPERM|EACCES|mkdir|storage/i.test(s.lastError)
        ? `${s.lastError} Check the storage folder.`
      : `${s.lastError} Reconnect the capture engine or restart Clips.`
    : "";
  $("error").classList.toggle("hidden", !s.lastError);
  const unknownStorage = s.storage?.byGame?.some(item => item.game === "Older recordings (game unknown)");
  $("storage-insights-summary").textContent = `${formatBytes(s.storage?.totalBytes || 0)} in Clips · ${formatBytes(s.storage?.driveFreeBytes || 0)} free on the drive.${unknownStorage ? " Footage saved before game tracking is grouped as unknown." : ""}`;
  $("storage-by-game").innerHTML = s.storage?.byGame?.length ? s.storage.byGame.map(item => `<div class="settings-row"><span><strong>${escapeHtml(item.game)}</strong><small>${formatBytes(item.bytes)}</small></span><meter min="0" max="${s.storage.totalBytes || 1}" value="${item.bytes}"></meter></div>`).join("") : '<div class="settings-row"><span class="muted">No recordings to measure yet.</span></div>';
  $("game-list").innerHTML = s.settings.gameExecutables.length
    ? s.settings.gameExecutables
        .map(
          (x, i) =>
            `<div class="chip"><span>${escapeHtml(x)}</span><button data-remove="${i}" aria-label="Remove ${escapeHtml(x)}">&times;</button></div>`,
        )
        .join("")
    : '<div class="muted">No games added. Add a running game to begin.</div>';
  $("ignored-game-list").innerHTML = s.settings.ignoredGameExecutables?.length
    ? `<div class="muted">Ignored detections</div>${s.settings.ignoredGameExecutables.map((x, i) =>
        `<div class="chip"><span>${escapeHtml(x)}</span><button data-remove-ignored="${i}" aria-label="Detect ${escapeHtml(x)} again">&times;</button></div>`).join("")}`
    : "";
  $("game-profiles").innerHTML = s.settings.gameExecutables.length ? s.settings.gameExecutables.map(game => {
    const key = game.toLowerCase(); const profile = s.settings.gameProfiles?.[key] || {};
    return `<div class="settings-row game-profile" data-profile-game="${escapeHtml(key)}"><span><strong>${escapeHtml(game)}</strong><small>Blank values use the global capture profile.</small></span><span class="profile-controls"><select data-profile="quality"><option value="">Default quality</option><option value="HQ"${profile.quality === "HQ" ? " selected" : ""}>High</option><option value="Small"${profile.quality === "Small" ? " selected" : ""}>Small</option></select><select data-profile="resolution"><option value="">Default resolution</option><option value="2560x1440"${profile.resolution === "2560x1440" ? " selected" : ""}>1440p</option><option value="1920x1080"${profile.resolution === "1920x1080" ? " selected" : ""}>1080p</option><option value="1280x720"${profile.resolution === "1280x720" ? " selected" : ""}>720p</option></select><select data-profile="fps"><option value="0">Default FPS</option><option value="60"${profile.fps === 60 ? " selected" : ""}>60 FPS</option><option value="30"${profile.fps === 30 ? " selected" : ""}>30 FPS</option></select><input data-profile="clipLengthSeconds" type="number" min="5" max="3600" placeholder="Default seconds" value="${profile.clipLengthSeconds || ""}"></span></div>`;
  }).join("") : '<div class="settings-row"><span class="muted">Add a monitored game to create a profile.</span></div>';
  $("audio-application-list").innerHTML = s.settings.audioExecutables.length
    ? s.settings.audioExecutables
        .map(
          (x, i) =>
            `<div class="chip"><span>${escapeHtml(x)}</span><button data-remove-audio="${i}" aria-label="Remove ${escapeHtml(x)}">&times;</button></div>`,
        )
        .join("")
    : '<div class="muted">No extra applications added. The active game audio is still recorded.</div>';
  const libraryJson = JSON.stringify([
    (s.recordings || []).map(recording => [
      recording.path, recording.name, recording.title, recording.game, recording.kind,
      recording.favorite, recording.tags || [], recording.markers?.length || 0,
    ]),
    s.archivedRecordings || [],
  ]);
  if (refreshLibrary || libraryJson !== renderedLibraryJson) {
  const organize = (items) => {
    const query = libraryQuery.toLowerCase();
    const filtered = query ? items.filter(item => [item.title, item.name, item.game, ...(item.tags || [])].join(" ").toLowerCase().includes(query)) : [...items];
    return filtered.sort((a, b) => librarySort === "oldest" ? a.modified.localeCompare(b.modified)
      : librarySort === "size" ? b.bytes - a.bytes
      : librarySort === "game" ? (a.game || "Uncategorized").localeCompare(b.game || "Uncategorized")
      : b.modified.localeCompare(a.modified));
  };
  const recordings = s.recordings || [];
  const favorites = recordings.filter((item) => item.favorite);
  const replayTotal = recordings.filter((item) => item.kind === "replay").length;
  const recordingTotal = recordings.length - replayTotal;
  const replays = recordings.filter((item) => item.kind === "replay" && !item.favorite);
  const fullRecordings = recordings.filter((item) => item.kind !== "replay" && !item.favorite);
  $("library-summary").textContent = recordings.length
    ? `${replayTotal} replay${replayTotal === 1 ? "" : "s"} and ${recordingTotal} full recording${recordingTotal === 1 ? "" : "s"} today.`
    : "Recordings from this session.";
  const renderFiles = (items, emptyTitle, emptyDetail) => items.length
    ? items.map((recording) => {
        const favoriteLabel = recording.favorite ? "Remove from favorites" : "Add to favorites";
        const selected = selectedRecordingPaths.has(recording.path);
        return `<article class="recording-card${recording.favorite ? " favorite" : ""}${selected ? " selected" : ""}"><button class="recording-open" data-recording-path="${escapeHtml(recording.path)}" data-recording-name="${escapeHtml(recording.title || recording.name)}" aria-label="Play ${escapeHtml(recording.title || recording.name)}"><span class="recording-preview"><img class="recording-thumbnail" data-thumbnail-path="${escapeHtml(recording.path)}" loading="lazy" decoding="async" alt=""><i class="recording-placeholder" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m9 7 8 5-8 5z"/></svg></i><i class="recording-play" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m9 7 8 5-8 5z"/></svg></i></span><span class="recording-meta"><strong title="${escapeHtml(recording.title || recording.name)}">${escapeHtml(recording.title || recording.name)}</strong><span data-recording-details-path="${escapeHtml(recording.path)}">${escapeHtml(recordingDetails(recording))}</span></span></button><button class="recording-select" data-select-path="${escapeHtml(recording.path)}" aria-pressed="${selected}" aria-label="${selected ? "Deselect" : "Select"} ${escapeHtml(recording.name)}" title="${selected ? "Deselect" : "Select"}"><i></i></button><button class="recording-favorite" data-favorite-path="${escapeHtml(recording.path)}" data-favorite="${recording.favorite ? "true" : "false"}" aria-label="${favoriteLabel}" title="${favoriteLabel}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z"/></svg></button><div class="recording-actions"><button class="recording-delete" data-delete-path="${escapeHtml(recording.path)}" data-delete-name="${escapeHtml(recording.name)}" aria-label="Delete ${escapeHtml(recording.name)}" title="Delete"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v5m4-5v5"/></svg></button></div></article>`;
      }).join("")
    : `<div class="empty compact"><div><strong>${emptyTitle}</strong><span>${emptyDetail}</span></div></div>`;
  $("replay-count").textContent = replays.length;
  $("recording-count").textContent = fullRecordings.length;
  $("recent-favorite-count").textContent = favorites.length;
  $("recent-favorites-section").classList.toggle("hidden", !favorites.length);
  $("recent-favorite-list").innerHTML = renderFiles(favorites, "", "");
  $("replay-list").innerHTML = renderFiles(replays, "No replays yet", "Use the clip shortcut to save one.");
  $("recording-list").innerHTML = renderFiles(fullRecordings, "No full recordings", "A session appears here when recording starts.");
  const archived = organize(s.archivedRecordings || []);
  const archivedFavorites = archived.filter(recording => recording.favorite);
  const archivedOthers = archived.filter(recording => !recording.favorite);
  const chronological = librarySort === "newest" || librarySort === "oldest";
  const visibleFavorites = archivedFavorites.slice(0, archiveVisibleCount);
  const archiveItems = chronological ? archivedOthers : archived;
  const visibleArchiveItems = archiveItems.slice(0, archiveVisibleCount);
  const groupedItems = visibleArchiveItems.reduce((groups, recording) => {
    const key = chronological ? recording.day
      : librarySort === "game" ? (recording.game || "Older recordings (game unknown)")
      : "Largest files";
    (groups[key] ||= []).push(recording);
    return groups;
  }, {});
  $("archive-favorite-count").textContent = archivedFavorites.length;
  $("archive-favorites-section").classList.toggle("hidden", !chronological || !archivedFavorites.length);
  $("archive-favorite-list").innerHTML = renderFiles(visibleFavorites, "", "");
  $("archive-summary").textContent = archived.length
    ? librarySort === "size" ? `${archived.length} saved item${archived.length === 1 ? "" : "s"}, ranked by file size.`
    : librarySort === "game" ? `${archived.length} saved item${archived.length === 1 ? "" : "s"}, grouped by game.`
    : `${archived.length} saved item${archived.length === 1 ? "" : "s"} across ${new Set(archived.map(item => item.day)).size} day${new Set(archived.map(item => item.day)).size === 1 ? "" : "s"}.`
    : "Previous days saved on this device.";
  $("archive-days").innerHTML = archived.length
    ? Object.entries(groupedItems).map(([group, items]) => {
        const heading = chronological
          ? archiveDateFormatter.format(new Date(`${group}T12:00:00`))
          : group;
        return `<section class="archive-day"><div class="group-title"><h3>${escapeHtml(heading)}</h3><span>${items.length}</span></div><div class="recording-list">${renderFiles(items, "", "")}</div></section>`;
      }).join("")
    : '<div class="empty archive-empty"><div><strong>No previous days yet</strong><span>Older recordings will appear here, grouped by day.</span></div></div>';
  const renderedArchiveCount = visibleArchiveItems.length + (chronological ? visibleFavorites.length : 0);
  const remainingArchiveCount = Math.max(0, archived.length - renderedArchiveCount);
  $("archive-load-more").classList.toggle("hidden", !remainingArchiveCount);
  $("archive-load-more").textContent = remainingArchiveCount
    ? `Show ${Math.min(ARCHIVE_PAGE_SIZE, remainingArchiveCount)} more`
    : "All recordings shown";
  loadRecordingThumbnails();
  updateSelectionBar();
  recentDetailElements.clear();
  for (const id of ["recent-favorite-list", "replay-list", "recording-list"]) {
    $(id).querySelectorAll("[data-recording-details-path]").forEach(element => {
      recentDetailElements.set(element.dataset.recordingDetailsPath, element);
    });
  }
  renderedLibraryJson = libraryJson;
  }
  for (const recording of s.recordings || []) {
    const element = recentDetailElements.get(recording.path);
    const details = recordingDetails(recording);
    if (element && element.textContent !== details) element.textContent = details;
  }
  $("footer-status").textContent = s.autoRecordSuppressed
    ? "Stopped until the game closes"
    : s.lastClip
    ? `Clip saved ${new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(s.lastClip))}`
    : "Monitoring in background";
  $("clip-key").textContent = formatAccelerator(s.settings.clipHotkey, " ");
  if (fill) {
    renderedSettingsJson = JSON.stringify(s.settings);
    $("folder").value = s.settings.recordingsFolder;
    $("days").value = s.settings.retentionDays;
    $("cleanup-mode").value = s.settings.storageCleanupMode;
    $("disk-percent").value = s.settings.maxDiskUsagePercent;
    $("raw-gigabytes").value = s.settings.maxRawRecordingGigabytes;
    $("clip-length").value = s.settings.clipLengthSeconds;
    $("instant-replay").checked = !!s.settings.instantReplay;
    $("instant-replay-length").value = s.settings.instantReplayLengthSeconds ?? 300;
    $("hotkey").dataset.accelerator = s.settings.clipHotkey;
    $("hotkey").value = formatAccelerator(s.settings.clipHotkey) || "Disabled";
    $("marker-hotkey").dataset.accelerator = s.settings.markerHotkey || "";
    $("marker-hotkey").value = formatAccelerator(s.settings.markerHotkey) || "Disabled";
    $("delay").value = s.settings.stopDelaySeconds;
    $("auto").checked = s.settings.autoRecord;
    $("startup").checked = s.settings.startWithWindows;
    $("recording-quality").value = s.settings.obsRecordingQuality;
    $("encoder").value = s.availableEncoders?.some(encoder => encoder.id === s.settings.obsEncoder) ? s.settings.obsEncoder : "auto";
    $("resolution").value = s.settings.obsResolution;
    $("fps").value = s.settings.obsFps;
    $("format").value = s.settings.obsFormat;
    restoreMicrophoneSelection(s.settings.microphoneDeviceId);
    $("microphone-volume").value = s.settings.microphoneVolumePercent ?? 100;
    $("microphone-volume-value").textContent = `${s.settings.microphoneVolumePercent ?? 100}%`;
    $("microphone-noise-gate").value = s.settings.microphoneNoiseGateDb ?? -40;
    $("microphone-nvidia-noise-removal").checked = s.settings.microphoneNvidiaNoiseRemoval !== false;
    updateMicrophoneNoiseGate();
    $("trim-bitrate").value = s.settings.trimBitrate || "original";
    $("desktop-window").checked = s.settings.desktopWindow !== false;
    $("nightly-updates").checked = !!s.settings.nightlyUpdates;
    $("telemetry-mode").value = ["diagnostics", "version", "off"].includes(s.settings.telemetryMode) ? s.settings.telemetryMode : "off";
    updateStorageVisibility();
  }
}

const isNightlyRelease = release => /(?:^|-)nightly(?:\.|$)/i.test(String(release?.version || ""));
function renderChangelog(releases, nightlyUpdates) {
  const container = $("changelog");
  const visibleReleases = nightlyUpdates ? releases : releases.filter(release => !isNightlyRelease(release));
  const renderKey = JSON.stringify({ releases: visibleReleases, nightlyUpdates });
  if (container.dataset.rendered === renderKey) return;
  container.dataset.rendered = renderKey;
  container.replaceChildren(...visibleReleases.map(release => {
    const article = document.createElement("article");
    article.className = "changelog-release";
    const heading = document.createElement("div");
    heading.className = "changelog-heading";
    const version = document.createElement("strong");
    version.textContent = `v${release.version}`;
    const title = document.createElement("span");
    title.textContent = release.title;
    heading.append(version, title);
    if (nightlyUpdates && !isNightlyRelease(release)) {
      const recap = document.createElement("span");
      recap.className = "changelog-tag";
      recap.textContent = "Recap";
      heading.append(recap);
    }
    const list = document.createElement("ul");
    for (const change of release.changes || []) {
      const item = document.createElement("li");
      item.textContent = change;
      list.append(item);
    }
    article.append(heading, list);
    return article;
  }));
}
function loadRecordingThumbnails() {
  thumbnailObserver.disconnect();
  document.querySelectorAll(".recording-thumbnail[data-thumbnail-path]").forEach((image) => {
    const filePath = image.dataset.thumbnailPath;
    if (thumbnailCache.has(filePath)) {
      image.src = thumbnailCache.get(filePath);
      image.classList.add("loaded");
      return;
    }
    thumbnailObserver.observe(image);
  });
}
function requestRecordingThumbnail(image) {
  const filePath = image.dataset.thumbnailPath;
  window.clips.getRecordingThumbnail(filePath).then((thumbnail) => {
    if (!thumbnail) return;
    cacheThumbnail(filePath, thumbnail);
    if (!image.isConnected || image.dataset.thumbnailPath !== filePath) return;
    image.src = thumbnail;
    image.classList.add("loaded");
  }).catch(() => {});
}
const escapeHtml = (s) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
let lastLibraryPage = "recent";
function navigateToPage(page) {
  if (page !== "settings") lastLibraryPage = page;
  document.querySelectorAll(".page").forEach((panel) => panel.classList.remove("active"));
  document.querySelectorAll(".nav-main").forEach((button) => {
    button.classList.toggle("active", button.dataset.page === page);
  });
  $(page).classList.add("active");
  $("primary-navigation").classList.toggle("hidden", page === "settings");
  $("settings-navigation").classList.toggle("hidden", page !== "settings");
  $("settings-button").classList.toggle("hidden", page === "settings");
  $("settings-back").classList.toggle("hidden", page !== "settings");
  $("workspace").classList.toggle("settings-open", page === "settings");
  if (page === "recent" || page === "library") requestAnimationFrame(loadRecordingThumbnails);
}
document.querySelectorAll(".nav-main").forEach((button) => {
  button.onclick = () => navigateToPage(button.dataset.page);
});
$("settings-back").onclick = () => navigateToPage(lastLibraryPage);
document.querySelectorAll(".settings-nav-item").forEach((button) => {
  button.onclick = () => {
    document.querySelectorAll(".settings-nav-item").forEach((item) => item.classList.remove("active"));
    document.querySelectorAll(".settings-group").forEach((group) => group.classList.remove("active"));
    button.classList.add("active");
    $(`settings-${button.dataset.settingsGroup}`).classList.add("active");
    if (button.dataset.settingsGroup === "capture") refreshMicrophones(state.settings.microphoneDeviceId);
  };
});
async function refreshMicrophones(selectedId) {
  const select = $("microphone");
  const wanted = selectedId || select.value || "disabled";
  try {
    const devices = await window.clips.listMicrophones();
    select.replaceChildren(new Option("Off", "disabled"));
    devices.forEach(device => select.add(new Option(device.name, device.id)));
    if (![...select.options].some(option => option.value === wanted) && wanted !== "disabled") {
      select.add(new Option("Unavailable microphone", wanted));
    }
    select.value = wanted;
    select.disabled = false;
  } catch {
    restoreMicrophoneSelection(wanted);
    select.disabled = false;
  }
}
let shortcutInput = $("hotkey");
let shortcutFeedback = $("shortcut-feedback");
let shortcutCapturing = false;
let shortcutPrevious = "";
let shortcutPressedCodes = new Set();
let shortcutCapturedTokens = new Set();
const stopShortcutCapture = async ({ save = false, message = "Click to remap" } = {}) => {
  const accelerator = [...modifierTokens.filter((token) => shortcutCapturedTokens.has(token)),
    ...[...shortcutCapturedTokens].filter((token) => !modifierTokens.includes(token))].join("+");
  shortcutCapturing = false;
  shortcutPressedCodes.clear();
  shortcutCapturedTokens.clear();
  shortcutInput.classList.remove("capturing");
  if (!save) {
    shortcutInput.dataset.accelerator = shortcutPrevious;
    shortcutInput.value = formatAccelerator(shortcutPrevious) || "Disabled";
    shortcutFeedback.textContent = message;
    await window.clips.cancelHotkeyCapture();
    return;
  }
  shortcutInput.dataset.accelerator = accelerator;
  shortcutInput.value = formatAccelerator(accelerator);
  shortcutFeedback.textContent = "Saving…";
  try {
    render(await window.clips.saveSettings(values()), true);
    shortcutFeedback.textContent = "Saved";
  } catch (error) {
    shortcutInput.dataset.accelerator = shortcutPrevious;
    shortcutInput.value = formatAccelerator(shortcutPrevious) || "Disabled";
    shortcutFeedback.textContent = error.message || "Could not save shortcut";
    await window.clips.cancelHotkeyCapture();
  }
};
const beginShortcutCapture = async (input = $("hotkey"), feedback = $("shortcut-feedback")) => {
  if (shortcutCapturing) return;
  shortcutInput = input;
  shortcutFeedback = feedback;
  shortcutCapturing = true;
  shortcutPrevious = shortcutInput.dataset.accelerator || "";
  shortcutPressedCodes.clear();
  shortcutCapturedTokens.clear();
  shortcutInput.value = "Press shortcut…";
  shortcutInput.classList.add("capturing");
  shortcutFeedback.textContent = "Release all keys to save";
  await window.clips.beginHotkeyCapture();
};
shortcutInput.addEventListener("focus", () => beginShortcutCapture($("hotkey"), $("shortcut-feedback")));
shortcutInput.addEventListener("keydown", (event) => {
  if (!shortcutCapturing) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.code === "Escape") {
    stopShortcutCapture({ message: "Cancelled" });
    shortcutInput.blur();
    return;
  }
  if (event.repeat) return;
  shortcutPressedCodes.add(event.code);
  const modifier = modifierCodeToken(event.code);
  const key = modifier || acceleratorKeyToken(event);
  if (key) shortcutCapturedTokens.add(key);
  shortcutInput.value = formatAccelerator(
    [...modifierTokens.filter((token) => shortcutCapturedTokens.has(token)),
      ...[...shortcutCapturedTokens].filter((token) => !modifierTokens.includes(token))].join("+"),
  ) || "Press shortcut…";
});
shortcutInput.addEventListener("keyup", (event) => {
  if (!shortcutCapturing) return;
  event.preventDefault();
  event.stopPropagation();
  shortcutPressedCodes.delete(event.code);
  if (shortcutPressedCodes.size) return;
  const primaryKeys = [...shortcutCapturedTokens].filter((token) => !modifierTokens.includes(token));
  if (primaryKeys.length !== 1) {
    shortcutFeedback.textContent = primaryKeys.length
      ? "Use one main key with any modifiers"
      : "Add a letter, number, function, or navigation key";
    shortcutCapturedTokens.clear();
    shortcutInput.value = "Try again…";
    return;
  }
  stopShortcutCapture({ save: true });
  shortcutInput.blur();
});
shortcutInput.addEventListener("blur", () => {
  if (shortcutCapturing && shortcutPressedCodes.size === 0 && shortcutCapturedTokens.size === 0) {
    stopShortcutCapture({ message: "Cancelled" });
  }
});
const markerShortcutInput = $("marker-hotkey");
const markerShortcutFeedback = $("marker-shortcut-feedback");
markerShortcutInput.addEventListener("focus", () => beginShortcutCapture(markerShortcutInput, markerShortcutFeedback));
for (const type of ["keydown", "keyup"]) markerShortcutInput.addEventListener(type, event => shortcutInput.dispatchEvent(new KeyboardEvent(type, {
  key: event.key, code: event.code, ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey, metaKey: event.metaKey,
  repeat: event.repeat, bubbles: false, cancelable: true
})));
markerShortcutInput.addEventListener("blur", () => {
  if (shortcutCapturing && shortcutInput === markerShortcutInput && shortcutPressedCodes.size === 0 && shortcutCapturedTokens.size === 0) stopShortcutCapture({ message: "Cancelled" });
});
const disableShortcut = async (input, feedback) => {
  if (shortcutCapturing) await stopShortcutCapture({ message: "Cancelled" });
  input.dataset.accelerator = "";
  input.value = "Disabled";
  feedback.textContent = "Saving…";
  render(await window.clips.saveSettings(values()), true);
  feedback.textContent = "Disabled";
};
$("disable-hotkey").onclick = () => disableShortcut($("hotkey"), $("shortcut-feedback"));
$("disable-marker-hotkey").onclick = () => disableShortcut(markerShortcutInput, markerShortcutFeedback);
$("game-list").onclick = async (e) => {
  if (e.target.dataset.remove != null) {
    state.settings.gameExecutables.splice(Number(e.target.dataset.remove), 1);
    render(await window.clips.saveSettings(values()), true);
  }
};
$("ignored-game-list").onclick = async (e) => {
  if (e.target.dataset.removeIgnored != null) {
    state.settings.ignoredGameExecutables.splice(Number(e.target.dataset.removeIgnored), 1);
    render(await window.clips.saveSettings(values()), true);
  }
};
$("scan").onclick = async () => {
  const list = await window.clips.listProcesses();
  $("process-picker").innerHTML = list
    .map(
      (p) =>
        `<button data-exe="${escapeHtml(p.name)}">${escapeHtml(p.title)} <span class="muted">${escapeHtml(p.path || `${p.name} · protected process`)}</span></button>`,
    )
    .join("");
  $("process-picker").classList.remove("hidden");
};
$("scan-shortcut").onclick = () => {
  navigateToPage("settings");
  document.querySelector('[data-settings-group="general"]').click();
  $("scan").click();
};
$("process-picker").onclick = async (e) => {
  const b = e.target.closest("[data-exe]");
  if (
    b &&
    !state.settings.gameExecutables.some(
      (x) => x.toLowerCase() === b.dataset.exe.toLowerCase(),
    )
  ) {
    state.settings.gameExecutables.push(b.dataset.exe);
    $("process-picker").classList.add("hidden");
    render(await window.clips.saveSettings(values()), true);
  }
};
$("audio-application-list").onclick = async (e) => {
  if (e.target.dataset.removeAudio != null) {
    state.settings.audioExecutables.splice(Number(e.target.dataset.removeAudio), 1);
    render(await window.clips.saveSettings(values()), true);
  }
};
$("scan-audio").onclick = async () => {
  const list = await window.clips.listProcesses();
  $("audio-process-picker").innerHTML = list
    .map(
      (p) =>
        `<button data-audio-exe="${escapeHtml(p.name)}">${escapeHtml(p.title)} <span class="muted">${escapeHtml(p.path || `${p.name} · protected process`)}</span></button>`,
    )
    .join("");
  $("audio-process-picker").classList.remove("hidden");
};
$("audio-process-picker").onclick = async (e) => {
  const b = e.target.closest("[data-audio-exe]");
  if (
    b &&
    !state.settings.audioExecutables.some(
      (x) => x.toLowerCase() === b.dataset.audioExe.toLowerCase(),
    )
  ) {
    state.settings.audioExecutables.push(b.dataset.audioExe);
    $("audio-process-picker").classList.add("hidden");
    render(await window.clips.saveSettings(values()), true);
  }
};
$("browse").onclick = async () => {
  const f = await window.clips.chooseFolder();
  if (f) {
    $("folder").value = f;
    render(await window.clips.saveSettings(values()), true);
  }
};
const updateMicrophoneVolumeLabel = () => {
  $("microphone-volume-value").textContent = `${$("microphone-volume").value}%`;
};
$("microphone-volume").addEventListener("input", () => {
  updateMicrophoneVolumeLabel();
});
$("microphone-test").onclick = async () => {
  const button = $("microphone-test");
  if ($("microphone").value === "disabled") { button.textContent = "Choose a microphone"; setTimeout(() => { button.textContent = "Test microphone"; }, 1800); return; }
  let stream;
  try {
    button.disabled = true; button.textContent = "Recording 5…";
    const devices = await navigator.mediaDevices.enumerateDevices();
    const wantedLabel = $("microphone").selectedOptions[0]?.textContent?.toLowerCase() || "";
    const device = devices.find(item => item.kind === "audioinput" && wantedLabel.includes(item.label.toLowerCase()));
    stream = await navigator.mediaDevices.getUserMedia({ audio: device ? { deviceId: { exact: device.deviceId } } : true });
    const chunks = []; const recorder = new MediaRecorder(stream);
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    const stopped = new Promise(resolve => { recorder.onstop = resolve; }); recorder.start();
    for (let remaining = 5; remaining > 0; remaining--) { button.textContent = `Recording ${remaining}…`; await new Promise(resolve => setTimeout(resolve, 1000)); }
    recorder.stop(); await stopped; stream.getTracks().forEach(track => track.stop()); stream = null;
    button.textContent = "Playing test…";
    const audio = new Audio(URL.createObjectURL(new Blob(chunks, { type: recorder.mimeType })));
    await audio.play(); await new Promise(resolve => { audio.onended = resolve; audio.onerror = resolve; }); URL.revokeObjectURL(audio.src);
  } catch (error) { alert(`Microphone test failed: ${error.message}`); }
  finally { stream?.getTracks().forEach(track => track.stop()); button.disabled = false; button.textContent = "Test microphone"; }
};
const updateMicrophoneNoiseGate = () => {
  const value = Number($("microphone-noise-gate").value);
  $("microphone-noise-gate-value").textContent = `${value} dB`;
  $("microphone-gate-marker").style.left = `${((value + 60) / 55) * 100}%`;
};
$("microphone-noise-gate").addEventListener("input", updateMicrophoneNoiseGate);
setInterval(async () => {
  if (!state?.obs?.connected || $("microphone").value === "disabled") {
    $("microphone-level-fill").style.width = "0%";
    return;
  }
  try {
    const db = await window.clips.microphoneLevel();
    $("microphone-level-fill").style.width = `${Math.max(0, Math.min(100, ((db + 60) / 60) * 100))}%`;
  } catch {}
}, 100);
function updateStorageVisibility() {
  const byDays = $("cleanup-mode").value === "days";
  $("disk-percent-row").classList.toggle("hidden", byDays);
  $("raw-gigabytes-row").classList.toggle("hidden", byDays);
  $("raw-gigabytes-row").classList.toggle("last-visible", !byDays);
  $("days-row").classList.toggle("hidden", !byDays);
}
$("cleanup-mode").addEventListener("change", updateStorageVisibility);
let autoSaveTimer = null;
let autoSaveInFlight = false;
let autoSaveRequested = false;
const flushAutoSave = async () => {
  if (autoSaveInFlight) {
    autoSaveRequested = true;
    return;
  }
  autoSaveInFlight = true;
  try {
    render(await window.clips.saveSettings(values()));
  } catch (error) {
    console.error("Could not autosave settings", error);
  } finally {
    autoSaveInFlight = false;
    if (autoSaveRequested) {
      autoSaveRequested = false;
      flushAutoSave();
    }
  }
};
const queueAutoSave = (delay = 450) => {
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(flushAutoSave, delay);
};
$("settings").addEventListener("input", (event) => {
  if (event.target.matches("input:not([readonly]), select, textarea")) queueAutoSave();
});
$("settings").addEventListener("change", (event) => {
  const profileControl = event.target.closest("[data-profile]");
  if (profileControl) {
    const game = profileControl.closest("[data-profile-game]").dataset.profileGame;
    const profile = state.settings.gameProfiles[game] ||= {};
    profile[profileControl.dataset.profile] = profileControl.type === "number" || profileControl.dataset.profile === "fps" ? Number(profileControl.value) : profileControl.value;
  }
  if (event.target.matches("input:not([readonly]), select, textarea")) queueAutoSave(0);
});
$("connect").onclick = async () => {
  await window.clips.saveSettings(values());
  render(await window.clips.connect());
};
$("record").onclick = async () => render(await window.clips.toggleRecording());
$("clip").onclick = async () => render(await window.clips.saveClip());
$("library-folder").onclick = () => window.clips.openFolder();
$("archive-folder").onclick = () => window.clips.openLibraryFolder();
$("library-search").oninput = event => {
  libraryQuery = event.currentTarget.value.trim();
  archiveVisibleCount = ARCHIVE_PAGE_SIZE;
  render(state, false, true);
};
$("library-sort").onchange = event => {
  librarySort = event.currentTarget.value;
  archiveVisibleCount = ARCHIVE_PAGE_SIZE;
  render(state, false, true);
};
$("archive-load-more").onclick = () => {
  archiveVisibleCount += ARCHIVE_PAGE_SIZE;
  render(state, false, true);
};
document.addEventListener("dblclick", async event => {
  const title = event.target.closest(".recording-meta strong");
  const card = title?.closest(".recording-card");
  const opener = card?.querySelector("[data-recording-path]");
  if (!opener) return;
  const recording = [...(state.recordings || []), ...(state.archivedRecordings || [])].find(item => item.path === opener.dataset.recordingPath);
  const nextTitle = prompt("Clip title", recording?.title || recording?.name || "");
  if (nextTitle == null) return;
  const tags = prompt("Tags, separated by commas", (recording?.tags || []).join(", "));
  if (tags == null) return;
  render(await window.clips.updateRecordingMetadata(recording.path, { title: nextTitle, tags: tags.split(",") }));
});
$("update-button").onclick = async () => {
  const button = $("update-button");
  button.disabled = true;
  button.classList.add("restarting");
  button.title = "Restarting...";
  await window.clips.installUpdate();
};
$("check-updates").onclick = async () => {
  const button = $("check-updates");
  button.disabled = true;
  $("about-update-status").textContent = "Checking for updates…";
  const started = await window.clips.checkForUpdates();
  if (!started) {
    $("about-update-status").textContent = "Nightly updates are off.";
    button.disabled = false;
  }
};
$("open-logs").onclick = () => window.clips.openLogs();
$("copy-update-diagnostics").onclick = async () => {
  await window.clips.copyUpdateDiagnostics();
  const button = $("copy-update-diagnostics");
  button.textContent = "Copied";
  setTimeout(() => { button.textContent = "Copy diagnostics"; }, 1500);
};
const openRecording = async (event) => {
  const card = event.target.closest("[data-recording-path]");
  if (!card) return;
  await openEmbeddedRecording({
    filePath: card.dataset.recordingPath,
    name: card.dataset.recordingName,
    mode: "view",
  });
};
function returnToViewer() {
  editorMode = "view";
  mixingPath = "";
  $("editor").classList.add("viewer-mode");
  $("editor").classList.remove("editing-mode", "mixer-mode", "trim-mode");
  $("editor").querySelector(".dialog-eyebrow").textContent = "Recording";
  $("editor-title").textContent = "Play recording";
  $("editor-status").textContent = "";
  updateEditorPanes();
  updateTimeline();
  syncMpvBounds();
}
function updateEditorPanes() {
  const mixing = editorMode === "mix";
  const trimming = editorMode === "trim";
  $("inline-mixer").hidden = !mixing;
  $("trim-editor-pane").hidden = !trimming;
  $("choose-volume-mix").classList.toggle("active", mixing);
  $("choose-volume-mix").setAttribute("aria-selected", String(mixing));
  $("choose-trim").classList.toggle("active", trimming);
  $("choose-trim").setAttribute("aria-selected", String(trimming));
}
function enterTrimEditor() {
  editorMode = "trim";
  $("editor").classList.remove("viewer-mode", "mixer-mode");
  $("editor").classList.add("editing-mode", "trim-mode");
  $("editor").querySelector(".dialog-eyebrow").textContent = "Clip editor";
  $("editor-title").textContent = "Edit recording";
  $("editor-status").textContent = "Drag either edge to choose the part you want to keep.";
  $("editor-trim-bitrate").value = state.settings.trimBitrate || "original";
  updateEditorPanes();
  updateTimeline();
  syncMpvBounds();
}
async function enterVolumeMixer() {
  editorMode = "mix";
  mixingPath = editingPath;
  $("editor").classList.remove("viewer-mode", "trim-mode");
  $("editor").classList.add("editing-mode", "mixer-mode");
  $("editor").querySelector(".dialog-eyebrow").textContent = "Clip editor";
  $("editor-title").textContent = "Edit recording";
  updateEditorPanes();
  $("save-mix-copy").disabled = false;
  $("save-mix-replace").disabled = false;
  updateTimeline();
  syncMpvBounds();
  if (mixerLoadedPath === mixingPath && $("mixer-tracks").children.length) {
    queueLiveAudioMix();
    return;
  }
  $("mixer-tracks").innerHTML = '<div class="muted">Reading audio tracks…</div>';
  $("mixer-status").textContent = "";
  try {
    const tracks = await window.clips.getAudioTracks(mixingPath);
    if (!tracks.length) throw new Error("This clip has no audio tracks.");
    const hasCombinedTrack = tracks.length > 1 && tracks[0].kind === "combined";
    const editableTracks = hasCombinedTrack ? tracks.slice(1) : tracks;
    if (hasCombinedTrack) $("mixer-status").textContent = "The Combined playback track will be rebuilt from these sources.";
    $("mixer-tracks").innerHTML = editableTracks.map(track => `<div class="mixer-track"><div><strong>${escapeHtml(track.label.replace(/\.exe$/i, ""))}</strong><small>${escapeHtml(track.codec.toUpperCase())} · Track ${track.index + 1}</small></div><button class="mixer-mute button outline" type="button" aria-pressed="false">Mute</button><input type="range" min="0" max="200" value="100" step="1" data-track-index="${track.index}" aria-label="${escapeHtml(track.label)} volume"><output>100%</output></div>`).join("");
    mixerLoadedPath = mixingPath;
    queueLiveAudioMix();
  } catch (error) {
    mixerLoadedPath = "";
    $("mixer-tracks").innerHTML = "";
    $("mixer-status").textContent = error.message;
    $("save-mix-copy").disabled = true;
    $("save-mix-replace").disabled = true;
  }
}
$("open-editor").onclick = enterVolumeMixer;
$("choose-trim").onclick = enterTrimEditor;
$("choose-volume-mix").onclick = enterVolumeMixer;
$("editor-trim-bitrate").onchange = async () => {
  $("trim-bitrate").value = $("editor-trim-bitrate").value;
  render(await window.clips.saveSettings(values()));
};
function mixerAdjustments() {
  return [...$("mixer-tracks").querySelectorAll('input[type="range"]')]
    .map(input => ({ index: Number(input.dataset.trackIndex), volume: Number(input.value) / 100 }));
}
function queueLiveAudioMix() {
  clearTimeout(liveMixTimer);
  liveMixTimer = setTimeout(() => {
    liveMixTimer = null;
    const adjustments = mixerAdjustments();
    if (!adjustments.length || !$("editor").open) return;
    window.clips.setMpvAudioMix(adjustments).catch(error => {
      $("mixer-status").textContent = error.message;
    });
  }, 40);
}
$("mixer-tracks").addEventListener("input", event => {
  if (!event.target.matches('input[type="range"]')) return;
  event.target.closest(".mixer-track").querySelector("output").textContent = `${event.target.value}%`;
  const mute = event.target.closest(".mixer-track").querySelector(".mixer-mute");
  mute.setAttribute("aria-pressed", String(event.target.value === "0"));
  mute.textContent = event.target.value === "0" ? "Unmute" : "Mute";
  queueLiveAudioMix();
});
$("mixer-tracks").addEventListener("click", event => {
  const mute = event.target.closest(".mixer-mute");
  if (!mute) return;
  const slider = mute.closest(".mixer-track").querySelector('input[type="range"]');
  if (slider.value === "0") slider.value = slider.dataset.previousVolume || "100";
  else { slider.dataset.previousVolume = slider.value; slider.value = "0"; }
  slider.dispatchEvent(new Event("input", { bubbles: true }));
});
async function saveVolumeMix(replace) {
  const buttons = [$("save-mix-copy"), $("save-mix-replace")];
  buttons.forEach(button => { button.disabled = true; });
  $("mixer-progress").classList.remove("hidden");
  $("mixer-progress").querySelector("span").textContent = "Mixing audio…";
  $("mixer-status").textContent = replace ? "Saving changes to the clip…" : "Creating a new mixed clip…";
  try {
    const adjustments = mixerAdjustments();
    const result = await window.clips.mixRecordingAudio(mixingPath, adjustments, replace);
    render(result.state);
    $("mixer-status").textContent = `Saved ${result.outputPath.split(/[\\/]/).pop()}`;
    setTimeout(() => $("editor").close(), 650);
  } catch (error) {
    $("mixer-status").textContent = error.message;
    buttons.forEach(button => { button.disabled = false; });
    $("mixer-progress").classList.add("hidden");
  }
}
$("save-mix-copy").onclick = () => saveVolumeMix(false);
$("save-mix-replace").onclick = () => saveVolumeMix(true);
window.clips.onAudioMixProgress(progress => {
  if (!$("editor").open || editorMode !== "mix") return;
  $("mixer-progress").setAttribute("aria-valuenow", progress.complete ? "100" : "50");
  $("mixer-progress").querySelector("i").style.width = progress.complete ? "100%" : "50%";
  $("mixer-progress").querySelector("span").textContent = progress.complete ? "Finalizing…" : "Mixing audio…";
});
async function openEmbeddedRecording({ filePath, name, mode }) {
  if ($("editor").open) return;
  editorMode = mode;
  editingPath = filePath;
  $("editor").classList.toggle("viewer-mode", mode === "view");
  $("editor").classList.toggle("editing-mode", mode !== "view");
  $("editor").classList.toggle("trim-mode", mode === "trim");
  $("editor").classList.remove("mixer-mode");
  $("editor").querySelector(".dialog-eyebrow").textContent = mode === "view" ? "Recording" : "Clip editor";
  $("editor-title").textContent = mode === "view" ? "Play recording" : "Edit recording";
  $("editor-name").textContent = name;
  updateEditorPanes();
  trimStart = 0;
  trimEnd = 0;
  mpvDuration = 0;
  mpvCurrentTime = 0;
  mpvPaused = true;
  $("viewer-volume").value = "100";
  $("editor-status").textContent = mode === "view"
    ? "Opening in the embedded player…"
    : "Opening the original recording…";
  $("export-trim").disabled = false;
  document.body.classList.add("editor-open");
  $("editor").show();
  try {
    const preview = await window.clips.startMpv(editingPath, mpvStageBounds());
    $("mpv-stage").classList.toggle("browser-playback", !!preview.mediaUrl);
    if (preview.mediaUrl) $("mpv-loading").classList.add("hidden");
    mpvDuration = preview.duration;
    trimEnd = mpvDuration;
    updateTimeline();
    if (mode === "view") {
      $("editor-status").textContent = "";
      await window.clips.pauseMpv(false);
      mpvPaused = false;
      updatePlayhead();
    } else {
      $("editor-status").textContent = "Drag either edge to choose the part you want to keep. The original file is being previewed.";
    }
    clearInterval(mpvPollTimer);
    mpvPollTimer = setInterval(refreshMpvStatus, 150);
  } catch (error) {
    $("editor-status").textContent = error.message;
  }
}
function mpvStageBounds() {
  const rect = $("mpv-stage").getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}
const syncMpvBounds = () => {
  if (editingPath && $("editor").open) window.clips.setMpvBounds(mpvStageBounds());
};
new ResizeObserver(syncMpvBounds).observe($("mpv-stage"));
window.addEventListener("resize", syncMpvBounds);
function updateTimeline() {
  const duration = mpvDuration;
  if (!duration) return;
  const startPercent = trimStart / duration * 100;
  const endPercent = trimEnd / duration * 100;
  $("trim-start").style.left = `${startPercent}%`;
  $("trim-end").style.left = `${endPercent}%`;
  $("trim-selection").style.left = `${startPercent}%`;
  $("trim-selection").style.width = `${endPercent - startPercent}%`;
  if (document.activeElement !== $("trim-start-time")) $("trim-start-time").value = formatTimestamp(trimStart);
  if (document.activeElement !== $("trim-end-time")) $("trim-end-time").value = formatTimestamp(trimEnd);
  $("selection-duration").textContent = editorMode === "trim"
    ? `${shortTimestamp(trimEnd - trimStart)} selected`
    : `${shortTimestamp(duration)} total`;
  updatePlayhead();
}
function updatePlayhead() {
  $("trim-playhead").style.left = `${mpvDuration ? mpvCurrentTime / mpvDuration * 100 : 0}%`;
  $("playhead-time").textContent = shortTimestamp(mpvCurrentTime);
  $("transport-play").innerHTML = mpvPaused ? playerIcons.play : playerIcons.pause;
  $("transport-play").setAttribute("aria-label", mpvPaused ? "Play" : "Pause");
  $("transport-play").title = mpvPaused ? "Play" : "Pause";
}
async function seekMpv(time) {
  mpvCurrentTime = Math.max(0, Math.min(mpvDuration, time));
  updatePlayhead();
  await window.clips.seekMpv(mpvCurrentTime);
}
function setTimeFromPointer(event, handle = "") {
  const timeline = $("trim-timeline");
  const rect = timeline.getBoundingClientRect();
  const duration = mpvDuration;
  if (!duration || !rect.width) return;
  const time = Math.max(0, Math.min(duration, (event.clientX - rect.left) / rect.width * duration));
  const minimum = Math.min(.1, duration / 10);
  if (handle === "start") {
    trimStart = Math.min(time, trimEnd - minimum);
    seekMpv(trimStart);
  } else if (handle === "end") {
    trimEnd = Math.max(time, trimStart + minimum);
    seekMpv(trimEnd);
  } else {
    seekMpv(editorMode === "trim" ? Math.max(trimStart, Math.min(trimEnd, time)) : time);
  }
  updateTimeline();
}
["trim-start", "trim-end"].forEach((id) => {
  $(id).addEventListener("pointerdown", (event) => {
    draggingHandle = id === "trim-start" ? "start" : "end";
    event.currentTarget.setPointerCapture(event.pointerId);
    setTimeFromPointer(event, draggingHandle);
  });
  $(id).addEventListener("pointermove", (event) => {
    if (draggingHandle) setTimeFromPointer(event, draggingHandle);
  });
  $(id).addEventListener("pointerup", () => { draggingHandle = ""; });
});
$("trim-timeline").addEventListener("pointerdown", (event) => {
  if (!event.target.closest(".trim-handle")) {
    draggingPlayhead = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    setTimeFromPointer(event);
  }
});
$("trim-timeline").addEventListener("pointermove", (event) => {
  if (draggingPlayhead) setTimeFromPointer(event);
});
$("trim-timeline").addEventListener("pointerup", () => { draggingPlayhead = false; });
$("trim-timeline").addEventListener("pointercancel", () => { draggingPlayhead = false; });
const togglePlayback = async () => {
  if (editorMode === "trim" && mpvPaused && (mpvCurrentTime < trimStart || mpvCurrentTime >= trimEnd)) await seekMpv(trimStart);
  await window.clips.toggleMpv();
  mpvPaused = !mpvPaused;
  updatePlayhead();
};
$("transport-play").onclick = togglePlayback;
$("viewer-volume").addEventListener("input", event => {
  window.clips.setMpvVolume(Number(event.target.value)).catch(() => {});
});
$("viewer-fullscreen").onclick = async () => {
  const fullscreen = await window.clips.openMpvFullscreen(editingPath);
  if (!fullscreen?.inPage) $("editor").close();
};
function updateFullscreenButton() {
  $("viewer-fullscreen").innerHTML = playerIcons.fullscreen;
  $("viewer-fullscreen").setAttribute("aria-label", "Open in MPV fullscreen");
  $("viewer-fullscreen").title = "Open in MPV fullscreen";
}
updatePlayhead();
updateFullscreenButton();
function applyTypedTime(which) {
  const input = $(which === "start" ? "trim-start-time" : "trim-end-time");
  const time = parseTimestamp(input.value);
  if (!Number.isFinite(time)) {
    input.value = formatTimestamp(which === "start" ? trimStart : trimEnd);
    $("editor-status").textContent = "Use HH:MM:SS, for example 00:01:23.50.";
    return;
  }
  if (which === "start") {
    trimStart = Math.max(0, Math.min(time, trimEnd - .01));
    seekMpv(trimStart);
  } else {
    trimEnd = Math.min(mpvDuration, Math.max(time, trimStart + .01));
    seekMpv(trimEnd);
  }
  input.value = formatTimestamp(which === "start" ? trimStart : trimEnd);
  updateTimeline();
}
["start", "end"].forEach(which => {
  const input = $(which === "start" ? "trim-start-time" : "trim-end-time");
  input.addEventListener("change", () => applyTypedTime(which));
  input.addEventListener("keydown", event => {
    if (event.key === "Enter") { event.preventDefault(); applyTypedTime(which); input.blur(); }
  });
});
async function refreshMpvStatus() {
  try {
    const status = await window.clips.mpvStatus();
    if (!status.running) return;
    mpvDuration = status.duration || mpvDuration;
    mpvCurrentTime = status.currentTime;
    mpvPaused = status.paused;
    if (editorMode === "trim" && !mpvPaused && mpvCurrentTime >= trimEnd) {
      await window.clips.pauseMpv(true);
      mpvPaused = true;
      await seekMpv(trimStart);
    } else {
      updatePlayhead();
    }
  } catch {
    clearInterval(mpvPollTimer);
    mpvPollTimer = null;
  }
}
$("export-trim").onclick = async () => {
  const button = $("export-trim");
  button.disabled = true;
  $("export-progress").classList.remove("hidden");
  $("export-progress").setAttribute("aria-valuenow", "0");
  $("export-progress").querySelector("i").style.width = "0%";
  $("export-progress").querySelector("span").textContent = "Starting...";
  $("editor-status").textContent = "Exporting trimmed clip…";
  try {
    if (!Number.isFinite(trimStart) || !Number.isFinite(trimEnd) || trimEnd <= trimStart) throw new Error("Choose a valid range.");
    const result = await window.clips.trimRecording(editingPath, trimStart, trimEnd, $("editor-trim-bitrate").value);
    render(result.state);
    $("editor-status").textContent = `Saved ${result.outputPath.split(/[\\/]/).pop()}`;
    button.textContent = "Done";
    setTimeout(() => $("editor").close(), 650);
  } catch (error) {
    $("editor-status").textContent = error.message;
    button.disabled = false;
  }
};
window.clips.onTrimProgress(progress => {
  const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
  $("export-progress").setAttribute("aria-valuenow", String(Math.round(percent)));
  $("export-progress").querySelector("i").style.width = `${percent}%`;
  $("export-progress").querySelector("span").textContent = `${Math.round(percent)}% | ${shortTimestamp(progress.seconds)} / ${shortTimestamp(progress.duration)}`;
});
window.clips.onMpvFrame(frame => {
  if (!editingPath || !$("editor").open) return;
  const canvas = $("mpv-canvas");
  if (canvas.width !== frame.width || canvas.height !== frame.height) {
    canvas.width = frame.width;
    canvas.height = frame.height;
  }
  const pixels = new Uint8ClampedArray(frame.pixels);
  canvas.getContext("2d").putImageData(new ImageData(pixels, frame.width, frame.height), 0, 0);
  $("mpv-loading").classList.add("hidden");
});
$("mpv-canvas").addEventListener("click", togglePlayback);
$("browser-video").addEventListener("click", togglePlayback);
const toggleFavorite = async (event) => {
  const button = event.target.closest("[data-favorite-path]");
  if (!button || button.disabled) return;
  button.disabled = true;
  try {
    render(await window.clips.setRecordingFavorite(button.dataset.favoritePath, button.dataset.favorite !== "true"));
  } catch (error) {
    button.disabled = false;
    button.title = error.message;
  }
};
function updateSelectionBar() {
  const count = selectedRecordingPaths.size;
  $("selection-count").textContent = `${count} selected`;
  $("selection-bar").classList.toggle("hidden", !count);
  $("selection-stitch").disabled = count < 2;
}
function toggleRecordingSelection(event) {
  const button = event.target.closest("[data-select-path]");
  if (!button) return;
  const filePath = button.dataset.selectPath;
  if (selectedRecordingPaths.has(filePath)) selectedRecordingPaths.delete(filePath);
  else selectedRecordingPaths.add(filePath);
  document.querySelectorAll("[data-select-path]").forEach(current => {
    if (current.dataset.selectPath !== filePath) return;
    const selected = selectedRecordingPaths.has(filePath);
    current.setAttribute("aria-pressed", String(selected));
    current.title = selected ? "Deselect" : "Select";
    current.closest(".recording-card")?.classList.toggle("selected", selected);
  });
  updateSelectionBar();
}
function requestDelete(filePaths, name = "") {
  pendingDeletePaths = [...new Set(filePaths)];
  if (!pendingDeletePaths.length) return;
  const multiple = pendingDeletePaths.length > 1;
  $("delete-title").textContent = multiple ? `Delete ${pendingDeletePaths.length} recordings?` : "Delete recording?";
  $("delete-detail").textContent = multiple
    ? "These files will be permanently deleted. This cannot be undone."
    : `“${name || pendingDeletePaths[0].split(/[\\/]/).pop()}” will be permanently deleted. This cannot be undone.`;
  $("delete-error").classList.add("hidden");
  $("confirm-delete").disabled = false;
  $("confirm-delete").textContent = multiple ? `Delete ${pendingDeletePaths.length}` : "Delete";
  $("delete-dialog").showModal();
  window.clips.setModalAppearance(true);
}
function requestSingleDelete(event) {
  const button = event.target.closest("[data-delete-path]");
  if (button) requestDelete([button.dataset.deletePath], button.dataset.deleteName);
}
$("selection-clear").onclick = () => {
  selectedRecordingPaths.clear();
  document.querySelectorAll(".recording-card.selected").forEach(card => card.classList.remove("selected"));
  document.querySelectorAll("[data-select-path]").forEach(button => button.setAttribute("aria-pressed", "false"));
  updateSelectionBar();
};
$("selection-delete").onclick = () => requestDelete([...selectedRecordingPaths]);
$("selection-stitch").onclick = async () => {
  const button = $("selection-stitch"); button.disabled = true; button.textContent = "Stitching…";
  try {
    const result = await window.clips.stitchRecordings([...selectedRecordingPaths]);
    selectedRecordingPaths.clear(); render(result.state, false, true); navigateToPage("recent");
  } catch (error) { alert(error.message); }
  finally { button.textContent = "Stitch clips"; updateSelectionBar(); }
};
$("confirm-delete").onclick = async () => {
  const button = $("confirm-delete");
  button.disabled = true;
  button.textContent = "Deleting…";
  try {
    const deleted = [...pendingDeletePaths];
    const nextState = await window.clips.deleteRecordings(deleted);
    deleted.forEach(filePath => {
      selectedRecordingPaths.delete(filePath);
      thumbnailCache.delete(filePath);
    });
    pendingDeletePaths = [];
    $("delete-dialog").close();
    render(nextState);
  } catch (error) {
    $("delete-error").textContent = error.message;
    $("delete-error").classList.remove("hidden");
    button.disabled = false;
    button.textContent = "Delete";
  }
};
$("delete-dialog").addEventListener("close", () => {
  pendingDeletePaths = [];
  window.clips.setModalAppearance(false);
});
let arrowSeekDelay = null;
let arrowSeekInterval = null;
function stopArrowSeeking() {
  clearTimeout(arrowSeekDelay);
  clearInterval(arrowSeekInterval);
  arrowSeekDelay = null;
  arrowSeekInterval = null;
}
function seekByArrow(direction) { seekMpv(mpvCurrentTime + direction * 5).catch(() => {}); }
document.addEventListener("keydown", event => {
  if ($("editor").open && event.code === "Space"
    && !event.target.closest("input, textarea, select, button, [contenteditable]") && !event.repeat) {
    event.preventDefault();
    togglePlayback().catch(() => {});
    return;
  }
  if (!$("editor").open || !["ArrowLeft", "ArrowRight"].includes(event.key)
    || event.target.closest("input, textarea, select") || event.repeat) return;
  event.preventDefault();
  stopArrowSeeking();
  const direction = event.key === "ArrowLeft" ? -1 : 1;
  seekByArrow(direction);
  arrowSeekDelay = setTimeout(() => {
    arrowSeekInterval = setInterval(() => seekByArrow(direction), 160);
  }, 380);
});
document.addEventListener("keyup", event => {
  if (["ArrowLeft", "ArrowRight"].includes(event.key)) stopArrowSeeking();
});
window.addEventListener("blur", stopArrowSeeking);
$("editor").addEventListener("close", () => {
  document.body.classList.remove("editor-open");
  stopArrowSeeking();
  clearTimeout(liveMixTimer);
  liveMixTimer = null;
  clearInterval(mpvPollTimer);
  mpvPollTimer = null;
  window.clips.closeMpv();
  $("export-trim").textContent = "Export trimmed clip";
  $("export-progress").classList.add("hidden");
  $("mpv-loading").classList.remove("hidden");
  $("mpv-stage").classList.remove("browser-playback");
  $("editor").classList.remove("viewer-mode", "editing-mode", "mixer-mode", "trim-mode");
  $("mixer-progress").classList.add("hidden");
  $("mixer-progress").querySelector("i").style.width = "0%";
  $("save-mix-copy").disabled = false;
  $("save-mix-replace").disabled = false;
  editorMode = "trim";
  mixingPath = "";
  mixerLoadedPath = "";
  $("mixer-tracks").innerHTML = "";
  editingPath = "";
});
$("recording-list").onclick = openRecording;
$("replay-list").onclick = openRecording;
document.addEventListener("click", toggleFavorite);
document.addEventListener("click", toggleRecordingSelection);
document.addEventListener("click", requestSingleDelete);
const archiveDays = $("archive-days");
archiveDays.addEventListener("click", openRecording);
$("recent-favorite-list").onclick = openRecording;
$("archive-favorite-list").onclick = openRecording;
window.clips.onState((s) => render(s,
  JSON.stringify(s.settings) !== renderedSettingsJson && !document.activeElement?.closest?.("#settings")
));
window.clips.getState().then((s) => render(s, true));
// Main-process state events keep the UI current. Only recover state after a
// suspended/hidden renderer becomes visible instead of polling while in tray.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') window.clips.getState().then((s) => render(s, true));
});
