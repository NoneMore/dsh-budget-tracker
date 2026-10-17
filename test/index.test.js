import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  apply,
  inject,
  Config,
  DEFAULT_PROMPT_MODE,
  PROMPT_SECTION_NAME,
  PROMPT_SECTION_ORDER,
  ADAPTIVE_POLICY_CONTEXT_NAME,
  ADAPTIVE_POLICY_CONTEXT_ORDER,
  ADAPTIVE_BAND_RATIOS,
  currentPromptMode,
  resolvePromptText,
  resolveAdaptivePolicyText,
  resolveAdaptiveBand,
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
  assert.equal(manifest.dependencies['@deepseek-ai/schemastery'], '^3.18.4')
  assert.equal(manifest.exports['./client'], './client.js')
})

test('only requires the host-level agent registry service', () => {
  assert.deepEqual(inject, ['agents'])
})

test('exports a volatile schemastery Config for the Web-editable prompt mode', () => {
  const defaults = Config({})
  const behavioral = Config({ promptMode: 'behavioral' })
  const adaptive = Config({ promptMode: 'adaptive' })
  assert.equal(defaults.promptMode.get(), DEFAULT_PROMPT_MODE)
  assert.equal(behavioral.promptMode.get(), 'behavioral')
  assert.equal(adaptive.promptMode.get(), 'adaptive')
})

test('reads direct and volatile prompt mode values', () => {
  assert.equal(currentPromptMode({ promptMode: 'planning' }), 'planning')
  assert.equal(currentPromptMode(Config({ promptMode: 'behavioral' })), 'behavioral')
  assert.equal(currentPromptMode(Config({ promptMode: 'adaptive' })), 'adaptive')
  assert.equal(currentPromptMode(), DEFAULT_PROMPT_MODE)
})

test('prompt modes preserve existing static behavior', () => {
  assert.equal(DEFAULT_PROMPT_MODE, 'semantic')
  assert.match(resolvePromptText(), /remaining token budget before proactive context compaction/)
  assert.match(resolvePromptText('planning'), /context-pressure signal/)
  assert.match(resolvePromptText('behavioral'), /actively limit avoidable context growth/)
  assert.equal(resolvePromptText('adaptive'), resolvePromptText('planning'))
  assert.equal(resolvePromptText('none'), undefined)
  assert.throws(
    () => resolvePromptText('aggressive'),
    /promptMode must be one of none, semantic, planning, behavioral, adaptive/,
  )
})

test('adaptive model-facing text is empty in ample and restrictive otherwise', () => {
  assert.equal(resolveAdaptivePolicyText('ample'), '')
  assert.match(resolveAdaptivePolicyText('conserve'), /reduce avoidable context growth/)
  assert.match(resolveAdaptivePolicyText('critical'), /context pressure is severe/)
})

test('reproduces compaction threshold and remaining budget semantics', () => {
  assert.equal(calculateThresholdTokens(1_000_000, 32_768, 0.8, 65_536), 800_000)
  assert.equal(calculateThresholdTokens(100_000, 20_000, 0.8, 30_000), 50_000)
  assert.equal(calculateContextRemaining(800_000, 610_000), 190_000)
  assert.equal(calculateContextRemaining(800_000, 810_000), 0)
})

test('resolves exact provider/model pressure overrides', () => {
  const config = {
    auto: true,
    thresholdRatio: 0.8,
    headroomTokens: 65_536,
    modelPolicies: [{
      provider: 'deepseek',
      model: 'small',
      thresholdRatio: 0.7,
      headroomTokens: 8192,
    }],
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

test('rejects unavailable or invalid budget inputs', () => {
  assert.equal(resolvePressurePolicy({
    auto: false,
    thresholdRatio: 0.8,
    headroomTokens: 65_536,
    modelPolicies: [],
  }, 'deepseek', 'model'), undefined)
  assert.equal(calculateThresholdTokens(undefined, 0, 0.8, 65_536), undefined)
  assert.equal(calculateThresholdTokens(100_000, -1, 0.8, 10_000), undefined)
  assert.equal(calculateThresholdTokens(100_000, 60_000, 0.8, 50_000), undefined)
  assert.equal(calculateContextRemaining(undefined, 1), undefined)
})

test('adaptive bands use relative remaining budget with inclusive boundaries', () => {
  assert.deepEqual(ADAPTIVE_BAND_RATIOS, { conserve: 0.25, critical: 0.10 })
  assert.equal(resolveAdaptiveBand(800_000, 800_000), 'ample')
  assert.equal(resolveAdaptiveBand(200_001, 800_000), 'ample')
  assert.equal(resolveAdaptiveBand(200_000, 800_000), 'conserve')
  assert.equal(resolveAdaptiveBand(80_001, 800_000), 'conserve')
  assert.equal(resolveAdaptiveBand(80_000, 800_000), 'critical')
  assert.equal(resolveAdaptiveBand(0, 800_000), 'critical')
})

test('adaptive band resolution rejects invalid inputs', () => {
  assert.equal(resolveAdaptiveBand(undefined, 800_000), undefined)
  assert.equal(resolveAdaptiveBand(1, undefined), undefined)
  assert.equal(resolveAdaptiveBand(1, 0), undefined)
  assert.equal(resolveAdaptiveBand(-1, 800_000), undefined)
  assert.equal(resolveAdaptiveBand(800_001, 800_000), undefined)
})

function integrationHarness({
  beforeTokens = 810_000,
  afterTokens = 300_000,
  contextWindow = 1_000_000,
  defaultMaxTokens,
  headerMaxTokens = 32_768,
  auto = true,
  retainedText,
  scopedCompaction = true,
  hostCompaction = false,
  hasAgentPresets = true,
  hasLlm = true,
  hasTokenMeter = true,
  promptMode,
} = {}) {
  let currentTokens = beforeTokens
  let downstreamTokens = afterTokens
  let listener
  let options
  let promptSection
  let policyContext
  let promptInjectCalls = 0
  let settingsConfigurePolicy
  const serviceLookups = []

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

  const compaction = {
    config: {
      auto,
      thresholdRatio: 0.8,
      headroomTokens: 65_536,
      modelPolicies: [],
    },
  }
  const llm = {
    resolveModelInfo: async () => ({
      context: { contextWindow },
      ...(defaultMaxTokens === undefined ? {} : { defaultMaxTokens }),
    }),
  }
  const tokenMeter = { measure: () => ({ totalTokens: currentTokens }) }

  const hostServices = {
    ...(hasAgentPresets ? {
      agentPresets: {
        serviceFor: (agent, serviceName) => {
          serviceLookups.push({ agent, serviceName })
          return scopedCompaction && serviceName === 'compaction'
            ? compaction
            : undefined
        },
      },
    } : {}),
    ...(hasLlm ? { llm } : {}),
    ...(hasTokenMeter ? { tokenMeter } : {}),
    ...(hostCompaction ? { compaction } : {}),
  }

  const strictContext = api => new Proxy(api, {
    get(target, property, receiver) {
      if (typeof property === 'string' && !(property in target)) {
        throw new Error(`undeclared context property access: ${property}`)
      }
      return Reflect.get(target, property, receiver)
    },
  })

  const agentCtx = strictContext({
    get: serviceName => (
      serviceName === 'compaction' && !hostCompaction
        ? undefined
        : hostServices[serviceName]
    ),
  })
  const agent = { session, ctx: agentCtx }

  const ctx = strictContext({
    get: serviceName => hostServices[serviceName],
    inject: (services, callback) => {
      if (services.length === 1 && services[0] === 'systemPrompt') {
        promptInjectCalls += 1
        return callback(strictContext({
          effect: factory => factory(),
          systemPrompt: strictContext({
            section: section => {
              promptSection = section
              return () => true
            },
            context: context => {
              policyContext = context
              return () => true
            },
          }),
        }))
      }
      if (services.length === 1 && services[0] === 'settings') {
        return callback(strictContext({
          effect: factory => factory(),
          settings: strictContext({
            configure: (policy, fiber) => {
              settingsConfigurePolicy = { policy, fiber }
              return () => true
            },
          }),
        }))
      }
      throw new Error('unexpected injected services: ' + services.join(','))
    },
    fiber: { id: 'budget-tracker-fiber' },
    on: (eventName, callback, listenerOptions) => {
      assert.equal(eventName, 'agent/pre-step')
      listener = callback
      options = listenerOptions
      return () => true
    },
  })

  apply(ctx, promptMode === undefined ? undefined : { promptMode })
  return {
    options,
    serviceLookups,
    promptSection,
    policyContext,
    promptInjectCalls,
    settingsConfigurePolicy,
    policyText: () => policyContext.text({ agent }),
    setAfterTokens: value => { downstreamTokens = value },
    run: async ({ reject = false } = {}) => listener(
      { agent, signal: new AbortController().signal },
      async () => {
        currentTokens = downstreamTokens
        return reject ? { kind: 'reject' } : { kind: 'enter', messages: [] }
      },
    ),
  }
}

test('registers static prompt and required adaptive runtime context together', () => {
  const harness = integrationHarness({ promptMode: 'adaptive' })
  assert.equal(harness.promptInjectCalls, 1)
  assert.deepEqual(
    {
      name: harness.promptSection.name,
      order: harness.promptSection.order,
      interpolate: harness.promptSection.interpolate,
    },
    {
      name: PROMPT_SECTION_NAME,
      order: PROMPT_SECTION_ORDER,
      interpolate: false,
    },
  )
  assert.equal(harness.promptSection.text(), resolvePromptText('planning'))
  assert.deepEqual(
    {
      name: harness.policyContext.name,
      order: harness.policyContext.order,
      interpolate: harness.policyContext.interpolate,
      required: harness.policyContext.required,
    },
    {
      name: ADAPTIVE_POLICY_CONTEXT_NAME,
      order: ADAPTIVE_POLICY_CONTEXT_ORDER,
      interpolate: false,
      required: true,
    },
  )
  assert.equal(harness.policyText(), '')
})

test('marks the settings form as plugin-owned instead of auto-generated', () => {
  const harness = integrationHarness()
  assert.deepEqual(harness.settingsConfigurePolicy, {
    policy: { auto: false },
    fiber: { id: 'budget-tracker-fiber' },
  })
})

test('resolves preset-isolated compaction and measures after downstream compaction', async () => {
  const harness = integrationHarness()
  assert.deepEqual(harness.options, { prepend: true })

  const decision = await harness.run()
  assert.equal(
    harness.serviceLookups.some(({ serviceName }) => serviceName === 'compaction'),
    true,
  )
  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages.length, 1)
  assert.equal(decision.messages[0].content[0].text, 'context_remaining: 500000')
  assert.equal(decision.messages[0].source.kind, 'dsh-budget-tracker')
  assert.equal(decision.messages[0].source.form, 'snapshot')
})

test('falls back to host compaction outside preset isolation', async () => {
  const harness = integrationHarness({ scopedCompaction: false, hostCompaction: true })
  const decision = await harness.run()
  assert.equal(decision.messages[0].content[0].text, 'context_remaining: 500000')
})

test('falls back to host services when no preset registry is installed', async () => {
  const harness = integrationHarness({
    scopedCompaction: false,
    hostCompaction: true,
    hasAgentPresets: false,
  })
  const decision = await harness.run()
  assert.equal(decision.messages[0].content[0].text, 'context_remaining: 500000')
})

test('emits no budget when required budget services are unavailable', async () => {
  assert.deepEqual(
    await integrationHarness({ scopedCompaction: false, hostCompaction: false }).run(),
    { kind: 'enter', messages: [] },
  )
  assert.deepEqual(
    await integrationHarness({ hasLlm: false }).run(),
    { kind: 'enter', messages: [] },
  )
  assert.deepEqual(
    await integrationHarness({ hasTokenMeter: false }).run(),
    { kind: 'enter', messages: [] },
  )
})

test('uses current routed model capacity and adapter completion defaults', async () => {
  const routed = integrationHarness({
    contextWindow: 256_000,
    beforeTokens: 100_000,
    afterTokens: 100_000,
    headerMaxTokens: 16_000,
  })
  assert.equal((await routed.run()).messages[0].content[0].text, 'context_remaining: 74464')

  const fallback = integrationHarness({
    contextWindow: 100_000,
    beforeTokens: 10_000,
    afterTokens: 10_000,
    headerMaxTokens: null,
    defaultMaxTokens: 20_000,
  })
  assert.equal((await fallback.run()).messages[0].content[0].text, 'context_remaining: 4464')
})

test('does not duplicate an unchanged retained budget snapshot', async () => {
  const harness = integrationHarness({ retainedText: 'context_remaining: 500000' })
  assert.deepEqual(await harness.run(), { kind: 'enter', messages: [] })
})

test('adaptive ample keeps policy runtime context empty', async () => {
  const harness = integrationHarness({ promptMode: 'adaptive' })
  const decision = await harness.run()
  assert.equal(decision.messages.length, 1)
  assert.equal(decision.messages[0].content[0].text, 'context_remaining: 500000')
  assert.equal(harness.policyText(), '')
})

test('adaptive conserve publishes guidance through runtime context, not decision messages', async () => {
  const harness = integrationHarness({ promptMode: 'adaptive', afterTokens: 650_000 })
  const decision = await harness.run()
  assert.equal(decision.messages.length, 1)
  assert.equal(decision.messages[0].content[0].text, 'context_remaining: 150000')
  assert.equal(harness.policyText(), resolveAdaptivePolicyText('conserve'))
})

test('adaptive critical publishes stronger runtime-context guidance', async () => {
  const harness = integrationHarness({ promptMode: 'adaptive', afterTokens: 730_000 })
  const decision = await harness.run()
  assert.equal(decision.messages.length, 1)
  assert.equal(decision.messages[0].content[0].text, 'context_remaining: 70000')
  assert.equal(harness.policyText(), resolveAdaptivePolicyText('critical'))
})

test('post-compaction ratio immediately returns policy to ample without hysteresis', async () => {
  const harness = integrationHarness({ promptMode: 'adaptive', afterTokens: 730_000 })
  await harness.run()
  assert.equal(harness.policyText(), resolveAdaptivePolicyText('critical'))

  harness.setAfterTokens(300_000)
  await harness.run()
  assert.equal(harness.policyText(), '')
})

test('non-adaptive mode and unavailable budget clear adaptive runtime contribution', async () => {
  const planning = integrationHarness({ promptMode: 'planning', afterTokens: 730_000 })
  await planning.run()
  assert.equal(planning.policyText(), '')

  const unavailable = integrationHarness({ promptMode: 'adaptive', hasLlm: false })
  await unavailable.run()
  assert.equal(unavailable.policyText(), '')
})

test('does not mutate policy state for a rejected pre-step', async () => {
  const harness = integrationHarness({ promptMode: 'adaptive', afterTokens: 730_000 })
  assert.deepEqual(await harness.run({ reject: true }), { kind: 'reject' })
  assert.equal(harness.policyText(), '')
})
