# apecs × WebGPU — a swarm in a box

Thirty-two thousand rods, each one an entity. The steering runs on the CPU in TypeScript as a chunk
walk over apecs columns, and those same columns are handed to WebGPU as vertex buffers. No compute
shaders, no WASM, no repacking step between the two.

```bash
npm install
npm run dev
```

Needs a browser with WebGPU: Chrome, Edge, Safari 26, or Firefox 141+.

## What it shows

| On screen                       | In apecs                                                           |
| ------------------------------- | ------------------------------------------------------------------ |
| the flock streaming and folding | `query(Position, Velocity, Rod, Tint, Surface).chunks()` — Tier 3  |
| moving the mouse through it     | a `Pointer` world trait the steering pass reads                    |
| holding to gather it up         | the same trait, with `hold` set                                    |
| the population buttons          | `spawnMany` / `despawnMany`, one archetype transition each         |
| the swarm sliders               | world traits on the world entity, written with `world.set`         |
| the stats panel                 | a `Stats` world trait read through `useField` from `apecs/react`   |
| every rod's colour and heading  | `Tint` and `Rod` columns, written in the same walk that reads them |

## Layout

- `src/sim.ts` — traits, the world, and the steering. Nothing here knows about the GPU.
- `src/main.tsx` — the frame: step the world, walk the chunks into the vertex buffers, draw.
- `src/renderer.ts` — WebGPU: the column buffers, the shadow map, one pass with MSAA.
- `src/shaders.ts` — WGSL for the room and the rods.
- `src/ui.tsx` — the overlay, entirely driven by `apecs/react` hooks.

## How it moves

Reynolds' three rules — separation, cohesion, alignment — over a counting-sorted uniform grid,
carried by an ambient flow field. There is no gravity; bodies cruise at a fixed speed, bank away
from the walls and bounce off them.

The field is the **curl of a drifting stream function**, three scales of counter-rotating cells
evaluated on a grid coarse enough to be free. Taking the curl rather than the gradient makes it
divergence-free, which is what gives the swarm several simultaneous directions — cells that turn
against each other and fold the flock through itself — instead of one basin everything slides
into.

Only separation needs the neighbours individually: crowding is a scalar, and a uniformly
over-dense patch has no gradient to push along, so the force has to come from the pressure of each
neighbour in turn. Cohesion and alignment fall out of aggregates the same pass already computes —
the density gradient points out of the flock, and the kernel-weighted velocity is what the
neighbourhood is doing on average.

Two balances decide whether it looks like anything:

- **Cohesion has to stay weak.** It and the ambient field reinforce each other. Turn it up and the
  flock stops being a volume and collapses onto the field's streamlines as a few thin ribbons.
- **Speed has to be regulated.** Without a pull back toward cruise, the flock separates into
  stalled clots and bolting stragglers, and the rods stop reading as one body in motion.

## Notes on speed

About 10 ms of CPU for 32,000 bodies on an Apple M1, in a single neighbour pass. Three details
carry most of that, all measured rather than assumed:

- **Gather, don't scatter.** Visiting the whole 3×3 stencil and accumulating into registers costs
  twice as many distance tests as visiting half of it and writing into both rows, and runs a little
  over twice as fast. Scattered read-modify-writes are the expensive part, not arithmetic.
- **`+(condition)`, not `condition ? 1 : 0`.** The neighbour pass appends its in-range rows to a
  list so separation visits six of them instead of twenty candidates. Written as a ternary,
  TurboFan emits a jump that mispredicts two thirds of the time and the pass costs 15 ns a row;
  written as a boolean coercion it is branchless and costs 3.5 ns.
- **Clamp with `Math.max`, not a branch.** Same reason: two thirds of the candidates in the stencil
  fall outside the radius, so a branch there is a coin flip.

## URL parameters

- `?n=64000` — initial population (default 32,000).
- `?dpr=1` — cap the device pixel ratio (default 2).
