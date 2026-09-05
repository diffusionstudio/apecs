# apecs schedule — Specification

The scheduler. Part of core and exported from `apecs`, specified in its own
document rather than as a section of [core.md](core.md) so that document's section
numbers stay put. Section references of the form §n point at core.md; references
within this document are written §S.n.

A schedule is a list of named systems with ordering constraints, plus the clock
advance that otherwise sits at the top of the frame by hand. It gives a frame one
call site and a deterministic order, and does nothing else: it is not a
dependency injector, a stage graph, or a parallel executor.

---

## S.1 Goals

1. **Deterministic order.** The same set of systems and constraints produces the
   same order on every run, in every build, independent of insertion order where
   constraints decide it and following insertion order where they do not.
2. **One call per frame.** The schedule owns `world.step()`, so the clock advance
   cannot be forgotten or accidentally doubled (§8.3).
3. **Nothing in the hot path.** All of the work is done when a system is added:
   ordering resolves on mutation, and the resolved order is compiled into a flat
   call sequence. A run is two branches, the clock advance, and one direct call
   per system — the same shape a hand-written frame has.
4. **Free when unused.** The scheduler is a leaf: no core module imports it, and
   nothing in a world knows a schedule exists. A frame driven by hand costs
   exactly what it did before, and a bundler drops the class from an app that
   never constructs one.

### Non-goals for v1

- No profiling or instrumentation hooks. Timing belongs to devtools (§15) and
  needs per-query counters core does not yet expose.
- No stages. `before`/`after` expresses grouping; stages are sugar over it and can
  be added without breaking this surface.
- No run conditions, no parallelism, no automatic `world.flush()`.

---

## S.2 Placement

`Schedule` is exported from `apecs` and is part of the frozen §14 surface. It lives
in `src/core/schedule.ts` and depends on one thing core already had: `world.step()`
(§8.3). The dependency runs one way — no core module imports the scheduler — which
is what keeps a hand-written frame free of it.

---

## S.3 Systems

A system is a plain function of the world.

```ts
type System<W extends World = World> = (world: W) => void;
```

Per-frame values are not parameters. `dt` reaches a system the way §13 passes it:
through a world trait the frame writes before running the schedule. This keeps the
signature monomorphic and keeps a system callable directly, without the schedule,
in a test.

`Schedule` is generic over the world type, so a `Schedule<Game>` accepts systems
declared as `(world: Game) => void` (§5.2).

---

## S.4 Registration

```ts
const sim = new Schedule()
  .add('movement', movement)
  .add('collide', collide, { after: 'movement' })
  .add('reap', reap, { after: ['collide', 'movement'] });
```

- `add(name, system, options?)` registers a system under a name and returns the
  schedule. `before` and `after` each take a name or an array of names.
- A name is unique within a schedule. Re-adding one throws in dev; production
  keeps the first registration and ignores the second.
- `remove(name)` deregisters, returning whether it was there. `has(name)` and
  `size` report membership. `clear()` empties the schedule.

Registration order is the tiebreak, not the order: two systems with no constraint
between them run in the order they were added.

---

## S.5 Ordering

Constraints form a directed graph — `before` is an edge out, `after` an edge in —
resolved into a run order by a **minimal-disturbance** topological sort: the
systems are walked in registration order and each is emitted only after the ones
it must follow. A constraint therefore moves exactly the systems it names and
leaves every other system where it was registered, which is both deterministic
and the least surprising thing to read in a diff.

Because the sort is over predecessors, the resolved order does not depend on
whether a constraint was written as the `before` on one system or the `after` on
the other, nor on the order the systems were declared in where constraints decide
it.

`order` exposes the resolved order as names, resolving first if the schedule has
changed since the last run. It is the seam a future inspector reads.

Resolution is lazy and cached: it runs on the first `run` or `order` after a
mutation, never per frame.

**Errors.** Dev throws on a constraint naming a system that is not registered, on
a system ordered against itself, and on a cycle, which is reported as the chain
that closes it. A failed resolve leaves the schedule dirty and the previous order
intact, so the next access reports the same fault rather than running a
half-resolved order. Production degrades predictably instead, in the manner of §9:
an unknown name drops that one edge, and a cycle drops the edge that closes it, so
every system still runs exactly once.

---

## S.6 Running

```ts
sim.run(world); // world.step(), then every system in order
```

`run` advances the clock once and then calls each system with the world. A
schedule constructed with `{ step: false }` skips the advance, which is what a
second schedule over the same world uses:

```ts
const sim = new Schedule(); // owns the clock
const render = new Schedule({ step: false });

accumulator += dt;
while (accumulator >= FIXED) {
  sim.run(world);
  accumulator -= FIXED;
}
render.run(world);
```

**Exactly one schedule per frame may own the clock.** The number of steps per
frame is observable: a removal is visible for exactly one tick (§8.3), so a second
advance can expire a `Removed()` record before a once-per-frame system runs.

**Dispatch.** The resolved order is not walked as an array at run time. It is
compiled once, at resolve time, into a single function with one call site per
system — `function (w) { f0(w); f1(w); … }` — so each call is direct and
monomorphic rather than a load-and-call through an array, which is megamorphic by
construction once a schedule holds more than a few distinct functions. Systems are
bound positionally: **a system name never reaches the generated source**, so a
name is data, not code.

The fallback is the array loop, taken where `new Function` is unavailable (a CSP
without `unsafe-eval`, probed once at load — §6.5) or past 512 systems, where the
generated function outgrows what an engine will optimise. Both paths run the same
order; only the dispatch shape differs.

`schedule-dispatch` measures the gap on sixteen systems that do nothing, which is
the worst case for a scheduler: flattened dispatch is within 8% of the
hand-written frame, against 3.4x slower for the array loop. On systems that do a
frame's worth of work the difference is unmeasurable either way — the flattening
exists so that nobody has to think about it, not because a frame can feel it.

`run` reads the dispatcher before the first system runs, so `add` and `remove`
called from inside a system are safe and take effect on the next run. Dev throws
on a reentrant `run` on the same schedule.

The schedule does not call `world.flush()`. `each` and `chunks` already flush at
the outermost exit (§9); a system that defers outside any iteration owns its own
flush, as it does today.

---

## S.7 API surface

```ts
new Schedule<W extends World = World>(options?: ScheduleOptions)

schedule.add(name, system, options?): this
schedule.remove(name): boolean
schedule.has(name): boolean
schedule.clear(): void
schedule.size: number
schedule.order: readonly string[]
schedule.run(world): void

interface ScheduleOptions {
  step?: boolean; // default true
}
interface SystemOptions {
  before?: string | readonly string[];
  after?: string | readonly string[];
}
```
