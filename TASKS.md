# apecs — Implementation Task List

TDD, stage by stage. **Every stage is two phases: write all of its unit tests first (phase A),
then make them green (phase B).** No implementation task in a stage starts before every test
task in that stage is written. Tests are authored against [SPEC.md](SPEC.md) — tasks reference
sections, they do not restate behaviour.

Phase-A tests are red on arrival; that is the point. Their listed dependencies are only on
**earlier stages'** implementations — the things a test must be able to call to run at all.
Phase-B tasks depend on their own test task plus any implementation earlier in the same stage.

Legend: `→` = depends on. A task is done when its tests pass under both the `dev` and `prod`
vitest projects unless noted.

---

## Stage 0 — Primitives

Stage gate: none. Everything here can start immediately.

### 0-A [COMPLETED]— Tests (all with no dependencies; write in parallel)

| ID        | Test task                                                                                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **T0.1**  | Entity handle pack/unpack, `NULL_ENTITY`, reserved ids, field widths and limits (§4.1, §12.3)                                                                                  |
| **T0.2**  | Field markers, bare-value inference, nested-object flattening, column-order stability, boxed-value dev warning (§3.2)                                                          |
| **T0.3**  | `Trait` declaration for struct/tag/AoS, `instanceof` + callability, fields-only string keys, symbol-keyed internals, trait instances, options parsing (§3.1, §3.3, §3.4, §3.5) |
| **T0.4**  | `Relation` declaration and options surface (§7.1)                                                                                                                              |
| **T0.5**  | Term modifier constructors and nesting, data-bearing vs non-data classification (§6.1)                                                                                         |
| **T0.6**  | Trait mask blocks — set/clear/test/superset/growth (§10.1)                                                                                                                     |
| **T0.7**  | Paged column — append/grow without reallocating existing pages, swap-remove, tail page, typed + boxed + AoS columns (§10.2)                                                    |
| **T0.8**  | Entity index — parallel typed arrays, generation liveness compare, growth past `maxEntities` (§10.3, §5.1)                                                                     |
| **T0.9**  | `new Function` capability probe, single detection at module load (§6.5)                                                                                                        |
| **T0.10** | Dev-assertion helper — throws in `dev`, compiled out in `prod` (§12.2)                                                                                                         |

### 0-B [COMPLETED] — Implementation

| ID        | Impl task                                            | →                |
| --------- | ---------------------------------------------------- | ---------------- |
| **I0.1**  | Handle codec                                         | T0.1             |
| **I0.2**  | Markers + schema normalisation                       | T0.2             |
| **I0.6**  | Masks                                                | T0.6             |
| **I0.9**  | Codegen capability probe                             | T0.9             |
| **I0.10** | `__DEV__` assertion helpers                          | T0.10            |
| **I0.3**  | `Trait`                                              | T0.3, I0.2       |
| **I0.7**  | Paged columns                                        | T0.7, I0.2       |
| **I0.8**  | Entity index                                         | T0.8, I0.1       |
| **I0.4**  | `Relation`                                           | T0.4, I0.3       |
| **I0.5**  | `Not/Or/With/Optional/Added/Removed/Changed/Cascade` | T0.5, I0.3, I0.4 |

---

## Stage 1 — World, archetypes, entity lifecycle

Stage gate: **0-B complete.**

### 1-A [COMPLETED] — Tests

| ID       | Test task                                                                                                                                                            |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **T1.1** | `World` construction + options, world-id allocation/release/reuse, prototype methods overridable, subclass field isolation, `super()` ordering rule (§5.1, §5.2)     |
| **T1.2** | Global trait id → dense per-world local id, lazy storage allocation, unused traits cost nothing, cross-world isolation (§5.3)                                        |
| **T1.3** | Archetype graph — lazy add/remove edges cached, row move on transition, mask identity (§10.1, §10.2)                                                                 |
| **T1.4** | `spawn` with instances/bare tags/defaults, `despawn`, `isAlive`, FIFO id recycling, generation bump, retirement on wrap, foreign-world handle detection (§4.1, §4.2) |
| **T1.5** | `add` / `remove` / `has` incl. re-add, no-op remove, defaults applied per entity, AoS factory called once per entity (§3.1, §4.4)                                    |
| **T1.6** | `get` copy semantics, `get` with field, `get` with `out`, `set` partial write, field `set` (§4.4, §3.3)                                                              |
| **T1.7** | World entity is id 1, world-trait overloads resolve unambiguously, `world.entity` (§5.4)                                                                             |
| **T1.8** | `spawnMany` / `addMany` / `removeMany` / `despawnMany`, single transition per batch, query as batch input (§4.3)                                                     |

### 1-B [COMPLETED] — Implementation

| ID       | Impl task                 | →                      |
| -------- | ------------------------- | ---------------------- |
| **I1.1** | `World` shell             | T1.1, I0.1, I0.10      |
| **I1.2** | Per-world trait registry  | T1.2, I1.1, I0.3, I0.6 |
| **I1.3** | Archetype graph           | T1.3, I1.2, I0.7       |
| **I1.4** | Entity lifecycle          | T1.4, I1.3, I0.8       |
| **I1.5** | Per-entity structural ops | T1.5, I1.4             |
| **I1.6** | `get` / `set`             | T1.6, I1.5             |
| **I1.7** | World-target overloads    | T1.7, I1.6             |
| **I1.8** | Bulk operations           | T1.8, I1.5             |

---

## Stage 2 — Queries and the three access tiers

Stage gate: **1-B complete.**

### 2-A [COMPLETED] — Tests

| ID       | Test task                                                                                                                                                             |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **T2.1** | Term list compiles to a mask predicate, archetypes tested once at creation, incremental matching-list maintenance (§6.1, §10.4)                                       |
| **T2.2** | Signature hashing returns the identical object, `createQuery`, `dispose`, `queryFirst` (§6.2, §6.3)                                                                   |
| **T2.3** | `count` / `isEmpty` / `first` / `Symbol.iterator` / `entities()` snapshot safety (§6.3, §6.4)                                                                         |
| **T2.4** | Per-trait cursor classes (tracked + untracked variants), page binding and row advance, borrowed-cursor poisoning in dev (§6.5)                                        |
| **T2.5** | `each` argument positions and trailing entity, tags/`Not`/`With` contribute nothing, `Optional` yields cursor-or-null, AoS yields the reference (§6.1, §6.5)          |
| **T2.6** | `chunks` — index alignment across columns and `entities`, never spans a page, short tail page, `get`/`column`/`entity`, reusable non-generator iterator (§6.6, §12.2) |
| **T2.7** | Fallback cursor parity with the codegen cursor across the `each` suite (§6.5)                                                                                         |

### 2-B [COMPLETED] — Implementation

| ID       | Impl task                                  | →                |
| -------- | ------------------------------------------ | ---------------- |
| **I2.1** | Query compilation + archetype subscription | T2.1, I1.3, I0.5 |
| **I2.2** | Query cache                                | T2.2, I2.1       |
| **I2.3** | Tier 1 result surface                      | T2.3, I2.2       |
| **I2.4** | Cursor codegen                             | T2.4, I2.3, I0.9 |
| **I2.5** | `each`                                     | T2.5, I2.4       |
| **I2.6** | `chunks`                                   | T2.6, I2.3       |
| **I2.7** | Generic fallback cursor                    | T2.7, I2.5       |

---

## Stage 3 — Events and change detection

Stage gate: **2-B complete.**

### 3-A [COMPLETED] — Tests

| ID       | Test task                                                                                                                                                                                           |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **T3.1** | `onAdd` / `onRemove` / `onChange`, immediate dispatch, registration order, per-entity ordering in batches, `onRemove` reads data before destruction, unsubscribe, reentrancy depth cap (§8.1, §8.4) |
| **T3.2** | `world.tick` / `world.step`, tracked-trait promotion triggers, per-row tick column + column `lastWriteTick`, untracked traits allocate nothing (§8.3)                                               |
| **T3.3** | `Changed` / `Added` / `Removed` filters, per-query last-seen tick isolation between systems, `Removed` valid for one tick (§6.1, §8.3)                                                              |
| **T3.4** | Writes that bump ticks — `world.set`, cursor setters, `world.changed`, `chunk.markChanged` whole-chunk and single-row; direct chunk writes do not (§6.6, §8.3)                                      |
| **T3.5** | `onEnter` / `onExit` fire on archetype transitions, spawn and despawn included (§8.2)                                                                                                               |
| **T3.6** | Dev warns once per call site when a tracked-trait `Store` is handed out and no `markChanged` follows (§6.6)                                                                                         |

### 3-B [COMPLETED] — Implementation

| ID       | Impl task                       | →                      |
| -------- | ------------------------------- | ---------------------- |
| **I3.1** | Observers                       | T3.1, I1.5, I1.8       |
| **I3.2** | Change-tick machinery           | T3.2, I3.1, I1.6       |
| **I3.3** | Tick-based query filters        | T3.3, I3.2, I2.5       |
| **I3.4** | Tick write sites                | T3.4, I3.2, I2.4, I2.6 |
| **I3.5** | Query enter/exit                | T3.5, I3.1, I2.2       |
| **I3.6** | Missing-`markChanged` detection | T3.6, I3.4             |

---

## Stage 4 — Structural change during iteration

Stage gate: **3-B complete.**

### 4-A [COMPLETED] — Tests

| ID       | Test task                                                                                                                                                                         |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **T4.1** | The safety matrix — back-to-front swap-remove keeps current-entity mutation and despawn safe across all three tiers (§9)                                                          |
| **T4.2** | `defer` FIFO, explicit `flush`, implicit flush at outermost `each`/`chunks` exit, nested iteration flushes once (§9)                                                              |
| **T4.3** | Dev structural-version assertion fires on unsafe mutation and is absent in prod (§9)                                                                                              |
| **T4.4** | `clear` keeps archetypes warm, `compact` releases empty tail pages, `destroy` fires `onRemove`, unsubscribes, releases the world id, and throws on later use in dev (§5.5, §10.2) |

### 4-B [COMPLETED] — Implementation

| ID       | Impl task                       | →                |
| -------- | ------------------------------- | ---------------- |
| **I4.1** | Iteration order guarantees      | T4.1, I2.5, I2.6 |
| **I4.2** | Deferral queue                  | T4.2, I4.1       |
| **I4.3** | Structural-version stamping     | T4.3, I4.2       |
| **I4.4** | `clear` / `compact` / `destroy` | T4.4, I4.2, I3.1 |

---

## Stage 5 — Sorted queries

Stage gate: **4-B complete.**

### 5-A [COMPLETED] — Tests

| ID       | Test task                                                                                                                                                                                                               |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **T5.1** | `sortBy` memoised on (signature, field, direction), returns a distinct cached result, unsorted query unaffected, Tier 1 + `each` supported and `chunks` rejected, sorting marks the trait tracked (§6.7)                |
| **T5.2** | One O(n) key-extraction pass, comparator reads only the key array, stable ties, permutation reused across frames (§6.7)                                                                                                 |
| **T5.3** | `clean` / `resort` / `rebuild` transitions — structural dirty via `archetype.sortedViews`, value dirty via column `lastWriteTick`, unsorted queries pay nothing, `markChanged` from a chunk schedules the resort (§6.7) |
| **T5.4** | `isDirty` / `invalidate` / `rebuild`, comparator overload is always resort-dirty (§6.7)                                                                                                                                 |

### 5-B [COMPLETED] — Implementation

| ID       | Impl task                                 | →                      |
| -------- | ----------------------------------------- | ---------------------- |
| **I5.1** | Sorted view cache + materialisation       | T5.1, I2.5, I3.2       |
| **I5.2** | Key extraction + adaptive in-place resort | T5.2, I5.1             |
| **I5.3** | Two-level invalidation                    | T5.3, I5.2, I3.4, I4.1 |
| **I5.4** | Escape hatches                            | T5.4, I5.3             |

---

## Stage 6 — Relations

Stage gate: **5-B complete.**

### 6-A [COMPLETED] — Tests

| ID       | Test task                                                                                                                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **T6.1** | Exclusive relation — one archetype regardless of target count, target column, target index maintained on add/remove/despawn, retarget causes no archetype transition, `R('*')` is a plain match (§7.4) |
| **T6.2** | Non-exclusive relation — pair-id interning participates in mask matching, multi-target queries, dev cardinality warning threshold (§7.4)                                                               |
| **T6.3** | `add`/`remove`/`has` with a target and with `'*'`, `target`, `targets`, `get` on a relation pair, relation data columns (§7.2, §7.3)                                                                   |
| **T6.4** | `onTargetDespawn` `remove` / `despawn` / `orphan`, iterative cascade over a deep hierarchy without stack overflow, cycles terminate, observers receive the target argument (§7.5, §8.1)                |
| **T6.5** | `Cascade` visits parents before children, depth maintained incrementally on re-parent, forces materialisation (no `chunks`), dev throws on cycle / non-exclusive relation (§7.6)                       |
| **T6.6** | `eid` fields registered in the reverse index and patched to `NULL_ENTITY` on despawn; bare-`0` handle fields are not patched (§8.5)                                                                    |

### 6-B [COMPLETED] — Implementation

| ID       | Impl task                                 | →                      |
| -------- | ----------------------------------------- | ---------------------- |
| **I6.1** | Exclusive relation storage + target index | T6.1, I1.5, I2.2, I0.4 |
| **I6.2** | Pair-id storage                           | T6.2, I6.1             |
| **I6.3** | Relation API surface                      | T6.3, I6.2             |
| **I6.4** | Target lifecycle                          | T6.4, I6.3, I4.2, I3.1 |
| **I6.5** | `Cascade`                                 | T6.5, I6.4, I5.1       |
| **I6.6** | `eid` reverse index + patching            | T6.6, I1.6, I6.4       |

---

## Stage 7 — Types, performance, hardening

Stage gate: **6-B complete.**

### 7-A [COMPLETED] — Tests

| ID       | Test task                                                                                                                                                                                      |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **T7.1** | Type tests (`types` project): marker/cursor/store mappings, `Values<T>` filtering, partial-init errors, AoS pass-through, positional `each` params, branded `Entity` arithmetic rejected (§11) |
| **T7.2** | Alloc: zero heap delta after warmup for `each`, `chunks`, `entity-cycle` (§12.2)                                                                                                               |
| **T7.3** | Structural guards: no `Proxy` and no generators in the iteration path, per-trait (not shared) cursor classes (§12.2)                                                                           |
| **T7.4** | Limits: entity/generation/world-id ceilings and their documented failure modes (§12.3, §5.5)                                                                                                   |
| **T7.5** | Prod-build parity: dev assertions absent, dev-only paths dropped (§12.2)                                                                                                                       |
| **T7.6** | Public API surface: every entry in §14 exported with the right shape                                                                                                                           |
| **T7.7** | Integration: the §13 worked example runs end to end                                                                                                                                            |

### 7-B [COMPLETED] — Implementation

| ID       | Impl task                                                                                                                                                   | →           |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| **I7.1** | Public type surface adjustments                                                                                                                             | T7.1        |
| **I7.2** | Fixes for alloc / structural / limits / parity / surface failures                                                                                           | T7.2 … T7.7 |
| **I7.3** | Benchmarks: `packed-5`, `simple-iter`, `frag-iter`, `entity-cycle`, `add-remove`, `sorted-static`, `sorted-drift` against the hand-written baseline (§12.1) | I7.2        |
| **I7.4** | CI: publish benchmark numbers, fail on regression beyond threshold (§12.1)                                                                                  | I7.3        |

---

## Stage 8 — Accessors

Stage gate: **7-B complete.**

### 8-A [COMPLETED] — Tests

| ID       | Test task                                                                                                                                                                                                                                 |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **T8.1** | `world.accessor` — get/set parity with `world.get`/`set` for every field kind, nested fields, AoS traits and exclusive-relation fields; memoised per field; dev rejection of tags, struct traits and non-exclusive relations (§4.5, §3.3) |
| **T8.2** | Accessor follows the entity — archetype moves, id recycling into another archetype, `compact()`, `clear()`, pages appended after resolution, a world that gains archetypes later (§4.5, §10.2)                                            |
| **T8.3** | `set` through an accessor stamps ticks, fires `onChange`, is seen by `Changed()`; dev liveness / world / has-trait assertions, absent in prod (§4.5, §8.1, §8.3, §12.2)                                                                   |
| **T8.4** | Alloc + surface: zero heap delta per pass after warmup; `accessor` on the prototype; `Accessor<V>` typed from the field, struct traits rejected at the type level (§4.5, §11, §12.2, §14)                                                 |

### 8-B [COMPLETED] — Implementation

| ID       | Impl task                                                                               | →                |
| -------- | --------------------------------------------------------------------------------------- | ---------------- |
| **I8.1** | `Accessor` — dense per-archetype column table, memoisation                              | T8.1, T8.2, T8.3 |
| **I8.2** | Public type + export, `random-access` benchmark and CI budget, compare adapter raw tier | T8.4, I8.1       |

---

## Critical path

`0-A → 0-B → 1-A → 1-B → 2-A → 2-B → 3-A → 3-B → 4-A → 4-B → 5-A → 5-B → 6-A → 6-B → 7-A → 7-B → 8-A → 8-B`

Inside phase A every task is independent — write them all in parallel. Inside phase B the
chains that matter are:

- Stage 0: `I0.2 → I0.3 → I0.4 → I0.5`; `I0.1 → I0.8`; `I0.2 → I0.7`
- Stage 1: `I1.1 → I1.2 → I1.3 → I1.4 → I1.5 → I1.6 → I1.7`, with `I1.8` branching off `I1.5`
- Stage 2: `I2.1 → I2.2 → I2.3 → I2.4 → I2.5 → I2.7`, with `I2.6` branching off `I2.3`
- Stage 3: `I3.1 → I3.2 → I3.4 → I3.6`, with `I3.3` and `I3.5` branching off
- Stage 5: strictly linear `I5.1 → I5.2 → I5.3 → I5.4`
- Stage 6: `I6.1 → I6.2 → I6.3 → I6.4 → I6.5`, with `I6.6` branching off `I6.4`
