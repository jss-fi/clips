import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [dist, bucket, channel, version, stdoutPath, stderrPath] = process.argv.slice(2);
const root = path.resolve(import.meta.dirname, '..');
const stdout = stdoutPath ? fs.openSync(stdoutPath, 'a') : 'inherit';
const stderr = stderrPath ? fs.openSync(stderrPath, 'a') : 'inherit';
function run(script, args, { required = true } = {}) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: root, env: process.env, stdio: ['ignore', stdout, stderr], windowsHide: true });
  if (result.status !== 0 && required) process.exit(result.status ?? 1);
  return result.status === 0;
}
run(path.join(root, 'scripts', 'publish-github-release.mjs'), [version]);
const cleaned = run(path.join(root, 'clips-worker', 'scripts', 'publish-r2.mjs'), [dist, bucket, channel, version, 'cleanup'], { required: false });
if (!cleaned) {
  const message = `Release ${version} is fully archived, but retention cleanup was deferred; all older artifacts were retained safely.\n`;
  if (typeof stderr === 'number') fs.writeSync(stderr, message);
  else console.warn(message.trim());
}
const completion = cleaned
  ? `GitHub archival and R2 retention completed for Clips ${version}.`
  : `GitHub archival completed for Clips ${version}; retention cleanup remains deferred.`;
if (typeof stdout === 'number') fs.writeSync(stdout, `${completion}\n`);
else console.log(completion);
