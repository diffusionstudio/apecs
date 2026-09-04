/**
 * The cross-library benchmark set.
 *
 * Shapes follow noctjs/ecs-benchmark where one exists, so our numbers sit next
 * to the tables those libraries already publish. `simple_iter` and `frag_iter`
 * instead follow SPEC §12.1, because those are the shapes apecs states its own
 * budget against and re-deriving them here would give us two different answers
 * to the same question.
 *
 * Every benchmark is self-restoring: one call leaves the world as it found it,
 * so a measurement loop can call it a million times without drift.
 */

export const BENCHMARKS = {
  packed_1: {
    label: 'packed_1',
    params: { entities: 5_000 },
    what: '5 000 entities, five traits each, one arithmetic pass over one trait.',
    measures: 'Best-case iteration. One archetype, no misses, nothing to skip.',
  },
  packed_5: {
    label: 'packed_5',
    params: { entities: 1_000 },
    what: '1 000 entities, five traits each, five passes — one per trait.',
    measures: 'Per-query fixed cost. Five short scans expose setup overhead a long scan hides.',
  },
  simple_iter: {
    label: 'simple_iter',
    params: { entities: 100_000 },
    what: '100 000 entities, Position + Velocity, one integrate pass (SPEC §12.1).',
    measures: 'The real-world hot loop. This is the number that matters most.',
  },
  frag_iter: {
    label: 'frag_iter',
    params: { entities: 100_000, archetypes: 26 },
    what: '100 000 entities spread over 26 archetypes, iterate the one shared trait.',
    measures: 'Fragmentation cost. Archetype designs pay per archetype; sparse-set designs do not.',
  },
  entity_cycle: {
    label: 'entity_cycle',
    params: { entities: 100_000 },
    what: 'Spawn 100 000 entities with two traits, then despawn all of them.',
    measures: 'Entity churn: id allocation, row insert, row release, free-list reuse.',
  },
  add_remove: {
    label: 'add_remove',
    params: { entities: 100_000 },
    what: 'Add a trait to 100 000 existing entities, then remove it from all of them.',
    measures: 'Structural change. Archetype designs move a row; sparse-set designs flip a bit.',
  },
  mixed_query: {
    label: 'mixed_query',
    params: { entities: 100_000, archetypes: 26, excluded: 13 },
    what: '26 archetypes; query the shared trait while excluding 13 of the 26 fragment traits.',
    measures:
      'Negation. Archetype matching resolves it once at query build; per-entity designs re-test every entity.',
  },
  random_access: {
    label: 'random_access',
    params: { entities: 100_000 },
    what: 'Read and write one field on 100 000 entities in shuffled order, by entity handle.',
    measures:
      'The archetype tax. Random access is where a row-indirection design should lose to a flat sparse set.',
  },
}

/** Ergonomic tier = the idiom a user reaches for. Raw tier = the escape hatch. */
export const TIERS = { ergonomic: 'ergonomic', raw: 'raw' }

export const ADAPTERS = ['baseline', 'apecs', 'bitecs', 'koota', 'becsy']

/** A deterministic shuffle, so every library walks the same "random" order. */
export function permutation(n) {
  const order = new Uint32Array(n)
  for (let i = 0; i < n; i++) order[i] = i
  let state = 0x9e3779b9
  for (let i = n - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    const j = state % (i + 1)
    const t = order[i]
    order[i] = order[j]
    order[j] = t
  }
  return order
}

/** How many entities land in fragment `f` of `archetypes`, summing to `entities`. */
export function fragmentSizes(entities, archetypes) {
  const sizes = new Array(archetypes)
  const per = Math.floor(entities / archetypes)
  let rest = entities - per * archetypes
  for (let f = 0; f < archetypes; f++) sizes[f] = per + (f < rest ? 1 : 0)
  return sizes
}
