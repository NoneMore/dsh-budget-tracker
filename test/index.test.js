import test from 'node:test'
import assert from 'node:assert/strict'
import { calculateContextRemaining } from '../index.js'

test('calculates remaining context', () => {
  assert.equal(calculateContextRemaining(1_000_000, 257_619), 742_381)
})

test('clamps at zero', () => {
  assert.equal(calculateContextRemaining(100, 120), 0)
})

test('does not invent a value when Harness has no reliable measurement', () => {
  assert.equal(calculateContextRemaining(undefined, 100), undefined)
  assert.equal(calculateContextRemaining(100, undefined), undefined)
  assert.equal(calculateContextRemaining(0, 0), undefined)
})
