/**
 * Does the ergonomic-tier cliff hit every library, or only apecs?
 * Same shape: N entities carrying k distinct traits, one pass per trait.
 *
 * ONE k per process, deliberately. Sweeping k inside a single process makes
 * every earlier k's trait shapes pollute the library's internal dispatch site,
 * so the cliff would appear even if k alone did not cause it. A fresh process
 * per k is the only way to attribute the cost to k.
 *
 *   node cliff-cross.mjs <apecs|koota|becsy|bitecs> <k>
 */
import { measure } from 'mitata';

const N = 1000;
const KS = [Number(process.argv[3])];
const which = process.argv[2];
const rows = [];

if (which === 'apecs') {
  const { Trait, World, f32 } = await import('../../dist/index.js');
  for (const k of KS) {
    const traits = Array.from({ length: k }, () => new Trait({ value: f32(0) }));
    const w = new World();
    for (let i = 0; i < N; i++) {
      w.spawn(...traits);
    }
    const qs = traits.map((t) => w.query(t));
    const fn = () => {
      for (let i = 0; i < k; i++) {
        qs[i].each((t) => (t.value += 1));
      }
    };
    for (let i = 0; i < 5; i++) {
      fn();
    }
    rows.push({ k, ns: (await measure(fn, { min_cpu_time: 700e6 })).avg / (k * N) });
  }
} else if (which === 'koota') {
  const { createQuery, createWorld, trait } = await import('koota');
  for (const k of KS) {
    const traits = Array.from({ length: k }, () => trait({ value: 0 }));
    const w = createWorld();
    for (let i = 0; i < N; i++) {
      w.spawn(...traits);
    }
    const keys = traits.map((t) => createQuery(t));
    const fn = () => {
      for (let i = 0; i < k; i++) {
        w.query(keys[i]).updateEach(([t]) => (t.value += 1));
      }
    };
    for (let i = 0; i < 5; i++) {
      fn();
    }
    rows.push({ k, ns: (await measure(fn, { min_cpu_time: 700e6 })).avg / (k * N) });
  }
} else if (which === 'bitecs') {
  const b = await import('bitecs');
  for (const k of KS) {
    const w = b.createWorld();
    const comps = Array.from({ length: k }, () => ({ value: new Float32Array(N + 1024) }));
    for (let i = 0; i < N; i++) {
      const e = b.addEntity(w);
      for (const c of comps) {
        b.addComponent(w, e, c);
      }
    }
    const terms = comps.map((c) => [c]);
    const fn = () => {
      for (let i = 0; i < k; i++) {
        const ents = b.query(w, terms[i]);
        const v = comps[i].value;
        for (let j = 0, m = ents.length; j < m; j++) {
          v[ents[j]] += 1;
        }
      }
    };
    for (let i = 0; i < 5; i++) {
      fn();
    }
    rows.push({ k, ns: (await measure(fn, { min_cpu_time: 700e6 })).avg / (k * N) });
  }
} else if (which === 'becsy') {
  const { System, Type, World } = await import('@lastolivegames/becsy/perf.js');
  for (const k of KS) {
    const comps = Array.from({ length: k }, () => {
      const C = class {};
      C.schema = { value: Type.float32 };
      return C;
    });
    class Pass extends System {
      qs = comps.map((c) => this.query((x) => x.current.with(c).write));
      execute() {
        for (let i = 0; i < comps.length; i++) {
          for (const e of this.qs[i].current) {
            e.write(comps[i]).value += 1;
          }
        }
      }
    }
    const world = await World.create({
      defs: [...comps, Pass],
      maxEntities: N + 16,
      maxShapeChangesPerFrame: N * 16 + 1024,
      maxWritesPerFrame: N * 16 + 1024,
      maxLimboComponents: 1024,
    });
    await world.build((sys) => {
      for (let i = 0; i < N; i++) {
        sys.createEntity(...comps);
      }
    });
    const fn = () => world.execute();
    for (let i = 0; i < 5; i++) {
      await fn();
    }
    rows.push({ k, ns: (await measure(fn, { min_cpu_time: 700e6 })).avg / (k * N) });
    await world.terminate();
  }
}

console.log(JSON.stringify({ library: which, rows }));
