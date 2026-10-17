import test from 'node:test'
import assert from 'node:assert/strict'
import {
  Config,
  DEFAULT_ADAPTIVE_POLICY,
  resolveAdaptivePolicyConfig,
  resolveAdaptiveBand,
} from '../index.js'

test('adaptive thresholds default to the current experimental policy', () => {
  const config = Config({})
  assert.deepEqual(config.adaptivePolicy, DEFAULT_ADAPTIVE_POLICY)
  assert.deepEqual(
    resolveAdaptivePolicyConfig(config),
    { conserveRatio: 0.25, criticalRatio: 0.10 },
  )
})

test('adaptive thresholds are hidden runtime config rather than volatile refs', () => {
  const config = Config({
    adaptivePolicy: { conserveRatio: 0.40, criticalRatio: 0.20 },
  })
  assert.deepEqual(config.adaptivePolicy, {
    conserveRatio: 0.40,
    criticalRatio: 0.20,
  })
  assert.equal(typeof config.adaptivePolicy.conserveRatio, 'number')
  assert.equal(typeof config.adaptivePolicy.criticalRatio, 'number')
})

test('custom adaptive thresholds change band resolution without changing defaults', () => {
  const custom = resolveAdaptivePolicyConfig({
    adaptivePolicy: { conserveRatio: 0.40, criticalRatio: 0.20 },
  })

  assert.equal(resolveAdaptiveBand(300_000, 800_000), 'ample')
  assert.equal(resolveAdaptiveBand(300_000, 800_000, custom), 'conserve')
  assert.equal(resolveAdaptiveBand(160_000, 800_000, custom), 'critical')
})

test('adaptive threshold ordering is an activation-time invariant', () => {
  for (const adaptivePolicy of [
    { conserveRatio: 0.25, criticalRatio: 0 },
    { conserveRatio: 1, criticalRatio: 0.10 },
    { conserveRatio: 0.25, criticalRatio: 0.25 },
    { conserveRatio: 0.20, criticalRatio: 0.30 },
  ]) {
    assert.throws(
      () => resolveAdaptivePolicyConfig({ adaptivePolicy }),
      /0 < criticalRatio < conserveRatio < 1/,
    )
  }
})
