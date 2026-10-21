import test from 'node:test'
import assert from 'node:assert/strict'
import {
  Config,
  DEFAULT_SURGE_POLICY,
  resolveSurgePolicyConfig,
  detectBudgetSurge,
  advanceSurgeState,
} from '../index.js'

test('surge defaults are hidden non-volatile experiment controls', () => {
  const defaults = Config({})
  assert.deepEqual(defaults.surgePolicy, DEFAULT_SURGE_POLICY)
  assert.equal(typeof defaults.surgePolicy.stepDropRatio, 'number')
  assert.equal(resolveSurgePolicyConfig().windowSteps, 5)
  const custom = resolveSurgePolicyConfig({
    surgePolicy: { stepDropRatio: 0.05, windowSteps: 4 },
  })
  assert.equal(custom.stepDropRatio, 0.05)
  assert.equal(custom.windowSteps, 4)
  assert.equal(custom.windowDropRatio, DEFAULT_SURGE_POLICY.windowDropRatio)
})

test('rejects invalid surge ratios, fractional steps, and overlong active windows', () => {
  const invalid = [
    { stepDropRatio: 0 },
    { windowDropRatio: 1.1 },
    { stepMaxRemainingRatio: -0.1 },
    { windowMaxRemainingRatio: NaN },
    { windowSteps: 2.5 },
    { cooldownSteps: 0 },
    { activeSteps: 6 },
  ]
  for (const surgePolicy of invalid) {
    assert.throws(
      () => resolveSurgePolicyConfig({ surgePolicy }),
      /surgePolicy requires/,
    )
  }
})

test('single-step alert is gated by remaining budget and uses exact ratios', () => {
  assert.equal(detectBudgetSurge([700_000], 670_000, 800_000), false) // > 80%
  assert.equal(detectBudgetSurge([650_000], 620_000, 800_000), true)
  assert.equal(detectBudgetSurge([650_000], 634_000, 800_000), false)
  assert.equal(detectBudgetSurge([], 300_000, 800_000), false)
})

test('rolling detection needs a complete window of five step intervals', () => {
  const history = [300_000, 288_000, 276_000, 264_000, 252_000]
  assert.equal(detectBudgetSurge(history, 240_000, 800_000), true)
  assert.equal(detectBudgetSurge(history.slice(1), 240_000, 800_000), false)
  assert.equal(detectBudgetSurge([290_000, ...history.slice(1)], 248_000, 800_000), false)
})

test('surge state resets its history and cooldown after an upward pressure reset', () => {
  const initial = { provider: 'deepseek', model: 'model', thresholdTokens: 800_000, remaining: 400_000 }
  const b1 = advanceSurgeState(undefined, initial)
  assert.equal(b1.active, false)
  const b2 = advanceSurgeState(b1.state, { ...initial, remaining: 368_000 })
  assert.equal(b2.active, true)
  const b3 = advanceSurgeState(b2.state, { ...initial, remaining: 600_000 })
  assert.equal(b3.active, false)
  assert.deepEqual(b3.state.history, [600_000])
  assert.equal(b3.state.step, 1)
})
