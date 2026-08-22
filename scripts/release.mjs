import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const { loadProjectEnv, required } = require('./env.js');
const { verifyMetadata, verifyPackageMetadata } = require('./update-signature.js');
const metadataFiles = ['package-lock.json', 'package.json', 'src/changelog.json'];

export function parseReleaseSpec(value) {
  const match = /^(\d+)\.(\d+)(-nightly)?$/.exec(String(value || '').trim());
  if (!match) throw new Error('Release version must look like 0.7-nightly or 0.7.');
  const base = `${Number(match[1])}.${Number(match[2])}`;
  return { base, channel: match[3] ? 'nightly' : 'stable' };
}

export function nextDevelopmentLine(version) {
  const match = /^(\d+)\.(\d+)$/.exec(String(version || ''));
  if (!match) throw new Error(`Invalid stable version in changelog: ${version}`);
  return `${Number(match[1])}.${Number(match[2]) + 1}`;
}

export function parseWorktrees(text) {
  return String(text).trim().split(/\r?\n\r?\n/).filter(Boolean).map(block => {
    const result = {};
    for (const line of block.split(/\r?\n/)) {
      const separator = line.indexOf(' ');
      if (separator === -1) result[line] = true;
      else result[line.slice(0, separator)] = line.slice(separator + 1);
    }
    return result;
  });
}

export function requiresFreshRuntime(files) {
  const patterns = [
    /^native\//,
    /^src\/runtime-abi\.json$/,
    /^electron-builder\.bootstrap\.json$/,
    /^scripts\/(?:install-prerequisites|stage-(?:obs|libobs|ffmpeg|mpv))\.ps1$/,
    /^scripts\/build-(?:capture|mpv)-host\.cmd$/,
    /^package(?:-lock)?\.json$/
  ];
  return files.some(file => patterns.some(pattern => pattern.test(String(file).replaceAll('\\', '/'))));
}

export function releaseBuildScripts(spec, fresh) {
  const scripts = [];
  if (fresh) scripts.push('dist:fresh');
  else if (spec.channel === 'stable') scripts.push('dist:bootstrap');
  scripts.push('dist:release');
  return scripts;
}

export function shouldReusePreparedArtifacts({ prepared, reusable, forceFresh, version }) {
  if (prepared && reusable && forceFresh) {
    throw new Error(`Cannot apply --fresh to prepared release ${version}: its checksum-verified artifacts may already be uploaded. Rerun without --fresh to publish the recorded artifacts, or prepare a new release/version for a fresh runtime build.`);
  }
  return prepared && reusable;
}

export function releaseArtifactNames(version) {
  const names = [
    `jss-clips-update-${version}-x64.exe`,
    `jss-clips-update-${version}-x64.exe.blockmap`,
    `jss-clips-app-${version}-x64.zip`,
    `jss-clips-source-${version}.zip`
  ];
  if (!version.includes('-')) names.push(`jss-clips-setup-${version}-x64.exe`);
  return names;
}

async function sha512File(file) {
  const hash = crypto.createHash('sha512');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('base64');
}

function ymlPrimaryArtifact(metadata) {
  const version = /^version:\s*([^\r\n]+)\s*$/m.exec(metadata)?.[1]?.trim();
  const url = /^\s*(?:-\s*)?url:\s*([^\r\n]+)\s*$/m.exec(metadata)?.[1]?.trim();
  const sha512 = /^sha512:\s*([^\r\n]+)\s*$/m.exec(metadata)?.[1]?.trim();
  const size = Number(/^\s*size:\s*(\d+)\s*$/m.exec(metadata)?.[1]);
  if (!version || !url || !sha512 || !Number.isSafeInteger(size) || size <= 0) {
    throw new Error('dist/latest.yml does not contain a complete primary artifact entry.');
  }
  return { version, url, sha512, size };
}

export async function validateReleaseArtifacts(dist, version, publicKey) {
  const artifactNames = releaseArtifactNames(version);
  for (const name of [...artifactNames, 'latest.yml', 'latest.json']) {
    if (!fs.existsSync(path.join(dist, name))) throw new Error(`Missing release artifact: dist/${name}`);
  }

  const staged = JSON.parse(fs.readFileSync(path.join(dist, 'latest.json'), 'utf8'));
  const appName = `jss-clips-app-${version}-x64.zip`;
  const appPath = path.join(dist, appName);
  if (staged.version !== version || staged.url !== appName
      || Number(staged.size) !== fs.statSync(appPath).size
      || staged.sha512 !== await sha512File(appPath)) {
    throw new Error(`dist/latest.json does not match ${appName}.`);
  }
  if (!verifyMetadata(staged, publicKey) || !verifyPackageMetadata(staged, publicKey)) {
    throw new Error('dist/latest.json does not have valid release signatures.');
  }

  const installerName = `jss-clips-update-${version}-x64.exe`;
  const installerPath = path.join(dist, installerName);
  const installer = ymlPrimaryArtifact(fs.readFileSync(path.join(dist, 'latest.yml'), 'utf8'));
  if (installer.version !== version || installer.url !== installerName
      || installer.size !== fs.statSync(installerPath).size
      || installer.sha512 !== await sha512File(installerPath)) {
    throw new Error(`dist/latest.yml does not match ${installerName}.`);
  }
  return [...artifactNames, 'latest.yml', 'latest.json'];
}

export async function writeReleaseManifest({ dist, manifestPath, version, commit, publicKey }) {
  const names = await validateReleaseArtifacts(dist, version, publicKey);
  const files = {};
  for (const name of names) {
    const file = path.join(dist, name);
    files[name] = { size: fs.statSync(file).size, sha512: await sha512File(file) };
  }
  const manifest = { schemaVersion: 1, version, commit, files };
  const temporary = `${manifestPath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.rmSync(manifestPath, { force: true });
  fs.renameSync(temporary, manifestPath);
  return manifest;
}

export async function canReuseReleaseManifest({ dist, manifestPath, version, commit, publicKey }) {
  if (!fs.existsSync(manifestPath)) return false;
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch { throw new Error(`Release artifact manifest is unreadable: ${manifestPath}`); }
  if (manifest.version !== version) return false;
  if (manifest.schemaVersion !== 1 || manifest.commit !== commit) {
    throw new Error(`Release artifact manifest for ${version} does not match the prepared release commit.`);
  }
  const names = await validateReleaseArtifacts(dist, version, publicKey);
  if (JSON.stringify(Object.keys(manifest.files || {}).sort()) !== JSON.stringify([...names].sort())) {
    throw new Error(`Release artifact manifest for ${version} has an unexpected file set.`);
  }
  for (const name of names) {
    const file = path.join(dist, name);
    const expected = manifest.files[name];
    if (expected.size !== fs.statSync(file).size || expected.sha512 !== await sha512File(file)) {
      throw new Error(`Prepared release artifact changed after it was built: dist/${name}`);
    }
  }
  return true;
}

export function withFileRollback(files, action, rollbackIndex = () => {}) {
  const snapshots = files.map(file => ({ file, contents: fs.readFileSync(file) }));
  try {
    return action();
  } catch (error) {
    let rollbackError;
    try { rollbackIndex(); } catch (failure) { rollbackError = failure; }
    for (const snapshot of snapshots) fs.writeFileSync(snapshot.file, snapshot.contents);
    if (rollbackError) error.message += ` Metadata index rollback also failed: ${rollbackError.message}`;
    throw error;
  }
}

export function commandInvocation(name, args, options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  if (platform === 'win32' && name === 'npm') {
    const npmCli = String(env.npm_execpath || '').trim();
    if (!npmCli) throw new Error('npm_execpath is unavailable; start the release with npm run release.');
    return { command: process.execPath, args: [npmCli, ...args] };
  }
  return { command: name, args };
}

function run(command, args, label, options = {}) {
  if (!options.quiet) console.log(`[release] ${label}`);
  const capture = Boolean(options.capture);
  const env = options.env || process.env;
  const invocation = commandInvocation(command, args, { env });
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: root,
    env,
    input: options.input,
    encoding: capture ? 'utf8' : undefined,
    stdio: capture ? ['pipe', 'pipe', 'pipe'] : 'inherit',
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = capture ? String(result.stderr || result.stdout || '').trim() : '';
    throw new Error(`${label} failed with exit code ${result.status}${detail ? `: ${detail}` : ''}`);
  }
  return capture ? String(result.stdout || '').trim() : '';
}

function git(args) {
  return run('git', args, `git ${args.join(' ')}`, { capture: true, quiet: true });
}

function samePath(left, right) {
  const normalize = value => path.resolve(value).replaceAll('\\', '/').replace(/\/$/, '').toLowerCase();
  return normalize(left) === normalize(right);
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

function writeJson(relativePath, value) {
  fs.writeFileSync(path.join(root, relativePath), `${JSON.stringify(value, null, 2)}\n`);
}

function assertReleaseWorktree() {
  const branch = git(['branch', '--show-current']);
  const worktrees = parseWorktrees(git(['worktree', 'list', '--porcelain']));
  const primary = worktrees[0]?.worktree;
  if (branch !== 'main' || !primary || !samePath(root, primary)) {
    throw new Error(`Releases are allowed only from the primary main worktree (${primary || 'not found'}). Current branch: ${branch || 'detached HEAD'}.`);
  }
  if (git(['status', '--porcelain'])) {
    throw new Error('Commit the source changes and the "next" changelog entry before releasing. The worktree must be clean.');
  }
}

function previousStable(changelog, requestedBase) {
  const stable = changelog.find(entry => /^\d+\.\d+$/.test(String(entry.version || '')) && entry.version !== requestedBase);
  if (!stable) throw new Error('Could not determine the previous stable release from src/changelog.json.');
  return stable.version;
}

function releaseState(spec, packageVersion, changelog) {
  if (!String(changelog[0]?.title || '').trim()
      || !Array.isArray(changelog[0]?.changes)
      || !changelog[0].changes.length
      || changelog[0].changes.some(change => !String(change).trim())) {
    throw new Error('The first changelog entry must have a user-facing title and at least one change.');
  }
  const entryVersion = String(changelog[0]?.version || '');
  const pending = entryVersion === 'next';
  const prepared = spec.channel === 'nightly'
    ? new RegExp(`^${spec.base.replace('.', '\\.')}\\.0-nightly\\.n\\d{6}\\.[0-9a-f]{8}$`, 'i').test(packageVersion)
      && new RegExp(`^${spec.base.replace('.', '\\.')}\\-nightly\\.\\d+$`).test(entryVersion)
    : packageVersion === `${spec.base}.0` && entryVersion === spec.base;
  if (!pending && !prepared) {
    throw new Error(`The first changelog entry must be "next", or the repository must already be prepared for ${spec.base}${spec.channel === 'nightly' ? '-nightly' : ''}.`);
  }
  return prepared ? 'prepared' : 'pending';
}

function validateReleaseLine(spec, changelog) {
  const prior = previousStable(changelog, spec.base);
  const expected = nextDevelopmentLine(prior);
  if (spec.base !== expected) {
    throw new Error(`The latest stable is ${prior}, so the next release line must be ${expected}, not ${spec.base}.`);
  }
}

function preflightCredentials() {
  const env = loadProjectEnv(root);
  required(env, ['CLIPS_UPDATE_BUCKET', 'CLIPS_R2_ACCOUNT_ID', 'CLIPS_R2_ACCESS_KEY_ID', 'CLIPS_R2_SECRET_ACCESS_KEY']);
  if (!String(env.CLIPS_UPDATE_URL || env.CLIPS_BASE_URL || '').trim()) {
    throw new Error('A production CLIPS_UPDATE_URL or CLIPS_BASE_URL is required for release builds.');
  }
  const signingKey = path.resolve(root, env.CLIPS_UPDATE_SIGNING_KEY || '.clips-private/update-signing-private.pem');
  if (!fs.existsSync(signingKey)) throw new Error(`Update signing key not found: ${signingKey}`);
  if (!env.GITHUB_TOKEN && !env.GH_TOKEN) {
    const credential = spawnSync('git', ['credential', 'fill'], {
      cwd: root,
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true
    });
    if (credential.status !== 0 || !/^password=.+$/m.test(String(credential.stdout || ''))) {
      throw new Error('GitHub authentication is unavailable. Configure GITHUB_TOKEN, GH_TOKEN, or a Git credential for github.com.');
    }
  }
  return env;
}

function changedFilesForSource(sourceRef) {
  let previousTag;
  try {
    previousTag = git(['describe', '--tags', '--abbrev=0', '--match', 'v*', sourceRef]);
  } catch {
    console.warn('[release] No earlier release tag was found; using a fresh runtime build.');
    return { files: [], fresh: true, previousTag: null };
  }
  const output = git(['diff', '--name-only', `${previousTag}..${sourceRef}`, '--']);
  const files = output ? output.split(/\r?\n/).filter(Boolean) : [];
  return { files, fresh: requiresFreshRuntime(files), previousTag };
}

function preparedSourceRef(spec, packageVersion) {
  if (spec.channel === 'nightly') {
    const hash = /\.([0-9a-f]{8})$/i.exec(packageVersion)?.[1];
    if (!hash) throw new Error(`Could not recover the source commit from nightly version ${packageVersion}.`);
    return git(['rev-parse', '--verify', `${hash}^{commit}`]);
  }
  const changed = git(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']).split(/\r?\n/).filter(Boolean).sort();
  if (JSON.stringify(changed) !== JSON.stringify(metadataFiles)) {
    throw new Error('The prepared stable release commit is not a release-metadata-only commit, so its source snapshot cannot be identified safely.');
  }
  return git(['rev-parse', 'HEAD^']);
}

function prepareStableVersion(spec) {
  const packageJson = readJson('package.json');
  const packageLock = readJson('package-lock.json');
  const changelog = readJson('src/changelog.json');
  packageJson.version = `${spec.base}.0`;
  packageLock.version = packageJson.version;
  if (!packageLock.packages?.['']) throw new Error('package-lock.json does not contain the root package metadata.');
  packageLock.packages[''].version = packageJson.version;
  changelog[0].version = spec.base;
  writeJson('package.json', packageJson);
  writeJson('package-lock.json', packageLock);
  writeJson('src/changelog.json', changelog);
}

function assertMetadataChanges() {
  const changed = git(['status', '--porcelain']).split(/\r?\n/).filter(Boolean)
    .map(line => line.slice(3).replaceAll('\\', '/')).sort();
  const expected = ['package-lock.json', 'package.json', 'src/changelog.json'];
  if (JSON.stringify(changed) !== JSON.stringify(expected)) {
    throw new Error(`Versioning changed unexpected files: ${changed.join(', ') || 'none'}.`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: npm run release -- <major.minor-nightly|major.minor> [--fresh]');
    console.log('Examples: npm run release -- 0.7-nightly   npm run release -- 0.7');
    return;
  }
  const unknown = args.filter(value => value.startsWith('-') && value !== '--fresh');
  if (unknown.length) throw new Error(`Unknown release option: ${unknown.join(', ')}`);
  const spec = parseReleaseSpec(args.find(value => !value.startsWith('-')));
  if (process.platform !== 'win32') throw new Error('Clips releases must be built on Windows.');

  console.log(`[release] Preparing ${spec.channel} release ${spec.base}${spec.channel === 'nightly' ? '-nightly' : ''}.`);
  assertReleaseWorktree();
  let packageJson = readJson('package.json');
  const changelog = readJson('src/changelog.json');
  const state = releaseState(spec, packageJson.version, changelog);
  validateReleaseLine(spec, changelog);
  const sourceRef = state === 'prepared' ? preparedSourceRef(spec, packageJson.version) : git(['rev-parse', 'HEAD']);
  const build = changedFilesForSource(sourceRef);
  const forceFresh = args.includes('--fresh');
  const fresh = forceFresh || build.fresh;
  const env = preflightCredentials();

  console.log(`[release] Source snapshot ${sourceRef.slice(0, 8)}; comparing with ${build.previousTag || 'no prior tag'}.`);
  console.log(`[release] Build mode: ${fresh ? 'fresh runtime + release' : 'ordinary release'}.`);
  run('npm', ['run', 'check'], 'Running repository checks');

  if (state === 'pending') {
    const metadataPaths = metadataFiles.map(file => path.join(root, file));
    withFileRollback(metadataPaths, () => {
      if (spec.channel === 'nightly') run('npm', ['run', 'version:nightly', '--', spec.base], 'Generating nightly metadata');
      else prepareStableVersion(spec);
      assertMetadataChanges();
      const displayVersion = readJson('src/changelog.json')[0].version;
      git(['add', '--', ...metadataFiles]);
      run('git', ['commit', '-m', `Version ${spec.channel} ${displayVersion}`], `Committing ${displayVersion} release metadata`);
    }, () => git(['restore', '--staged', '--', ...metadataFiles]));
  } else {
    console.log('[release] Release metadata already exists; resuming from the committed release snapshot.');
  }

  packageJson = readJson('package.json');
  const releaseCommit = git(['rev-parse', 'HEAD']);
  const dist = path.join(root, 'dist');
  const manifestPath = path.join(root, '.clips-release.json');
  const publicKey = fs.readFileSync(path.join(root, 'src', 'update-signing-public.pem'));
  const reusableArtifacts = state === 'prepared' && await canReuseReleaseManifest({
    dist, manifestPath, version: packageJson.version, commit: releaseCommit, publicKey
  });
  const reuseArtifacts = shouldReusePreparedArtifacts({
    prepared: state === 'prepared',
    reusable: reusableArtifacts,
    forceFresh,
    version: packageJson.version
  });
  const buildInfoPath = path.join(root, 'src', 'build-info.json');
  const originalBuildInfo = fs.readFileSync(buildInfoPath);
  try {
    if (reuseArtifacts) {
      console.log('[release] Reusing checksum-verified artifacts from the prepared release; no rebuild is needed.');
    } else {
      for (const script of releaseBuildScripts(spec, fresh)) {
        const label = script === 'dist:fresh'
          ? 'Building fresh media runtime and bootstrap installer'
          : script === 'dist:bootstrap'
            ? 'Building stable bootstrap installer'
            : 'Building and compatibility-testing release artifacts';
        run('npm', ['run', script], label, { env });
      }
      await writeReleaseManifest({
        dist, manifestPath, version: packageJson.version, commit: releaseCommit, publicKey
      });
      console.log('[release] Recorded checksums for resumable publication.');
    }
    run('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'clips-worker/scripts/publish.ps1',
      '-Version', packageJson.version,
      '-Channel', spec.channel === 'stable' ? 'both' : 'nightly',
      '-WaitForArchive'
    ], 'Publishing and verifying R2, CDN, and GitHub artifacts', { env });
  } finally {
    fs.writeFileSync(buildInfoPath, originalBuildInfo);
  }
  if (git(['status', '--porcelain'])) throw new Error('Release finished, but generated files left the worktree dirty.');
  console.log(`[release] Clips ${readJson('src/changelog.json')[0].version} is fully published and verified.`);
  console.log('[release] No branch commits were pushed; only the immutable release tag was published.');
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath && samePath(fileURLToPath(import.meta.url), invokedPath)) {
  main().catch(error => {
    console.error(`[release] FAILED: ${error.message}`);
    console.error('[release] Fix the reported issue, then rerun the same command; completed metadata steps will be resumed.');
    process.exitCode = 1;
  });
}
