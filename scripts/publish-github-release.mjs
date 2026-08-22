import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = process.argv[2] || packageJson.version;
const repository = process.env.CLIPS_GITHUB_REPOSITORY || 'jssfi/clips';
const tag = `v${version}`;
const artifacts = [
  `jss-clips-update-${version}-x64.exe`,
  `jss-clips-update-${version}-x64.exe.blockmap`,
  `jss-clips-app-${version}-x64.zip`,
  `jss-clips-source-${version}.zip`
];
if (!version.includes('-')) artifacts.push(`jss-clips-setup-${version}-x64.exe`);
function displayVersion(value) {
  const developmentNightly = /^(\d+\.\d+)\.0-nightly\.(?:n0*(\d+)|(\d+))\.[0-9a-f]+$/i.exec(value);
  if (developmentNightly) return `${developmentNightly[1]}-nightly.${developmentNightly[2] || developmentNightly[3]}`;
  const nightly = /^(\d+\.\d+)\.\d+-nightly\.\d+\.([0-9a-f]+)$/i.exec(value);
  if (nightly) return `${nightly[1]}-${nightly[2]}`;
  const stable = /^(\d+\.\d+)\.0$/.exec(value);
  return stable ? stable[1] : value;
}

function credential() {
  if (process.env.GITHUB_TOKEN || process.env.GH_TOKEN) return process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const result = spawnSync('git', ['credential', 'fill'], {
    cwd: root, encoding: 'utf8', input: 'protocol=https\nhost=github.com\n\n', windowsHide: true
  });
  if (result.status !== 0) throw new Error('GitHub authentication is unavailable. Configure GITHUB_TOKEN, GH_TOKEN, or a Git credential for github.com.');
  const password = /^password=(.+)$/m.exec(result.stdout)?.[1]?.trim();
  if (!password) throw new Error('The configured GitHub credential did not provide an access token.');
  return password;
}

const token = credential();
const headers = {
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${token}`,
  'User-Agent': 'jss-clips-local-publisher',
  'X-GitHub-Api-Version': '2022-11-28'
};

async function api(url, options = {}) {
  const response = await fetch(`https://api.github.com${url}`, { ...options, headers: { ...headers, ...options.headers } });
  if (!response.ok && response.status !== 404) throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
  return response;
}

for (const name of artifacts) {
  if (!fs.existsSync(path.join(dist, name))) throw new Error(`Missing release artifact: dist\\${name}`);
}

let tagExists = true;
try { execFileSync('git', ['rev-parse', '--verify', `refs/tags/${tag}`], { cwd: root, stdio: 'ignore' }); }
catch { tagExists = false; }
if (!tagExists) execFileSync('git', ['tag', tag, 'HEAD'], { cwd: root, stdio: 'inherit' });
execFileSync('git', ['push', 'origin', `refs/tags/${tag}`], { cwd: root, stdio: 'inherit' });

let response = await api(`/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`);
let release;
if (response.status === 404) {
  const changelog = JSON.parse(fs.readFileSync(path.join(root, 'src', 'changelog.json'), 'utf8'));
  const entry = changelog.find(item => item.version && version.includes(item.version.replace(/^\d+\.\d+-/, '')) ) || changelog[0];
  response = await api(`/repos/${repository}/releases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tag_name: tag,
      name: `Clips ${entry?.version || displayVersion(version)}`,
      body: [`## ${entry?.title || 'Clips release'}`, '', ...(entry?.changes || []).map(change => `- ${change}`)].join('\n'),
      prerelease: version.includes('-'),
      draft: false
    })
  });
  release = await response.json();
  console.log(`Created GitHub release ${tag}`);
} else {
  release = await response.json();
  console.log(`Using existing GitHub release ${tag}`);
}
const expectedName = `Clips ${displayVersion(version)}`;
if (release.name !== expectedName) {
  const updated = await api(`/repos/${repository}/releases/${release.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: expectedName })
  });
  release = await updated.json();
  console.log(`Named GitHub release ${expectedName}`);
}

const existing = new Map((release.assets || []).map(asset => [asset.name, asset]));
const uploadBase = String(release.upload_url).replace(/\{.*$/, '');
const localHashes = new Map();
async function sha512File(file) {
  if (localHashes.has(file)) return localHashes.get(file);
  const hash = crypto.createHash('sha512');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  const digest = hash.digest('base64');
  localHashes.set(file, digest);
  return digest;
}

async function uploadArtifact(name) {
  const file = path.join(dist, name);
  const size = fs.statSync(file).size;
  const current = existing.get(name);
  if (current) {
    if (Number(current.size) !== size) throw new Error(`GitHub asset ${name} exists with the wrong size.`);
    console.log(`Found existing GitHub asset ${name} (${size} bytes); checksum verification pending.`);
    return current;
  }
  const started = Date.now();
  console.log(`Uploading GitHub asset ${name} (${size} bytes)`);
  const upload = await fetch(`${uploadBase}?name=${encodeURIComponent(name)}`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) },
    body: fs.createReadStream(file, { highWaterMark: 4 * 1024 * 1024 }), duplex: 'half'
  });
  if (!upload.ok) throw new Error(`GitHub upload failed for ${name}: HTTP ${upload.status} ${await upload.text()}`);
  const asset = await upload.json();
  if (Number(asset.size) !== size || asset.state !== 'uploaded') throw new Error(`GitHub did not finish uploading ${name}.`);
  console.log(`Uploaded GitHub asset ${name} (${size} bytes) in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return asset;
}
const publishedAssets = await Promise.all(artifacts.map(uploadArtifact));

async function verifyArtifact(name, asset) {
  const expected = await sha512File(path.join(dist, name));
  const response = await fetch(asset.url, {
    headers: { ...headers, Accept: 'application/octet-stream', 'Accept-Encoding': 'identity' },
    redirect: 'follow',
    signal: AbortSignal.timeout(10 * 60 * 1000)
  });
  if (!response.ok || !response.body) throw new Error(`Could not download GitHub asset ${name} for verification: HTTP ${response.status}`);
  const hash = crypto.createHash('sha512');
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    hash.update(chunk);
  }
  if (size !== fs.statSync(path.join(dist, name)).size) throw new Error(`GitHub asset ${name} changed size during verification.`);
  if (hash.digest('base64') !== expected) throw new Error(`GitHub asset ${name} exists with the wrong checksum.`);
  console.log(`Checksum-verified GitHub asset ${name} (${size} bytes)`);
}

await Promise.all(artifacts.map((name, index) => verifyArtifact(name, publishedAssets[index])));

console.log(`Published and verified https://github.com/${repository}/releases/tag/${tag}`);
