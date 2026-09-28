import test from 'node:test'
import assert from 'node:assert/strict'
import {
  calculateContextRemaining,
  calculateThresholdTokens,
  resolvePressurePolicy,
} from '../index.js'

test('reproduces the default compaction threshold shape', () => {
  assert.equal(
    calculateThresholdTokens(1_000_000, 32_768, 0.8, 65_536),
    800_000,
  )
})

test('capacity minus completion reservation and headroom can be the tighter cap', () => {
  assert.equal(
    calculateThresholdTokens(100_000, 20_000, 0.8, 30_000),
    50_000,
  )
})

test('reports remaining pressure budget before compaction', () => {
  assert.equal(calculateContextRemaining(800_000, 610_000), 190_000)
})

test('clamps remaining pressure budget at zero', () => {
  assert.equal(calculateContextRemaining(800_000, 810_000), 0)
})

test('resolves exact provider/model pressure overrides', () => {
  const config = {
    auto: true,
    thresholdRatio: 0.8,
    headroomTokens: 65_536,
    modelPolicies: [
      {
        provider: 'deepseek',
        model: 'small',
        thresholdRatio: 0.7,
        headroomTokens: 8192,
      },
    ],
  }

  assert.deepEqual(
    resolvePressurePolicy(config, 'deepseek', 'small'),
    { thresholdRatio: 0.7, headroomTokens: 8192 },
  )
  assert.deepEqual(
    resolvePressurePolicy(config, 'deepseek', 'large'),
    { thresholdRatio: 0.8, headroomTokens: 65_536 },
  )
})

test('emits no budget when automatic compaction is disabled', () => {
  assert.equal(
    resolvePressurePolicy({
      auto: false,
      thresholdRatio: 0.8,
      headroomTokens: 65_536,
      modelPolicies: [],
    }, 'deepseek', 'model'),
    undefined,
  )
})

test('rejects invalid threshold inputs instead of inventing a budget', () => {
  assert.equal(calculateThresholdTokens(undefined, 0, 0.8, 65_536), undefined)
  assert.equal(calculateThresholdTokens(100_000, -1, 0.8, 10_000), undefined)
  assert.equal(calculateThresholdTokens(100_000, 60_000, 0.8, 50_000), undefined)
  assert.equal(calculateContextRemaining(undefined, 1), undefined)
})
