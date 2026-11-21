import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig(({ mode }) => {
  const isWebBuild = mode === 'web' || process.env.VERCEL === '1';

  return {
    plugins: [react()],
    // Electron loads dist/renderer/index.html via file:// (needs './'); Vercel/Web needs '/' for /callback routes
    base: isWebBuild ? '/' : './',
    resolve: {
      alias: {
        '@shared': path.resolve(__dirname, 'shared'),
        '@': path.resolve(__dirname, 'src'),
      },
    },
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
    },
    build: {
      outDir: 'dist/renderer',
      emptyOutDir: true,
      sourcemap: false,
    },
  };
});
