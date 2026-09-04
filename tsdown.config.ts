import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/internal.ts', 'src/react/index.ts', 'src/solid/index.ts'],
  // The framework bindings are subpath entries of this package; rolldown emits
  // the core they share as one chunk both of them import.
  deps: { neverBundle: ['react', 'solid-js'] },
  format: ['esm'],
  platform: 'neutral',
  target: 'es2022',
  // Declarations are emitted by the TypeScript 7 native compiler; the plugin's
  // default tsc path drives the old JS compiler API, which TS 7 no longer ships.
  dts: { tsgo: { path: './node_modules/.bin/tsc' } },
  clean: true,
  sourcemap: true,
  treeshake: true,
  // Dev-only assertions are dropped entirely from the published build (SPEC §12.2).
  define: { __DEV__: 'false' },
});
