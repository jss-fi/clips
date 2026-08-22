const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8');
const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');

test('library organization controls live in Library, not Recent', () => {
  const recent = html.slice(html.indexOf('<section id="recent"'), html.indexOf('<section id="library"'));
  const library = html.slice(html.indexOf('<section id="library"'), html.indexOf('<section id="settings"'));
  assert.doesNotMatch(recent, /id="library-search"|id="library-sort"/);
  assert.match(library, /id="library-search"/);
  assert.match(library, /id="library-sort"/);
});

test('marker is shortcut-only and can be disabled', () => {
  const titlebar = html.slice(html.indexOf('<header class="titlebar">'), html.indexOf('</header>'));
  assert.doesNotMatch(titlebar, /id="marker"/);
  assert.match(html, /id="marker-hotkey" class="shortcut-capture"[^>]*readonly/);
});

test('library sort menu defines readable native option colors', () => {
  assert.match(css, /\.library-tools select option\s*\{[^}]*background:\s*#18181b;[^}]*color:\s*#f4f4f5;/);
});

test('update check stays disabled and explains itself when an update is ready', () => {
  assert.match(renderer, /\["checking", "downloading", "preparing", "ready"\]\.includes\(s\.update\?\.status\)/);
  assert.match(renderer, /ready: "Update ready"/);
});

test('clip and marker shortcuts share capture controls and disable buttons', () => {
  for (const id of ['hotkey', 'marker-hotkey']) assert.match(html, new RegExp(`id="${id}" class="shortcut-capture"[^>]*readonly`));
  assert.match(html, /id="disable-hotkey"/);
  assert.match(html, /id="disable-marker-hotkey"/);
  assert.match(renderer, /beginShortcutCapture\(markerShortcutInput, markerShortcutFeedback\)/);
});

test('non-chronological library sorts stop grouping recordings by day', () => {
  assert.match(renderer, /const chronological = librarySort === "newest" \|\| librarySort === "oldest"/);
  assert.match(renderer, /librarySort === "game" \? \(recording\.game \|\| "Older recordings \(game unknown\)"\)/);
  assert.match(renderer, /: "Largest files"/);
  assert.match(renderer, /!chronological \|\| !archivedFavorites\.length/);
});

test('unchanged recording collections do not rebuild the library DOM', () => {
  assert.match(renderer, /libraryJson !== renderedLibraryJson/);
  assert.match(renderer, /render\(state, false, true\)/);
  assert.match(renderer, /renderedLibraryJson = libraryJson/);
  assert.match(renderer, /recording\.path, recording\.name, recording\.title/);
  assert.match(renderer, /recentDetailElements\.get\(recording\.path\)/);
  assert.doesNotMatch(renderer, /JSON\.stringify\(\[s\.recordings \|\| \[\], s\.archivedRecordings/);
});

test('recording mutations reuse the state snapshot they broadcast', () => {
  assert.match(main, /async function broadcast\(currentState = null, \{ force = false \} = \{\}\)/);
  assert.match(main, /async function setRecordingFavorite[\s\S]*?return broadcast\(null, \{ force: true \}\);/);
  assert.match(main, /async function deleteRecordings[\s\S]*?return broadcast\(null, \{ force: true \}\);/);
  assert.match(main, /async function saveClip[\s\S]*?return broadcast\(null, \{ force: true \}\);/);
  assert.match(main, /async function mixRecordingAction[\s\S]*?state: await broadcast\(null, \{ force: true \}\)/);
  assert.match(main, /ipcMain\.handle\('clip:save', saveClip\)/);
});

test('stitching clears cached selection state with a forced library refresh', () => {
  assert.match(renderer, /selectedRecordingPaths\.clear\(\); render\(result\.state, false, true\);/);
});

test('large archives render in bounded batches with an explicit continuation', () => {
  assert.match(html, /id="archive-load-more"/);
  assert.match(renderer, /const ARCHIVE_PAGE_SIZE = 120/);
  assert.match(renderer, /archiveItems\.slice\(0, archiveVisibleCount\)/);
  assert.match(renderer, /archiveVisibleCount \+= ARCHIVE_PAGE_SIZE/);
  assert.match(css, /\.archive-day\s*\{[^}]*content-visibility:\s*auto/);
});

test('thumbnail loading uses native hints and a bounded renderer cache', () => {
  assert.match(renderer, /loading="lazy" decoding="async"/);
  assert.match(renderer, /const THUMBNAIL_CACHE_LIMIT = 160/);
  assert.match(renderer, /while \(thumbnailCache\.size > THUMBNAIL_CACHE_LIMIT\)/);
  assert.doesNotMatch(renderer, /document\.querySelectorAll\("\.recording-thumbnail\[data-thumbnail-path\]"\)\.forEach\(\(current\)/);
});

test('background broadcasts avoid full library snapshots without a visible client', () => {
  assert.match(main, /function hasVisibleStateConsumer\(\)/);
  assert.match(main, /!force && !hasVisibleStateConsumer\(\)/);
  assert.match(main, /broadcast\(null, \{ force: true \}\)/);
});
