import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const { loadProjectEnv, required } = require('./env.js');

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

function commandName(name) {
  return process.platform === 'win32' && name === 'npm' ? 'npm.cmd' : name;
}

function run(command, args, label, options = {}) {
  if (!options.quiet) console.log(`[release] ${label}`);
  const capture = Boolean(options.capture);
  const result = spawnSync(commandName(command), args, {
    cwd: root,
    env: options.env || process.env,
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
  const metadataFiles = ['package-lock.json', 'package.json', 'src/changelog.json'];
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
  const fresh = args.includes('--fresh') || build.fresh;
  const env = preflightCredentials();

  console.log(`[release] Source snapshot ${sourceRef.slice(0, 8)}; comparing with ${build.previousTag || 'no prior tag'}.`);
  console.log(`[release] Build mode: ${fresh ? 'fresh runtime + release' : 'ordinary release'}.`);
  run('npm', ['run', 'check'], 'Running repository checks');

  if (state === 'pending') {
    if (spec.channel === 'nightly') run('npm', ['run', 'version:nightly', '--', spec.base], 'Generating nightly metadata');
    else prepareStableVersion(spec);
    assertMetadataChanges();
    const displayVersion = readJson('src/changelog.json')[0].version;
    git(['add', '--', 'package.json', 'package-lock.json', 'src/changelog.json']);
    run('git', ['commit', '-m', `Version ${spec.channel} ${displayVersion}`], `Committing ${displayVersion} release metadata`);
  } else {
    console.log('[release] Release metadata already exists; resuming from the committed release snapshot.');
  }

  packageJson = readJson('package.json');
  const buildInfoPath = path.join(root, 'src', 'build-info.json');
  const originalBuildInfo = fs.readFileSync(buildInfoPath);
  try {
    if (fresh) run('npm', ['run', 'dist:fresh'], 'Building fresh media runtime and bootstrap installer', { env });
    run('npm', ['run', 'dist:release'], 'Building and compatibility-testing release artifacts', { env });
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
