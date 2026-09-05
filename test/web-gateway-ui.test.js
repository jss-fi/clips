const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('experimental desktop-window setting makes the browser UI discoverable', () => {
  const html = source('src/index.html');
  const renderer = source('src/renderer.js');
  assert.match(html, /id="desktop-window"[^>]*name="desktopWindow"/);
  assert.match(html, /Turn this off to use Clips in your browser/);
  assert.match(renderer, /desktopWindow: \$\("desktop-window"\)\.checked/);
});

test('settings expose detected encoders and submit the selected encoder', () => {
  const html = source('src/index.html');
  const renderer = source('src/renderer.js');
  const main = source('src/main.js');
  const host = source('native/capture-host.cpp');
  assert.match(html, /id="encoder"[^>]*name="obsEncoder"/);
  assert.match(renderer, /obsEncoder: \$\("encoder"\)\.value/);
  assert.match(renderer, /renderEncoders\(s\.availableEncoders, s\.settings\.obsEncoder, s\.selectedEncoder\)/);
  assert.match(main, /await detectAvailableEncoders\(\)/);
  assert.match(host, /obs_video_encoder_create\(selected_video_encoder_\.c_str\(\)/);
});

test('local browser UI connects only to the restricted loopback gateway', () => {
  const web = source('clips-worker/src/web.js');
  assert.match(web, /http:\/\/127\.0\.0\.1:\$\{gatewayPort\}\/v1/);
  assert.match(web, /targetAddressSpace: 'local'/);
  assert.doesNotMatch(web, /demoState|Browser demo|demo:\/\//);
  assert.match(web, /if \(!gatewayConnected\) await pairGateway\(\)/);
});

test('shared player supports browser video without removing native canvas playback', () => {
  const html = source('src/index.html');
  const renderer = source('src/renderer.js');
  assert.match(html, /id="mpv-canvas"/);
  assert.match(html, /id="browser-video"/);
  assert.match(renderer, /classList\.toggle\("browser-playback", !!preview\.mediaUrl\)/);
  assert.match(html, /id="mpv-loading"[^>]*>[\s\S]*?<i aria-hidden="true"><\/i>/);
  assert.match(renderer, /if \(!fullscreen\?\.inPage\) \$\("editor"\)\.close\(\)/);
});

test('browser fullscreen keeps the current clip and exposes native controls', () => {
  const web = source('clips-worker/src/web.js');
  assert.match(web, /video\.controls = true/);
  assert.match(web, /await video\.requestFullscreen\(\)/);
  assert.match(web, /return \{ inPage: true \}/);
  assert.match(web, /addEventListener\('fullscreenchange'/);
});

test('browser media disconnects handle normal broken pipes', () => {
  const mediaServer = source('src/media-server.js');
  assert.match(mediaServer, /pipeline\(ffmpeg\.stdout, response/);
  assert.match(mediaServer, /'EPIPE', 'ECONNRESET', 'ERR_STREAM_PREMATURE_CLOSE'/);
  assert.match(mediaServer, /request\.on\('aborted', stopStream\)/);
});

test('live settings synchronization does not rediscover microphones on every render', () => {
  const renderer = source('src/renderer.js');
  const renderBody = renderer.slice(renderer.indexOf('function render(s, fill = false)'), renderer.indexOf('function renderChangelog'));
  assert.doesNotMatch(renderBody, /refreshMicrophones/);
  assert.match(renderer, /JSON\.stringify\(s\.settings\) !== renderedSettingsJson/);
});

test('release history follows the nightly update preference', () => {
  const renderer = source('src/renderer.js');
  const css = source('src/styles.css');
  assert.match(renderer, /renderChangelog\(s\.app\?\.changelog \|\| \[\], !!s\.settings\?\.nightlyUpdates\)/);
  assert.match(renderer, /nightlyUpdates \? releases : releases\.filter\(release => !isNightlyRelease\(release\)\)/);
  assert.match(renderer, /if \(nightlyUpdates && !isNightlyRelease\(release\)\)/);
  assert.match(renderer, /recap\.textContent = "Recap"/);
  assert.match(css, /\.changelog-heading \.changelog-tag/);
});

test('saved microphone selection is restored before asynchronous device discovery', () => {
  const renderer = source('src/renderer.js');
  assert.match(renderer, /restoreMicrophoneSelection\(s\.settings\.microphoneDeviceId\)/);
  assert.match(renderer, /Saved microphone \(loading…\)/);
  assert.doesNotMatch(renderer, /catch \{\s*select\.disabled = true/);
});

test('opening the browser UI reuses a connected tab', () => {
  const main = source('src/main.js');
  const web = source('clips-worker/src/web.js');
  assert.match(main, /gateway\?\.hasEventClients\(\)/);
  assert.match(main, /gateway\.emit\('activate-ui'/);
  assert.match(main, /await focusConnectedBrowserTab\(\)/);
  assert.match(main, /ControlType\]::TabItem/);
  assert.match(main, /SelectionItemPattern\]::Pattern/);
  assert.match(main, /SetForegroundWindow/);
  assert.doesNotMatch(main, /SendKeys\('\^\+a'\)/);
  assert.doesNotMatch(main, /method = 'tab-search'/);
  assert.match(web, /addEventListener\('activate-ui'/);
  assert.match(web, /window\.focus\(\)/);
  assert.match(main, /browser-gateway\.json/);
  assert.match(main, /attempt < 5/);
  assert.match(web, /setTimeout\(reconnectGateway, 500\)/);
  assert.match(web, /uiVersion=\$\{uiVersion\}/);
  assert.match(main, /onStaleUi: refreshStaleBrowserUi/);
  assert.match(main, /SendKeys\('\^r'\)/);
  assert.match(web, /await pairGateway\(\)/);
});

test('capture health diagnostics only show an overlay when the health policy requests it', () => {
  const main = source('src/main.js');
  assert.match(main, /captureHealth\.inspect\(status/);
  assert.match(main, /logger.warn\('capture frame drops detected', \{ renderingLag, encoderDrops, warning \}\);\s*if \(!warning\) return;/);
});
