import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const toolsRoot = join(projectRoot, 'clips-worker', 'node_modules');
const wrangler = join(toolsRoot, 'wrangler', 'bin', 'wrangler.js');
const tsc = join(toolsRoot, 'typescript', 'bin', 'tsc');
const workers = ['legacy/update-worker', 'legacy/telemetry-worker', 'clips-worker'];

function run(script, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: 'inherit', ...options });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolveRun() : reject(new Error(`${script} exited with code ${code}.`)));
  });
}

const temporaryRoot = await mkdtemp(join(tmpdir(), 'clips-worker-check-'));
const isolatedEnv = { ...process.env, CI: '1', XDG_CONFIG_HOME: join(temporaryRoot, '.config') };
try {
  await mkdir(join(temporaryRoot, 'clips-worker'), { recursive: true });
  await cp(join(projectRoot, 'clips-worker', 'src'), join(temporaryRoot, 'clips-worker', 'src'), { recursive: true });
  for (const workerName of workers) {
    const sourceRoot = join(projectRoot, workerName);
    const checkRoot = join(temporaryRoot, workerName);
    await mkdir(checkRoot, { recursive: true });
    const setup = [
      cp(join(sourceRoot, 'wrangler.template.jsonc'), join(checkRoot, 'wrangler.template.jsonc')),
      cp(join(sourceRoot, 'tsconfig.json'), join(checkRoot, 'tsconfig.json')),
      symlink(toolsRoot, join(checkRoot, 'node_modules'), 'junction')
    ];
    if (workerName !== 'clips-worker') setup.push(cp(join(sourceRoot, 'src'), join(checkRoot, 'src'), { recursive: true }));
    await Promise.all(setup);
    const configPath = join(checkRoot, 'wrangler.jsonc');
    await run(join(projectRoot, 'scripts', 'write-worker-config.js'), [workerName, configPath], {
      cwd: projectRoot,
      env: { ...isolatedEnv, CLIPS_HERMETIC_CHECK: '1' }
    });
    await run(wrangler, ['types', join(checkRoot, 'worker-configuration.d.ts'), '--config', configPath], { cwd: checkRoot, env: isolatedEnv });
    await run(tsc, ['--project', join(checkRoot, 'tsconfig.json'), '--noEmit'], { cwd: checkRoot, env: isolatedEnv });
    await run(wrangler, ['deploy', '--dry-run', '--config', configPath], { cwd: checkRoot, env: isolatedEnv });
  }
  console.log(`Worker checks completed in an isolated temporary directory using .env.example.`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
