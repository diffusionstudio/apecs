/**
 * The draw system: sheets, the visible tokens, the spheres. Culling is one
 * compare per token against the viewport; the font is switched only when the
 * style changes between consecutive tokens, which in running text is rarely.
 */
import { SHEET_GAP, sheetHeightFor } from './layout';
import { FONTS } from './styles';
import { Ball, Page, Pos, SPACE, Shade, Stats, Token, Viewport } from './traits';
import type { Reader } from './world';

const INK = '#1b1b1f';
/** Vertical slack around the viewport so tall glyphs at the edges are not clipped. */
const SLOP = 48;
const TAU = Math.PI * 2;

export function draw(world: Reader): void {
  const t0 = performance.now();
  const ctx = world.ctx;
  const vw = world.get(Viewport.w);
  const vh = world.get(Viewport.h);
  const dpr = world.get(Viewport.dpr);
  const width = world.get(Page.width);
  const left = world.get(Page.left);
  const top = world.get(Page.top);

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, vw, vh);

  // Sheets: white on off-white, separated by a shadow with no offset.
  const sheetH = sheetHeightFor(width);
  const sheets = world.get(Page.sheets);
  ctx.save();
  ctx.shadowColor = 'rgba(24, 26, 40, 0.24)';
  ctx.shadowBlur = 28;
  ctx.fillStyle = '#fff';
  for (let k = 0; k < sheets; k++) {
    const sy = top + k * (sheetH + SHEET_GAP);
    if (sy > vh || sy + sheetH < 0) {
      continue;
    }
    ctx.fillRect(left, sy, width, sheetH);
  }
  ctx.restore();

  ctx.fillStyle = INK;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  let style = -1;
  let drawn = 0;
  for (const chunk of world.query(Token, Pos).chunks()) {
    const token = chunk.get(Token);
    const pos = chunk.get(Pos);
    const T = token.text;
    const S = token.style;
    const F = token.flags;
    const X = pos.x;
    const Y = pos.y;
    for (let i = 0, n = chunk.length; i < n; i++) {
      const sy = Y[i] + top;
      if (sy < -SLOP || sy > vh + SLOP || F[i] & SPACE) {
        continue;
      }
      const s = S[i];
      if (s !== style) {
        style = s;
        ctx.font = FONTS[s];
      }
      ctx.fillText(T[i], X[i] + left, sy);
      drawn++;
    }
  }

  world.query(Ball, Shade).each((b, shade) => {
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.shadowColor = 'rgba(0, 0, 0, 0.28)';
    ctx.shadowBlur = b.r * 0.5;
    ctx.shadowOffsetY = b.r * 0.22;
    ctx.fillStyle = shade;
    ctx.beginPath();
    ctx.arc(0, 0, b.r, 0, TAU);
    ctx.fill();
    ctx.restore();
  });

  world.set(Stats, { drawn, drawMs: performance.now() - t0 });
}
