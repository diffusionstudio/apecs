import type { Trait } from './trait'

/**
 * Global trait ids identify a trait; each world maps the traits it actually
 * touches onto dense local ids, which are the bit positions of its archetype
 * masks. A trait a world never sees costs that world nothing (SPEC §5.3).
 */
export class TraitRegistry {
  /** Local id → trait. */
  readonly list: Trait[] = []

  private readonly locals = new Map<Trait, number>()

  public get size(): number {
    return this.list.length
  }

  /** The trait's local id, or -1 if this world has never used it. */
  public localId(trait: Trait): number {
    const local = this.locals.get(trait)
    return local === undefined ? -1 : local
  }

  public register(trait: Trait): number {
    let local = this.locals.get(trait)
    if (local === undefined) {
      local = this.list.length
      this.locals.set(trait, local)
      this.list.push(trait)
    }
    return local
  }
}
