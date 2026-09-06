/**
 * The layout system. Every frame it walks the whole paper in document order
 * and writes a position for every token: line breaks, columns, sheets and the
 * holes the spheres punch into the lines all come out of one pass.
 *
 * The state lives at module scope on purpose. The kernel is a loop over typed
 * arrays with a handful of scalars beside it; there is no closure, no object
 * per line and no allocation once the fonts are measured.
 */
import type { World } from 'apecs';

import { BASELINE, CENTER, DY, JUSTIFY, KINDS } from './styles';
import { Ball, FIRST, HEAD, LAST, Page, Pos, SPACE, Stats, Token, Viewport, WIDE } from './traits';

/** Screen px above the first sheet and below the last. */
export const MARGIN = 64;
export const SHEET_GAP = 32;
export const MIN_WIDTH = 440;
export const MAX_WIDTH = 1400;
const GUTTER = 26;
/** Text keeps this far from a sphere's rim. */
const CLEARANCE = 14;
/** A gap narrower than this is not a place to put words. */
const MIN_SEGMENT = 30;
/** Justify only while no space has to grow past this multiple of itself. */
const MAX_STRETCH = 2.5;

export function columnsFor(width: number): number {
  return width < 680 ? 1 : width < 1080 ? 2 : 3;
}

export function paddingFor(width: number): number {
  return Math.round(width * 0.075);
}

export function sheetHeightFor(width: number): number {
  return Math.round(width * Math.SQRT2);
}

/* --------------------------------------------------------------- obstacles */

const MAX_OBSTACLES = 8;
const ox = new Float32Array(MAX_OBSTACLES);
const oy = new Float32Array(MAX_OBSTACLES);
const orad = new Float32Array(MAX_OBSTACLES);
let obstacles = 0;

const cutL = new Float32Array(MAX_OBSTACLES);
const cutR = new Float32Array(MAX_OBSTACLES);
const segL = new Float32Array(MAX_OBSTACLES + 1);
const segR = new Float32Array(MAX_OBSTACLES + 1);
let segments = 0;
let cuts = 0;
/** No sphere touched the current line: its one segment is the whole measure. */
let clear = true;

/**
 * The free intervals of one line. A sphere that overlaps the line's band cuts
 * out its widest chord inside the band; cuts are merged and the remainder is
 * the list of segments the words may go in.
 */
function findSegments(left: number, right: number, y0: number, y1: number): void {
  cuts = 0;
  for (let k = 0; k < obstacles; k++) {
    const r = orad[k];
    const cy = oy[k];
    if (cy + r <= y0 || cy - r >= y1) {
      continue;
    }
    const dy = cy < y0 ? y0 - cy : cy > y1 ? cy - y1 : 0;
    const half = Math.sqrt(r * r - dy * dy);
    const l = ox[k] - half;
    const rr = ox[k] + half;
    if (rr <= left || l >= right) {
      continue;
    }
    let j = cuts++;
    while (j > 0 && cutL[j - 1] > l) {
      cutL[j] = cutL[j - 1];
      cutR[j] = cutR[j - 1];
      j--;
    }
    cutL[j] = l;
    cutR[j] = rr;
  }
  clear = cuts === 0;
  segments = 0;
  let x = left;
  for (let k = 0; k < cuts; k++) {
    if (cutL[k] - x >= MIN_SEGMENT) {
      segL[segments] = x;
      segR[segments] = cutL[k];
      segments++;
    }
    if (cutR[k] > x) {
      x = cutR[k];
    }
  }
  if (right - x >= MIN_SEGMENT) {
    segL[segments] = x;
    segR[segments] = right;
    segments++;
  }
}

/* ------------------------------------------------------------ line state */

let F: Uint8Array;
let W: Float32Array;
let R: Float32Array;
let S: Uint8Array;
let K: Uint8Array;
let X: Float32Array;
let Y: Float32Array;

let x = 0;
let y = 0;
let lineTop = 0;
let base = 0;
let lh = 0;
let align = JUSTIFY;
let kind = 0;
let lineL = 0;
let lineR = 0;
let seg = 0;
/** First row of the open segment; leading spaces move it forward. */
let segStart = 0;
/** Cursor after the last non-space token: what justification measures. */
let lineEnd = 0;
let spaces = 0;
let spaceWidth = 0;

let col = 0;
let cols = 1;
let colW = 0;
let colTop = 0;
let bottom = 0;
let sheet = 0;
let sheetH = 0;
let pad = 0;
let contentL = 0;
let contentR = 0;
let wide = false;
let columnsStarted = false;
/** `y` sits at the top of a column: the next block skips its `before`. */
let fresh = true;

function setBounds(): void {
  if (wide) {
    lineL = contentL;
    lineR = contentR;
  } else {
    lineL = contentL + col * (colW + GUTTER);
    lineR = lineL + colW;
  }
  const inset = (lineR - lineL) * KINDS[kind].inset;
  lineL += inset;
  lineR -= inset;
}

function nextColumn(): void {
  col++;
  if (wide || col >= cols) {
    col = 0;
    sheet++;
    const top = sheet * (sheetH + SHEET_GAP);
    colTop = top + pad;
    bottom = top + sheetH - pad;
  }
  y = colTop;
  setBounds();
}

function openLine(i: number): void {
  for (;;) {
    if (y + lh > bottom) {
      nextColumn();
    }
    findSegments(lineL, lineR, y, y + lh);
    if (segments > 0) {
      break;
    }
    // A sphere covers the whole measure here: the line is skipped, not filled.
    y += lh;
  }
  lineTop = y;
  base = y + BASELINE[kind];
  seg = 0;
  x = segL[0];
  segStart = i;
  lineEnd = x;
  spaces = 0;
  spaceWidth = 0;
}

function nextSegment(i: number): void {
  seg++;
  if (seg >= segments) {
    y = lineTop + lh;
    openLine(i);
    return;
  }
  x = segL[seg];
  segStart = i;
  lineEnd = x;
  spaces = 0;
  spaceWidth = 0;
}

function beginBlock(i: number): void {
  kind = K[i];
  const spec = KINDS[kind];
  lh = spec.lh;
  align = spec.align;
  wide = (F[i] & WIDE) !== 0;
  if (!wide && !columnsStarted) {
    // The columns begin where the front matter ends, on every column of this sheet.
    columnsStarted = true;
    colTop = y;
    col = 0;
  }
  setBounds();
  if (!fresh) {
    if (spec.keep > 0 && y + spec.before + lh * (1 + spec.keep) > bottom) {
      // A heading with nothing under it is an orphan: start the next column instead.
      nextColumn();
    } else {
      y += spec.before;
    }
  }
  fresh = false;
  openLine(i);
}

/**
 * Distributes a justified segment's slack. Trailing spaces are not part of
 * the line; a segment that would have to stretch its spaces too far stays
 * ragged, which is what keeps short segments beside a sphere from turning
 * into rivers.
 */
function closeSegment(end: number, last: boolean): void {
  let e = end;
  while (e > segStart && F[e - 1] & SPACE) {
    e--;
    spaces--;
    spaceWidth -= W[e];
  }
  if (e <= segStart) {
    return;
  }
  const slack = segR[seg] - lineEnd;
  if (slack <= 0) {
    return;
  }
  if (align !== JUSTIFY || last || spaces <= 0 || slack > spaceWidth * MAX_STRETCH) {
    return;
  }
  const ratio = slack / spaceWidth;
  let acc = 0;
  for (let r = segStart; r < e; r++) {
    X[r] += acc;
    if (F[r] & SPACE) {
      acc += W[r] * ratio;
    }
  }
}

/* ---------------------------------------------------------- centred lines */

/**
 * A centred line is anchored to the middle of the measure, not filled from
 * the left: it is laid out as if nothing were in the way, and a sphere then
 * moves only the runs it touches. The line splits at the run boundary that
 * displaces the fewest tokens, and wraps only when neither side has room.
 * Returns the row after the last one placed.
 */
function centeredLine(a: number): number {
  while (F[a] & SPACE) {
    X[a] = lineL;
    Y[a] = base;
    a++;
  }
  const measure = lineR - lineL;
  let b = a;
  // A line that could hold nothing is skipped here, not handed back: the
  // caller would run the block's opening twice.
  while (b === a) {
    b = centeredLineAt(a, measure);
    if (b === a) {
      y = lineTop + lh;
      openLine(a);
    }
  }
  if (F[b - 1] & LAST) {
    y = lineTop + lh + KINDS[kind].after;
  } else {
    y = lineTop + lh;
    openLine(b);
  }
  return b;
}

/** One attempt at the line starting at `a`; `a` back when nothing fit. */
function centeredLineAt(a: number, measure: number): number {
  let cursor = 0;
  let content = 0;
  let b = a;
  for (;;) {
    const f = F[b];
    if (f & HEAD && b > a && cursor + R[b] > measure) {
      break;
    }
    X[b] = cursor;
    Y[b] = base + DY[S[b]];
    cursor += W[b];
    if (!(f & SPACE)) {
      content = cursor;
    }
    b++;
    if (f & LAST) {
      break;
    }
  }
  const x0 = lineL + (measure - content) / 2;
  for (let k = a; k < b; k++) {
    X[k] += x0;
  }

  let last = b - 1;
  while (last > a && F[last] & SPACE) {
    last--;
  }
  // Runs left of a resolved cut are final: `from` is where the movable part
  // begins and `lo` how far left it may go.
  let from = a;
  let lo = lineL;
  for (let c = 0; c < cuts && from < b; c++) {
    const cl = cutL[c];
    const cr = cutR[c];
    if (cr <= X[from] || cl >= X[last] + W[last]) {
      continue;
    }
    let p = from;
    while (p <= last && (F[p] & SPACE || X[p] + W[p] <= cl)) {
      p++;
    }
    if (p > last) {
      continue;
    }
    let q = p;
    for (let k = p; k <= last && X[k] < cr; k++) {
      if (!(F[k] & SPACE)) {
        q = k;
      }
    }
    let pHead = p;
    while (pHead > from && !(F[pHead] & HEAD)) {
      pHead--;
    }
    let qHead = q + 1;
    while (qHead < b && !(F[qHead] & HEAD)) {
      qHead++;
    }

    let best = -1;
    let bestCost = Infinity;
    let bestL = 0;
    let bestR = 0;
    let wrapAt = -1;
    let wrapL = 0;
    for (let s = pHead; s <= qHead; s++) {
      if (s < b && !(F[s] & HEAD)) {
        continue;
      }
      let shiftL = 0;
      if (s > from) {
        let e = s - 1;
        while (F[e] & SPACE) {
          e--;
        }
        const end = X[e] + W[e];
        if (end > cl) {
          shiftL = cl - end;
        }
        if (X[from] + shiftL < lo) {
          continue;
        }
        // The left part fits: the widest such split is the wrap fallback.
        wrapAt = s;
        wrapL = shiftL;
      }
      let shiftR = 0;
      if (s < b) {
        if (X[s] < cr) {
          shiftR = cr - X[s];
        }
        if (X[last] + W[last] + shiftR > lineR) {
          continue;
        }
      }
      const cost = (s - from) * -shiftL + (b - s) * shiftR;
      if (cost < bestCost) {
        best = s;
        bestCost = cost;
        bestL = shiftL;
        bestR = shiftR;
      }
    }

    if (best >= 0) {
      for (let k = from; k < best; k++) {
        X[k] += bestL;
      }
      for (let k = best; k < b; k++) {
        X[k] += bestR;
      }
      from = best;
      lo = cr;
      continue;
    }
    if (wrapAt > from) {
      // Keep what fits left of the sphere; the rest starts the next line.
      for (let k = from; k < wrapAt; k++) {
        X[k] += wrapL;
      }
      b = wrapAt;
      break;
    }
    // Nothing fits left of it: push right and keep as many runs as fit.
    const shiftR = cr - X[from];
    let e = from;
    for (let k = from + 1; k <= b; k++) {
      if (k < b && !(F[k] & HEAD)) {
        continue;
      }
      let t = k - 1;
      while (F[t] & SPACE) {
        t--;
      }
      if (X[t] + W[t] + shiftR > lineR) {
        break;
      }
      e = k;
    }
    if (e === from) {
      b = from;
      break;
    }
    for (let k = from; k < e; k++) {
      X[k] += shiftR;
    }
    b = e;
    break;
  }
  return b;
}

/* ------------------------------------------------------------- the system */

export function layout(world: World): void {
  const t0 = performance.now();
  const width = world.get(Page.width);
  const vw = world.get(Viewport.w);
  const left = Math.round((vw - width) / 2);
  const top = MARGIN - world.get(Page.scroll);

  cols = columnsFor(width);
  pad = paddingFor(width);
  sheetH = sheetHeightFor(width);
  contentL = pad;
  contentR = width - pad;
  colW = (contentR - contentL - GUTTER * (cols - 1)) / cols;

  // The spheres live in screen space; the page moves under them.
  obstacles = 0;
  world.query(Ball).each((b) => {
    ox[obstacles] = b.x - left;
    oy[obstacles] = b.y - top;
    orad[obstacles] = b.r + CLEARANCE;
    obstacles++;
  });

  sheet = 0;
  col = 0;
  columnsStarted = false;
  colTop = pad;
  y = pad;
  bottom = sheetH - pad;
  fresh = true;

  for (const chunk of world.query(Token, Pos).chunks()) {
    const token = chunk.get(Token);
    const pos = chunk.get(Pos);
    F = token.flags;
    W = token.width;
    R = token.run;
    S = token.style;
    K = token.kind;
    X = pos.x;
    Y = pos.y;

    for (let i = 0, n = chunk.length; i < n; i++) {
      const f = F[i];
      if (f & FIRST) {
        beginBlock(i);
      }
      if (align === CENTER) {
        i = centeredLine(i) - 1;
        continue;
      }
      if (f & SPACE) {
        if (segStart === i) {
          // Leading space: swallowed, and the segment starts after it.
          segStart = i + 1;
          X[i] = x;
          Y[i] = base;
          continue;
        }
        X[i] = x;
        Y[i] = base;
        x += W[i];
        spaces++;
        spaceWidth += W[i];
        continue;
      }
      if (f & HEAD) {
        const need = R[i];
        while (x + need > segR[seg]) {
          if (clear && segStart === i) {
            // A clean line and still too wide: overflow rather than loop.
            break;
          }
          closeSegment(i, false);
          nextSegment(i);
        }
      }
      X[i] = x;
      Y[i] = base + DY[S[i]];
      x += W[i];
      lineEnd = x;
      if (f & LAST) {
        closeSegment(i + 1, true);
        y = lineTop + lh + KINDS[kind].after;
      }
    }
  }

  const height = sheet * (sheetH + SHEET_GAP) + sheetH;
  world.set(Page, { height, sheets: sheet + 1, columns: cols, left, top });
  world.set(Stats.layoutMs, performance.now() - t0);
}
