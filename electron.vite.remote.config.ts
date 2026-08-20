import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'));
const define = { __APP_VERSION__: JSON.stringify(pkg.version) };
const defineMain = {
  ...define,
  __POSTHOG_KEY__: JSON.stringify(process.env.POSTHOG_KEY ?? ''),
  __POSTHOG_HOST__: JSON.stringify(process.env.POSTHOG_HOST ?? 'https://us.i.posthog.com'),
};

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: defineMain,
    build: {
      rollupOptions: {
        // Name it 'index' so electron-vite boots this file as the Electron entry.
        // remote-entry.ts proxies all IPC over WS to the VM — no local hive/PTY.
        input: {
          index: resolve(__dirname, 'src/main/remote-entry.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    define,
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
      },
    },
  },
  renderer: {
    define,
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
    plugins: [react()],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/src'),
        '@brand': resolve(__dirname, 'docs'),
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
  },
});
