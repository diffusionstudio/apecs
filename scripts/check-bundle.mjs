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

const bundles = readdirSync(DIST).filter((file) => file.endsWith('.js'));
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

const entry = readFileSync(join(DIST, 'index.js'), 'utf8');
const exported = /export\s*{([^}]*)}/
  .exec(entry)?.[1]
  .split(',')
  .map((name) =>
    name
      .trim()
      .split(/\s+as\s+/)
      .pop(),
  )
  .filter(Boolean)
  .sort();

check(exported !== undefined, 'dist/index.js exports nothing');
if (exported !== undefined) {
  const expected = [...SURFACE].sort();
  check(
    exported.join(',') === expected.join(','),
    `dist/index.js exports ${exported.join(', ')}\n  expected ${expected.join(', ')}`,
  );
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`✗ ${failure}`);
  }
  process.exit(1);
}

console.log(`✓ ${bundles.length} bundle(s): no dev paths, ${SURFACE.length} exports`);
