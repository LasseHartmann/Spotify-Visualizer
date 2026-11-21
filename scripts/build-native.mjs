import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const srcPath = path.join(rootDir, 'native', 'wasapi-tap.cs');
const outDir = path.join(rootDir, 'build');
const outPath = path.join(outDir, 'wasapi-tap.exe');

const CSC_CANDIDATES = [
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
];

export function buildNative() {
  if (process.platform !== 'win32') return;
  const csc = CSC_CANDIDATES.find((p) => fs.existsSync(p));
  if (!csc) {
    if (fs.existsSync(outPath)) {
      console.log('[build-native] csc.exe not found; using prebuilt build/wasapi-tap.exe');
      return;
    }
    throw new Error('Could not find .NET Framework csc.exe to compile native/wasapi-tap.cs');
  }

  fs.mkdirSync(outDir, { recursive: true });
  execFileSync(
    csc,
    ['/nologo', '/optimize+', '/platform:x64', '/target:exe', `/out:${outPath}`, srcPath],
    { stdio: 'inherit' }
  );
  console.log('[build-native] Built build/wasapi-tap.exe');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildNative();
}
