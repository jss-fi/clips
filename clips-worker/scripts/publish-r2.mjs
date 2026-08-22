import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CopyObjectCommand,
  CreateMultipartUploadCommand, DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand,
  HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client, UploadPartCommand
} from '@aws-sdk/client-s3';
import {
  artifactVersion, compareReleaseVersions, limiter, publishMetadataPair, releaseArtifactNames,
  releaseMarkerName, releaseMarkerVersion, releaseRetentionPlan
} from './release-utils.mjs';

const [dist, bucket, channel, version, mode = 'publish'] = process.argv.slice(2);
for (const name of ['CLIPS_R2_ACCOUNT_ID', 'CLIPS_R2_ACCESS_KEY_ID', 'CLIPS_R2_SECRET_ACCESS_KEY']) {
  if (!process.env[name]) throw new Error(`${name} is required. Use bucket-scoped R2 credentials.`);
}
const client = new S3Client({
  region: 'auto', endpoint: `https://${process.env.CLIPS_R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: process.env.CLIPS_R2_ACCESS_KEY_ID, secretAccessKey: process.env.CLIPS_R2_SECRET_ACCESS_KEY }
});
const artifactNames = releaseArtifactNames(version);
const channels = channel === 'both' ? ['nightly', 'stable'] : [channel];
const prefixFor = value => value === 'stable' ? 'releases/stable/' : 'releases/';
const types = { '.exe': 'application/octet-stream', '.blockmap': 'application/octet-stream', '.zip': 'application/zip', '.yml': 'text/yaml; charset=utf-8', '.json': 'application/json; charset=utf-8' };

const network = limiter(Number(process.env.CLIPS_R2_UPLOAD_CONCURRENCY || 16));
const partSize = Number(process.env.CLIPS_R2_PART_SIZE || 16 * 1024 * 1024);
const retainedVersionCount = 3;

async function sha512File(source) {
  const hash = crypto.createHash('sha512');
  for await (const chunk of fs.createReadStream(source)) hash.update(chunk);
  return hash.digest('base64');
}

async function remoteBody(key) {
  const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!result.Body) throw new Error(`R2 object has no body: ${key}`);
  const chunks = [];
  for await (const chunk of result.Body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function remoteSha512(key) {
  const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!result.Body) throw new Error(`R2 object has no body: ${key}`);
  const hash = crypto.createHash('sha512');
  for await (const chunk of result.Body) hash.update(chunk);
  return hash.digest('base64');
}

async function verify(key, source) {
  const size = fs.statSync(source).size;
  const expectedHash = await sha512File(source);
  const result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  if (Number(result.ContentLength) !== size) throw new Error(`R2 size mismatch for ${key}: ${result.ContentLength} != ${size}`);
  if (result.Metadata?.sha512 !== expectedHash) throw new Error(`R2 checksum metadata mismatch for ${key}.`);
  const actualHash = await remoteSha512(key);
  if (actualHash !== expectedHash) throw new Error(`R2 content checksum mismatch for ${key}.`);
}

async function upload(source, key, contentType) {
  const size = fs.statSync(source).size;
  const sha512 = await sha512File(source);
  if (size <= partSize) {
    await network(() => client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: fs.createReadStream(source), ContentLength: size, ContentType: contentType, CacheControl: 'public, max-age=31536000, immutable', Metadata: { sha512 } })));
  } else {
    const created = await client.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: contentType, CacheControl: 'public, max-age=31536000, immutable', Metadata: { sha512 } }));
    try {
      const count = Math.ceil(size / partSize);
      const parts = await Promise.all(Array.from({ length: count }, (_, index) => network(async () => {
        const start = index * partSize;
        const length = Math.min(partSize, size - start);
        const result = await client.send(new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: created.UploadId, PartNumber: index + 1, Body: fs.createReadStream(source, { start, end: start + length - 1 }), ContentLength: length }));
        return { ETag: result.ETag, PartNumber: index + 1 };
      })));
      await client.send(new CompleteMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: created.UploadId, MultipartUpload: { Parts: parts } }));
    } catch (error) {
      await client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: created.UploadId })).catch(() => {});
      throw error;
    }
  }
  await verify(key, source);
  console.log(`Uploaded and verified ${key} (${size} bytes)`);
}

async function listObjects(prefix) {
  const objects = [];
  let continuationToken;
  do {
    const page = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      Delimiter: '/',
      ContinuationToken: continuationToken
    }));
    objects.push(...(page.Contents || []));
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    if (page.IsTruncated && !continuationToken) throw new Error(`R2 did not return a continuation token for ${prefix}.`);
  } while (continuationToken);
  return objects;
}

function githubReleaseTag(version) {
  return version.replace(/-nightly\.(\d+)(?=\.|$)/, (_match, sequence) =>
    `-nightly.n${sequence.padStart(6, '0')}`);
}

async function verifyGithubFallback(object) {
  const name = object.Key.split('/').at(-1);
  const version = artifactVersion(name);
  const repository = process.env.CLIPS_GITHUB_REPOSITORY || 'jssfi/clips';
  const url = version
    ? `https://github.com/${repository}/releases/download/v${githubReleaseTag(version)}/${encodeURIComponent(name)}`
    : null;
  if (!url || !Number.isSafeInteger(Number(object.Size))) throw new Error(`Cannot verify GitHub fallback for ${object.Key}.`);

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'HEAD',
        redirect: 'follow',
        signal: AbortSignal.timeout(120_000)
      });
      const size = Number(response.headers.get('content-length'));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (size !== Number(object.Size)) throw new Error(`size ${size} != ${object.Size}`);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 1000));
    }
  }
  throw new Error(`GitHub fallback verification failed for ${name}: ${lastError?.message || lastError}`);
}

async function markPublishedVersion(releaseChannel) {
  const prefix = prefixFor(releaseChannel);
  await Promise.all(artifactNames.map(name => client.send(new HeadObjectCommand({
    Bucket: bucket,
    Key: `${prefix}${name}`
  }))));
  const key = `${prefix}${releaseMarkerName(version)}`;
  const body = Buffer.from(`${JSON.stringify({ version, artifacts: artifactNames, verifiedAt: new Date().toISOString() })}\n`);
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentLength: body.length,
    ContentType: 'application/json; charset=utf-8',
    CacheControl: 'no-store, max-age=0'
  }));
  if (!(await remoteBody(key)).equals(body)) throw new Error(`Release marker verification failed for ${key}.`);
  console.log(`Marked ${version} as publicly verified in ${releaseChannel}.`);
}

async function deleteObjects(objects) {
  const unique = [...new Map(objects.filter(Boolean).map(object => [object.Key, object])).values()];
  for (let index = 0; index < unique.length; index += 1000) {
    const batch = unique.slice(index, index + 1000);
    const result = await client.send(new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: { Objects: batch.map(object => ({ Key: object.Key })), Quiet: true }
    }));
    if (result.Errors?.length) {
      throw new Error(`R2 failed to delete: ${result.Errors.map(error => `${error.Key}: ${error.Message}`).join(', ')}`);
    }
  }
}

async function pruneChannel(releaseChannel) {
  const prefix = prefixFor(releaseChannel);
  const plan = releaseRetentionPlan(await listObjects(prefix), retainedVersionCount);
  if (plan.incompleteVersions.length) {
    console.warn(`Removing incomplete marked R2 version(s) from ${releaseChannel}: ${plan.incompleteVersions.join(', ')}`);
  }
  const objectVersion = object => artifactVersion(object.Key) || releaseMarkerVersion(object.Key);
  const verifiedRemoval = [];
  const verificationErrors = [];
  const markedObjects = [...plan.deleteObjects, ...plan.incompleteObjects];
  for (const candidate of [...plan.deletedVersions, ...plan.incompleteVersions]) {
    const objects = markedObjects.filter(object => objectVersion(object) === candidate);
    try {
      await Promise.all(objects
        .filter(object => artifactVersion(object.Key))
        .map(object => network(() => verifyGithubFallback(object))));
      verifiedRemoval.push(...objects);
    } catch (error) {
      verificationErrors.push(new Error(`${candidate}: ${error.message}`));
    }
  }

  const removableIncompleteVersions = new Set(plan.unmarkedIncompleteVersions.filter(candidate =>
    compareReleaseVersions(candidate, version) <= 0));
  const failedUploadObjects = plan.unmarkedIncompleteObjects.filter(object =>
    removableIncompleteVersions.has(artifactVersion(object.Key)));
  const archivedOrphanVersions = [];
  for (const candidate of plan.unmarkedCompleteVersions.filter(value => compareReleaseVersions(value, version) <= 0)) {
    const objects = plan.unmarkedCompleteObjects.filter(object => artifactVersion(object.Key) === candidate);
    try {
      await Promise.all(objects.map(object => network(() => verifyGithubFallback(object))));
      verifiedRemoval.push(...objects);
      archivedOrphanVersions.push(candidate);
    } catch (error) {
      console.warn(`Retaining unmarked complete R2 version ${candidate} in ${releaseChannel}: ${error.message}`);
    }
  }

  const removal = [...verifiedRemoval, ...failedUploadObjects];
  if (!removal.length) {
    console.log(`Retained ${plan.retainedVersions.length} R2 version(s) for ${releaseChannel}; nothing to prune.`);
  } else {
    await deleteObjects(removal);
    console.log(`Retained ${plan.retainedVersions.join(', ')} in R2 for ${releaseChannel}; pruned ${plan.deletedVersions.join(', ')} after verifying GitHub fallbacks.`);
    if (removableIncompleteVersions.size) {
      console.log(`Removed incomplete failed-upload version(s) from ${releaseChannel}: ${[...removableIncompleteVersions].join(', ')}`);
    }
    if (archivedOrphanVersions.length) {
      console.log(`Removed archived unmarked version(s) from ${releaseChannel}: ${archivedOrphanVersions.join(', ')}`);
    }
  }
  if (verificationErrors.length) {
    throw new AggregateError(verificationErrors, `Could not verify every marked GitHub fallback in ${releaseChannel}.`);
  }
}

if (mode === 'mark') {
  for (const releaseChannel of channels) await markPublishedVersion(releaseChannel);
} else if (mode === 'cleanup') {
  for (const releaseChannel of channels) await pruneChannel(releaseChannel);
} else {
  const primary = channels[0];
  const primaryPrefix = prefixFor(primary);
  await Promise.all(artifactNames.map(async name => {
    const extension = name.endsWith('.exe.blockmap') ? '.blockmap' : path.extname(name);
    await upload(path.join(dist, name), `${primaryPrefix}${name}`, types[extension]);
  }));
  for (const releaseChannel of channels.slice(1)) {
    const prefix = prefixFor(releaseChannel);
    await Promise.all(artifactNames.map(async name => {
      const sourceKey = `${primaryPrefix}${name}`;
      const destinationKey = `${prefix}${name}`;
      await network(() => client.send(new CopyObjectCommand({ Bucket: bucket, Key: destinationKey, CopySource: `${bucket}/${sourceKey}` })));
      await verify(destinationKey, path.join(dist, name));
    }));
  }
  // Metadata is the commit point: publish it only after every referenced object is verified.
  for (const releaseChannel of channels) {
    const prefix = prefixFor(releaseChannel);
    const names = ['latest.json', 'latest.yml'];
    await publishMetadataPair(names, {
      async readPrevious(name) {
        try { return await remoteBody(`${prefix}${name}`); }
        catch (error) { if (error?.name === 'NoSuchKey') return null; throw error; }
      },
      async publishAndVerify(name) {
        const source = path.join(dist, name);
        const key = `${prefix}${name}`;
        const body = await fs.promises.readFile(source);
        await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentLength: body.length, ContentType: types[path.extname(name)], CacheControl: 'no-store, max-age=0', Metadata: { sha512: crypto.createHash('sha512').update(body).digest('base64') } }));
        const live = await remoteBody(key);
        if (!live.equals(body)) throw new Error(`Published metadata verification failed for ${key}.`);
        console.log(`Published and verified ${key}`);
      },
      async restore(name, body) {
        const key = `${prefix}${name}`;
        await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentLength: body.length, ContentType: types[path.extname(name)], CacheControl: 'no-store, max-age=0' }));
        if (!(await remoteBody(key)).equals(body)) throw new Error(`Metadata rollback verification failed for ${key}.`);
      },
      remove(name) {
        return client.send(new DeleteObjectCommand({ Bucket: bucket, Key: `${prefix}${name}` }));
      }
    });
  }
}
