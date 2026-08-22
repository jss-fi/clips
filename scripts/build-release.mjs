import { spawn } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const windows = process.platform === 'win32';

function run(command, args, label) {
  const started = Date.now();
  console.log(`[build] ${label} started`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', windowsHide: true, shell: false });
    child.once('error', reject);
    child.once('exit', code => {
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      if (code === 0) { console.log(`[build] ${label} finished in ${seconds}s`); resolve(); }
      else reject(new Error(`${label} exited with code ${code} after ${seconds}s`));
    });
  });
}

const node = process.execPath;
const builder = path.join(root, 'node_modules', 'electron-builder', 'cli.js');
const powershell = windows ? 'powershell.exe' : 'pwsh';

await run(node, ['scripts/write-build-info.js'], 'shared build metadata');
await run(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/stage-legal.ps1'], 'legal notices');

const updateInstaller = run(node, [builder, '--config', 'electron-builder.update.json', '--win', 'nsis'], 'update installer');
const stagedApplication = (async () => {
  await run(node, [builder, '--config', 'electron-builder.staged.json', '--win', 'dir'], 'staged application');
  await run(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/build-staged-update.ps1'], 'staged archive');
})();
const sourceBundle = run(node, ['scripts/build-source-bundle.js'], 'source bundle');

await Promise.all([updateInstaller, stagedApplication, sourceBundle]);
await Promise.all([
  run(node, ['scripts/test-staged-update.js'], 'staged updater integration'),
  run(node, ['scripts/test-runtime-install.js'], 'runtime install and migration integration'),
  run(node, ['scripts/test-update-compatibility.js'], 'released-client compatibility matrix')
]);
console.log('[build] release artifacts complete');
