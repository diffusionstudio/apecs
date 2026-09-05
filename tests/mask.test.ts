import { describe, expect, test } from 'vitest';

import {
  BITS_PER_BLOCK,
  createMask,
  maskClear,
  maskEquals,
  maskGrow,
  maskHas,
  maskKey,
  maskSet,
  maskSuperset,
  maskWith,
  maskWithout,
} from '../src/internal';

const maskOf = (...bits: number[]) => bits.reduce(maskWith, createMask());

describe('layout (§10.1)', () => {
  test('masks are Uint32Array blocks over dense local trait ids', () => {
    const mask = createMask();

    expect(BITS_PER_BLOCK).toBe(32);
    expect(mask).toBeInstanceOf(Uint32Array);
    expect(mask).toHaveLength(1);
  });

  test('a mask is sized to the requested bit capacity, a block at a time', () => {
    expect(createMask(0)).toHaveLength(1);
    expect(createMask(32)).toHaveLength(1);
    expect(createMask(33)).toHaveLength(2);
    expect(createMask(64)).toHaveLength(2);
    expect(createMask(100)).toHaveLength(4);
  });

  test('a fresh mask is empty', () => {
    const mask = createMask(100);

    for (let bit = 0; bit < 100; bit++) {
      expect(maskHas(mask, bit)).toBe(false);
    }
  });
});

describe('set / clear / test (§10.1)', () => {
  test('bits round trip across block boundaries', () => {
    const mask = createMask(96);

    for (const bit of [0, 1, 31, 32, 63, 64, 95]) {
      maskSet(mask, bit);
      expect(maskHas(mask, bit)).toBe(true);
    }

    expect(maskHas(mask, 30)).toBe(false);
    expect(maskHas(mask, 33)).toBe(false);
  });

  test('bit 31 does not spill into the next block', () => {
    const mask = createMask(64);
    maskSet(mask, 31);

    expect(mask[0]).toBe(0x80000000);
    expect(mask[1]).toBe(0);
    expect(maskHas(mask, 32)).toBe(false);
  });

  test('clear removes only the named bit', () => {
    const mask = createMask(64);
    maskSet(mask, 32);
    maskSet(mask, 33);
    maskClear(mask, 32);

    expect(maskHas(mask, 32)).toBe(false);
    expect(maskHas(mask, 33)).toBe(true);
  });

  test('setting twice is idempotent', () => {
    const mask = createMask();
    maskSet(mask, 5);
    maskSet(mask, 5);
    maskClear(mask, 5);

    expect(maskHas(mask, 5)).toBe(false);
  });

  test('bits beyond the allocated blocks read as unset and clear as a no-op', () => {
    const mask = createMask();

    expect(maskHas(mask, 4096)).toBe(false);
    expect(() => maskClear(mask, 4096)).not.toThrow();
    expect(mask).toHaveLength(1);
  });

  test.runIf(__DEV__)('dev rejects setting a bit the mask cannot hold', () => {
    expect(() => maskSet(createMask(), 32)).toThrowError(/apecs/);
  });
});

describe('growth (§10.1)', () => {
  test('grow returns the same mask when the bit already fits', () => {
    const mask = createMask(64);

    expect(maskGrow(mask, 63)).toBe(mask);
  });

  test('grow allocates enough blocks and preserves the set bits', () => {
    const mask = maskOf(1, 40);
    const grown = maskGrow(mask, 70);

    expect(grown).not.toBe(mask);
    expect(grown).toHaveLength(3);
    expect(maskHas(grown, 1)).toBe(true);
    expect(maskHas(grown, 40)).toBe(true);
    expect(maskHas(grown, 70)).toBe(false);
  });

  test('with/without copy rather than mutate', () => {
    const mask = maskOf(1);
    const added = maskWith(mask, 100);
    const removed = maskWithout(added, 1);

    expect(maskHas(mask, 100)).toBe(false);
    expect(maskHas(added, 1)).toBe(true);
    expect(maskHas(added, 100)).toBe(true);
    expect(maskHas(removed, 1)).toBe(false);
    expect(maskHas(removed, 100)).toBe(true);
  });

  test('without does not grow the mask', () => {
    const mask = createMask();

    expect(maskWithout(mask, 4096)).toHaveLength(1);
  });
});

describe('comparison (§10.1, §10.4)', () => {
  test('superset holds for equal masks and for extra bits', () => {
    expect(maskSuperset(maskOf(1, 2), maskOf(1, 2))).toBe(true);
    expect(maskSuperset(maskOf(1, 2, 3), maskOf(1, 3))).toBe(true);
    expect(maskSuperset(maskOf(1, 2), maskOf(1, 4))).toBe(false);
    expect(maskSuperset(createMask(), createMask())).toBe(true);
    expect(maskSuperset(createMask(), maskOf(0))).toBe(false);
  });

  test('superset compares across differently sized masks', () => {
    const wide = maskOf(1, 100);
    const narrow = maskOf(1);

    expect(maskSuperset(wide, narrow)).toBe(true);
    expect(maskSuperset(narrow, wide)).toBe(false);
    expect(maskSuperset(narrow, maskGrow(maskOf(1), 100))).toBe(true);
  });

  test('superset holds for the sign bit of every block', () => {
    // `&` yields a signed int32 and a Uint32Array read is unsigned, so a block
    // whose top bit is set compares unequal to itself without a `>>> 0`. The
    // symptom is a query on local trait id 31 (or 63, or 95) matching nothing.
    for (const bit of [31, 63, 95]) {
      const mask = maskOf(bit);

      expect(maskSuperset(mask, mask)).toBe(true);
      expect(maskSuperset(maskOf(0, bit), maskOf(bit))).toBe(true);
      expect(maskSuperset(maskOf(bit), maskOf(0, bit))).toBe(false);
    }
  });

  test('equality ignores trailing empty blocks', () => {
    expect(maskEquals(maskOf(1), maskGrow(maskOf(1), 100))).toBe(true);
    expect(maskEquals(maskOf(1), maskOf(1, 100))).toBe(false);
    expect(maskEquals(createMask(), createMask(256))).toBe(true);
  });

  test('the identity key follows equality, not block count', () => {
    expect(maskKey(maskOf(1))).toBe(maskKey(maskGrow(maskOf(1), 100)));
    expect(maskKey(maskOf(1))).not.toBe(maskKey(maskOf(2)));
    expect(maskKey(maskOf(1, 100))).not.toBe(maskKey(maskOf(1)));
    expect(maskKey(createMask())).toBe(maskKey(createMask(256)));
  });
});
