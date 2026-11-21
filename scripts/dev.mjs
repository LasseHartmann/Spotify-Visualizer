import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildElectron } from './build-electron.mjs';
import { buildNative } from './build-native.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const DEV_URL = 'http://127.0.0.1:5173';

function waitForUrl(url, timeoutMs = 20000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Timed out waiting for ${url}`));
        } else {
          setTimeout(check, 250);
        }
      });
    };
    check();
  });
}

async function run() {
  buildNative();
  await buildElectron();

  const isWin = process.platform === 'win32';
  const viteCmd = isWin ? 'npx.cmd' : 'npx';
  const viteProc = spawn(viteCmd, ['vite'], {
    cwd: rootDir,
    stdio: 'inherit',
    shell: isWin,
  });

  await waitForUrl(DEV_URL);

  const electronBin = path.join(
    rootDir,
    'node_modules',
    '.bin',
    isWin ? 'electron.cmd' : 'electron'
  );

  const electronProc = spawn(electronBin, ['.'], {
    cwd: rootDir,
    stdio: 'inherit',
    shell: isWin,
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: DEV_URL,
    },
  });

  const cleanup = () => {
    if (!viteProc.killed) viteProc.kill();
    if (!electronProc.killed) electronProc.kill();
  };

  electronProc.on('exit', (code) => {
    cleanup();
    process.exit(code ?? 0);
  });

  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
