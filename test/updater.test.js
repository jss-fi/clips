const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { signMetadata, signPackageMetadata } = require('../scripts/update-signature');
const {
  compareVersions,
  cleanupOldVersionDirectories,
  cleanupStalePreparations,
  cleanupInvalidPreparedVersions,
  isPreparationDirectory,
  isVersionDirectory,
  validateMetadata,
  authenticateMetadata,
  preparedUpdateMatches,
  downloadRanges,
  downloadUpdateArchive,
  withFetchTimeout,
  renameWithRetries,
  promotePreparedDirectory,
  updateRelaunchArgs,
  readActiveVersion,
  rollbackActiveVersion,
  confirmActiveVersionBoot,
  redirectToActiveVersion
} = require('../src/updater');

function createPreparedVersion(root, version, directory = version, { asar = 'application' } = {}) {
  const destination = path.join(root, 'jss-clips', 'app-versions', directory);
  fs.mkdirSync(path.join(destination, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(destination, 'jss clips.exe'), 'executable');
  fs.writeFileSync(path.join(destination, 'resources', 'app.asar'), asar);
  fs.writeFileSync(path.join(destination, '.clips-update.json'), JSON.stringify({
    version,
    asarSha512: crypto.createHash('sha512').update(asar).digest('base64')
  }));
  return destination;
}

function updateTestApp(root, version = '0.5.0') {
  return { isPackaged: true, getVersion: () => version, getPath: () => root };
}

function withLocalAppData(root, callback) {
  const original = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = root;
  try { return callback(); }
  finally {
    if (original === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = original;
  }
}

test('update restarts discard background startup without changing other arguments', () => {
  assert.deepEqual(updateRelaunchArgs(['--hidden', '--trace-warnings']), ['--trace-warnings']);
  assert.deepEqual(updateRelaunchArgs(['--trace-warnings']), ['--trace-warnings']);
});

test('legacy active pointers remain compatible but require a complete prepared application', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clips-active-legacy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const version = '0.5.1-nightly.1.deadbeef';
  const directory = `${version}.app-valid`;
  const destination = createPreparedVersion(root, version, directory);
  const pointer = path.join(root, 'jss-clips', 'active-app.json');
  fs.writeFileSync(pointer, JSON.stringify({ version, directory, activatedAt: '2026-08-17T00:00:00.000Z' }));

  withLocalAppData(root, () => {
    assert.equal(readActiveVersion(updateTestApp(root)).state, 'confirmed');
    fs.writeFileSync(path.join(destination, 'resources', 'app.asar'), 'corrupt');
    assert.equal(readActiveVersion(updateTestApp(root)), null);
  });
});

test('malformed and incomplete active pointers are rejected', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clips-active-invalid-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pointer = path.join(root, 'jss-clips', 'active-app.json');
  fs.mkdirSync(path.dirname(pointer), { recursive: true });

  withLocalAppData(root, () => {
    fs.writeFileSync(pointer, '{not json');
    assert.equal(readActiveVersion(updateTestApp(root)), null);
    fs.writeFileSync(pointer, JSON.stringify({ version: '0.5.1', directory: '../escape' }));
    assert.equal(readActiveVersion(updateTestApp(root)), null);
    createPreparedVersion(root, '0.5.1');
    fs.rmSync(path.join(root, 'jss-clips', 'app-versions', '0.5.1', '.clips-update.json'));
    fs.writeFileSync(pointer, JSON.stringify({ version: '0.5.1' }));
    assert.equal(readActiveVersion(updateTestApp(root)), null);
  });
});

test('a failed pending boot rolls back to the previous confirmed version', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clips-active-rollback-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const previousVersion = '0.5.1-nightly.1.aaaaaaaa';
  const failedVersion = '0.5.1-nightly.2.bbbbbbbb';
  const previousDirectory = `${previousVersion}.app-previous`;
  const failedDirectory = `${failedVersion}.app-failed`;
  createPreparedVersion(root, previousVersion, previousDirectory);
  createPreparedVersion(root, failedVersion, failedDirectory);
  const pointer = path.join(root, 'jss-clips', 'active-app.json');
  fs.writeFileSync(pointer, JSON.stringify({
    version: failedVersion,
    directory: failedDirectory,
    state: 'pending',
    bootAttempts: 1,
    previous: { version: previousVersion, directory: previousDirectory, activatedAt: '2026-08-16T00:00:00.000Z' }
  }));

  withLocalAppData(root, () => {
    const restored = rollbackActiveVersion(updateTestApp(root));
    assert.equal(restored.version, previousVersion);
    assert.deepEqual(JSON.parse(fs.readFileSync(pointer, 'utf8')), {
      version: previousVersion,
      directory: previousDirectory,
      activatedAt: '2026-08-16T00:00:00.000Z',
      state: 'confirmed'
    });
  });
});

test('a healthy pending version can be confirmed only by its own executable', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clips-active-confirm-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const version = '0.5.1-nightly.3.cccccccc';
  const directory = `${version}.app-current`;
  const destination = createPreparedVersion(root, version, directory);
  const executable = path.join(destination, 'jss clips.exe');
  const pointer = path.join(root, 'jss-clips', 'active-app.json');
  fs.writeFileSync(pointer, JSON.stringify({ version, directory, state: 'pending', bootAttempts: 1 }));

  withLocalAppData(root, () => {
    assert.equal(confirmActiveVersionBoot(updateTestApp(root), path.join(root, 'other.exe')), false);
    assert.equal(confirmActiveVersionBoot(updateTestApp(root), executable), true);
    const confirmed = JSON.parse(fs.readFileSync(pointer, 'utf8'));
    assert.equal(confirmed.state, 'confirmed');
    assert.ok(confirmed.confirmedAt);
    assert.equal('bootAttempts' in confirmed, false);
  });
});

test('the first pending-version launch is recorded before version comparison', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clips-active-first-boot-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const version = '0.5.1-nightly.4.dddddddd';
  const directory = `${version}.app-current`;
  const executable = path.join(createPreparedVersion(root, version, directory), 'jss clips.exe');
  const pointer = path.join(root, 'jss-clips', 'active-app.json');
  fs.writeFileSync(pointer, JSON.stringify({ version, directory, state: 'pending', bootAttempts: 0 }));

  withLocalAppData(root, () => {
    assert.equal(redirectToActiveVersion(updateTestApp(root, version), { currentExecutable: executable }), false);
    const attempted = JSON.parse(fs.readFileSync(pointer, 'utf8'));
    assert.equal(attempted.bootAttempts, 1);
    assert.ok(attempted.bootStartedAt);
  });
});

test('a later launch automatically redirects to the rollback version after an unconfirmed boot', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clips-active-auto-rollback-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const previousVersion = '0.5.1-nightly.4.aaaaaaaa';
  const failedVersion = '0.5.1-nightly.5.bbbbbbbb';
  const previousDirectory = `${previousVersion}.app-previous`;
  const failedDirectory = `${failedVersion}.app-failed`;
  const previousExecutable = path.join(createPreparedVersion(root, previousVersion, previousDirectory), 'jss clips.exe');
  createPreparedVersion(root, failedVersion, failedDirectory);
  const pointer = path.join(root, 'jss-clips', 'active-app.json');
  fs.writeFileSync(pointer, JSON.stringify({
    version: failedVersion,
    directory: failedDirectory,
    state: 'pending',
    bootAttempts: 1,
    previous: { version: previousVersion, directory: previousDirectory }
  }));
  const launches = [];

  withLocalAppData(root, () => {
    assert.equal(redirectToActiveVersion(updateTestApp(root), {
      currentExecutable: path.join(root, 'installed', 'jss clips.exe'),
      spawnImpl: executable => {
        launches.push(executable);
        return { unref() {} };
      }
    }), true);
    assert.deepEqual(launches, [previousExecutable]);
    assert.equal(readActiveVersion(updateTestApp(root)).version, previousVersion);
  });
});

test('old app versions are pruned while active and rollback versions are retained', async t => {
  const versions = fs.mkdtempSync(path.join(os.tmpdir(), 'clips-versions-'));
  t.after(() => fs.rmSync(versions, { recursive: true, force: true }));
  const names = ['0.1.50.app-old', '0.1.51.app-active', '0.1.52.app-new'];
  for (const [index, name] of names.entries()) {
    const directory = path.join(versions, name);
    fs.mkdirSync(directory);
    const timestamp = new Date(2026, 0, index + 1);
    fs.utimesSync(directory, timestamp, timestamp);
  }

  await cleanupOldVersionDirectories(versions, {
    protectedDirectories: ['0.1.51.app-active'],
    retain: 2
  });

  assert.deepEqual(fs.readdirSync(versions).sort(), [
    '0.1.51.app-active',
    '0.1.52.app-new'
  ]);
});

test('compareVersions orders patch releases', () => {
  assert.equal(compareVersions('0.1.12', '0.1.11'), 1);
  assert.equal(compareVersions('0.1.11', '0.1.12'), -1);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
});

test('compareVersions orders sortable nightlies after legacy sequences', () => {
  assert.equal(compareVersions('0.5.0-nightly.n000019.aaaaaaaa', '0.5.0-nightly.18.bbbbbbbb'), 1);
  assert.equal(compareVersions('0.5.0-nightly.n000020.aaaaaaaa', '0.5.0-nightly.n000019.bbbbbbbb'), 1);
});

test('compareVersions orders commit nightlies after their stable base', () => {
  assert.equal(compareVersions('0.3.1-nightly.42.bbbbbbbb', '0.3.0'), 1);
  assert.equal(compareVersions('0.3.1-nightly.43.aaaaaaaa', '0.3.1-nightly.42.bbbbbbbb'), 1);
});

test('isPreparationDirectory recognizes fixed and unique updater staging directories', () => {
  assert.equal(isPreparationDirectory('0.1.13.preparing'), true);
  assert.equal(isPreparationDirectory('0.1.14.preparing-1234-5678-abcd'), true);
  assert.equal(isPreparationDirectory('0.1.14'), false);
  assert.equal(isPreparationDirectory('../0.1.14.preparing'), false);
});

test('isVersionDirectory accepts only safe canonical and immutable version directories', () => {
  assert.equal(isVersionDirectory('0.1.17', '0.1.17'), true);
  assert.equal(isVersionDirectory('0.1.17.app-1234-5678-abcd', '0.1.17'), true);
  assert.equal(isVersionDirectory('0.1.16.app-1234', '0.1.17'), false);
  assert.equal(isVersionDirectory('0.1.17.preparing', '0.1.17'), false);
  assert.equal(isVersionDirectory('../0.1.17.app-1234', '0.1.17'), false);
  assert.equal(isVersionDirectory('0.3.1-nightly.42.a1b2c3d4.app-1234', '0.3.1-nightly.42.a1b2c3d4'), true);
});

test('validateMetadata accepts a matching immutable application package', () => {
  assert.deepEqual(validateMetadata({
    version: '0.1.12',
    url: 'jss-clips-app-0.1.12-x64.zip',
    sha512: 'checksum',
    size: 123
  }), {
    version: '0.1.12',
    url: 'jss-clips-app-0.1.12-x64.zip',
    sha512: 'checksum',
    size: 123
  });
});

test('validateMetadata accepts a commit nightly package', () => {
  const version = '0.3.1-nightly.42.a1b2c3d4';
  assert.equal(validateMetadata({ version, url: `jss-clips-app-${version}-x64.zip`, sha512: 'checksum', size: 123 }).version, version);
});

test('validateMetadata rejects traversal and mismatched versions', () => {
  assert.throws(() => validateMetadata({
    version: '0.1.12',
    url: '../jss-clips-app-0.1.12-x64.zip',
    sha512: 'checksum',
    size: 123
  }));
  assert.throws(() => validateMetadata({
    version: '0.1.12',
    url: 'jss-clips-app-0.1.13-x64.zip',
    sha512: 'checksum',
    size: 123
  }));
});

test('authenticateMetadata accepts only metadata signed by the trusted key', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const metadata = {
    version: '0.1.12',
    url: 'jss-clips-app-0.1.12-x64.zip',
    sha512: 'checksum',
    size: 123,
    releaseDate: '2026-08-10T00:00:00.000Z'
  };
  metadata.signature = signMetadata(metadata, privateKey);
  assert.equal(authenticateMetadata(metadata, publicKey).version, '0.1.12');
  assert.throws(() => authenticateMetadata({ ...metadata, size: 124 }, publicKey), /signature/i);
  assert.throws(() => authenticateMetadata({ ...metadata, signature: '' }, publicKey), /signature/i);
});

test('package integrity metadata has an additive signature compatible with legacy feeds', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const metadata = { version: '0.5.0-nightly.11.abcdef12', url: 'jss-clips-app-0.5.0-nightly.11.abcdef12-x64.zip', sha512: 'archive', asarSha512: 'asar', size: 123, releaseDate: '2026-08-17T00:00:00.000Z' };
  metadata.signature = signMetadata(metadata, privateKey);
  metadata.packageSignature = signPackageMetadata(metadata, privateKey);
  assert.equal(authenticateMetadata(metadata, publicKey).asarSha512, 'asar');
  assert.throws(() => authenticateMetadata({ ...metadata, asarSha512: 'tampered' }, publicKey), /package signature/i);
});

test('restart confirmation requires the exact prepared update metadata', () => {
  const prepared = { version: '0.1.12', url: 'jss-clips-app-0.1.12-x64.zip', sha512: 'one', size: 123 };
  assert.equal(preparedUpdateMatches(prepared, { ...prepared }), true);
  assert.equal(preparedUpdateMatches(prepared, { ...prepared, version: '0.1.13' }), false);
  assert.equal(preparedUpdateMatches(prepared, { ...prepared, sha512: 'two' }), false);
  assert.equal(preparedUpdateMatches(prepared, { ...prepared, size: 124 }), false);
});

test('downloadRanges splits large updates into complete non-overlapping parts', () => {
  assert.deepEqual(downloadRanges(10, 4, 3), [
    { start: 0, end: 3 },
    { start: 4, end: 7 },
    { start: 8, end: 9 }
  ]);
  assert.deepEqual(downloadRanges(5, 4, 3), []);
});

test('update archives download over parallel byte ranges', async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'clips-download-'));
  const archive = path.join(temporary, 'update.zip');
  const source = Buffer.from('a fast update delivered in several independently verified pieces');
  const requestedRanges = [];
  const diagnostics = [];
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));

  await downloadUpdateArchive('https://updates.example/update.zip', archive, source.length, () => {}, {
    streams: 4,
    minimumPartSize: 8,
    onDiagnostic: (level, event, details) => diagnostics.push({ level, event, details }),
    fetchImpl: async (_url, options) => {
      requestedRanges.push(options.headers.Range);
      const match = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);
      const start = Number(match[1]);
      const end = Number(match[2]);
      return new Response(source.subarray(start, end + 1), {
        status: 206,
        headers: { 'Content-Range': `bytes ${start}-${end}/${source.length}` }
      });
    }
  });

  assert.equal(requestedRanges.length, 4);
  assert.deepEqual(fs.readFileSync(archive), source);
  assert.deepEqual(diagnostics[0], {
    level: 'info',
    event: 'mode selected',
    details: { mode: 'parallel', streams: 4, maximumAttemptsPerRange: 3 }
  });
});

test('parallel update downloads retry only a failed range', async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'clips-download-retry-'));
  const archive = path.join(temporary, 'update.zip');
  const source = Buffer.from('a fast update whose first range is briefly cut short in transit');
  const requests = new Map();
  const progress = [];
  const diagnostics = [];
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));

  await downloadUpdateArchive('https://updates.example/update.zip', archive, source.length, received => progress.push(received), {
    streams: 4,
    minimumPartSize: 8,
    rangeRetryDelayMs: 0,
    onDiagnostic: (level, event, details) => diagnostics.push({ level, event, details }),
    fetchImpl: async (_url, options) => {
      const requestedRange = options.headers.Range;
      const count = (requests.get(requestedRange) || 0) + 1;
      requests.set(requestedRange, count);
      const match = /^bytes=(\d+)-(\d+)$/.exec(requestedRange);
      const start = Number(match[1]);
      const end = Number(match[2]);
      const body = requestedRange === 'bytes=0-15' && count === 1
        ? source.subarray(start, end)
        : source.subarray(start, end + 1);
      return new Response(body, {
        status: 206,
        headers: { 'Content-Range': `bytes ${start}-${end}/${source.length}` }
      });
    }
  });

  assert.equal(requests.get('bytes=0-15'), 2);
  assert.deepEqual([...requests.values()].sort(), [1, 1, 1, 2]);
  assert.equal(progress.at(-1), source.length);
  assert.deepEqual(fs.readFileSync(archive), source);
  assert.equal(diagnostics.some(entry => entry.event === 'range retry scheduled'
    && entry.details.range.start === 0
    && /incomplete/.test(entry.details.message)), true);
  assert.equal(diagnostics.some(entry => entry.event === 'range retry succeeded'
    && entry.details.range.start === 0), true);
});

test('update archive download falls back when byte ranges are unsupported', async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'clips-download-fallback-'));
  const archive = path.join(temporary, 'update.zip');
  const source = Buffer.from('a complete update from an older server');
  const diagnostics = [];
  let rangeRequests = 0;
  let fullRequests = 0;
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));

  await downloadUpdateArchive('https://updates.example/update.zip', archive, source.length, () => {}, {
    streams: 4,
    minimumPartSize: 8,
    rangeRetries: 1,
    rangeRetryDelayMs: 0,
    onDiagnostic: (level, event, details) => diagnostics.push({ level, event, details }),
    fetchImpl: async (_url, options) => {
      if (options.headers.Range) {
        rangeRequests += 1;
        return new Response(source, { status: 200 });
      }
      fullRequests += 1;
      return new Response(source, { status: 200 });
    }
  });

  assert.equal(rangeRequests >= 2, true);
  assert.equal(fullRequests, 1);
  assert.deepEqual(fs.readFileSync(archive), source);
  assert.equal(diagnostics.some(entry => entry.event === 'fallback to single stream'
    && entry.details.status === 200
    && /ignored/.test(entry.details.reason)), true);
});

test('invalid range responses are retried without silently falling back', async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'clips-download-invalid-range-'));
  const archive = path.join(temporary, 'update.zip');
  const source = Buffer.from('an update served with invalid range metadata');
  const diagnostics = [];
  let rangeRequests = 0;
  let fullRequests = 0;
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));

  await assert.rejects(downloadUpdateArchive('https://updates.example/update.zip', archive, source.length, () => {}, {
    streams: 4,
    minimumPartSize: 8,
    rangeRetries: 1,
    rangeRetryDelayMs: 0,
    onDiagnostic: (level, event, details) => diagnostics.push({ level, event, details }),
    fetchImpl: async (_url, options) => {
      if (!options.headers.Range) {
        fullRequests += 1;
        return new Response(source, { status: 200 });
      }
      rangeRequests += 1;
      return new Response(source.subarray(0, 1), {
        status: 206,
        headers: { 'Content-Range': `bytes 0-0/${source.length}` }
      });
    }
  }), /invalid Content-Range/);

  assert.equal(rangeRequests >= 2, true);
  assert.equal(fullRequests, 0);
  assert.equal(diagnostics.some(entry => entry.event === 'range retry scheduled'
    && /Content-Range/.test(entry.details.message)), true);
  assert.equal(diagnostics.some(entry => entry.event === 'fallback to single stream'), false);
});

test('update requests abort stalled connections and bodies', async () => {
  await assert.rejects(
    withFetchTimeout((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }), 'https://updates.example/latest.json', {}, async () => {}, 10),
    /timed out/
  );
  await assert.rejects(
    withFetchTimeout(async (_url, { signal }) => new Response(new ReadableStream({ start(controller) {
      signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    } })), 'https://updates.example/app.zip', {}, async response => {
      await response.arrayBuffer();
    }, 10),
    /timed out/
  );
});

test('incomplete final-looking update directories are removed before retention', async t => {
  const versions = fs.mkdtempSync(path.join(os.tmpdir(), 'clips-invalid-version-'));
  t.after(() => fs.rmSync(versions, { recursive: true, force: true }));
  const invalid = path.join(versions, '0.5.0-nightly.4.deadbeef.app-crashed');
  fs.mkdirSync(invalid);
  fs.writeFileSync(path.join(invalid, '.clips-update.json'), JSON.stringify({ version: '0.5.0-nightly.4.deadbeef' }));
  await cleanupInvalidPreparedVersions(versions);
  assert.equal(fs.existsSync(invalid), false);
});

test('invalid-package cleanup never removes an active or running version directory', async t => {
  const versions = fs.mkdtempSync(path.join(os.tmpdir(), 'clips-protected-version-'));
  t.after(() => fs.rmSync(versions, { recursive: true, force: true }));
  const protectedName = '0.5.0-nightly.4.deadbeef.app-running';
  const unprotectedName = '0.5.0-nightly.3.cafebabe.app-abandoned';
  fs.mkdirSync(path.join(versions, protectedName));
  fs.mkdirSync(path.join(versions, unprotectedName));

  await cleanupInvalidPreparedVersions(versions, {
    protectedDirectories: [protectedName]
  });

  assert.equal(fs.existsSync(path.join(versions, protectedName)), true);
  assert.equal(fs.existsSync(path.join(versions, unprotectedName)), false);
});

test('stale preparation cleanup cannot delete the update currently being prepared', async t => {
  const versions = fs.mkdtempSync(path.join(os.tmpdir(), 'clips-preparation-cleanup-'));
  t.after(() => fs.rmSync(versions, { recursive: true, force: true }));
  const current = '0.5.0-nightly.6.deadbeef.preparing-current';
  const stale = '0.5.0-nightly.5.cafebabe.preparing-stale';
  fs.mkdirSync(path.join(versions, current));
  fs.mkdirSync(path.join(versions, stale));
  const staleTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(path.join(versions, stale), staleTime, staleTime);

  await cleanupStalePreparations(versions, { protectedDirectories: [current] });

  assert.equal(fs.existsSync(path.join(versions, current)), true);
  assert.equal(fs.existsSync(path.join(versions, stale)), false);
});

test('cleanup preserves a fresh preparation owned by another updater process', async t => {
  const versions = fs.mkdtempSync(path.join(os.tmpdir(), 'clips-fresh-preparation-'));
  t.after(() => fs.rmSync(versions, { recursive: true, force: true }));
  const fresh = '0.5.0-nightly.12.deadbeef.preparing-other-process';
  fs.mkdirSync(path.join(versions, fresh));
  await cleanupStalePreparations(versions);
  assert.equal(fs.existsSync(path.join(versions, fresh)), true);
});

test('prepared update finalization retries transient Windows directory locks', async () => {
  let attempts = 0;
  const delays = [];
  await renameWithRetries('preparing', 'final', {
    rename: async () => {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error('locked'), { code: 'EPERM' });
    },
    wait: async delay => { delays.push(delay); }
  });

  assert.equal(attempts, 3);
  assert.deepEqual(delays, [50, 100]);
});

test('prepared update promotion reports a direct directory rename', async () => {
  const method = await promotePreparedDirectory('preparing', 'final', {
    rename: async () => {},
    copy: async () => { throw new Error('copy fallback should not run'); }
  });

  assert.equal(method, 'rename');
});

test('prepared update promotion copies and verifies when Windows keeps the directory locked', async () => {
  const copied = [];
  const removed = [];
  const method = await promotePreparedDirectory('preparing', 'final', {
    rename: async () => { throw Object.assign(new Error('locked'), { code: 'EPERM' }); },
    wait: async () => {},
    copy: async (...args) => { copied.push(args); },
    stat: async file => ({ size: file.endsWith('app.asar') ? 200 : 100 }),
    remove: async name => { removed.push(name); }
  });
  assert.equal(method, 'copy');
  assert.equal(copied.length, 1);
  assert.deepEqual(removed, ['final', 'preparing']);
});
