import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  apply,
  inject,
  DEFAULT_PROMPT_MODE,
  PROMPT_SECTION_NAME,
  PROMPT_SECTION_ORDER,
  resolvePromptText,
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

test('only requires the host-level agent registry service', () => {
  assert.deepEqual(inject, ['agents'])
})

test('defaults to semantic-only prompt guidance', () => {
  assert.equal(DEFAULT_PROMPT_MODE, 'semantic')
  assert.equal(
    resolvePromptText(),
    'context_remaining reports the remaining token budget before proactive context compaction, not the model\'s absolute context-window remainder.',
  )
})

test('planning mode adds lightweight context-pressure guidance', () => {
  assert.equal(
    resolvePromptText('planning'),
    'context_remaining reports the remaining token budget before proactive context compaction, not the model\'s absolute context-window remainder. Use it as a context-pressure signal when deciding how much context to spend on the current response.',
  )
})

test('behavioral mode guides context-conserving behavior', () => {
  assert.equal(
    resolvePromptText('behavioral'),
    'context_remaining reports the remaining token budget before proactive context compaction, not the model\'s absolute context-window remainder. Use it as a context-pressure signal when deciding how much context to spend on the current response. As the remaining budget decreases, actively limit avoidable context growth: prioritize essential information, avoid unnecessary restatement, keep intermediate outputs compact, and prefer completing the current task over opening large new lines of work. Do not invent numeric thresholds or treat the value as a hard limit.',
  )
})

test('none mode disables static prompt guidance', () => {
  assert.equal(resolvePromptText('none'), undefined)
})

test('rejects unknown prompt modes', () => {
  assert.throws(
    () => resolvePromptText('aggressive'),
    /promptMode must be one of none, semantic, planning, behavioral/,
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
  scopedCompaction = true,
  hostCompaction = false,
  hasAgentPresets = true,
  hasLlm = true,
  hasTokenMeter = true,
  promptMode,
} = {}) {
  let currentTokens = beforeTokens
  let listener
  let options
  let promptSection
  let promptInjectCalls = 0
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

  // DSH Web keeps compaction behind a preset-owned isolate realm. The agent
  // context can inherit host services such as llm/tokenMeter, but it cannot
  // directly resolve that isolated compaction service.
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

  // Cordis contexts reject undeclared service property access. Keep the harness
  // strict so optional services must be read through ctx.get(), just like the
  // real runtime.
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

  const ctx = strictContext({
    get: serviceName => hostServices[serviceName],
    inject: (services, callback) => {
      assert.deepEqual(services, ['systemPrompt'])
      promptInjectCalls += 1
      return callback(strictContext({
        effect: factory => factory(),
        systemPrompt: strictContext({
          section: section => {
            promptSection = section
            return () => true
          },
        }),
      }))
    },
    on: (name, callback, listenerOptions) => {
      assert.equal(name, 'agent/pre-step')
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
    promptInjectCalls,
    run: async ({ reject = false } = {}) => {
      const agent = { session, ctx: agentCtx }
      return listener(
        { agent, signal: new AbortController().signal },
        async () => {
          currentTokens = afterTokens
          return reject ? { kind: 'reject' } : { kind: 'enter', messages: [] }
        },
      )
    },
  }
}

test('registers semantic system-prompt guidance by default', () => {
  const harness = integrationHarness()
  assert.equal(harness.promptInjectCalls, 1)
  assert.deepEqual(harness.promptSection, {
    name: PROMPT_SECTION_NAME,
    order: PROMPT_SECTION_ORDER,
    text: resolvePromptText('semantic'),
    interpolate: false,
  })
})

test('registers planning guidance when configured', () => {
  const harness = integrationHarness({ promptMode: 'planning' })
  assert.equal(harness.promptInjectCalls, 1)
  assert.equal(harness.promptSection.text, resolvePromptText('planning'))
})

test('registers behavioral guidance when configured', () => {
  const harness = integrationHarness({ promptMode: 'behavioral' })
  assert.equal(harness.promptInjectCalls, 1)
  assert.equal(harness.promptSection.text, resolvePromptText('behavioral'))
})

test('none prompt mode leaves the system prompt untouched', () => {
  const harness = integrationHarness({ promptMode: 'none' })
  assert.equal(harness.promptInjectCalls, 0)
  assert.equal(harness.promptSection, undefined)
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

test('falls back to a host-visible compaction service outside preset isolation', async () => {
  const harness = integrationHarness({
    scopedCompaction: false,
    hostCompaction: true,
  })
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

test('emits no budget when the agent has no active compaction service', async () => {
  const harness = integrationHarness({
    scopedCompaction: false,
    hostCompaction: false,
  })
  const decision = await harness.run()
  assert.deepEqual(decision, { kind: 'enter', messages: [] })
})

test('emits no budget when the LLM service is unavailable', async () => {
  const harness = integrationHarness({ hasLlm: false })
  const decision = await harness.run()
  assert.deepEqual(decision, { kind: 'enter', messages: [] })
})

test('emits no budget when the token meter service is unavailable', async () => {
  const harness = integrationHarness({ hasTokenMeter: false })
  const decision = await harness.run()
  assert.deepEqual(decision, { kind: 'enter', messages: [] })
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
