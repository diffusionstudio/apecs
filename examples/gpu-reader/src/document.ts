/**
 * Turns the block list into token entities. Runs once: `Intl.Segmenter` splits
 * every span into words, spaces and punctuation, each segment is measured at
 * its style, and the lot is spawned in document order with one `spawnMany`.
 */
import type { World } from 'apecs';

import { PAPER } from './paper';
import { FONTS, KIND_INDEX, styleOf } from './styles';
import { FIRST, HEAD, LAST, Pos, SPACE, Token, WIDE } from './traits';
import { PAGE_SIZE } from './world';

const WHITESPACE = /^\s+$/;
/** A line may end after a hyphen, an en dash or a slash. */
const BREAK_AFTER = /[-–/]$/;

export function buildDocument(world: World, ctx: CanvasRenderingContext2D): number {
  const segmenter = new Intl.Segmenter('en', { granularity: 'word' });
  const texts: string[] = [];
  const widths: number[] = [];
  const styles: number[] = [];
  const kinds: number[] = [];
  const flags: number[] = [];
  const measured: Array<Map<string, number> | undefined> = [];

  // Everything before the first body block is front matter and spans the page.
  const body = PAPER.findIndex((b) => b.kind === 'h1' || b.kind === 'p');

  for (let b = 0; b < PAPER.length; b++) {
    const block = PAPER[b];
    const kind = KIND_INDEX[block.kind];
    const wide = b < body ? WIDE : 0;
    const first = texts.length;
    let previous = ' ';
    for (const [face, text] of block.spans) {
      const style = styleOf(kind, face);
      ctx.font = FONTS[style];
      const cache = (measured[style] ??= new Map());
      for (const { segment } of segmenter.segment(text)) {
        let f = wide;
        if (WHITESPACE.test(segment)) {
          f |= SPACE;
        } else if (WHITESPACE.test(previous) || BREAK_AFTER.test(previous)) {
          f |= HEAD;
        }
        let width = cache.get(segment);
        if (width === undefined) {
          width = ctx.measureText(segment).width;
          cache.set(segment, width);
        }
        texts.push(segment);
        widths.push(width);
        styles.push(style);
        kinds.push(kind);
        flags.push(f);
        previous = segment;
      }
    }
    if (texts.length > first) {
      flags[first] |= FIRST | HEAD;
      flags[texts.length - 1] |= LAST;
    }
  }

  const n = texts.length;

  // A run is a head and everything glued to it up to the next space or head:
  // "self-attention," is three runs, "(1)" is one. Walked back to front so
  // each head sees the widths behind it exactly once.
  const runs = new Float32Array(n);
  let acc = 0;
  for (let i = n - 1; i >= 0; i--) {
    const f = flags[i];
    if (f & SPACE) {
      acc = 0;
      continue;
    }
    acc += widths[i];
    if (f & HEAD) {
      runs[i] = acc;
      acc = 0;
    }
  }

  world.spawnMany(n, Token, Pos);
  for (const chunk of world.query(Token, Pos).chunks()) {
    if (__DEV__ && (chunk.length !== n || n > PAGE_SIZE)) {
      throw new Error(`the paper must fit one page: ${n} tokens, page size ${PAGE_SIZE}`);
    }
    const token = chunk.get(Token);
    for (let i = 0; i < n; i++) {
      token.text[i] = texts[i];
      token.width[i] = widths[i];
      token.run[i] = runs[i];
      token.style[i] = styles[i];
      token.kind[i] = kinds[i];
      token.flags[i] = flags[i];
    }
  }
  return n;
}
