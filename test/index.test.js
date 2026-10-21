import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import semver from 'semver'
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
  SURGE_GUIDANCE_TEXT,
  formatSurgeNotice,
  calculateContextRemaining,
  calculateThresholdTokens,
  resolvePressurePolicy,
} from '../index.js'

test('declares DSH 0.2.1 RC compatibility without dropping 0.2.0 RC support', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  )
  const supportedDsh = '>=0.2.0-rc.2 <0.2.1-0 || >=0.2.1-rc.2 <0.3.0-0'

  assert.equal(manifest.version, '0.4.0')
  assert.equal(manifest.engines.node, '^22.19.0 || >=24.0.0')
  assert.equal(manifest.engines.dsh, supportedDsh)
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh'], supportedDsh)
  assert.equal(manifest.dsh.manifestVersion, 1)
  assert.equal(manifest.dependencies['@deepseek-ai/schemastery'], '^3.18.4')
  assert.equal(manifest.exports['./client'], './client.js')
})


test('RC compatibility agrees with npm and Harness prerelease matching', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  )
  const range = manifest.engines.dsh

  for (const version of ['0.2.0-rc.2', '0.2.0', '0.2.1-rc.2', '0.2.1-rc.3', '0.2.1', '0.2.2']) {
    assert.equal(semver.satisfies(version, range), true, `npm: ${version}`)
    assert.equal(semver.satisfies(version, range, { includePrerelease: true }), true, `DSH: ${version}`)
  }

  for (const version of ['0.2.0-rc.1', '0.2.1-alpha.5', '0.2.1-rc.1', '0.3.0-rc.1', '0.3.0']) {
    assert.equal(semver.satisfies(version, range), false, `npm: ${version}`)
    assert.equal(semver.satisfies(version, range, { includePrerelease: true }), false, `DSH: ${version}`)
  }
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
  retainedSurgeText,
  supportsAdmissionContextRefresh = true,
  scopedCompaction = true,
  hostCompaction = false,
  hasAgentPresets = true,
  hasLlm = true,
  hasTokenMeter = true,
  promptMode,
} = {}) {
  let currentTokens = beforeTokens
  let downstreamTokens = afterTokens
  let routedModel = 'model'
  let listener
  let options
  let promptSection
  let policyContext
  let promptInjectCalls = 0
  let settingsConfigurePolicy
  const serviceLookups = []

  const retained = [
    ...(retainedText === undefined ? [] : [{ type: 'user/message', data: {
      content: [{ type: 'text', text: retainedText }],
      source: { kind: 'dsh-budget-tracker', form: 'snapshot' },
    } }]),
    ...(retainedSurgeText === undefined ? [] : [{ type: 'user/message', data: {
      content: [{ type: 'text', text: retainedSurgeText }],
      source: { kind: 'dsh-budget-tracker', form: 'surge-notice' },
    } }]),
  ]

  const session = {
    surface: { nodes: retained.map((_, index) => index) },
    eventAt: index => retained[index],
    requestHeader: () => ({
      config: {
        provider: 'deepseek',
        model: routedModel,
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
        const systemPromptApi = {
          section: section => {
            promptSection = section
            return () => true
          },
          context: context => {
            policyContext = context
            return () => true
          },
          ...(supportsAdmissionContextRefresh ? { refreshContext: () => undefined } : {}),
        }
        return callback(strictContext({
          effect: factory => factory(),
          systemPrompt: strictContext(systemPromptApi),
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
    hasPolicyContext: () => policyContext !== undefined,
    policyText: () => policyContext?.text({ agent }) ?? '',
    setAfterTokens: value => { downstreamTokens = value },
    setRoutedModel: value => { routedModel = value },
    setThresholdRatio: value => { compaction.config.thresholdRatio = value },
    run: async ({ reject = false } = {}) => listener(
      { agent, signal: new AbortController().signal },
      async () => {
        currentTokens = downstreamTokens
        return reject ? { kind: 'reject' } : { kind: 'enter', messages: [] }
      },
    ),
  }
}

test('registers static prompt and optional adaptive runtime context together', () => {
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
    },
    {
      name: ADAPTIVE_POLICY_CONTEXT_NAME,
      order: ADAPTIVE_POLICY_CONTEXT_ORDER,
      interpolate: false,
    },
  )
  assert.equal(harness.policyContext.required, undefined)
  assert.equal(harness.policyText(), '')
})

test('adaptive mode rejects runtimes without admission-time context refresh', () => {
  assert.throws(
    () => integrationHarness({
      promptMode: 'adaptive',
      supportsAdmissionContextRefresh: false,
    }),
    /adaptive promptMode requires admission-time systemPrompt\.refreshContext\(\)/,
  )
})

test('runtimes without admission refresh still support non-adaptive modes', async () => {
  const harness = integrationHarness({
    promptMode: 'planning',
    supportsAdmissionContextRefresh: false,
  })
  assert.equal(harness.hasPolicyContext(), false)
  assert.equal(harness.promptSection.text(), resolvePromptText('planning'))
  const decision = await harness.run()
  assert.equal(decision.messages[0].content[0].text, 'context_remaining: 500000')
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

test('adaptive surge sends a factual notice AND runtime guidance above conserve', async () => {
  const harness = integrationHarness({ promptMode: 'adaptive', afterTokens: 140_000 })
  await harness.run() // 82.5% remaining: establish baseline
  assert.equal(harness.policyText(), '')

  harness.setAfterTokens(180_000) // 77.5%, a 5-point single-step decrease
  const decision = await harness.run()
  assert.equal(decision.messages.length, 2)
  assert.equal(decision.messages[0].content[0].text, 'context_remaining: 620000')
  assert.equal(decision.messages[1].source.kind, 'dsh-budget-tracker')
  assert.equal(decision.messages[1].source.form, 'surge-notice')
  assert.equal(
    decision.messages[1].content[0].text,
    'context_usage_notice: rapid consumption (5.0% of proactive-compaction budget over 1 step); remaining 77.5%.',
  )
  assert.equal(harness.policyText(), SURGE_GUIDANCE_TEXT)
})

test('adaptive surge detects sustained burn across five small steps', async () => {
  const harness = integrationHarness({ promptMode: 'adaptive', afterTokens: 500_000 })
  await harness.run() // 37.5% remaining
  for (let index = 1; index < 5; index += 1) {
    harness.setAfterTokens(500_000 + 12_000 * index)
    await harness.run()
    assert.equal(harness.policyText(), '')
  }
  harness.setAfterTokens(560_000) // 30% remaining, 7.5 points in five steps
  await harness.run()
  assert.equal(harness.policyText(), SURGE_GUIDANCE_TEXT)
})

test('surge warning persists for three steps and respects its five-step cooldown', async () => {
  const harness = integrationHarness({ promptMode: 'adaptive', afterTokens: 160_000 })
  await harness.run()
  harness.setAfterTokens(190_000)
  await harness.run() // step 2: trigger
  assert.equal(harness.policyText(), SURGE_GUIDANCE_TEXT)

  await harness.run() // step 3: still active
  assert.equal(harness.policyText(), SURGE_GUIDANCE_TEXT)
  await harness.run() // step 4: still active
  assert.equal(harness.policyText(), SURGE_GUIDANCE_TEXT)
  await harness.run() // step 5: expired
  assert.equal(harness.policyText(), '')

  harness.setAfterTokens(230_000)
  await harness.run() // step 6: drop is large, but cooldown applies
  assert.equal(harness.policyText(), '')
  harness.setAfterTokens(261_000)
  await harness.run() // step 7: cooldown has passed
  assert.equal(harness.policyText(), SURGE_GUIDANCE_TEXT)
})

test('surge baseline resets on compaction or pruning that increases remaining tokens', async () => {
  const harness = integrationHarness({ promptMode: 'adaptive', afterTokens: 450_000 })
  await harness.run()
  harness.setAfterTokens(480_000)
  await harness.run()
  assert.equal(harness.policyText(), SURGE_GUIDANCE_TEXT)

  harness.setAfterTokens(150_000) // simulated compaction: remaining jumps upward
  await harness.run()
  assert.equal(harness.policyText(), '')
  harness.setAfterTokens(158_000)
  await harness.run()
  assert.equal(harness.policyText(), '')
})

test('surge baseline resets when the model route changes even with equal capacity', async () => {
  const harness = integrationHarness({ promptMode: 'adaptive', afterTokens: 120_000 })
  await harness.run()
  harness.setAfterTokens(180_000)
  await harness.run()
  assert.equal(harness.policyText(), SURGE_GUIDANCE_TEXT)

  harness.setRoutedModel('another-model')
  harness.setAfterTokens(200_000)
  await harness.run()
  assert.equal(harness.policyText(), '')
  harness.setAfterTokens(232_000)
  await harness.run()
  assert.equal(harness.policyText(), SURGE_GUIDANCE_TEXT)
})

test('surge baseline resets when the effective compaction threshold changes', async () => {
  const harness = integrationHarness({ promptMode: 'adaptive', afterTokens: 150_000 })
  await harness.run()
  harness.setAfterTokens(190_000)
  await harness.run()
  assert.equal(harness.policyText(), SURGE_GUIDANCE_TEXT)

  harness.setThresholdRatio(0.7)
  harness.setAfterTokens(215_000)
  await harness.run() // new 700k threshold; new baseline
  assert.equal(harness.policyText(), '')
  harness.setAfterTokens(240_000)
  await harness.run()
  assert.equal(harness.policyText(), SURGE_GUIDANCE_TEXT)
})

test('all non-adaptive modes emit one factual alert with no guidance', async () => {
  for (const mode of ['none', 'semantic', 'planning', 'behavioral']) {
    const harness = integrationHarness({
      promptMode: mode,
      afterTokens: 140_000,
      supportsAdmissionContextRefresh: false,
    })
    await harness.run()
    harness.setAfterTokens(180_000)
    const decision = await harness.run()
    assert.equal(harness.policyText(), '', mode)
    assert.equal(decision.messages.length, 2, mode)
    assert.deepEqual(decision.messages[0].content, [
      { type: 'text', text: 'context_remaining: 620000' },
    ])
    assert.equal(decision.messages[1].source.form, 'surge-notice', mode)
    assert.equal(
      decision.messages[1].content[0].text,
      'context_usage_notice: rapid consumption (5.0% of proactive-compaction budget over 1 step); remaining 77.5%.',
      mode,
    )

    // Cooldown: do not re-emit a notice on the next admission.
    harness.setAfterTokens(185_000)
    const next = await harness.run()
    assert.equal(next.messages.some(m => m.source?.form === 'surge-notice'), false, mode)
    assert.equal(harness.policyText(), '', mode)
  }
})

test('surge notice is not mistaken for the latest retained budget snapshot', async () => {
  const harness = integrationHarness({
    promptMode: 'semantic',
    retainedText: 'context_remaining: 500000',
    retainedSurgeText: 'context_usage_notice: previous trigger',
    afterTokens: 300_000,
  })
  assert.deepEqual(await harness.run(), { kind: 'enter', messages: [] })
})

test('all modes can detect rolling burn without an individual step spike', async () => {
  const harness = integrationHarness({ promptMode: 'semantic', afterTokens: 500_000 })
  await harness.run()
  for (let index = 1; index < 5; index += 1) {
    harness.setAfterTokens(500_000 + 12_000 * index)
    const decision = await harness.run()
    assert.equal(decision.messages.some(m => m.source?.form === 'surge-notice'), false)
  }
  harness.setAfterTokens(560_000)
  const decision = await harness.run()
  assert.equal(decision.messages.filter(m => m.source?.form === 'surge-notice').length, 1)
  assert.equal(
    decision.messages.find(m => m.source?.form === 'surge-notice').content[0].text,
    'context_usage_notice: rapid consumption (7.5% of proactive-compaction budget over 5 steps); remaining 30.0%.',
  )
  assert.equal(harness.policyText(), '')
})

test('critical pressure remains the dominant guidance even during a surge', async () => {
  const harness = integrationHarness({ promptMode: 'adaptive', afterTokens: 700_000 })
  await harness.run() // remaining 12.5%
  harness.setAfterTokens(740_000) // remaining 7.5%, single-step surge
  const decision = await harness.run()
  assert.equal(harness.policyText(), resolveAdaptivePolicyText('critical'))
  assert.equal(decision.messages.filter(m => m.source?.form === 'surge-notice').length, 1)
})

test('surge notice formatting is factual and contains no prescriptive text', () => {
  const single = formatSurgeNotice({ spanSteps: 1, spentRatio: 0.05, remainingRatio: 0.775 })
  const rolling = formatSurgeNotice({ spanSteps: 5, spentRatio: 0.075, remainingRatio: 0.30 })
  assert.match(single, /5\.0%.*1 step/)
  assert.match(rolling, /7\.5%.*5 steps/)
  assert.doesNotMatch(single, /reassess|should|must|prioritize|prefer|reduce/i)
})
