/**
 * Renders the benchmark numbers as one HTML page: the SPEC §12.1 budgets from
 * `bench/results.json`, and the cross-library figures from
 * `bench/compare/results.json` + `findings.json`.
 *
 * Nothing here is typed in by hand — every figure is read from a results file,
 * for the same reason `bench/compare/report.mjs` derives its prose: a number
 * copied into a document is a number that will be wrong later. The charts are
 * built as SVG strings at render time, so the page is static and complete
 * before any script runs.
 *
 *   node scripts/bench-report-html.mjs [out.html] [--fragment]
 *
 * `--fragment` omits the document skeleton, for hosts that supply their own.
 */
import { readFileSync, statSync, writeFileSync } from 'node:fs';

import { BUDGETS, readResults } from './bench-budgets.mjs';

const args = process.argv.slice(2);
const FRAGMENT = args.includes('--fragment');
const OUT = args.find((a) => !a.startsWith('--')) ?? 'bench/report.html';
const SPEC_RESULTS = 'bench/results.json';
const COMPARE = 'bench/compare/results.json';
const FINDINGS = 'bench/compare/findings.json';

const { results, median } = readResults(SPEC_RESULTS);
const compare = JSON.parse(readFileSync(COMPARE, 'utf8'));
const findings = JSON.parse(readFileSync(FINDINGS, 'utf8'));
const sweep = findings.traitCountSweep;

const N = 100_000;
const RIVALS = ['bitecs', 'koota', 'becsy'];
const LIBS = ['baseline', 'apecs', ...RIVALS];
const TITLE = {
  baseline: 'hand-written',
  apecs: 'apecs',
  bitecs: 'bitECS',
  koota: 'koota',
  becsy: 'becsy',
};
/** Short enough to sit in a chart's label column; the tables carry the long form. */
const SHORT = {
  packed_1: 'Iterate 1 trait',
  packed_5: '5 systems',
  simple_iter: 'Move 100 000',
  frag_iter: '26 archetypes',
  entity_cycle: 'Spawn/despawn',
  add_remove: 'Add/remove trait',
  mixed_query: 'Query + exclusions',
  random_access: 'Look up by handle',
};
const LONG = {
  packed_1: 'Iterate one trait',
  packed_5: 'Five systems in a row',
  simple_iter: 'Move 100 000 entities',
  frag_iter: 'Iterate across 26 archetypes',
  entity_cycle: 'Spawn and despawn',
  add_remove: 'Add and remove a trait',
  mixed_query: 'Query with exclusions',
  random_access: 'Look up by entity handle',
};
const BENCHES = Object.keys(SHORT);

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const num = (v, digits = 0) =>
  v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const us = (ns) => (ns / 1000 >= 100 ? num(ns / 1000) : num(ns / 1000, 1));
const times = (v) => (v >= 100 ? `${num(v)}×` : `${num(v, 1)}×`);

/** The fastest tier a library offers for a benchmark — its honest best. */
function best(bench, lib) {
  const entry = compare.timings[bench]?.[lib];
  if (!entry) {
    return undefined;
  }
  const values = Object.values(entry.variants)
    .filter((v) => !v.error)
    .map((v) => v.avg);
  return values.length ? Math.min(...values) : undefined;
}
function tier(bench, lib, name) {
  const v = compare.timings[bench]?.[lib]?.variants?.[name];
  return v && !v.error ? v.avg : undefined;
}

// ---------------------------------------------------------------- chart parts
//
// Colour is achromatic by mandate: identity never rests on a hue here. Where a
// chart needs to tell series apart it either splits into small multiples or
// labels every mark, and the one accent — the brand red — is reserved for a
// single meaning: a number that misses its budget.

const T = (x, y, s, cls = 'tick', anchor = 'middle', extra = '') =>
  `<text class="${cls}" x="${x}" y="${y}" text-anchor="${anchor}"${extra}>${s}</text>`;
const L = (x1, y1, x2, y2, cls, extra = '') =>
  `<line class="${cls}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"${extra} />`;
const RECT = (x, y, w, h, cls, extra = '') =>
  `<rect class="${cls}" x="${x}" y="${y}" width="${Math.max(0, w).toFixed(1)}" height="${h}"${extra} />`;
const DOT = (cx, cy, r, cls, title = '') =>
  `<circle class="${cls}" cx="${Number(cx).toFixed(1)}" cy="${Number(cy).toFixed(1)}" r="${r}">${
    title ? `<title>${esc(title)}</title>` : ''
  }</circle>`;
const svg = (w, h, body, label) =>
  `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}">${body}</svg>`;

const W = 824;

/** Horizontal bars from a zero baseline: the only honest bar scale. */
function barChart(
  rows,
  { max, ticks, unit, label, format = (v) => num(v, 1), ref, x0 = 200, tickLabel = (v) => num(v) },
) {
  const X0 = x0;
  const X1 = W - 96;
  const ROW = 34;
  const H = 16 + rows.length * ROW + 34;
  const at = (v) => X0 + (v / max) * (X1 - X0);
  let s = '';
  for (const t of ticks) {
    s += L(at(t), 8, at(t), H - 30, 'grid') + T(at(t), H - 14, tickLabel(t));
  }
  if (ref) {
    s +=
      L(at(ref.value), 4, at(ref.value), H - 30, 'ref') +
      T(at(ref.value) + 8, 14, esc(ref.label), 'tick', 'start');
  }
  rows.forEach((row, i) => {
    const y = 16 + i * ROW;
    s +=
      T(X0 - 14, y + 15, esc(row.label), `row-label${row.strong ? ' is-strong' : ''}`, 'end') +
      RECT(
        X0,
        y + 2,
        at(row.value) - X0,
        18,
        `bar${row.strong ? ' is-strong' : ''}${row.over ? ' is-over' : ''}`,
        `><title>${esc(row.label)}: ${format(row.value)} ${unit}</title></rect`,
      ) +
      T(at(row.value) + 10, y + 15, format(row.value), 'value', 'start');
  });
  s += L(X0, 8, X0, H - 30, 'axis-line') + T(X0, H - 14, '0');
  return svg(W, H, s, label);
}

/**
 * Two states of the same row, joined: the distance is the point. Filled dot is
 * the first state, hollow the second, so the pair reads without colour.
 */
function dumbbell(rows, { min, max, ticks, tickLabel = (v) => num(v), label, legend }) {
  const X0 = 208;
  const X1 = W - 220;
  const ROW = 34;
  const H = 24 + rows.length * ROW + 34;
  const at = (v) =>
    X0 + ((Math.log10(v) - Math.log10(min)) / (Math.log10(max) - Math.log10(min))) * (X1 - X0);
  let s = '';
  for (const t of ticks) {
    s += L(at(t), 16, at(t), H - 30, 'grid') + T(at(t), H - 14, tickLabel(t));
  }
  rows.forEach((row, i) => {
    const y = 24 + i * ROW + 12;
    const [a, b] = [at(row.a), at(row.b)];
    s +=
      T(X0 - 14, y + 4, esc(row.label), `row-label${row.strong ? ' is-strong' : ''}`, 'end') +
      L(Math.min(a, b), y, Math.max(a, b), y, 'link') +
      DOT(
        a,
        y,
        5,
        `dot${row.strong ? ' is-strong' : ''}`,
        `${row.label}, ${legend[0]}: ${num(row.a)}`,
      ) +
      DOT(
        b,
        y,
        5,
        `dot hollow${row.strong ? ' is-strong' : ''}`,
        `${row.label}, ${legend[1]}: ${num(row.b)}`,
      ) +
      T(W, y + 4, `${num(row.a)} → ${num(row.b)}`, 'value', 'end');
  });
  s += L(X0, 16, X0, H - 30, 'axis-line');
  return svg(W, H, s, label);
}

/** Diverging from a centre line: how far apecs sits from the next-fastest library. */
function divergingChart(rows, { label }) {
  const X0 = 200;
  const X1 = W - 16;
  // The extents come from the data: a fixed allowance either clips the long
  // bars or wastes half the frame when nothing is slow.
  const logs = rows.map((r) => Math.log10(r.factor));
  const left = Math.max(0.12, -Math.min(...logs, 0)) * 1.04;
  const right = Math.max(0.12, Math.max(...logs, 0)) * 1.04;
  const px = (X1 - X0) / (left + right);
  const CX = X0 + left * px;
  const at = (logv) => CX + logv * px;
  const ROW = 32;
  const H = 34 + rows.length * ROW + 30;
  let s = '';
  for (const [v, lab] of [
    [-1, '10×'],
    [-0.699, '5×'],
    [-0.301, '2×'],
    [0.301, '2×'],
    [0.699, '5×'],
  ]) {
    if (v < -left || v > right) {
      continue;
    }
    s += L(at(v), 26, at(v), H - 28, 'grid') + T(at(v), H - 12, lab);
  }
  s +=
    T(X0 + 4, 16, 'apecs slower', 'tick', 'start') +
    T(X1 - 4, 16, 'apecs faster', 'tick', 'end') +
    L(CX, 22, CX, H - 28, 'axis-line');
  rows.forEach((row, i) => {
    const y = 34 + i * ROW;
    const faster = row.factor >= 1;
    const w = Math.abs(Math.log10(row.factor)) * px;
    const text = `${times(faster ? row.factor : 1 / row.factor)} vs ${row.rival}`;
    // A label only goes inside a bar that can hold it with room on both sides.
    const inside = w > text.length * 7.4 + 24;
    s +=
      T(X0 - 14, y + 14, esc(row.label), 'row-label is-strong', 'end') +
      RECT(
        faster ? CX : CX - w,
        y,
        w,
        19,
        // Neutral both ways: the side of the axis is what says faster or slower,
        // so the fill only has to carry the two-group emphasis.
        `bar ${faster ? 'is-strong' : 'is-weak'}`,
        `><title>${esc(row.label)}: ${text} ${faster ? 'faster' : 'slower'}</title></rect`,
      ) +
      T(
        faster ? (inside ? CX + w - 10 : CX + w + 10) : inside ? CX - w + 10 : CX - w - 10,
        y + 14,
        esc(text),
        `value${inside ? ' on-dark' : ''}`,
        faster === inside ? 'end' : 'start',
      );
  });
  return svg(W, H, s, label);
}

/** Magnitude by luminance: one ramp, dark is slow, and the winner is outlined. */
function heatmap({ label }) {
  const X0 = 168;
  const CW = (W - X0) / LIBS.length;
  const RH = 36;
  const H = 34 + BENCHES.length * RH + 26;
  const ramp = (t) => {
    const v = Math.round(252 - 240 * t);
    return `rgb(${v},${v},${v})`;
  };
  // The winner keeps the same lightness position and takes the positive hue: a
  // ring in any single colour disappears somewhere along a full-range ramp.
  const winRamp = (t) => {
    const a = [226, 240, 255];
    const b = [0, 74, 138];
    return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(',')})`;
  };
  let s = '';
  LIBS.forEach((lib, c) => {
    s += T(
      X0 + c * CW + CW / 2,
      22,
      esc(TITLE[lib]),
      `col-label${lib === 'apecs' ? ' is-strong' : ''}`,
    );
  });
  BENCHES.forEach((bench, r) => {
    const y = 34 + r * RH;
    const base = best(bench, 'baseline');
    const ratios = LIBS.map((lib) => best(bench, lib) / base);
    const fastest = Math.min(...ratios.slice(1));
    s += T(X0 - 14, y + RH / 2 + 4, esc(SHORT[bench]), 'row-label is-strong', 'end');
    ratios.forEach((ratio, c) => {
      const x = X0 + c * CW;
      const t = Math.min(1, Math.max(0, Math.log10(ratio) / 2.7));
      const wins = c > 0 && ratio === fastest;
      s += `<rect x="${(x + 2).toFixed(1)}" y="${y + 2}" width="${(CW - 4).toFixed(1)}" height="${RH - 6}" fill="${
        c === 0 ? 'var(--surface-2)' : wins ? winRamp(t) : ramp(t)
      }"><title>${esc(TITLE[LIBS[c]])} · ${esc(SHORT[bench])}: ${times(ratio)} baseline${
        wins ? ', fastest in this row' : ''
      }</title></rect>`;
      // A pale blue against a pale grey is a small difference; the ring closes it.
      if (wins && t < 0.45) {
        s += `<rect class="win" x="${(x + 3).toFixed(1)}" y="${y + 3}" width="${(CW - 6).toFixed(1)}" height="${RH - 8}" />`;
      }
      s += T(
        x + CW / 2,
        y + RH / 2 + 4,
        times(ratio),
        `cell${(wins ? t > 0.4 : t > 0.55) ? ' on-dark' : ''}`,
      );
    });
  });
  s += T(X0, H - 6, 'lower is better · 1.0× is the hand-written typed-array loop', 'tick', 'start');
  return svg(W, H, s, label);
}

/**
 * One frame, four libraries overlaid: the cliff is only legible as a shape
 * against the flat lines beside it. This is the one chart where colour carries
 * identity, so the four hues are a validated categorical set (CVD-checked),
 * each line is labelled at its end, and the label text stays in the text ink —
 * the colour rides the mark beside it, never the words.
 */
function cliffChart() {
  const ks = sweep.ks;
  const series = [
    { key: 'koota', label: 'koota', values: sweep.koota },
    { key: 'becsy', label: 'becsy', values: sweep.becsy },
    { key: 'bitecs', label: 'bitECS', values: sweep.bitecs },
    { key: 'apecs', label: 'apecs each', values: sweep.apecs },
  ];
  const H = 372;
  const X0 = 56;
  const X1 = W - 168;
  const Y0 = 28;
  const Y1 = H - 56;
  const MAX = 45;
  const x = (i) => X0 + (i / (ks.length - 1)) * (X1 - X0);
  const y = (v) => Y1 - (Math.min(v, MAX) / MAX) * (Y1 - Y0);
  let s = '';
  for (const g of [0, 10, 20, 30, 40]) {
    s += L(X0, y(g), X1, y(g), 'grid') + T(X0 - 10, y(g) + 4, g, 'tick', 'end');
  }
  s += T(X0 - 10, Y0 - 12, 'ns per entity visit', 'tick', 'start');
  // Where V8 stops inlining a polymorphic call. becsy breaks here; koota breaks
  // three traits earlier, on the monomorphic-to-polymorphic step.
  const icx = x(3.5);
  s +=
    L(icx, Y0 - 6, icx, Y1, 'ref') + T(icx + 8, Y0 + 4, "V8's four-shape limit", 'tick', 'start');
  s += L(X0, Y1, X1, Y1, 'axis-line');
  ks.forEach((k, i) => {
    s += T(x(i), Y1 + 22, k);
  });
  s += T((X0 + X1) / 2, Y1 + 44, 'distinct traits used with the ergonomic API', 'tick');

  const points = (values, indices = values.map((_, i) => i)) =>
    indices.map((i, n) => `${x(i).toFixed(1)},${y(values[n]).toFixed(1)}`).join(' ');

  // apecs's other tiers are the same entity: same hue, dashed.
  const chunks = sweep.apecsChunks;
  s += `<polyline class="line s-apecs dashed" points="${points(
    chunks.ns,
    chunks.ks.map((k) => ks.indexOf(k)),
  )}" />`;
  for (const item of series) {
    s += `<polyline class="line s-${item.key}" points="${points(item.values)}" />`;
    s += item.values
      .map((v, i) =>
        DOT(x(i), y(v), 3, `mark s-${item.key}`, `${item.label}, ${ks[i]} traits: ${num(v, 2)} ns`),
      )
      .join('');
  }

  // End labels, nudged apart so no two collide.
  const ends = [
    ...series.map((item) => ({
      key: item.key,
      label: item.label,
      value: item.values.at(-1),
      y: y(item.values.at(-1)),
    })),
    {
      key: 'apecs',
      label: 'apecs chunks',
      value: chunks.ns.at(-1),
      y: y(chunks.ns.at(-1)),
      dashed: true,
    },
  ].sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) {
    ends[i].y = Math.max(ends[i].y, ends[i - 1].y + 19);
  }
  for (const end of ends) {
    const lx = X1 + 16;
    s +=
      (end.dashed
        ? L(lx, end.y - 4, lx + 14, end.y - 4, `line s-${end.key} dashed`)
        : DOT(lx + 7, end.y - 4, 4, `mark s-${end.key}`)) +
      T(lx + 24, end.y, `${esc(end.label)} ${num(end.value, 1)}`, 'value', 'start');
  }
  return svg(W, H, s, 'Nanoseconds per entity visit against the number of distinct traits');
}

// ------------------------------------------------------------------- the data

const budgets = BUDGETS.map((budget) => {
  const value = budget.value(median);
  // A negative limit reads as "at least this much", for the ratios that must be large.
  const atLeast = budget.limit < 0;
  const limit = Math.abs(budget.limit);
  const ok = atLeast ? value >= limit : value <= limit;
  // Both kinds plot as "share of the budget spent", so one axis carries all nine.
  const used = atLeast ? limit / Math.max(value, 1e-9) : value / limit;
  return {
    name: budget.name,
    spec: budget.spec,
    measured: budget.format(value),
    limit: atLeast ? `≥ ${budget.format(limit)}` : `≤ ${budget.format(limit)}`,
    ok,
    used,
  };
});
const failed = budgets.filter((b) => !b.ok);

const sorted = findings.sortedQueries;
const CAPABILITY = [
  ['apecsOrderedChunks', 'apecs orderBy + chunks', true],
  ['apecsOrderedEach', 'apecs orderBy + each', true],
  ['apecs', 'apecs sortBy + each', true],
  ['handwritten', 'hand-written sort', false],
  ['koota', 'koota sort()', false],
].map(([key, label, strong]) => ({ label, strong, ...sorted[key] }));

const rivalRows = BENCHES.map((bench) => {
  const mine = best(bench, 'apecs');
  const rival = RIVALS.map((lib) => ({ lib, v: best(bench, lib) }))
    .filter((r) => r.v !== undefined)
    .sort((a, b) => a.v - b.v)[0];
  return { label: SHORT[bench], factor: rival.v / mine, rival: TITLE[rival.lib] };
}).sort((a, b) => b.factor - a.factor);

const tierRows = BENCHES.flatMap((bench) =>
  ['apecs', 'koota']
    .map((lib) => ({
      label: `${SHORT[bench]} · ${TITLE[lib]}`,
      a: tier(bench, lib, 'raw') / 1000,
      b: tier(bench, lib, 'ergonomic') / 1000,
      strong: lib === 'apecs',
    }))
    .filter((r) => Number.isFinite(r.a) && Number.isFinite(r.b)),
);

/** ns per entity to walk 100 000 rows, all three from the same vitest run. */
const walkRows = [
  { label: 'chunks, unsorted', value: (median('ordered-iter', 'apecs chunks') * 1e6) / N },
  {
    label: 'orderBy + chunks',
    value: (median('ordered-iter', 'apecs ordered chunks') * 1e6) / N,
    strong: true,
  },
  { label: 'sortBy + each', value: (median('ordered-iter', 'apecs sorted each') * 1e6) / N },
];

const orderedRatio = budgets.find((b) => b.name.startsWith('ordered-iter')).measured;
const cleanUs = sorted.apecsOrderedChunks.static;
const vsKoota = sorted.koota.static / cleanUs;
const vsHand = sorted.handwritten.static / cleanUs;
const vsSortBy = sorted.apecs.static / cleanUs;
const when = new Date(compare.meta.when);
const specWhen = statSync(SPEC_RESULTS).mtime;
const date = (d) =>
  d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
const marginal = (lib) => {
  const [a, b] = compare.memory[lib].points.slice(-2);
  return (b.bytes - a.bytes) / (b.n - a.n);
};

const style = `
:root {
  --ground: #ffffff;
  --surface: #f4f4f4;
  --surface-2: #e9e9e9;
  --rule: #e4e4e4;
  --ink: #0b0b0b;
  --ink-2: #6b6b6b;
  --ink-3: #9c9c9c;
  --mark: #c4c4c4;
  --red: #f43535;
  /* The product blue is the positive, against the brand red. The design guide
     reserves it for real product UI, so this is a deliberate extension of it —
     and it separates from the red far better than a green would for a
     red-blind reader. The deep step is the one that carries white labels at AA. */
  --blue: #008cff;
  --blue-deep: #006ec7;
  --blue-soft: #e2f0ff;
  /* One validated categorical set, used only where colour carries identity:
     CVD-checked against this surface, and never the sole channel — every line
     is labelled at its end. */
  --s-apecs: #0079db;
  --s-bitecs: #0f7a5a;
  --s-koota: #7a3e9d;
  --s-becsy: #b0641a;
  --sans: 'Geist', system-ui, -apple-system, 'Segoe UI', sans-serif;
  --mono: 'Geist Mono', ui-monospace, 'SF Mono', Menlo, monospace;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--ground);
  color: var(--ink);
  font-family: var(--sans);
  font-size: 15px;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}
.page { max-width: 1000px; margin: 0 auto; padding: 64px; }
@media (max-width: 720px) { .page { padding: 32px 24px; } }
main { display: flex; flex-direction: column; gap: 80px; }
section { display: flex; flex-direction: column; gap: 24px; }
h1, h2, h3 { margin: 0; text-wrap: balance; font-weight: 600; letter-spacing: -0.02em; }
h1 { font-size: 44px; line-height: 1.1; }
h2 { font-size: 24px; line-height: 1.25; }
h3 { font-size: 14px; font-weight: 500; letter-spacing: 0; }
h3 .unit { color: var(--ink-3); font-weight: 400; }
p { margin: 0; max-width: 66ch; color: var(--ink-2); }
p strong { color: var(--ink); font-weight: 500; }
code { font-family: var(--mono); font-size: 0.92em; color: var(--ink); }
.label {
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--ink-3);
}
.masthead { display: flex; flex-direction: column; gap: 24px; padding-bottom: 40px; }
.dek { font-size: 19px; line-height: 1.5; max-width: 60ch; }
.runmeta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 32px;
  padding-top: 24px;
  border-top: 1px solid var(--rule);
  font-family: var(--mono);
  font-size: 12.5px;
  color: var(--ink-2);
}
.runmeta span::before { content: attr(data-key) ' '; color: var(--ink-3); }
.tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
@media (max-width: 900px) { .tiles { grid-template-columns: repeat(2, 1fr); } }
@media (max-width: 720px) { .tiles { grid-template-columns: 1fr; } }
.tile {
  background: var(--surface);
  border-radius: 24px;
  padding: 32px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.tile .figure.is-gap { color: var(--red); }
.tile .figure.is-win { color: var(--blue-deep); }
.tile .figure {
  font-family: var(--mono);
  font-size: 40px;
  font-weight: 500;
  letter-spacing: -0.03em;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
.tile p { font-size: 14px; }
.section-head { display: flex; flex-direction: column; gap: 16px; }
figure { margin: 0; display: flex; flex-direction: column; gap: 16px; }
.frame { background: var(--surface); border-radius: 24px; padding: 32px; overflow-x: auto; }
.frame svg { display: block; width: 100%; min-width: 560px; height: auto; }
figcaption { font-size: 13.5px; color: var(--ink-3); max-width: 74ch; line-height: 1.55; }
.legend { display: flex; flex-wrap: wrap; gap: 8px 24px; font-family: var(--mono); font-size: 12px; color: var(--ink-2); }
.legend span { display: inline-flex; align-items: center; gap: 8px; }
.key { width: 11px; height: 11px; border-radius: 50%; background: var(--ink); }
.key.hollow { background: var(--ground); box-shadow: inset 0 0 0 2px var(--ink); }
.key.s-apecs { background: var(--s-apecs); }
.key.s-bitecs { background: var(--s-bitecs); }
.key.s-koota { background: var(--s-koota); }
.key.s-becsy { background: var(--s-becsy); }
.key.dash.s-apecs { background: none; border-top-color: var(--s-apecs); }
.key.dash { width: 16px; height: 0; border-radius: 0; border-top: 2px dashed var(--ink); }
svg text { font-family: var(--mono); font-size: 12px; font-variant-numeric: tabular-nums; }
svg .row-label, svg .col-label { font-family: var(--sans); font-size: 13px; fill: var(--ink-2); }
svg .row-label.is-strong, svg .col-label.is-strong { fill: var(--ink); font-weight: 500; }
svg .value { fill: var(--ink-2); }
svg .value.on-dark { fill: var(--ground); font-weight: 500; }
svg .cell { fill: var(--ink); font-size: 11.5px; }
svg .cell.on-dark { fill: var(--ground); }
svg .tick { fill: var(--ink-3); font-size: 11px; }
svg .grid { stroke: var(--rule); stroke-width: 1; }
svg .axis-line { stroke: var(--ink-3); stroke-width: 1; }
svg .ref { stroke: var(--ink-3); stroke-width: 1; stroke-dasharray: 2 3; }
svg .link { stroke: var(--mark); stroke-width: 2; }
svg .bar { fill: var(--mark); }
svg .bar.is-strong { fill: var(--ink); }
svg .bar.is-over { fill: var(--red); }
svg .bar.is-weak { fill: var(--ink-2); }
svg .dot { fill: var(--mark); stroke: var(--surface); stroke-width: 2; }
svg .dot.is-strong { fill: var(--ink); }
svg .dot.hollow { fill: var(--surface); stroke: var(--mark); }
svg .dot.hollow.is-strong { stroke: var(--ink); }
svg .win { fill: none; stroke: var(--blue); stroke-width: 2.5; }
svg .line { fill: none; stroke: var(--ink); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
svg .line.dashed { stroke-dasharray: 5 4; stroke-width: 2; }
svg .s-apecs { stroke: var(--s-apecs); }
svg .s-bitecs { stroke: var(--s-bitecs); }
svg .s-koota { stroke: var(--s-koota); }
svg .s-becsy { stroke: var(--s-becsy); }
svg .mark { stroke: var(--surface); stroke-width: 1.5; }
svg .mark.s-apecs { fill: var(--s-apecs); }
svg .mark.s-bitecs { fill: var(--s-bitecs); }
svg .mark.s-koota { fill: var(--s-koota); }
svg .mark.s-becsy { fill: var(--s-becsy); }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
th, td { text-align: right; padding: 12px 16px; border-bottom: 1px solid var(--rule); white-space: nowrap; }
th:first-child, td:first-child { text-align: left; padding-left: 0; }
th:last-child, td:last-child { padding-right: 0; }
thead th {
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--ink-3);
  border-bottom-color: var(--ink-3);
}
tbody td { font-family: var(--mono); font-variant-numeric: tabular-nums; color: var(--ink-2); }
tbody td:first-child { font-family: var(--sans); color: var(--ink); }
tbody tr:last-child td { border-bottom: none; }
td.lead { color: var(--ink); font-weight: 500; }
td.sub { font-family: var(--sans); font-size: 13px; color: var(--ink-3); white-space: normal; }
td .mul { display: block; font-size: 12px; color: var(--ink-3); }
.status { display: inline-flex; align-items: center; gap: 8px; font-family: var(--sans); font-size: 13px; }
.status::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: var(--blue); }
.status.over { color: var(--red); }
.status.over::before { background: var(--red); }
tr.over td { color: var(--ink); }
.note {
  border-left: 2px solid var(--ink);
  padding: 4px 0 4px 24px;
  max-width: 74ch;
  font-size: 15px;
  color: var(--ink-2);
}
.note .lab { display: block; margin-bottom: 8px; }
.method { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; }
@media (max-width: 720px) { .method { grid-template-columns: 1fr; } }
.mcell { background: var(--surface); border-radius: 24px; padding: 24px 24px 28px; display: flex; flex-direction: column; gap: 8px; }
.mcell p { font-size: 14px; }
footer {
  margin-top: 80px;
  padding-top: 24px;
  border-top: 1px solid var(--rule);
  display: flex;
  flex-direction: column;
  gap: 16px;
}
footer pre { margin: 0; font-family: var(--mono); font-size: 12.5px; color: var(--ink-2); overflow-x: auto; }
a { color: var(--ink); text-decoration-color: var(--ink-3); text-underline-offset: 3px; }
:focus-visible { outline: 2px solid var(--ink); outline-offset: 3px; }

/* Print: the surfaces and the heat cells are data, so they have to survive the
   print pipeline's default of dropping backgrounds. */
@page { size: A4 portrait; margin: 14mm; }
@media print {
  :root { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
  body { font-size: 11pt; }
  .page { padding: 0; max-width: none; }
  main { gap: 40px; }
  h1 { font-size: 32px; }
  h2 { font-size: 19px; }
  .frame, .mcell, .tile { overflow: visible; }
  figure, .frame, .tiles, .method, .note, tr { break-inside: avoid; }
  .legend { break-after: avoid; }
  section { break-inside: auto; }
  h2 { break-after: avoid; }
  .section-head { break-inside: avoid; break-after: avoid; }
  .scroll { overflow: visible; }
  .frame svg { min-width: 0; }
}
`;

const body = `
<div class="page">
  <header class="masthead">
    <div class="label">Diffusion Studio · apecs 0.1.0</div>
    <h1>Where apecs stands</h1>
    <p class="dek">
      The whole measured surface as it is today: eight benchmarks against bitECS, koota and becsy
      with a hand-written typed-array loop as the floor, the nine SPEC §12.1 budgets, both known
      gaps, and what a query in key order costs.
    </p>
    <div class="runmeta">
      <span data-key="machine">${esc(compare.meta.cpus)}</span>
      <span data-key="node">${esc(compare.meta.node)}</span>
      <span data-key="suite">${esc(date(specWhen))}</span>
      <span data-key="comparison">${esc(date(when))} · min of ${compare.meta.runs} runs</span>
    </div>
  </header>

  <main>
    <section>
      <div class="tiles">
        <div class="tile">
          <div class="figure is-win">${num(
            median('simple-iter', 'apecs chunks') / median('simple-iter', 'baseline'),
            2,
          )}×</div>
          <p><strong>The hot loop, against a hand-written typed-array loop.</strong> 100 000
          entities, two traits, one integrate pass through <code>chunks</code>.</p>
        </div>
        <div class="tile">
          <div class="figure">${num(compare.memory.apecs.perEntity, 1)} B</div>
          <p><strong>Per entity</strong>, where the payload itself is 16 and the next-lightest
          library charges ${num(compare.memory.becsy.perEntity)}.</p>
        </div>
        <div class="tile">
          <div class="figure">${budgets.length - failed.length} of ${budgets.length}</div>
          <p><strong>SPEC §12.1 budgets held.</strong> The miss is per-entity access by handle, at
          ${esc(budgets.find((b) => b.name.startsWith('random-access')).measured)} of a flat
          array.</p>
        </div>
        <div class="tile">
          <div class="figure">${times(
            Math.min(findings.traitCountSweep.koota.at(-1), findings.traitCountSweep.becsy.at(-1)) /
              findings.traitCountSweep.apecs.at(-1),
          )}</div>
          <p><strong>The next ergonomic tier, at eight traits.</strong> apecs holds
          ~${num(findings.traitCountSweep.apecs.at(-1), 1)} ns per entity visit at every trait
          count; koota and becsy lose an inline and never get it back.</p>
        </div>
      </div>
    </section>
    <section>
      <div class="section-head">
        <div class="label">Cross-library</div>
        <h2>Against the field</h2>
        <p>
          apecs against the fastest of bitECS, koota and becsy on each benchmark, log scale. Each
          library runs its own fastest correct idiom, one process per pair, and no timing is
          published until every library has matched the same entity count.
        </p>
      </div>
      <figure>
        <div class="frame">${divergingChart(rivalRows, {
          label: 'apecs against its fastest rival on each benchmark',
        })}</div>
        <figcaption>
          The losses are the same story: work that touches one entity at a time rather than a whole
          column. Iteration and query matching, where a column is the unit, are wins.
        </figcaption>
      </figure>
      <figure>
        <div class="frame">${heatmap({
          label: 'Every benchmark and library as a multiple of the hand-written baseline',
        })}</div>
        <figcaption>
          Every cell as a multiple of the hand-written floor; the fastest library in each row is
          the blue one. apecs beats the floor outright on three rows, which is what a column-shaped
          query buys over an index-shaped one.
        </figcaption>
      </figure>
      <div class="scroll">
        <table>
          <thead>
            <tr>
              <th>What it does</th>
              ${LIBS.map((lib) => `<th>${esc(TITLE[lib])}</th>`).join('\n              ')}
            </tr>
          </thead>
          <tbody>
            ${BENCHES.map((bench) => {
              const base = best(bench, 'baseline');
              const cells = LIBS.map((lib) => {
                const v = best(bench, lib);
                if (v === undefined) {
                  return '<td>–</td>';
                }
                const mul = lib === 'baseline' ? '' : `<span class="mul">${times(v / base)}</span>`;
                return `<td${lib === 'apecs' ? ' class="lead"' : ''}>${us(v)}${mul}</td>`;
              });
              return `<tr><td class="lead">${esc(LONG[bench])}</td>${cells.join('')}</tr>`;
            }).join('\n            ')}
          </tbody>
        </table>
      </div>
    </section>
    <section>
      <div class="section-head">
        <div class="label">SPEC §12.1</div>
        <h2>Budgets</h2>
        <p>
          Each budget is a ratio between two benchmarks of the same run, never an absolute time: a
          laptop's microseconds say nothing, but “<code>chunks</code> is within 1.1× of the
          hand-written loop” holds anywhere. ${budgets.length - failed.length} of ${budgets.length}
          hold${failed.length ? `; ${failed.length} does not` : ''}.
        </p>
      </div>
      <figure>
        <div class="frame">
          ${barChart(
            budgets.map((b) => ({
              label: b.name,
              value: Math.min(b.used, 1.6),
              over: !b.ok,
            })),
            {
              max: 1.6,
              x0: 268,
              ticks: [0.5, 1],
              tickLabel: (v) => `${num(v * 100)}%`,
              unit: 'of budget',
              format: (v) => `${num(v * 100)}%`,
              ref: { value: 1, label: 'the limit' },
              label: 'Share of each budget spent',
            },
          )}
        </div>
        <figcaption>
          Share of the budget spent, so all nine sit on one axis — the two budgets stated as “at
          least” are inverted to match. Anything past the dashed line is over.
        </figcaption>
      </figure>
      <div class="scroll">
        <table>
          <thead>
            <tr><th>Budget</th><th>Measured</th><th>Limit</th><th>§12.1 target</th><th>Verdict</th></tr>
          </thead>
          <tbody>
            ${budgets
              .map(
                (b) => `<tr${b.ok ? '' : ' class="over"'}>
              <td class="lead">${esc(b.name)}</td>
              <td>${esc(b.measured)}</td>
              <td>${esc(b.limit)}</td>
              <td class="sub">${esc(b.spec)}</td>
              <td><span class="status${b.ok ? '' : ' over'}">${b.ok ? 'within budget' : 'over budget'}</span></td>
            </tr>`,
              )
              .join('\n            ')}
          </tbody>
        </table>
      </div>
      <div class="note">
        <span class="label lab">The one miss predates this work</span>
        <code>world.accessor</code> resolves a field once and keeps a table per archetype, but three
        dependent loads against one flat array load is the archetype tax, and 25× was always the
        optimistic end of it. The iteration path is not involved and did not move.
      </div>
    </section>
    <section>
      <div class="section-head">
        <div class="label">Tiers</div>
        <h2>What the escape hatch buys</h2>
        <p>
          The ergonomic idiom against the raw one, same benchmark and same data, log scale. bitECS
          has no ergonomic tier — the raw arrays are the API. becsy has no raw tier — everything
          goes through a system.
        </p>
      </div>
      <div class="legend">
        <span><i class="key"></i>raw tier</span>
        <span><i class="key hollow"></i>ergonomic tier</span>
      </div>
      <figure>
        <div class="frame">
          ${dumbbell(tierRows, {
            min: 3,
            max: 20000,
            ticks: [10, 100, 1000, 10000],
            tickLabel: (v) => (v >= 1000 ? `${v / 1000} ms` : `${v} µs`),
            label: 'Ergonomic tier against raw tier, microseconds',
            legend: ['raw', 'ergonomic'],
          })}
        </div>
        <figcaption>
          apecs pays about 2× to leave the raw arrays alone; koota pays between 6× and 58×. The
          numbers are microseconds — raw first, ergonomic second.
        </figcaption>
      </figure>
    </section>
    <section>
      <div class="section-head">
        <div class="label">Trait count</div>
        <h2>The five-trait cliff, and who pays it</h2>
        <p>
          Nanoseconds per entity visit against the number of distinct traits a program uses, one
          trait count per process — sweeping inside one process lets earlier traits pollute the
          dispatch site and manufactures a cliff whether or not it is there. Two of the four
          libraries charge for trait count, and they break in different places: becsy at the fifth
          trait, koota at the second.
        </p>
      </div>
      <div class="legend">
        <span><i class="key s-apecs"></i>apecs <code>each</code></span>
        <span><i class="key s-apecs dash"></i>apecs <code>chunks</code></span>
        <span><i class="key s-bitecs"></i>bitECS</span>
        <span><i class="key s-koota"></i>koota</span>
        <span><i class="key s-becsy"></i>becsy</span>
      </div>
      <figure>
        <div class="frame">${cliffChart()}</div>
        <figcaption>
          Nanoseconds per entity visit against the number of distinct traits a program uses with the
          ergonomic API. apecs is the fastest ergonomic tier at every trait count — bitECS's flat
          ~${num(findings.traitCountSweep.bitecs[0], 1)} ns is its raw array API, not an ergonomic
          one. becsy steps at the fifth trait, koota at the second, and both are flat either side of
          the step.
        </figcaption>
      </figure>
    </section>
    <section>
      <div class="section-head">
        <div class="label">Capability</div>
        <h2>Iterating in key order, every frame</h2>
        <p>
          100 000 entities, microseconds per frame, log scale. bitECS and becsy ship no sorting, so
          their honest cost is the hand-written one: copy the ids out and sort them. Every apecs
          frame includes the <code>world.step()</code> a real frame pays — the dirty check is
          tick-based, and a view settles only once the tick has moved past the writes that built it.
        </p>
      </div>
      <div class="legend">
        <span><i class="key"></i>keys never change</span>
        <span><i class="key hollow"></i>1% of keys change per frame</span>
      </div>
      <figure>
        <div class="frame">
          ${dumbbell(
            CAPABILITY.map((r) => ({ label: r.label, a: r.static, b: r.drift, strong: r.strong })),
            {
              min: 60,
              max: 34000,
              ticks: [100, 1000, 10000],
              label: 'Sorted iteration, microseconds per frame',
              legend: ['clean', 'drift'],
            },
          )}
        </div>
        <figcaption>
          The distance between the two dots is what caching the order buys. koota's barely moves,
          because it re-sorts either way; apecs's <code>orderBy</code> is nearly two decades apart.
        </figcaption>
      </figure>
      <p>
        <strong>Sorted iteration is free; sorting is not.</strong> On a clean frame the rows are
        already in key order, so there is no gather and no side array to walk — ${times(vsSortBy)}
        faster than apecs's own <code>sortBy</code>. When 1% of keys drift, <code>orderBy</code>
        extracts the keys, sorts, and applies the permutation to every column:
        ${times(sorted.apecsOrderedChunks.drift / sorted.handwritten.drift)} the hand-written sort,
        which moves one id array where apecs moves five columns of real data.
      </p>
      <figure>
        <div class="frame">
          ${barChart(walkRows, {
            max: 32,
            ticks: [10, 20, 30],
            unit: 'ns per entity',
            format: (v) => num(v, 2),
            label: 'Nanoseconds per entity to walk 100 000 rows in key order',
          })}
        </div>
        <figcaption>
          Nanoseconds per entity, all three from the same run. <code>sortBy</code> materialises the
          order into a side array and pays for the indirection on every row;
          <code>orderBy</code> leaves the rows in order and pays nothing.
        </figcaption>
      </figure>
      <div class="note">
        <span class="label lab">The guarantee is per archetype</span>
        Rows are in key order within each matching archetype, not across them — chunk boundaries are
        archetype boundaries, and a merge cannot cross one without materialising.
        <code>sortBy</code> remains the answer when the order must be total.
      </div>
    </section>
    <section>
      <div class="section-head">
        <div class="label">Footprint</div>
        <h2>Bytes per entity</h2>
        <p>
          A world of entities carrying Position + Velocity — two <code>f32</code> fields each, so 16
          bytes is the payload. Everything above it is ids, masks, archetype bookkeeping and query
          caches. Measured as absolute resident bytes at five world sizes and least-squares fitted;
          the check that the fit works is that the hand-written baseline lands on 16.
        </p>
      </div>
      <figure>
        <div class="frame">
          ${barChart(
            LIBS.map((lib) => ({
              label: TITLE[lib],
              value: compare.memory[lib].perEntity,
              strong: lib === 'apecs',
            })),
            {
              max: 320,
              ticks: [100, 200, 300],
              unit: 'bytes per entity',
              ref: { value: 16, label: '16 B payload' },
              label: 'Bytes per entity',
            },
          )}
        </div>
        <figcaption>
          At a million entities: ${num((compare.memory.apecs.perEntity * 1e6) / 1e6)} MB for apecs
          against ${num((compare.memory.bitecs.perEntity * 1e6) / 1e6)} MB for bitECS and
          ${num((compare.memory.koota.perEntity * 1e6) / 1e6)} MB for koota.
        </figcaption>
      </figure>
      <p class="note">
        <span class="label lab">Reading the fit</span>
        It spans an empty world, so a fixed cost that moves between builds leaks into the slope. The
        marginal bytes between the two largest sizes cannot:
        ${LIBS.map((lib) => `${num(marginal(lib), 1)} for ${esc(TITLE[lib])}`).join(', ')}.
      </p>
    </section>
    <section>
      <div class="section-head">
        <div class="label">Method</div>
        <h2>What would have made this wrong</h2>
      </div>
      <div class="method">
        <div class="mcell">
          <h3>One process per library, per benchmark</h3>
          <p>Four ECS libraries in one isolate make the shared iteration call sites megamorphic, and
          V8 deoptimises whichever warmed up second — a larger effect than most of the differences
          being measured.</p>
        </div>
        <div class="mcell">
          <h3>A fairness census before any timing</h3>
          <p>Every library must match the same entity count on every query-shaped benchmark or the
          run aborts. It caught apecs's <code>Not()</code> silently ignoring all but its first
          argument, and becsy's perf build silently creating only some of the entities asked for.</p>
        </div>
        <div class="mcell">
          <h3>Minimum of ${compare.meta.runs} full runs</h3>
          <p>One pass is not trustworthy on a laptop: across runs some competitor cells moved by
          tens of percent while apecs's moved under 2%. Worst spread observed here:
          ${esc(compare.meta.worstSpread.cell)} at ${num(compare.meta.worstSpread.spread * 100)}%.</p>
        </div>
        <div class="mcell">
          <h3>Production builds only</h3>
          <p>apecs from its built <code>dist/</code> with <code>__DEV__</code> compiled out; becsy
          from its <code>perf</code> build, whose default carries runtime validation.</p>
        </div>
      </div>
    </section>
    <section>
      <div class="section-head">
        <div class="label">SPEC §12.1</div>
        <h2>Every measurement</h2>
        <p>The full suite behind the budgets above, as vitest reported it.</p>
      </div>
      <div class="scroll">
        <table>
          <thead>
            <tr><th>Benchmark</th><th>Median</th><th>Mean</th><th>ops/s</th><th>±rme</th></tr>
          </thead>
          <tbody>
            ${[...results]
              .map(([key, b]) => {
                const at = key.indexOf(' ');
                return `<tr>
              <td class="lead">${esc(key.slice(0, at))} · ${esc(key.slice(at + 1))}</td>
              <td>${num(b.median, 4)} ms</td>
              <td>${num(b.mean, 4)} ms</td>
              <td>${num(Math.round(b.hz))}</td>
              <td>${num(b.rme, 1)}%</td>
            </tr>`;
              })
              .join('\n            ')}
          </tbody>
        </table>
      </div>
    </section>
  </main>

  <footer>
    <div class="label">Reproducing</div>
    <pre>npm run bench:ci                  # SPEC §12.1 suite and budgets
cd bench/compare &amp;&amp; node run.mjs    # census, timings, memory
node capability.mjs apecs-ordered-chunks static
node ../../scripts/bench-report-html.mjs</pre>
    <p class="note">
      apecs 0.1.0 (dist) · bitECS 0.4.0 · koota 0.6.6 · becsy 0.15.5 (perf build). Rendered from
      <code>bench/results.json</code> and <code>bench/compare/results.json</code>; every figure on
      this page is read from a results file, none is typed in.
    </p>
  </footer>
</div>
`;

const head = `<title>apecs Benchmark Report</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link
  rel="stylesheet"
  href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&amp;family=Geist+Mono:wght@400;500&amp;display=swap"
/>
<style>${style}</style>`;

const page = FRAGMENT
  ? `${head}\n${body}`
  : `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
${head}
</head>
<body>
${body}
</body>
</html>
`;

writeFileSync(OUT, page);
console.log(`wrote ${OUT} (${(page.length / 1024).toFixed(1)} kB${FRAGMENT ? ', fragment' : ''})`);
