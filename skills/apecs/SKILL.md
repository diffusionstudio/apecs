---
name: apecs
description: Build with apecs — a high-performance archetype ECS for TypeScript — and its React (`apecs/react`) and Solid (`apecs/solid`) bindings. Use when writing traits, systems, queries, relations, or observers; when choosing between `get`/`each`/`chunks`/accessors; when wiring world state into a component tree; or when diagnosing "my UI doesn't update", "my system allocates", "Changed() misses writes", or archetype/query behaviour.
---

# apecs

An archetype ECS whose entire point is that iteration compiles down to a linear
scan over typed arrays with zero allocation. Every ergonomic affordance has a
documented cost, and choosing the wrong one is the main way to lose the
performance the library exists to provide. This skill is mostly about choosing
correctly.

Source of truth: [SPEC.md](../../SPEC.md) (core, §-numbered) and
[SPEC-CLIENTS.md](../../SPEC-CLIENTS.md) (bindings, §C-numbered). The specs are
current with the implementation — when in doubt, cite them, don't guess.

## Entry points

| specifier        | what                                    |
| ---------------- | --------------------------------------- |
| `apecs`          | the ECS                                 |
| `apecs/react`    | hooks, peer `react >=18`                |
| `apecs/solid`    | signal factories, peer `solid-js >=1.8` |
| `apecs/internal` | internals; not for application code     |

## The 60-second model

```ts
import { World, Trait, Changed, f32 } from 'apecs';

const Position = new Trait({ x: f32(0), y: f32(0) }); // struct — one column per field
const Velocity = new Trait({ x: f32(0), y: f32(0) });
const Mesh = new Trait(() => new THREE.Mesh()); // AoS — one boxed column
const IsEnemy = new Trait(); // tag — no column
const Time = new Trait({ delta: 0, current: 0 }); // used as a world trait

const world = new World();
world.add(Time); // no entity arg → the world entity (§5.4)

const e = world.spawn(Position({ x: 20 }), Velocity, IsEnemy);
const swarm = world.spawnMany(10_000, Position, Velocity); // ONE archetype transition

world.query(Position, Velocity).each((p, v) => {
  // IsEnemy would contribute no arg
  p.x += v.x * world.get(Time.delta);
});
```

- **Traits are global, worlds are isolated.** Declare traits once at module
  scope; a world only pays for the traits it actually uses (§5.3).
- **Entities are packed 52-bit numbers**, not objects. `world.add(T)` targets the
  world entity, `world.add(e, T)` targets `e` — the overload is discriminated on
  "first argument is a number" (§4.1, §5.4).
- **Queries are cached and incrementally maintained.** Calling
  `world.query(Position, Velocity)` every frame is the intended usage and is an
  O(1) hash lookup — matching cost per frame is zero (§6.2).

## Pick the right access tier

This is the decision that matters. Each row is honest about its cost.

| Situation                                           | Use                          | Cost                                      |
| --------------------------------------------------- | ---------------------------- | ----------------------------------------- |
| One entity, cold path (UI, editor, event handler)   | `world.get(e, Position)`     | resolves per call; **allocates a copy**   |
| One entity, one value, cold path                    | `world.get(e, Position.x)`   | resolves per call; no allocation          |
| One entity, hot path, arbitrary order               | `world.accessor(Position.x)` | resolve once; ~2 indirections per access  |
| Many entities, ergonomic, up to a few thousand      | `query.each((p, v) => …)`    | 1.1–1.5× a raw loop, zero allocation      |
| Many entities, arithmetic, tens of thousands and up | `query.chunks()`             | ~1.1× a raw loop; no tracking, no checks  |
| Need deterministic order                            | `query.sortBy(field, dir)`   | memoised; O(n) resort, O(n log n) rebuild |
| Need parent-before-child order                      | `query(…, Cascade(ChildOf))` | materialised; `each`/iteration, no chunks |

Rules of thumb:

- **Start with `each`.** Drop to `chunks` when a benchmark says to, not before.
- **Hoist accessors and queries** the way you would hoist a compiled regex.
  `world.accessor(Position.x)` is memoised per `(world, field)`, so calling it
  inline is free after the first call, but a named binding reads better.
- **`world.get` on a struct trait allocates.** In any loop, either pass an `out`
  object (`world.get(e, Position, out)`) or read a field (`Position.x`).

## Structural changes during iteration

Archetypes iterate back-to-front with swap-remove. So:

- Reading/writing values on **any** entity: safe.
- Adding/removing traits on, or despawning, **the current** entity: safe.
- Touching **any other** entity, or spawning: **must be deferred**.

```ts
world.query(Health).each((hp, e) => {
  if (hp.current <= 0) world.defer(() => world.despawn(e)); // any-other-entity case
});
// each() / chunks() flush automatically at the outermost exit
```

`query.entities()` returns a snapshot copy and is always safe — the escape hatch
when deferral is awkward. Dev builds detect unsafe mutation; production does not.

## Change detection

Two mechanisms, for two different questions (§8):

- **Push — `world.onAdd` / `onRemove` / `onChange` / `onEnter` / `onExit`.**
  Dispatched synchronously inside the write. `onRemove` fires _before_ the data is
  destroyed, which is what makes it usable for disposing GPU/DOM resources.
- **Pull — `Changed(T)` / `Added(T)` / `Removed(T)` query terms.** A linear scan
  of a `Uint32Array`, driven by `world.step()` advancing the tick. Each such query
  keeps its own last-seen tick, so two systems don't steal each other's events.

At scale prefer pull. And know the one silent failure mode:

> **Chunk writes bypass change tracking.** After writing columns through
> `chunks()`, call `chunk.markChanged(Trait)` — otherwise `Changed()` filters miss
> the write, sorted views don't resort, and `onChange`-driven UI never updates.
> Dev warns about a missing `markChanged`; production is silent.

## Relations

```ts
const ChildOf = new Relation(undefined, { exclusive: true, onTargetDespawn: 'despawn' });
const child = world.spawn(ChildOf(parent));

world.query(ChildOf(parent)); // children of one parent
world.query(ChildOf('*')); // anything with a parent
world.query(Position, Not(ChildOf('*'))); // roots
world.target(child, ChildOf); // Entity — NULL_ENTITY (0) when absent, not undefined
```

**Choose `exclusive: true` whenever an entity has at most one target.** Exclusive
relations store the target in a column plus a target index: one archetype no
matter how many parents exist, and re-targeting costs no archetype transition.
Non-exclusive relations intern one pair id per `(relation, target)` into the
archetype mask — correct at low fan-out (`Likes`, `Owes`), pathological at high
fan-out. Dev warns past a threshold (§7.4).

## UI bindings in one rule

**Systems iterate; components read single values.** Never call `each` or `chunks`
in a render function. The bindings project a mutable, frame-rate-decoupled world
into a framework by gating on _value_ (never on "a write happened") and coalescing
to at most one update per animation frame.

```tsx
import { WorldProvider, useField, useQuery, useWorld } from 'apecs/react';

<WorldProvider world={world}>…</WorldProvider>; // required; hooks throw without it

const hp = useField(player, Health.current); // primitive, gated on Object.is
const score = useField(Score.value); // no entity → world trait
const enemies = useQuery(Position, IsEnemy); // readonly Entity[], keyed by entity
```

Solid is the same set under `create*` names (`createField`, `createQuery`, …) with
bare `on*` for the owner-bound subscriptions — everything returns a getter, so
call it. Full mapping in [references/solid.md](references/solid.md).

Two things to internalise before writing any binding code:

1. **Mounting a hook makes its trait tracked world-wide**, so every system write to
   that trait then stamps a tick (§C.3.5). It is a real cost on the simulation, not
   just on the component.
2. **Anything that changes every frame does not belong in a re-render.** Use the
   imperative hooks (`useOnChange` / `onChange`, …) and write into a ref or canvas.
   That is what they exist for.

## References

- [references/core.md](references/core.md) — full core API, trait schemas, tier
  recipes, query terms, lifecycle, and the core gotcha checklist.
- [references/react.md](references/react.md) — every hook, the cell/flush model as
  React sees it, testing, and the React gotcha checklist.
- [references/solid.md](references/solid.md) — every signal factory, the same
  model in Solid's idiom, testing, and the Solid gotcha checklist.

Load one binding reference, not both — they are self-contained and the model
sections restate each other on purpose.

## Working in this repo

```bash
npm test              # all vitest projects
npm run test:dev      # dev build — assertions on
npm run test:prod     # prod build — assertions stripped; parity must hold
npm run test:types    # type-level tests (*.test-d.ts)
npm run typecheck
npm run bench         # builds first, then vitest bench
npm run check:bundle  # entry export lists; react/solid stay external
```

Conventions that hold across the codebase: tests first, then implementation;
dev-only assertions behind `__DEV__` so the production build drops them entirely;
no allocation in `each` or `chunks` after warmup (asserted by a heap-delta test);
no `Proxy`, no generators, and no megamorphic call sites in the iteration path.
