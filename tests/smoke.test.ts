import { expect, test } from 'vitest';

import { VERSION } from '../src/index';
import { PAGE_SIZE } from '../src/internal';

test('entry points resolve', () => {
  expect(VERSION).toBe('0.1.0');
  expect(PAGE_SIZE & (PAGE_SIZE - 1)).toBe(0);
});

test('__DEV__ is defined by the build', () => {
  expect(typeof __DEV__).toBe('boolean');
});
