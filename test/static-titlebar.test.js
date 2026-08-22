const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = name => fs.readFileSync(path.join(__dirname, '..', 'src', name), 'utf8');

test('the shared title bar stays visible in settings and above the player', () => {
  const css = source('styles.css');
  const html = source('index.html');
  assert.doesNotMatch(css, /settings-open\s*>\s*\.titlebar\s*\{\s*display:\s*none/);
  assert.doesNotMatch(html, /class="settings-titlebar"/);
  assert.match(css, /\.titlebar\s*\{[\s\S]*?z-index:\s*60/);
  assert.match(css, /#editor\s*\{[\s\S]*?inset:\s*calc\(var\(--topbar-height\)/);
});

test('the clip player uses a non-modal overlay so title-bar actions remain usable', () => {
  const renderer = source('renderer.js');
  assert.match(renderer, /\$\("editor"\)\.show\(\)/);
  assert.doesNotMatch(renderer, /\$\("editor"\)\.showModal\(\)/);
});

test('the update Worker routes prerelease restart packages', () => {
  const worker = fs.readFileSync(path.join(__dirname, '..', 'clips-worker', 'src', 'updates.ts'), 'utf8');
  assert.equal(worker.includes('jss-clips-app-\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?-x64\\.zip'), true);
});

test('the About page presents updates first and privacy before release history', () => {
  const html = source('index.html');
  const about = html.slice(html.indexOf('id="settings-about"'), html.indexOf('</main>'));
  assert.ok(about.indexOf('<h2>App &amp; updates</h2>') < about.indexOf('id="about-privacy"'));
  assert.ok(about.indexOf('id="about-privacy"') < about.indexOf('id="changelog"'));
  assert.match(about, /Recordings stay on this computer/);
});

test('secondary instances cannot initialize or overwrite the shared runtime', () => {
  const main = source('main.js');
  assert.match(main, /app\.whenReady\(\)\.then\(async \(\) => \{\s*if \(!gotSingleInstanceLock\) return;/);
});
