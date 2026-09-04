import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The example resolves `apecs` to the repository source, so it always runs
 * against the current library. `__DEV__` follows the Vite mode: assertions on
 * the dev server, stripped from the deployable build (SPEC §12.2).
 */
export default defineConfig(({ mode }) => ({
  base: './',
  plugins: [react()],
  define: { __DEV__: JSON.stringify(mode !== 'production') },
  resolve: {
    alias: [
      {
        find: /^apecs\/react$/,
        replacement: fileURLToPath(new URL('../../src/react/index.ts', import.meta.url)),
      },
      {
        find: /^apecs$/,
        replacement: fileURLToPath(new URL('../../src/index.ts', import.meta.url)),
      },
    ],
    // The library source lives outside this package; make sure its `react`
    // import lands on the same copy the app renders with.
    dedupe: ['react', 'react-dom'],
  },
  server: { fs: { allow: [fileURLToPath(new URL('../..', import.meta.url))] } },
}));
