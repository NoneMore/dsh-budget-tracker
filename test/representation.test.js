import test from 'node:test'
import assert from 'node:assert/strict'
import {
  Config,
  BUDGET_REPRESENTATIONS,
  DEFAULT_BUDGET_REPRESENTATION,
  BUDGET_PERCENT_PRECISION,
  resolveBudgetRepresentation,
  formatBudgetText,
  resolveAdaptiveBand,
  resolvePromptText,
} from '../index.js'

test('raw remains the hidden representation default', () => {
  const config = Config({})
  assert.deepEqual(BUDGET_REPRESENTATIONS, ['raw', 'normalized'])
  assert.equal(DEFAULT_BUDGET_REPRESENTATION, 'raw')
  assert.equal(BUDGET_PERCENT_PRECISION, 1)
  assert.equal(config.budgetRepresentation, 'raw')
  assert.equal(resolveBudgetRepresentation(config), 'raw')
})

test('normalized representation is non-volatile runtime config', () => {
  const config = Config({ budgetRepresentation: 'normalized' })
  assert.equal(config.budgetRepresentation, 'normalized')
  assert.equal(typeof config.budgetRepresentation, 'string')
  assert.equal(resolveBudgetRepresentation(config), 'normalized')
})

test('rejects unknown representation treatments', () => {
  assert.throws(
    () => resolveBudgetRepresentation({ budgetRepresentation: 'verbose' }),
    /budgetRepresentation must be one of raw, normalized/,
  )
})

test('raw formatting preserves the historical scalar interface', () => {
  assert.equal(
    formatBudgetText(98_694, 284_819, 'raw'),
    'context_remaining: 98694',
  )
})

test('normalized formatting uses current thresholdTokens and one decimal place', () => {
  assert.equal(
    formatBudgetText(98_694, 284_819, 'normalized'),
    'context_remaining: 98694 / 284819 (34.7%)',
  )
})

test('display rounding never feeds adaptive band resolution', () => {
  assert.equal(
    formatBudgetText(199_968, 800_000, 'normalized'),
    'context_remaining: 199968 / 800000 (25.0%)',
  )
  assert.equal(resolveAdaptiveBand(199_968, 800_000), 'conserve')
})

test('representation is orthogonal to a representation-neutral static prompt', () => {
  const planning = resolvePromptText('planning')
  assert.match(planning, /context-pressure signal/)
  assert.match(planning, /R \/ B \(P%\)/)
  assert.match(planning, /P = R\/B/)
  assert.equal(resolvePromptText('none'), undefined)
})
