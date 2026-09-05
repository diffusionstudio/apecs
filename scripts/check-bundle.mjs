/**
 * Checks that the published build is the production build: `__DEV__` is
 * substituted rather than read, the assertion and warning bodies are gone, and
 * the entry point exports the §14 surface and nothing else (SPEC §12.2, §14).
 *
 *   npm run build && node scripts/check-bundle.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIST = 'dist';

const SURFACE = [
  'VERSION',
  'Trait',
  'Relation',
  'World',
  'Schedule',
  'Not',
  'Or',
  'With',
  'Optional',
  'Added',
  'Removed',
  'Changed',
  'Cascade',
  'f32',
  'f64',
  'i8',
  'i16',
  'i32',
  'u8',
  'u16',
  'u32',
  'bool',
  'str',
  'eid',
];

/** Comments still mention `__DEV__`; only emitted code matters. */
function code(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const failures = [];

function check(condition, message) {
  if (!condition) {
    failures.push(message);
  }
}

/** Entry point → the exports it is allowed to have, in any order. */
const ENTRIES = {
  'index.js': SURFACE,
  'react/index.js': [
    'WorldProvider',
    'useWorld',
    'useField',
    'useTrait',
    'useHas',
    'useTag',
    'useQuery',
    'useQueryFirst',
    'useSortedQuery',
    'useSortedQueryFirst',
    'useTarget',
    'useParent',
    'useChildren',
    'useAccessor',
    'useEntity',
    'useOn',
  ],
  'solid/index.js': [
    'WorldProvider',
    'useWorld',
    'createField',
    'createTrait',
    'createHas',
    'createTag',
    'createQuery',
    'createQueryFirst',
    'createSortedQuery',
    'createSortedQueryFirst',
    'createTarget',
    'createParent',
    'createChildren',
    'createAccessor',
    'createEntity',
    'on',
  ],
};

/** Names a module re-exports, `x as y` resolved to `y`. */
function exportsOf(file) {
  const source = readFileSync(join(DIST, file), 'utf8');
  return /export\s*{([^}]*)}/
    .exec(source)?.[1]
    .split(',')
    .map((name) =>
      name
        .trim()
        .split(/\s+as\s+/)
        .pop(),
    )
    .filter(Boolean)
    .sort();
}

// Subpath entries live in their own directories (dist/react/index.js).
const bundles = readdirSync(DIST, { recursive: true }).filter((file) => file.endsWith('.js'));
check(bundles.length > 0, `no bundles in ${DIST}/ — run npm run build first`);

for (const file of bundles) {
  const source = code(readFileSync(join(DIST, file), 'utf8'));
  check(!source.includes('__DEV__'), `${file} still reads __DEV__ at runtime`);
  check(!/\bconsole\s*\./.test(source), `${file} still calls console`);
  for (const helper of ['assert', 'warn', 'warnOnce']) {
    const body = new RegExp(`function ${helper}\\([^)]*\\)\\s*{([^}]*)}`).exec(source);
    if (body !== null) {
      check(body[1].trim() === '', `${file} keeps a body for ${helper}()`);
    }
  }
}

for (const [file, surface] of Object.entries(ENTRIES)) {
  const exported = exportsOf(file);
  check(exported !== undefined, `dist/${file} exports nothing`);
  if (exported !== undefined) {
    const expected = [...surface].sort();
    check(
      exported.join(',') === expected.join(','),
      `dist/${file} exports ${exported.join(', ')}\n  expected ${expected.join(', ')}`,
    );
  }
}

// The bindings are subpaths of this package, not repackagings of a framework:
// react and solid-js stay external, and the core they share stays one chunk.
for (const [file, peer] of [
  ['react/index.js', 'react'],
  ['solid/index.js', 'solid-js'],
]) {
  const source = readFileSync(join(DIST, file), 'utf8');
  check(
    new RegExp(`from\\s*["']${peer}["']`).test(source),
    `dist/${file} does not import ${peer} — it was bundled instead of externalised`,
  );
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`✗ ${failure}`);
  }
  process.exit(1);
}

console.log(
  `✓ ${bundles.length} bundle(s): no dev paths, ` +
    `${Object.keys(ENTRIES).length} entries with the expected surface`,
);
