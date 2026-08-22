import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [dist, bucket, channel, version, stdoutPath, stderrPath] = process.argv.slice(2);
const root = path.resolve(import.meta.dirname, '..');
const stdout = stdoutPath ? fs.openSync(stdoutPath, 'a') : 'inherit';
const stderr = stderrPath ? fs.openSync(stderrPath, 'a') : 'inherit';
function run(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: root, env: process.env, stdio: ['ignore', stdout, stderr], windowsHide: true });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run(path.join(root, 'scripts', 'publish-github-release.mjs'), [version]);
run(path.join(root, 'clips-worker', 'scripts', 'publish-r2.mjs'), [dist, bucket, channel, version, 'cleanup']);
if (typeof stdout === 'number') fs.writeSync(stdout, `GitHub archival and R2 retention completed for Clips ${version}.\n`);
else console.log(`GitHub archival and R2 retention completed for Clips ${version}.`);
