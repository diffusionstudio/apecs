import { expectTypeOf, test } from 'vitest'

import { VERSION } from '../src/index'

test('VERSION is a string', () => {
  expectTypeOf(VERSION).toEqualTypeOf<string>()
})
