import { bench } from 'vitest'

import { PAGE_SIZE } from '../src/internal'

bench('page index arithmetic', () => {
  let sum = 0
  for (let i = 0; i < PAGE_SIZE; i++) sum += i & (PAGE_SIZE - 1)
  if (sum < 0) throw new Error('unreachable')
})
