/**
 * Every token of the paper is an entity, and everything the frame needs to
 * know is a trait: the page, the viewport, the pointer, the three spheres. The
 * layout system reads and writes nothing that is not declared here.
 */
import { Trait, bool, eid, f32, f64, str, u8, u32 } from 'apecs';

/* ------------------------------------------------------------------ tokens */

/** `Token.flags` bits. */
export const SPACE = 1;
/** A line may break before this token: the previous one was a space or a hyphen. */
export const HEAD = 2;
/** First token of its block. Carries the block's spacing and alignment. */
export const FIRST = 4;
/** Last token of its block. Closes the line without justifying it. */
export const LAST = 8;
/** Front matter: spans the whole content width instead of a column. */
export const WIDE = 16;

/**
 * One `Intl.Segmenter` segment. Measured once at its style; nothing here
 * changes after `buildDocument` — the layout only ever reads it.
 */
export const Token = new Trait({
  text: str(''),
  /** Advance width in CSS px. */
  width: f32(0),
  /** Width of the unbreakable run starting here; zero unless `HEAD`. */
  run: f32(0),
  /** Index into `FONTS`: the block kind and the face, packed. */
  style: u8(0),
  /** Index into `KINDS`. */
  kind: u8(0),
  flags: u8(0),
});

/** Where the last layout put the token's baseline origin, in page space. */
export const Pos = new Trait({ x: f32(0), y: f32(0) });

/* ----------------------------------------------------------------- spheres */

/**
 * Screen space. The spheres do not scroll; the text flows around them. A held
 * sphere is kinematic: the pointer writes its position and velocity, and the
 * pair loop treats it as immovable. It is a field rather than a tag so the
 * three spheres stay in one archetype and the pair loop sees one chunk.
 */
export const Ball = new Trait({
  x: f32(0),
  y: f32(0),
  vx: f32(0),
  vy: f32(0),
  r: f32(40),
  held: bool(false),
});

/** The sphere's gradient, built once around the origin and drawn translated. */
export const Shade = new Trait(() => null as unknown as CanvasGradient);

/* ------------------------------------------------------------ world traits */

export const Page = new Trait({
  /** The one input: dragged at the edges. */
  width: f32(816),
  scroll: f32(0),
  /** Outputs of the last layout. */
  height: f32(0),
  sheets: u8(1),
  columns: u8(1),
  /** Screen position of the page origin this frame. */
  left: f32(0),
  top: f32(0),
});

export const Viewport = new Trait({ w: f32(1), h: f32(1), dpr: f32(1) });

export const Time = new Trait({ delta: f32(0), current: f32(0) });

export const Pointer = new Trait({
  x: f32(0),
  y: f32(0),
  resizing: bool(false),
  /** The sphere under the pointer, `NULL_ENTITY` when none. */
  held: eid(0),
  /** Where inside the sphere it was grabbed, so it does not jump to the pointer. */
  gripX: f32(0),
  gripY: f32(0),
  /** Event time of the last move, for the throw velocity. */
  stamp: f64(0),
});

export const Stats = new Trait({
  tokens: u32(0),
  drawn: u32(0),
  layoutMs: f32(0),
  drawMs: f32(0),
});
