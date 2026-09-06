/**
 * The typography: one spec per block kind, one font string per (kind, face)
 * pair. `prepareStyles` runs once, after the web font has loaded, and nothing
 * here changes afterwards — which is what lets every token be measured once.
 */
import type { Face, Kind } from './paper';

export const JUSTIFY = 0;
export const CENTER = 1;
export const LEFT = 2;

export interface KindSpec {
  size: number;
  /** Line height. Every line of a block is this tall, whatever faces it mixes. */
  lh: number;
  weight: 400 | 700;
  align: typeof JUSTIFY | typeof CENTER | typeof LEFT;
  before: number;
  after: number;
  /** Fraction of the line width left empty on each side. */
  inset: number;
  /** Lines that must fit below this block's first line, or it moves to the next column. */
  keep: number;
}

const SPEC: Record<Kind, KindSpec> = {
  title: { size: 26, lh: 34, weight: 700, align: CENTER, before: 0, after: 22, keep: 0, inset: 0 },
  author: {
    size: 12.5,
    lh: 18,
    weight: 400,
    align: CENTER,
    before: 0,
    after: 0,
    keep: 0,
    inset: 0,
  },
  note: { size: 10, lh: 13, weight: 400, align: JUSTIFY, before: 8, after: 2, keep: 0, inset: 0 },
  'abstract-title': {
    size: 14,
    lh: 20,
    weight: 700,
    align: CENTER,
    before: 22,
    after: 8,
    inset: 0,
    keep: 2,
  },
  abstract: {
    size: 12.5,
    lh: 16.5,
    weight: 400,
    align: JUSTIFY,
    before: 0,
    after: 20,
    inset: 0.09,
    keep: 0,
  },
  h1: { size: 15.5, lh: 21, weight: 700, align: LEFT, before: 20, after: 8, keep: 2, inset: 0 },
  h2: { size: 13.5, lh: 18, weight: 700, align: LEFT, before: 14, after: 6, keep: 2, inset: 0 },
  h3: { size: 12.5, lh: 17, weight: 700, align: LEFT, before: 12, after: 5, keep: 2, inset: 0 },
  p: { size: 12.5, lh: 16.5, weight: 400, align: JUSTIFY, before: 0, after: 9, keep: 0, inset: 0 },
  li: {
    size: 12.5,
    lh: 16.5,
    weight: 400,
    align: JUSTIFY,
    before: 0,
    after: 7,
    keep: 0,
    inset: 0.03,
  },
  eq: { size: 12.5, lh: 18, weight: 400, align: CENTER, before: 4, after: 10, keep: 0, inset: 0 },
  ref: { size: 11, lh: 14, weight: 400, align: JUSTIFY, before: 0, after: 5, keep: 0, inset: 0 },
};

export const KIND_NAMES = Object.keys(SPEC) as Kind[];
export const KINDS: KindSpec[] = KIND_NAMES.map((k) => SPEC[k]);
export const KIND_INDEX = Object.fromEntries(KIND_NAMES.map((k, i) => [k, i])) as Record<
  Kind,
  number
>;

const FACES: Face[] = ['r', 'b', 'i', 'm', 'c', 'sub', 'sup'];
const FACE_INDEX = Object.fromEntries(FACES.map((f, i) => [f, i])) as Record<Face, number>;
/** Styles are packed `kind << 3 | face`; eight faces per kind is headroom. */
const FACE_BITS = 3;

export const SERIF = '"STIX Two Text", "Times New Roman", Times, serif';
const MONO = 'ui-monospace, Menlo, Consolas, monospace';

export const FONTS: string[] = new Array<string>(KINDS.length << FACE_BITS).fill('');
/** Baseline shift per style: sub- and superscripts sit off the line. */
export const DY = new Float32Array(KINDS.length << FACE_BITS);
/** Baseline offset from the line top per kind, from the regular face's em box. */
export const BASELINE = new Float32Array(KINDS.length);

export function styleOf(kind: number, face: Face): number {
  return (kind << FACE_BITS) | FACE_INDEX[face];
}

export function prepareStyles(ctx: CanvasRenderingContext2D): void {
  for (let k = 0; k < KINDS.length; k++) {
    const spec = KINDS[k];
    for (let f = 0; f < FACES.length; f++) {
      let size = spec.size;
      let weight = spec.weight;
      let italic = false;
      let family = SERIF;
      let dy = 0;
      switch (FACES[f]) {
        case 'b':
          weight = 700;
          break;
        case 'i':
        case 'm':
          italic = true;
          break;
        case 'c':
          family = MONO;
          size *= 0.86;
          break;
        case 'sub':
          italic = true;
          size *= 0.68;
          dy = spec.size * 0.22;
          break;
        case 'sup':
          italic = true;
          size *= 0.68;
          dy = -spec.size * 0.4;
          break;
      }
      const id = (k << FACE_BITS) | f;
      FONTS[id] = `${italic ? 'italic ' : ''}${weight} ${size}px ${family}`;
      DY[id] = dy;
    }
    ctx.font = FONTS[k << FACE_BITS];
    const box = ctx.measureText('Hg');
    const ascent = box.fontBoundingBoxAscent || spec.size * 0.8;
    const descent = box.fontBoundingBoxDescent || spec.size * 0.2;
    BASELINE[k] = (spec.lh - ascent - descent) / 2 + ascent;
  }
}
