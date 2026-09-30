import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  apply,
  calculateContextRemaining,
  calculateThresholdTokens,
  resolvePressurePolicy,
} from '../index.js'

test('declares DeepSeek Harness 0.2 runtime compatibility', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  )

  assert.equal(manifest.engines.node, '^22.19.0 || >=24.0.0')
  assert.equal(
    manifest.peerDependencies['@deepseek-ai/dsh'],
    '>=0.2.0-rc.2 <0.3.0',
  )
})

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

function integrationHarness({
  beforeTokens = 810_000,
  afterTokens = 300_000,
  contextWindow = 1_000_000,
  defaultMaxTokens,
  headerMaxTokens = 32_768,
  auto = true,
  retainedText,
} = {}) {
  let currentTokens = beforeTokens
  let listener
  let options

  const retained = retainedText === undefined
    ? []
    : [{ type: 'user/message', data: {
      content: [{ type: 'text', text: retainedText }],
      source: { kind: 'dsh-budget-tracker' },
    } }]

  const session = {
    surface: { nodes: retained.map((_, index) => index) },
    eventAt: index => retained[index],
    requestHeader: () => ({
      config: {
        provider: 'deepseek',
        model: 'model',
        ...(headerMaxTokens == null ? {} : { maxTokens: headerMaxTokens }),
      },
    }),
  }

  const ctx = {
    compaction: {
      config: {
        auto,
        thresholdRatio: 0.8,
        headroomTokens: 65_536,
        modelPolicies: [],
      },
    },
    llm: {
      resolveModelInfo: async () => ({
        context: { contextWindow },
        ...(defaultMaxTokens === undefined ? {} : { defaultMaxTokens }),
      }),
    },
    tokenMeter: { measure: () => ({ totalTokens: currentTokens }) },
    on: (name, callback, listenerOptions) => {
      assert.equal(name, 'agent/pre-step')
      listener = callback
      options = listenerOptions
      return () => true
    },
  }

  apply(ctx)
  return {
    options,
    run: async ({ reject = false } = {}) => listener(
      { agent: { session }, signal: new AbortController().signal },
      async () => {
        currentTokens = afterTokens
        return reject ? { kind: 'reject' } : { kind: 'enter', messages: [] }
      },
    ),
  }
}

test('prepends its pre-step wrapper and measures after downstream compaction', async () => {
  const harness = integrationHarness()
  assert.deepEqual(harness.options, { prepend: true })

  const decision = await harness.run()
  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages.length, 1)
  assert.equal(decision.messages[0].content[0].text, 'context_remaining: 500000')
  assert.equal(decision.messages[0].source.kind, 'dsh-budget-tracker')
  assert.equal(decision.messages[0].source.form, 'snapshot')
})

test('uses current routed model capacity rather than a stale persisted capacity', async () => {
  const harness = integrationHarness({
    contextWindow: 256_000,
    beforeTokens: 100_000,
    afterTokens: 100_000,
    headerMaxTokens: 16_000,
  })

  const decision = await harness.run()
  assert.equal(decision.messages[0].content[0].text, 'context_remaining: 74464')
})

test('falls back to the adapter default completion reservation when the header omits maxTokens', async () => {
  const harness = integrationHarness({
    contextWindow: 100_000,
    beforeTokens: 10_000,
    afterTokens: 10_000,
    headerMaxTokens: null,
    defaultMaxTokens: 20_000,
  })

  const decision = await harness.run()
  assert.equal(decision.messages[0].content[0].text, 'context_remaining: 4464')
})

test('does not duplicate an unchanged retained budget snapshot', async () => {
  const harness = integrationHarness({ retainedText: 'context_remaining: 500000' })
  const decision = await harness.run()
  assert.deepEqual(decision, { kind: 'enter', messages: [] })
})

test('does not inject into a rejected pre-step', async () => {
  const harness = integrationHarness()
  assert.deepEqual(await harness.run({ reject: true }), { kind: 'reject' })
})
