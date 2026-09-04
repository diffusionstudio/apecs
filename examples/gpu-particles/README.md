# apecs × WebGPU — one million entities

Every particle is an entity. The physics runs on the CPU, in TypeScript, as a
plain chunk walk over apecs columns. WebGPU does nothing but draw: each column
page is copied into a matching vertex buffer, and each archetype group is one
instanced draw. No WASM, no compute shaders, no repacking step.

```bash
npm install
npm run dev
```

Needs a browser with WebGPU: Chrome, Edge, Safari 26, or Firefox 141+.

## What it shows

| On screen                                   | In apecs                                                       |
| ------------------------------------------- | -------------------------------------------------------------- |
| a million particles moving                  | `query(Position, Velocity, Not(Ember)).chunks()` — Tier 3      |
| the 1M / 2M population buttons              | `spawnMany` / `despawnMany`, one archetype transition each     |
| "ignite around cursor" and the second draw  | `addMany(batch, Ember)` moves the batch to a second archetype  |
| embers burning out                          | a per-entity `life` column and a batched `removeMany`          |
| the physics sliders                         | world traits on the world entity, written with `world.set`     |
| the stats panel                             | a `Stats` world trait read through `useField` from `apecs/react` |
| clicking a particle                         | a GPU id pass resolves a slot back to a chunk row and its handle |
| the inspector following that particle       | `useField(entity, Position.x)` with `chunk.markChanged` upstream |
| "add Ember" / "kick" / "despawn" on one entity | `world.add`, `world.set`, `world.despawn`; `eid` clears the selection |

## Layout

- `src/sim.ts` — traits, the world, and the two hot loops. Nothing here knows about the GPU.
- `src/main.tsx` — the frame: step the world, walk the chunks into the staging ring, draw.
- `src/renderer.ts` — WebGPU: mapped staging ring, trail buffer, tonemap, id pass for picking.
- `src/shaders.ts` — WGSL for the four passes.
- `src/ui.tsx` — the overlay, entirely driven by `apecs/react` hooks.

## URL parameters

- `?n=250000` — initial population (default 1,000,000).
- `?dpr=1` — cap the device pixel ratio (default 2).

## Notes on cost

The simulation is about 8 ms for a million entities on an Apple M1. Upload is a
memcpy into a mapped staging buffer, about 1 ms; `writeBuffer` would cost seven.
What bounds the frame on a base M1 is the GPU rasterising a million tiny
triangles into the trail buffer, about 19 ms. Faster GPUs hold 60 fps.
