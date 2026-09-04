/**
 * The hand-written floor: plain typed arrays and index arithmetic, no ECS.
 * Every library number is only meaningful as a ratio against this one.
 */
import { fragmentSizes, permutation } from '../lib/spec.mjs';

const F = (n) => new Float32Array(n);

export const name = 'baseline';
export const version = 'hand-written';
export const notes =
  'Typed arrays and index arithmetic. No entity ids, no queries, no structural change.';

export const benchmarks = {
  'packed_1/raw': ({ entities }) => {
    const a = F(entities);
    return () => {
      for (let i = 0; i < entities; i++) {
        a[i] += 1;
      }
    };
  },

  'packed_5/raw': ({ entities }) => {
    const columns = [F(entities), F(entities), F(entities), F(entities), F(entities)];
    return () => {
      for (let c = 0; c < 5; c++) {
        const column = columns[c];
        for (let i = 0; i < entities; i++) {
          column[i] += 1;
        }
      }
    };
  },

  'simple_iter/raw': ({ entities }) => {
    const x = F(entities);
    const y = F(entities);
    const vx = F(entities);
    const vy = F(entities);
    for (let i = 0; i < entities; i++) {
      vx[i] = 1;
      vy[i] = 2;
    }
    const dt = 1 / 60;
    return () => {
      for (let i = 0; i < entities; i++) {
        x[i] += vx[i] * dt;
        y[i] += vy[i] * dt;
      }
    };
  },

  'frag_iter/raw': ({ entities, archetypes }) => {
    // 26 separate blocks is exactly what 26 archetypes are, minus the bookkeeping.
    const blocks = fragmentSizes(entities, archetypes).map(F);
    return () => {
      for (let b = 0; b < blocks.length; b++) {
        const block = blocks[b];
        for (let i = 0, n = block.length; i < n; i++) {
          block[i] += 1;
        }
      }
    };
  },

  'entity_cycle/raw': ({ entities }) => {
    const free = new Uint32Array(entities);
    const generations = new Uint16Array(entities);
    const x = F(entities);
    let top = 0;
    return () => {
      for (let i = 0; i < entities; i++) {
        free[top++] = i;
        x[i] = i;
      }
      while (top > 0) {
        generations[free[--top]]++;
      }
    };
  },

  'add_remove/raw': ({ entities }) => {
    // A trait add/remove with no archetype graph: flip a bit, keep a dense list.
    const has = new Uint8Array(entities);
    const dense = new Uint32Array(entities);
    let count = 0;
    return () => {
      for (let i = 0; i < entities; i++) {
        has[i] = 1;
        dense[count++] = i;
      }
      for (let i = 0; i < entities; i++) {
        has[i] = 0;
      }
      count = 0;
    };
  },

  'mixed_query/raw': ({ entities, archetypes, excluded }) => {
    const blocks = fragmentSizes(entities, archetypes).map(F);
    const kept = blocks.slice(excluded);
    return () => {
      for (let b = 0; b < kept.length; b++) {
        const block = kept[b];
        for (let i = 0, n = block.length; i < n; i++) {
          block[i] += 1;
        }
      }
    };
  },

  'random_access/raw': ({ entities }) => {
    const x = F(entities);
    const order = permutation(entities);
    return () => {
      for (let i = 0; i < entities; i++) {
        const e = order[i];
        x[e] = x[e] + 1;
      }
    };
  },
};

/** The counts every library must reproduce. */
export function census({ entities, archetypes, excluded }) {
  const sizes = fragmentSizes(entities, archetypes);
  return {
    packed_1: entities,
    packed_5: entities * 5,
    simple_iter: entities,
    frag_iter: sizes.reduce((a, b) => a + b, 0),
    mixed_query: sizes.slice(excluded).reduce((a, b) => a + b, 0),
  };
}

/** The floor: four Float32Arrays. 16 bytes of payload per entity, nothing else. */
export function footprint(n) {
  const world = { x: F(n), y: F(n), vx: F(n), vy: F(n) };
  for (let i = 0; i < n; i++) {
    world.x[i] = i;
    world.y[i] = i;
    world.vx[i] = 1;
    world.vy[i] = 2;
  }
  return world;
}
