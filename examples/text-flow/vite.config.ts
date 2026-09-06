import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

/**
 * The example resolves `apecs` to the repository source, so it always runs
 * against the current library. `__DEV__` follows the Vite mode: assertions on
 * the dev server, stripped from the deployable build (SPEC §12.2).
 */
export default defineConfig(({ mode }) => ({
  base: './',
  define: { __DEV__: JSON.stringify(mode !== 'production') },
  resolve: {
    alias: [
      {
        find: /^apecs$/,
        replacement: fileURLToPath(new URL('../../src/index.ts', import.meta.url)),
      },
    ],
  },
  server: { fs: { allow: [fileURLToPath(new URL('../..', import.meta.url))] } },
}));
