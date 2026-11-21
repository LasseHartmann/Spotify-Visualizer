import * as esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const defaultClientId = (process.env.SPOTIFY_CLIENT_ID ?? '').trim();

const sharedOptions = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['electron'],
  sourcemap: process.env.NODE_ENV !== 'production',
  minify: process.env.NODE_ENV === 'production',
  define: {
    __DEFAULT_SPOTIFY_CLIENT_ID__: JSON.stringify(defaultClientId),
  },
  alias: {
    '@shared': path.join(rootDir, 'shared'),
  },
};

export async function buildElectron() {
  await Promise.all([
    esbuild.build({
      ...sharedOptions,
      entryPoints: [path.join(rootDir, 'electron', 'main.ts')],
      outfile: path.join(rootDir, 'dist', 'electron', 'main.cjs'),
    }),
    esbuild.build({
      ...sharedOptions,
      entryPoints: [path.join(rootDir, 'electron', 'preload.ts')],
      outfile: path.join(rootDir, 'dist', 'electron', 'preload.cjs'),
    }),
  ]);
  console.log('[build-electron] Built main.cjs and preload.cjs');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildElectron().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
