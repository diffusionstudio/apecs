import { assert } from './debug'

/**
 * Trait masks: `Uint32Array` blocks over dense local trait ids, grown a block
 * at a time (SPEC §10.1).
 */
export type Mask = Uint32Array

export const BITS_PER_BLOCK = 32
const BLOCK_SHIFT = 5
const BLOCK_MASK = 31

export function createMask(bits = 0): Mask {
  const blocks = (bits + BLOCK_MASK) >>> BLOCK_SHIFT
  return new Uint32Array(blocks > 0 ? blocks : 1)
}

export function maskHas(mask: Mask, bit: number): boolean {
  const block = bit >>> BLOCK_SHIFT
  return block < mask.length && (mask[block] & (1 << (bit & BLOCK_MASK))) !== 0
}

export function maskSet(mask: Mask, bit: number): void {
  const block = bit >>> BLOCK_SHIFT
  if (__DEV__) assert(block < mask.length, `bit ${bit} exceeds the capacity of this mask`)
  mask[block] |= 1 << (bit & BLOCK_MASK)
}

export function maskClear(mask: Mask, bit: number): void {
  const block = bit >>> BLOCK_SHIFT
  if (block < mask.length) mask[block] &= ~(1 << (bit & BLOCK_MASK))
}

/** Returns `mask` untouched when the bit already fits, otherwise a widened copy. */
export function maskGrow(mask: Mask, bit: number): Mask {
  const blocks = (bit >>> BLOCK_SHIFT) + 1
  if (blocks <= mask.length) return mask
  const grown = new Uint32Array(blocks)
  grown.set(mask)
  return grown
}

export function maskWith(mask: Mask, bit: number): Mask {
  const grown = maskGrow(mask, bit)
  const copy = grown === mask ? new Uint32Array(mask) : grown
  maskSet(copy, bit)
  return copy
}

export function maskWithout(mask: Mask, bit: number): Mask {
  const copy = new Uint32Array(mask)
  maskClear(copy, bit)
  return copy
}

/** Every bit of `subset` is set in `mask`. Blocks past either end read as zero. */
export function maskSuperset(mask: Mask, subset: Mask): boolean {
  const shared = mask.length < subset.length ? mask.length : subset.length
  for (let i = 0; i < shared; i++) if ((mask[i] & subset[i]) !== subset[i]) return false
  for (let i = shared; i < subset.length; i++) if (subset[i] !== 0) return false
  return true
}

export function maskEquals(a: Mask, b: Mask): boolean {
  const shared = a.length < b.length ? a.length : b.length
  for (let i = 0; i < shared; i++) if (a[i] !== b[i]) return false
  for (let i = shared; i < a.length; i++) if (a[i] !== 0) return false
  for (let i = shared; i < b.length; i++) if (b[i] !== 0) return false
  return true
}

/** Archetype identity key. Trailing empty blocks are trimmed so it follows `maskEquals`. */
export function maskKey(mask: Mask): string {
  let end = mask.length
  while (end > 0 && mask[end - 1] === 0) end--
  let key = ''
  for (let i = 0; i < end; i++) key += `${mask[i].toString(36)},`
  return key
}
