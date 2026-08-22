import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [distArgument, channel = 'nightly', versionArgument] = process.argv.slice(2);
const root = path.resolve(import.meta.dirname, '..');
const dist = path.resolve(distArgument || path.join(root, 'dist'));
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = versionArgument || packageJson.version;
const publicBase = String(process.env.CLIPS_PUBLIC_UPDATE_URL || 'https://cdn.clips.jss.fi').replace(/\/$/, '');
const channels = channel === 'both' ? ['nightly', 'stable'] : [channel];
const artifactNames = [
  `jss-clips-update-${version}-x64.exe`,
  `jss-clips-update-${version}-x64.exe.blockmap`,
  `jss-clips-app-${version}-x64.zip`,
  `jss-clips-source-${version}.zip`
];
if (!version.includes('-')) artifactNames.push(`jss-clips-setup-${version}-x64.exe`);

function channelUrl(releaseChannel, name) {
  const prefix = releaseChannel === 'stable' ? 'stable/' : '';
  return `${publicBase}/${prefix}${encodeURIComponent(name)}`;
}

async function fetchWithRetry(url, options = {}) {
  let lastError;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000), ...options });
      if (response.ok) return response;
      lastError = new Error(`HTTP ${response.status} ${response.statusText}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < 6) await new Promise(resolve => setTimeout(resolve, attempt * 2000));
  }
  throw new Error(`Public release request failed for ${url}: ${lastError?.message || lastError}`);
}

function ymlArtifact(metadata) {
  const url = /^\s*(?:-\s*)?url:\s*([^\r\n]+)\s*$/m.exec(metadata)?.[1]?.trim();
  const sha512 = /^sha512:\s*([^\r\n]+)\s*$/m.exec(metadata)?.[1]?.trim();
  const size = Number(/^\s*size:\s*(\d+)\s*$/m.exec(metadata)?.[1]);
  if (!url || !sha512 || !Number.isSafeInteger(size) || size <= 0) {
    throw new Error('latest.yml does not contain a complete primary artifact entry.');
  }
  return { url, sha512, size };
}

async function verifyBody(response, expected) {
  const hash = crypto.createHash('sha512');
  let size = 0;
  if (!response.body) throw new Error(`Public artifact has no body: ${response.url}`);
  for await (const chunk of response.body) {
    size += chunk.length;
    hash.update(chunk);
  }
  if (size !== expected.size) throw new Error(`Public artifact size mismatch for ${expected.url}: ${size} != ${expected.size}`);
  const actualHash = hash.digest('base64');
  if (actualHash !== expected.sha512) throw new Error(`Public artifact checksum mismatch for ${expected.url}.`);
}

for (const releaseChannel of channels) {
  const metadata = new Map();
  for (const name of ['latest.yml', 'latest.json']) {
    const local = fs.readFileSync(path.join(dist, name));
    const separator = channelUrl(releaseChannel, name).includes('?') ? '&' : '?';
    const response = await fetchWithRetry(`${channelUrl(releaseChannel, name)}${separator}verify=${Date.now()}`, {
      headers: { 'Cache-Control': 'no-cache' }
    });
    const live = Buffer.from(await response.arrayBuffer());
    if (!live.equals(local)) throw new Error(`Public ${releaseChannel} ${name} does not match the published release.`);
    metadata.set(name, live.toString('utf8'));
  }

  const staged = JSON.parse(metadata.get('latest.json'));
  const referenced = [
    { url: staged.url, sha512: staged.sha512, size: Number(staged.size) },
    ymlArtifact(metadata.get('latest.yml'))
  ];
  await Promise.all(referenced.map(async expected => {
    if (!artifactNames.includes(expected.url)) throw new Error(`Public metadata references an unexpected artifact: ${expected.url}`);
    const response = await fetchWithRetry(channelUrl(releaseChannel, expected.url), {
      headers: { 'Accept-Encoding': 'identity', Range: `bytes=0-${expected.size - 1}` }
    });
    if (response.status !== 200 && response.status !== 206) throw new Error(`Unexpected response for ${expected.url}: HTTP ${response.status}`);
    await verifyBody(response, expected);
    console.log(`Verified public ${releaseChannel} artifact ${expected.url}`);
  }));

  await Promise.all(artifactNames.map(async name => {
    const localSize = fs.statSync(path.join(dist, name)).size;
    const response = await fetchWithRetry(channelUrl(releaseChannel, name), { method: 'HEAD' });
    const publicSize = Number(response.headers.get('content-length'));
    if (publicSize !== localSize) throw new Error(`Public artifact size mismatch for ${name}: ${publicSize} != ${localSize}`);
  }));
  console.log(`Verified public ${releaseChannel} metadata and all ${artifactNames.length} release artifacts.`);
}
