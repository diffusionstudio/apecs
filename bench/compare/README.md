# Cross-library ECS benchmarks

Compares apecs against bitECS, koota and becsy, plus a hand-written typed-array baseline.
Read [REPORT.md](REPORT.md) for the results.

Kept in its own package so the library's own dependency tree stays clean — the competitors
are never devDependencies of apecs.

```bash
npm install
node run.mjs        # census, timings, memory  -> results.json
node merge.mjs results.json a.json b.json c.json   # per-cell minimum across passes
node report.mjs     # results.json + findings.json -> REPORT.md
```

## Layout

| Path             | What it is                                                                  |
| ---------------- | --------------------------------------------------------------------------- |
| `lib/spec.mjs`   | The benchmark set: shapes, sizes, and what each one measures.               |
| `adapters/*.mjs` | One per library. Same benchmarks, each written in that library's own idiom. |
| `run.mjs`        | Orchestrator. One child process per (library, benchmark).                   |
| `run-one.mjs`    | The child: measures every variant of one benchmark for one library.         |
| `memory.mjs`     | Absolute resident bytes for one world size, one size per process.           |
| `report.mjs`     | Renders `REPORT.md`.                                                        |

## The gates

A benchmark comparison is worthless if the libraries are not doing the same work, so nothing is
timed until that is proven:

| Script                        | Proves                                                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------------------------------- |
| `verify.mjs`                  | Every adapter variant runs at all.                                                                        |
| `census.mjs`                  | Every library matches the **same entity count** on every query-shaped benchmark. `run.mjs` aborts if not. |
| `verify-structural.mjs`       | `add_remove` actually adds and removes, in every library.                                                 |
| `verify-becsy-structural.mjs` | becsy's deferred structural changes really land (observed across frame boundaries).                       |
| `verify-becsy-coalesce.mjs`   | becsy is not collapsing an in-frame add+remove into nothing.                                              |

The census is not ceremony. It caught apecs's `Not()` silently ignoring all but its first argument,
and becsy's `perf` build silently creating only some of the entities it was asked for.

## Supplementary measurements

Recorded in `findings.json`, each with the script that reproduces it:

| Script                                 | Question                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------ |
| `cliff-cross.mjs <lib> <k>`            | How does the ergonomic tier scale with the number of distinct traits? One `k` per process. |
| `chunks-cliff.mjs <k>`                 | Is apecs's `chunks` tier immune to that?                                                   |
| `scaling.mjs`                          | Fixed cost per `each`/`chunks` call vs marginal cost per entity.                           |
| `capability.mjs <lib> <static\|drift>` | Sorted-query iteration, against koota and against a hand-written sort.                     |
| `sorted-isolate.mjs`                   | Where apecs's sorted iteration cost actually goes.                                         |
| `sorted-scaling.mjs`                   | Is a clean sorted view O(1) in entity count, as SPEC §12.1 budgets?                        |
| `random-access-breakdown.mjs`          | How much of `random_access` is the shuffled order, and how much is the accessor call?      |
| `proto-accessor.mjs`                   | Prototype: how much of `random_access` is recoverable, and by which change.                |
| `proto-accessor-frag.mjs <k>`          | Prototype: does the accessor cache survive archetype fragmentation?                        |
| `proto-accessor-gap.mjs`               | Why the shipped accessor lands at 14.8 ns where the prototype claimed 8.8.                 |
