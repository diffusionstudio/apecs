/**
 * bitECS 0.4 — sparse sets over user-owned typed arrays. There is no
 * ergonomic tier to measure: the raw arrays *are* the API, so every
 * benchmark here is bitECS at full speed.
 *
 * `query(world, terms)` is called inside the measured function because that is
 * the documented idiom; the terms array is hoisted so we are not measuring an
 * allocation bitECS users would not make.
 */
import {
  Not,
  addComponent,
  addEntity,
  createWorld,
  query,
  removeComponent,
  removeEntity,
} from 'bitecs';
import { fragmentSizes, permutation } from '../lib/spec.mjs';

export const name = 'bitECS';
export const version = '0.4.0';
export const notes =
  'Sparse sets; components are user-owned typed arrays indexed by entity id. No archetypes, no ergonomic tier.';

const DT = 1 / 60;
const soa1 = (n) => ({ value: new Float32Array(n) });
const soa2 = (n) => ({ x: new Float32Array(n), y: new Float32Array(n) });

/** bitECS ids are recycled but not dense-from-zero; leave headroom. */
const slots = (entities) => entities + 1024;

function packedWorld(entities) {
  const world = createWorld();
  const comps = [
    soa1(slots(entities)),
    soa1(slots(entities)),
    soa1(slots(entities)),
    soa1(slots(entities)),
    soa1(slots(entities)),
  ];
  for (let i = 0; i < entities; i++) {
    const e = addEntity(world);
    for (let c = 0; c < comps.length; c++) {
      addComponent(world, e, comps[c]);
    }
  }
  return { world, comps };
}

function fragmentedWorld(entities, archetypes) {
  const world = createWorld();
  const Data = soa1(slots(entities));
  const fragments = Array.from({ length: archetypes }, () => ({}));
  const sizes = fragmentSizes(entities, archetypes);
  for (let f = 0; f < archetypes; f++) {
    for (let i = 0; i < sizes[f]; i++) {
      const e = addEntity(world);
      addComponent(world, e, Data);
      addComponent(world, e, fragments[f]);
    }
  }
  return { world, Data, fragments };
}

export const benchmarks = {
  'packed_1/raw': ({ entities }) => {
    const { world, comps } = packedWorld(entities);
    const A = comps[0];
    const terms = [A];
    return () => {
      const ents = query(world, terms);
      const value = A.value;
      for (let i = 0, n = ents.length; i < n; i++) {
        value[ents[i]] += 1;
      }
    };
  },

  'packed_5/raw': ({ entities }) => {
    const { world, comps } = packedWorld(entities);
    const terms = comps.map((c) => [c]);
    return () => {
      for (let c = 0; c < comps.length; c++) {
        const ents = query(world, terms[c]);
        const value = comps[c].value;
        for (let i = 0, n = ents.length; i < n; i++) {
          value[ents[i]] += 1;
        }
      }
    };
  },

  'simple_iter/raw': ({ entities }) => {
    const world = createWorld();
    const Position = soa2(slots(entities));
    const Velocity = soa2(slots(entities));
    for (let i = 0; i < entities; i++) {
      const e = addEntity(world);
      addComponent(world, e, Position);
      addComponent(world, e, Velocity);
      Position.x[e] = i;
      Position.y[e] = i;
      Velocity.x[e] = 1;
      Velocity.y[e] = 2;
    }
    const terms = [Position, Velocity];
    return () => {
      const ents = query(world, terms);
      const { x, y } = Position;
      const { x: vx, y: vy } = Velocity;
      for (let i = 0, n = ents.length; i < n; i++) {
        const e = ents[i];
        x[e] += vx[e] * DT;
        y[e] += vy[e] * DT;
      }
    };
  },

  'frag_iter/raw': ({ entities, archetypes }) => {
    const { world, Data } = fragmentedWorld(entities, archetypes);
    const terms = [Data];
    return () => {
      const ents = query(world, terms);
      const value = Data.value;
      for (let i = 0, n = ents.length; i < n; i++) {
        value[ents[i]] += 1;
      }
    };
  },

  'entity_cycle/raw': ({ entities }) => {
    const world = createWorld();
    const Position = soa2(slots(entities));
    const Velocity = soa2(slots(entities));
    const live = new Uint32Array(entities);
    return () => {
      for (let i = 0; i < entities; i++) {
        const e = addEntity(world);
        addComponent(world, e, Position);
        addComponent(world, e, Velocity);
        live[i] = e;
      }
      for (let i = 0; i < entities; i++) {
        removeEntity(world, live[i]);
      }
    };
  },

  'add_remove/raw': ({ entities }) => {
    const world = createWorld();
    const Position = soa2(slots(entities));
    const Velocity = soa2(slots(entities));
    const live = new Uint32Array(entities);
    for (let i = 0; i < entities; i++) {
      const e = addEntity(world);
      addComponent(world, e, Position);
      live[i] = e;
    }
    return () => {
      for (let i = 0; i < entities; i++) {
        addComponent(world, live[i], Velocity);
      }
      for (let i = 0; i < entities; i++) {
        removeComponent(world, live[i], Velocity);
      }
    };
  },

  'mixed_query/raw': ({ entities, archetypes, excluded }) => {
    const { world, Data, fragments } = fragmentedWorld(entities, archetypes);
    const terms = [Data, Not(...fragments.slice(0, excluded))];
    return () => {
      const ents = query(world, terms);
      const value = Data.value;
      for (let i = 0, n = ents.length; i < n; i++) {
        value[ents[i]] += 1;
      }
    };
  },

  'random_access/raw': ({ entities }) => {
    const world = createWorld();
    const Position = soa2(slots(entities));
    const live = new Uint32Array(entities);
    for (let i = 0; i < entities; i++) {
      const e = addEntity(world);
      addComponent(world, e, Position);
      live[i] = e;
    }
    const order = permutation(entities);
    const x = Position.x;
    return () => {
      for (let i = 0; i < entities; i++) {
        const e = live[order[i]];
        x[e] = x[e] + 1;
      }
    };
  },
};

/** How many entities each query-shaped benchmark actually matches. */
export function census({ entities, archetypes, excluded }) {
  const packed = packedWorld(entities);
  const frag = fragmentedWorld(entities, archetypes);
  const simple = createWorld();
  const P = soa2(slots(entities));
  const V = soa2(slots(entities));
  for (let i = 0; i < entities; i++) {
    const e = addEntity(simple);
    addComponent(simple, e, P);
    addComponent(simple, e, V);
  }
  return {
    packed_1: query(packed.world, [packed.comps[0]]).length,
    packed_5: packed.comps.reduce((n, c) => n + query(packed.world, [c]).length, 0),
    simple_iter: query(simple, [P, V]).length,
    frag_iter: query(frag.world, [frag.Data]).length,
    mixed_query: query(frag.world, [frag.Data, Not(...frag.fragments.slice(0, excluded))]).length,
  };
}

/** A world of `n` entities carrying Position + Velocity, for the memory probe. */
export function footprint(n) {
  const world = createWorld();
  const Position = soa2(slots(n));
  const Velocity = soa2(slots(n));
  for (let i = 0; i < n; i++) {
    const e = addEntity(world);
    addComponent(world, e, Position);
    addComponent(world, e, Velocity);
    Position.x[e] = i;
    Position.y[e] = i;
    Velocity.x[e] = 1;
    Velocity.y[e] = 2;
  }
  return { world, Position, Velocity };
}
