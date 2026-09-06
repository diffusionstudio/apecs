/**
 * Extracts the three README charts out of the benchmark report and re-emits them
 * as standalone, self-contained SVGs — light and dark — for `<picture>` in the
 * README. The report's SVGs lean on the page's stylesheet and on a light-only
 * heat ramp, neither of which survives being loaded through an `<img>`.
 *
 *   node scripts/readme-charts.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';

const SRC = 'reports/2026-09-06-apecs-benchmark.html';
const OUT = 'assets';
const PAD = 28;

const THEMES = {
  light: {
    ground: '#ffffff',
    surface: '#f6f6f6',
    surface2: '#e9e9e9',
    rule: '#e0e0e0',
    ink: '#0b0b0b',
    ink2: '#6b6b6b',
    ink3: '#949494',
    mark: '#c4c4c4',
    blue: '#008cff',
    // dark is slow: the ramp runs from just off the surface down to near-ink.
    ramp: (t) => grey(Math.round(252 - 240 * t)),
    winRamp: (t) => lerp([226, 240, 255], [0, 74, 138], t),
  },
  dark: {
    ground: '#0a0a0a',
    surface: '#141414',
    surface2: '#262626',
    rule: '#2c2c2c',
    ink: '#f0f0f0',
    ink2: '#a8a8a8',
    ink3: '#7a7a7a',
    mark: '#5a5a5a',
    blue: '#3aa0ff',
    // Inverted: on a dark ground the slow end has to be the light one.
    ramp: (t) => grey(Math.round(26 + 205 * t)),
    winRamp: (t) => lerp([16, 40, 64], [140, 205, 255], t),
  },
};

const grey = (v) => `rgb(${v},${v},${v})`;
const lerp = (a, b, t) => `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(',')})`;

/** sRGB relative luminance — decides whether a cell label goes light or dark. */
function luminance(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const parseRgb = (s) =>
  s.startsWith('#')
    ? [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16))
    : s.match(/\d+/g).map(Number);

const style = (t) => `
  <style>
    svg { font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
    text { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; font-variant-numeric: tabular-nums; fill: ${t.ink2}; }
    .row-label, .col-label { font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; font-size: 13px; fill: ${t.ink2}; }
    .row-label.is-strong, .col-label.is-strong { fill: ${t.ink}; font-weight: 600; }
    .value { fill: ${t.ink2}; }
    .value.on-dark { fill: ${t.ground}; font-weight: 500; }
    .cell { font-size: 11.5px; }
    .tick { fill: ${t.ink3}; font-size: 11px; }
    .foot { fill: ${t.ink3}; font-size: 11px; }
    .grid { stroke: ${t.rule}; stroke-width: 1; }
    .axis-line { stroke: ${t.ink3}; stroke-width: 1; }
    .ref { stroke: ${t.ink3}; stroke-width: 1; stroke-dasharray: 2 3; }
    .link { stroke: ${t.mark}; stroke-width: 2; }
    .bar { fill: ${t.mark}; }
    .bar.is-strong { fill: ${t.ink}; }
    .dot { fill: ${t.mark}; stroke: ${t.surface}; stroke-width: 2; }
    .dot.is-strong { fill: ${t.ink}; }
    .dot.hollow { fill: ${t.surface}; stroke: ${t.mark}; }
    .dot.hollow.is-strong { stroke: ${t.ink}; }
    .win { fill: none; stroke: ${t.blue}; stroke-width: 2.5; }
  </style>`;

/** Wraps report-coordinate content in a padded, rounded card. */
const card = (w, h, body, label, t) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w + PAD * 2} ${h + PAD * 2}" width="${w + PAD * 2}" height="${h + PAD * 2}" role="img" aria-label="${label}">${style(t)}
  <rect width="${w + PAD * 2}" height="${h + PAD * 2}" rx="20" fill="${t.surface}" />
  <g transform="translate(${PAD},${PAD})">${body}</g>
</svg>
`;

const html = readFileSync(SRC, 'utf8');
const svgs = html.match(/<svg [\s\S]*?<\/svg>/g);
const byLabel = (needle) => svgs.find((s) => s.includes(`aria-label="${needle}`));
// The report is served as HTML, which tolerates the `</rect />` its bar helper
// emits. A standalone SVG is parsed as XML, which does not.
const inner = (svg) =>
  svg
    .replace(/^<svg[^>]*>/, '')
    .replace(/<\/svg>$/, '')
    .replace(/<\/rect \/>/g, '</rect>');
const size = (svg) =>
  svg
    .match(/viewBox="0 0 (\d+) (\d+)"/)
    .slice(1, 3)
    .map(Number);

/* ── 1. Heatmap: every library as a multiple of the hand-written floor ─────── */
function heatmap(t) {
  const src = byLabel('Every benchmark and library as a multiple');
  const [w, h] = size(src);
  let body = inner(src);

  // The report bakes its light-mode ramp into fill attributes. Re-derive `t`
  // from each fill, re-ramp it for this theme, then pick the label colour from
  // the result's luminance rather than from the report's light-mode threshold.
  body = body.replace(
    /<rect x="([\d.]+)" y="(\d+)" width="([\d.]+)" height="(\d+)" fill="([^"]+)"><title>([\s\S]*?)<\/title><\/rect>((?:<rect class="win"[^>]*\/>)?)<text class="cell[^"]*"([^>]*)>([^<]*)<\/text>/g,
    (_m, x, y, cw, ch, fill, title, ring, attrs, label) => {
      let out;
      if (fill.includes('surface-2')) {
        out = t.surface2;
      } else if (fill.startsWith('rgb')) {
        const rgb = parseRgb(fill);
        const isWin = rgb[0] !== rgb[1] || rgb[1] !== rgb[2];
        const k = isWin ? (226 - rgb[0]) / 226 : (252 - rgb[0]) / 240;
        out = isWin ? t.winRamp(k) : t.ramp(k);
      } else {
        out = fill;
      }
      // `text { fill }` in the stylesheet outranks a fill attribute, so this goes inline.
      const ink = luminance(parseRgb(out)) > 0.4 ? '#0b0b0b' : '#f5f5f5';
      return `<rect x="${x}" y="${y}" width="${cw}" height="${ch}" fill="${out}"><title>${title}</title></rect>${ring}<text class="cell"${attrs} style="fill:${ink}">${label}</text>`;
    },
  );
  body = body.replace(/class="tick"([^>]*)>lower is better/, 'class="foot"$1>lower is better');
  return card(
    w,
    h,
    body,
    'Every benchmark and library as a multiple of the hand-written baseline',
    t,
  );
}

/* ── 2. Escape hatch, apecs rows only ─────────────────────────────────────── */
function escapeHatch(t) {
  const src = byLabel('Ergonomic tier against raw tier');
  const [w] = size(src);
  const body = inner(src);

  const head = body.slice(0, body.indexOf('<text class="row-label'));
  const tail = body.slice(body.indexOf('<line class="axis-line"'));
  const middle = body.slice(head.length, body.length - tail.length);
  const rows = middle.split(/(?=<text class="row-label)/).filter(Boolean);

  const ROW = 34;
  const kept = [];
  rows.forEach((row, i) => {
    if (!/>[^<]*· apecs</.test(row)) return;
    const dy = ROW * (kept.length - i);
    kept.push(dy === 0 ? row : `<g transform="translate(0,${dy})">${row}</g>`);
  });

  const bottom = 16 + ROW * (kept.length + 1) - 6; // axis foot, one row of slack
  const out =
    (head + kept.join('') + tail)
      .replace(/y2="436"/g, `y2="${bottom}"`)
      .replace(/y="452"/g, `y="${bottom + 16}"`) +
    `<circle class="dot is-strong" cx="214" cy="${bottom + 42}" r="5" /><text class="foot" x="226" y="${bottom + 46}">raw tier (chunks)</text>` +
    `<circle class="dot hollow is-strong" cx="366" cy="${bottom + 42}" r="5" /><text class="foot" x="378" y="${bottom + 46}">ergonomic tier (each)</text>` +
    `<text class="foot" x="824" y="${bottom + 46}" text-anchor="end">microseconds · lower is better</text>`;

  return card(w, bottom + 52, out, 'apecs ergonomic tier against its raw tier, microseconds', t);
}

/* ── 3. Bytes per entity ──────────────────────────────────────────────────── */
function bytes(t) {
  const src = byLabel('Bytes per entity');
  const [w, h] = size(src);
  const body =
    inner(src) +
    `<text class="foot" x="200" y="${h + 14}">bytes per entity · lower is better</text>`;
  return card(w, h + 20, body, 'Bytes per entity', t);
}

const charts = { 'bench-baseline': heatmap, 'bench-tiers': escapeHatch, 'bench-bytes': bytes };
for (const [name, build] of Object.entries(charts)) {
  for (const [theme, tokens] of Object.entries(THEMES)) {
    const file = `${OUT}/${name}-${theme}.svg`;
    writeFileSync(file, build(tokens));
    console.log(file);
  }
}
