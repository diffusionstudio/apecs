import { World } from 'apecs';

import { Page, Pointer, Stats, Time, Viewport } from './traits';

/**
 * The page size is the one deliberate constant: it is larger than the paper,
 * so every token lives in a single page and the layout walks one chunk in
 * document order. `buildDocument` asserts it in dev.
 */
export const PAGE_SIZE = 1 << 15;

/** A `World` subclass is the intended extension point: the canvas rides on it. */
export class Reader extends World {
  public readonly ctx: CanvasRenderingContext2D;

  public constructor(ctx: CanvasRenderingContext2D) {
    super({ pageSize: PAGE_SIZE });
    this.ctx = ctx;
    this.add(Page, Viewport, Time, Pointer, Stats);
  }
}
