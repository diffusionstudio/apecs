import { createRoot } from 'react-dom/client';
import type { Entity } from 'apecs';

import { Renderer, type DrawRange } from './renderer';
import { Ember, Position, Selection, Sim, Stats, Velocity } from './sim';
import { App } from './ui';
import './styles.css';

const canvas = document.getElementById('gpu') as HTMLCanvasElement;
const ui = document.getElementById('ui') as HTMLElement;

const params = new URLSearchParams(location.search);
const initial = Number(params.get('n')) || 1_000_000;

async function main(): Promise<void> {
  const renderer = await Renderer.create(canvas);
  const sim = new Sim(initial);
  const { world } = sim;
  sim.aspect = renderer.width / renderer.height;

  createRoot(ui).render(<App sim={sim} renderer={renderer} />);
  if (__DEV__) {
    (window as unknown as { demo: unknown }).demo = {
      sim,
      renderer,
      world,
      Position,
      Velocity,
      Ember,
    };
  }

  // Pointer: hover attracts, holding repels, a short still click picks.
  let pointerX = 0;
  let pointerY = 0;
  let pointerAt = -Infinity;
  let down: { x: number; y: number; at: number } | null = null;
  let pendingSlot = -1;

  const toWorld = (e: PointerEvent): [number, number] => [
    ((e.clientX / canvas.clientWidth) * 2 - 1) * sim.aspect,
    -((e.clientY / canvas.clientHeight) * 2 - 1),
  ];
  canvas.addEventListener('pointermove', (e) => {
    [pointerX, pointerY] = toWorld(e);
    pointerAt = performance.now();
  });
  canvas.addEventListener('pointerdown', (e) => {
    [pointerX, pointerY] = toWorld(e);
    pointerAt = performance.now();
    down = { x: e.clientX, y: e.clientY, at: pointerAt };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointerup', (e) => {
    if (down !== null) {
      const still = Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5;
      if (still && performance.now() - down.at < 220) {
        renderer.pick(e.clientX, e.clientY).then((slot) => {
          pendingSlot = slot;
          if (slot === -1) {
            world.set(Selection.entity, 0 as Entity);
          }
        });
      }
    }
    down = null;
  });
  canvas.addEventListener('pointerleave', () => {
    pointerAt = -Infinity;
    down = null;
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'f') {
      sim.ignite(0.35);
    } else if (e.key === 'e') {
      sim.extinguish();
    }
  });

  const ranges: DrawRange[] = [
    { first: 0, count: 0, palette: 0 },
    { first: 0, count: 0, palette: 1 },
  ];
  const px = world.accessor(Position.x);
  const py = world.accessor(Position.y);
  const selection = { on: false, x: 0, y: 0 };

  /** Walk the chunks; each column page lands in its vertex buffer at the running slot. */
  function upload(): number {
    renderer.reserve(sim.count);
    renderer.beginUpload();
    let slot = 0;
    let chunks = 0;
    let picked: Entity | null = null;
    for (let g = 0; g < 2; g++) {
      const query = g === 0 ? sim.base : sim.embers;
      const first = slot;
      for (const chunk of query.chunks()) {
        const n = chunk.length;
        renderer.writeColumn(0, slot, chunk.column(Position.x), n);
        renderer.writeColumn(1, slot, chunk.column(Position.y), n);
        renderer.writeColumn(2, slot, chunk.column(Velocity.x), n);
        renderer.writeColumn(3, slot, chunk.column(Velocity.y), n);
        if (g === 1) {
          renderer.writeColumn(4, slot, chunk.column(Ember.life), n);
        }
        if (pendingSlot >= slot && pendingSlot < slot + n) {
          picked = chunk.entity(pendingSlot - slot);
        }
        slot += n;
        chunks++;
      }
      ranges[g].first = first;
      ranges[g].count = slot - first;
    }
    if (pendingSlot !== -1) {
      pendingSlot = -1;
      if (picked !== null) {
        world.set(Selection.entity, picked);
      }
    }
    return chunks;
  }

  let last = performance.now();
  let igniteAt = last;
  let accSim = 0;
  let accUpload = 0;
  let accFrame = 0;
  let frames = 0;
  let statsAt = last;

  function frame(now: number): void {
    const dt = Math.min((now - last) / 1000, 1 / 30);
    last = now;
    if (renderer.resize()) {
      sim.aspect = renderer.width / renderer.height;
    }

    const idle = now - pointerAt > 2500;
    const t = sim.time;
    const tx = idle ? sim.aspect * 0.55 * Math.sin(t * 0.37) : pointerX;
    const ty = idle ? 0.55 * Math.sin(t * 0.53 + 1.3) : pointerY;
    // Left alone, the demo performs itself: a burst of fire every few seconds.
    if (idle && now - igniteAt > 9000) {
      igniteAt = now;
      sim.ignite(0.35);
    }
    const repel = down !== null && now - down.at > 180;
    sim.setTarget(tx, ty, repel ? -2.5 : 1);

    const t0 = performance.now();
    sim.step(dt);
    const t1 = performance.now();
    const chunks = upload();
    const t2 = performance.now();

    const selected = world.get(Selection.entity);
    selection.on = selected !== 0 && world.isAlive(selected);
    if (selection.on) {
      selection.x = px.get(selected);
      selection.y = py.get(selected);
    }
    renderer.frame(ranges, selection, sim.time, dt);

    accSim += t1 - t0;
    accUpload += t2 - t1;
    accFrame += now - (frames === 0 ? now : last);
    frames++;
    if (now - statsAt > 400) {
      const elapsed = now - statsAt;
      world.set(Stats, {
        count: sim.count,
        embers: sim.embers.count,
        sim: accSim / frames,
        upload: accUpload / frames,
        frame: elapsed / frames,
        fps: (frames * 1000) / elapsed,
        draws: ranges.filter((r) => r.count > 0).length,
        chunks,
      });
      accSim = accUpload = accFrame = 0;
      frames = 0;
      statsAt = now;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

main().catch((error: Error) => {
  ui.innerHTML = `<div class="fatal"><div><b>${error.message}</b>This demo needs WebGPU — Chrome, Edge, Safari 26 or Firefox 141+.</div></div>`;
});
