import { Schedule, type Entity } from 'apecs';

import { buildDocument } from './document';
import { draw } from './draw';
import { MARGIN, MAX_WIDTH, MIN_WIDTH, layout } from './layout';
import { moveSpheres, spawnSpheres } from './spheres';
import { SERIF, prepareStyles } from './styles';
import './styles.css';
import { Ball, Page, Pointer, Stats, Time, Viewport } from './traits';
import { Reader } from './world';

const canvas = document.getElementById('page') as HTMLCanvasElement;
const stats = document.getElementById('stats')!;
const world = new Reader(canvas.getContext('2d')!);

/** Physics, then layout, then draw. The schedule owns the clock. */
const frame = new Schedule<Reader>()
  .add('spheres', moveSpheres)
  .add('layout', layout, { after: 'spheres' })
  .add('draw', draw, { after: 'layout' });

async function boot(): Promise<void> {
  // Measuring against a fallback font and drawing with the real one would
  // justify every line to the wrong width.
  const faces = [`400 16px ${SERIF}`, `700 16px ${SERIF}`, `italic 400 16px ${SERIF}`];
  await Promise.all(faces.map((f) => document.fonts.load(f)));

  fit();
  prepareStyles(world.ctx);
  world.set(Stats.tokens, buildDocument(world, world.ctx));
  spawnSpheres(world, world.ctx);
  attachInput();

  // One frame now, so the page has a height for `?scroll=` to clamp against.
  frame.run(world);
  const query = new URLSearchParams(location.search);
  if (query.has('width')) {
    setWidth(Number(query.get('width')));
  }
  scrollBy(Number(query.get('scroll') ?? 0));
  requestAnimationFrame(loop);
}

/* ---------------------------------------------------------------- viewport */

function fit(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
  world.set(Viewport, { w, h, dpr });
  setWidth(world.get(Page.width));
  scrollBy(0);
}

/** Page width: the one thing the pointer edits. Clamped to the window. */
function setWidth(width: number): void {
  const vw = world.get(Viewport.w);
  const max = Math.min(MAX_WIDTH, vw - 48);
  world.set(Page.width, Math.min(max, Math.max(MIN_WIDTH, width)));
}

function scrollBy(delta: number): void {
  const max = Math.max(0, world.get(Page.height) + 2 * MARGIN - world.get(Viewport.h));
  world.set(Page.scroll, Math.min(max, Math.max(0, world.get(Page.scroll) + delta)));
}

/* ------------------------------------------------------------------- input */

/** Half-width of the strip along each page edge that resizes the page. */
const GRIP = 10;
/** A throw is capped here, in px/s: past it the sphere tunnels through a column. */
const MAX_THROW = 1400;
/** The null entity handle: what an `eid` field holds when it points at nothing. */
const NONE = 0 as Entity;

function nearEdge(px: number): boolean {
  const width = world.get(Page.width);
  const left = (world.get(Viewport.w) - width) / 2;
  return Math.abs(px - left) <= GRIP || Math.abs(px - left - width) <= GRIP;
}

let hit: Entity = NONE;

function sphereAt(px: number, py: number): Entity {
  hit = NONE;
  world.query(Ball).each((b, e) => {
    const dx = px - b.x;
    const dy = py - b.y;
    if (dx * dx + dy * dy <= b.r * b.r) {
      hit = e;
      return false;
    }
  });
  return hit;
}

function grab(e: Entity, ev: PointerEvent): void {
  world.set(e, Ball, { vx: 0, vy: 0, held: true });
  world.set(Pointer, {
    held: e,
    gripX: ev.clientX - world.get(e, Ball.x),
    gripY: ev.clientY - world.get(e, Ball.y),
    stamp: ev.timeStamp,
  });
}

/** The pointer writes the sphere's position; its velocity is the pointer's, smoothed. */
function drag(e: Entity, ev: PointerEvent): void {
  const dt = Math.max(1, ev.timeStamp - world.get(Pointer.stamp)) / 1000;
  const x = ev.clientX - world.get(Pointer.gripX);
  const y = ev.clientY - world.get(Pointer.gripY);
  const throwX = Math.max(-MAX_THROW, Math.min(MAX_THROW, (x - world.get(e, Ball.x)) / dt));
  const throwY = Math.max(-MAX_THROW, Math.min(MAX_THROW, (y - world.get(e, Ball.y)) / dt));
  world.set(e, Ball, {
    x,
    y,
    vx: world.get(e, Ball.vx) * 0.4 + throwX * 0.6,
    vy: world.get(e, Ball.vy) * 0.4 + throwY * 0.6,
  });
  world.set(Pointer.stamp, ev.timeStamp);
}

function release(ev: PointerEvent): void {
  const e = world.get(Pointer.held);
  if (e !== NONE) {
    // A pointer that stopped before letting go drops the sphere; a moving one throws it.
    const still = ev.timeStamp - world.get(Pointer.stamp) > 80;
    world.set(e, Ball, { held: false, ...(still ? { vx: 0, vy: 0 } : {}) });
    world.set(Pointer.held, NONE);
  }
  world.set(Pointer.resizing, false);
  setCursor(ev.clientX, ev.clientY);
}

let cursor = '';

function setCursor(px: number, py: number): void {
  const next =
    world.get(Pointer.held) !== NONE
      ? 'grabbing'
      : sphereAt(px, py) !== NONE
        ? 'grab'
        : world.get(Pointer.resizing) || nearEdge(px)
          ? 'ew-resize'
          : '';
  if (next !== cursor) {
    cursor = next;
    canvas.style.cursor = next;
  }
}

function attachInput(): void {
  new ResizeObserver(fit).observe(canvas);

  canvas.addEventListener(
    'wheel',
    (ev) => {
      ev.preventDefault();
      const unit = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? world.get(Viewport.h) : 1;
      scrollBy(ev.deltaY * unit);
    },
    { passive: false },
  );

  canvas.addEventListener('pointerdown', (ev) => {
    world.set(Pointer, { x: ev.clientX, y: ev.clientY });
    const sphere = sphereAt(ev.clientX, ev.clientY);
    if (sphere !== NONE) {
      grab(sphere, ev);
    } else if (nearEdge(ev.clientX)) {
      world.set(Pointer.resizing, true);
    } else {
      return;
    }
    canvas.setPointerCapture(ev.pointerId);
    setCursor(ev.clientX, ev.clientY);
  });

  canvas.addEventListener('pointermove', (ev) => {
    world.set(Pointer, { x: ev.clientX, y: ev.clientY });
    const held = world.get(Pointer.held);
    if (held !== NONE) {
      drag(held, ev);
      return;
    }
    if (world.get(Pointer.resizing)) {
      // The page is centred, so an edge drag is a width change about the middle.
      setWidth(2 * Math.abs(ev.clientX - world.get(Viewport.w) / 2));
      return;
    }
    setCursor(ev.clientX, ev.clientY);
  });

  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  window.addEventListener('keydown', (ev) => {
    const vh = world.get(Viewport.h);
    switch (ev.key) {
      case 'ArrowDown':
        scrollBy(60);
        break;
      case 'ArrowUp':
        scrollBy(-60);
        break;
      case 'PageDown':
      case ' ':
        scrollBy(vh * 0.9);
        break;
      case 'PageUp':
        scrollBy(-vh * 0.9);
        break;
      case 'Home':
        scrollBy(-1e9);
        break;
      case 'End':
        scrollBy(1e9);
        break;
      default:
        return;
    }
    ev.preventDefault();
  });
}

/* -------------------------------------------------------------------- loop */

const format = new Intl.NumberFormat('en-US');
let previous = 0;
let frames = 0;

function loop(now: number): void {
  requestAnimationFrame(loop);
  const dt = previous === 0 ? 1 / 60 : Math.min(0.05, (now - previous) / 1000);
  previous = now;
  world.set(Time, { delta: dt, current: world.get(Time.current) + dt });
  frame.run(world);
  if (++frames % 15 === 0) {
    report();
  }
}

/** Per-frame numbers go straight to the DOM; nothing re-renders for them. */
function report(): void {
  const s = world.get(Stats);
  const columns = world.get(Page.columns);
  stats.textContent =
    `${format.format(s.tokens)} tokens · ${format.format(s.drawn)} drawn · ` +
    `${columns} ${columns === 1 ? 'column' : 'columns'} · ` +
    `layout ${s.layoutMs.toFixed(2)} ms · draw ${s.drawMs.toFixed(2)} ms`;
}

void boot().catch((err: unknown) => {
  const box = document.createElement('div');
  box.className = 'fatal';
  box.textContent = String(err);
  document.body.append(box);
  console.error(err);
});
