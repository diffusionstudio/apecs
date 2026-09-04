import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const include = ['tests/**/*.test.ts'];
/** The bindings' tests run in their own jsdom projects, below (SPEC-CLIENTS §C.9). */
const react = ['tests/react/**/*.test.ts'];
const solid = ['tests/solid/**/*.test.ts'];
const exclude = ['**/node_modules/**', ...react, ...solid];

const reactProject = {
  test: { include: react, environment: 'jsdom', benchmark: { include: [] } },
};

/**
 * `solid-js` ships conditional exports and Node's resolver picks the server
 * build, whose signals never propagate. Inlining it lets Vite resolve it with
 * the browser conditions instead (SPEC-CLIENTS §C.9).
 */
const solidProject = {
  ssr: { resolve: { conditions: ['browser', 'development'] } },
  test: { include: solid, benchmark: { include: [] }, server: { deps: { inline: ['solid-js'] } } },
};

/**
 * The bench project resolves `src/index` to the built bundle. Vite's SSR
 * transform leaves `__DEV__` as a global read and turns every import into a
 * getter on the module object — invisible in a test, a multiple in a
 * per-entity loop. `npm run bench` builds first.
 */
const bundle = [
  {
    find: /^(\.\.\/)+src\/index$/,
    replacement: fileURLToPath(new URL('./dist/index.js', import.meta.url)),
  },
];

export default defineConfig({
  test: {
    projects: [
      {
        // Source with dev assertions enabled; also the project that runs the
        // heap-delta allocation checks (SPEC §12.2).
        define: { __DEV__: 'true' },
        test: {
          name: 'dev',
          include,
          exclude,
          benchmark: { include: [] },
          // `globalThis.gc` for the heap-delta assertions — workers do not
          // inherit the parent process's V8 flags, so pass it through here.
          pool: 'forks',
          execArgv: ['--expose-gc'],
        },
      },
      {
        // Same tests with assertions compiled out, mirroring the published build.
        define: { __DEV__: 'false' },
        test: {
          name: 'prod',
          include,
          exclude,
          benchmark: { include: [] },
        },
      },
      {
        // The benchmarks measure what ships, so they run with the assertions
        // compiled out, like the published bundle (SPEC §12.1).
        define: { __DEV__: 'false' },
        resolve: { alias: bundle },
        test: {
          name: 'bench',
          include: [],
          benchmark: { include: ['bench/**/*.bench.ts'] },
        },
      },
      {
        // apecs/react over React's renderer, with and without assertions.
        ...reactProject,
        define: { __DEV__: 'true' },
        test: { ...reactProject.test, name: 'react' },
      },
      {
        ...reactProject,
        define: { __DEV__: 'false' },
        test: { ...reactProject.test, name: 'react-prod' },
      },
      {
        // apecs/solid over Solid's reactive graph, with and without assertions.
        ...solidProject,
        define: { __DEV__: 'true' },
        test: { ...solidProject.test, name: 'solid' },
      },
      {
        ...solidProject,
        define: { __DEV__: 'false' },
        test: { ...solidProject.test, name: 'solid-prod' },
      },
      {
        // Type-level tests only (`expectTypeOf` / `assertType`) — SPEC §11.
        define: { __DEV__: 'true' },
        test: {
          name: 'types',
          include: [],
          benchmark: { include: [] },
          typecheck: {
            enabled: true,
            only: true,
            include: ['tests/**/*.test-d.ts'],
            tsconfig: './tsconfig.json',
          },
        },
      },
    ],
  },
});
