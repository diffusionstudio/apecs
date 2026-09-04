import { createRoot } from 'react-dom/client';

import { CAM_Z, FLUID_Z, FRAME, Renderer, type Scene } from './renderer';
import { Pointer, Position, Rod, Sim, Stats, Surface, Tint } from './sim';
import { App } from './ui';
import './styles.css';

const canvas = document.getElementById('gpu') as HTMLCanvasElement;
const ui = document.getElementById('ui') as HTMLElement;

const params = new URLSearchParams(location.search);
const initial = Number(params.get('n')) || 24_000;

async function main(): Promise<void> {
  const renderer = await Renderer.create(canvas);
  const sim = new Sim(0);
  const { world } = sim;
  sim.setAspect(renderer.aspect);
  sim.resize(initial);

  createRoot(ui).render(<App sim={sim} renderer={renderer} />);
  if (__DEV__) {
    (window as unknown as { demo: unknown }).demo = { sim, renderer, world };
  }

  // The pointer lives on the opening's plane; moving stirs, holding pulls.
  let pointerX = 0;
  let pointerY = 0;
  let pointerAt = -Infinity;
  let hold = false;
  // Screen to the middle of the fluid slab, undoing the box's perspective.
  const reach = (FRAME * (CAM_Z + FLUID_Z)) / CAM_Z;
  const toWorld = (e: PointerEvent): void => {
    pointerX = ((e.clientX / canvas.clientWidth) * 2 - 1) * sim.aspect * reach;
    pointerY = -((e.clientY / canvas.clientHeight) * 2 - 1) * reach;
    pointerAt = performance.now();
  };
  canvas.addEventListener('pointermove', toWorld);
  canvas.addEventListener('pointerdown', (e) => {
    toWorld(e);
    hold = true;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointerup', () => {
    hold = false;
  });
  canvas.addEventListener('pointerleave', () => {
    pointerAt = -Infinity;
    hold = false;
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === ' ') {
      sim.jolt();
      e.preventDefault();
    }
  });

  /** Walk the chunks; each column page lands in its vertex buffer at the running slot. */
  function upload(): number {
    renderer.reserve(sim.count);
    let slot = 0;
    let chunks = 0;
    for (const chunk of sim.drops.chunks()) {
      const n = chunk.length;
      renderer.writeColumn(0, slot, chunk.column(Position.x), n);
      renderer.writeColumn(1, slot, chunk.column(Position.y), n);
      renderer.writeColumn(2, slot, chunk.column(Rod.dx), n);
      renderer.writeColumn(3, slot, chunk.column(Rod.dy), n);
      renderer.writeColumn(4, slot, chunk.column(Tint.hue), n);
      renderer.writeColumn(5, slot, chunk.column(Surface.gx), n);
      renderer.writeColumn(6, slot, chunk.column(Surface.gy), n);
      renderer.writeColumn(7, slot, chunk.column(Surface.rho), n);
      slot += n;
      chunks++;
    }
    return chunks;
  }

  const glow: [number, number, number] = [0, 0, 0];
  const scene: Scene = { time: 0, spacingPx: 1, spacing: 0.01, glow, cover: sim.cover };

  let last = performance.now();
  let joltAt = last;
  let lastX = 0;
  let lastY = 0;
  let smoothVX = 0;
  let smoothVY = 0;
  let accSolve = 0;
  let accUpload = 0;
  let frames = 0;
  let statsAt = last;

  function frame(now: number): void {
    const dt = Math.min((now - last) / 1000, 1 / 30);
    last = now;
    if (renderer.resize()) {
      sim.setAspect(renderer.aspect);
    }

    const on = now - pointerAt < 1500;
    const k = 1 - Math.exp(-dt * 12);
    smoothVX += ((pointerX - lastX) / dt - smoothVX) * k;
    smoothVY += ((pointerY - lastY) / dt - smoothVY) * k;
    lastX = pointerX;
    lastY = pointerY;
    world.set(Pointer, { x: pointerX, y: pointerY, vx: smoothVX, vy: smoothVY, on, hold });

    // Left alone, the box gets shaken every few seconds.
    const idle = now - pointerAt > 5000;
    if (idle && now - joltAt > 14000) {
      joltAt = now;
      sim.jolt();
    }

    const t0 = performance.now();
    sim.step(dt);
    const t1 = performance.now();
    const chunks = upload();
    const t2 = performance.now();

    hsv(sim.hue, 0.85, 1, glow);
    scene.time = sim.time;
    scene.spacing = sim.spacing;
    scene.spacingPx = (sim.spacing * (renderer.height / 2) * CAM_Z) / ((CAM_Z + FLUID_Z) * FRAME);
    renderer.frame(sim.count, scene);

    accSolve += t1 - t0;
    accUpload += t2 - t1;
    frames++;
    if (now - statsAt > 400) {
      const elapsed = now - statsAt;
      world.set(Stats, {
        count: sim.count,
        solve: accSolve / frames,
        upload: accUpload / frames,
        frame: elapsed / frames,
        fps: (frames * 1000) / elapsed,
        pairs: sim.pairs,
        chunks,
        hue: sim.hue * 360,
      });
      accSolve = accUpload = 0;
      frames = 0;
      statsAt = now;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

/** Written out rather than looped over a literal array, which would allocate every frame. */
function hsv(h: number, s: number, v: number, out: [number, number, number]): void {
  out[0] = channel(h, s, v);
  out[1] = channel(h + 2 / 3, s, v);
  out[2] = channel(h + 1 / 3, s, v);
}

function channel(h: number, s: number, v: number): number {
  const k = h - Math.floor(h);
  const p = Math.abs(k * 6 - 3) - 1;
  return v * (1 + s * (Math.min(Math.max(p, 0), 1) - 1));
}

main().catch((error: Error) => {
  ui.innerHTML = `<div class="fatal"><div><b>${error.message}</b>This demo needs WebGPU — Chrome, Edge, Safari 26 or Firefox 141+.</div></div>`;
});
