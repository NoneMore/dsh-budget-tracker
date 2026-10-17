import z from '@deepseek-ai/schemastery'
import { randomUUID } from 'node:crypto'

export const name = 'dsh-budget-tracker'

export const PROMPT_MODES = Object.freeze(['none', 'semantic', 'planning', 'behavioral', 'adaptive'])
export const DEFAULT_PROMPT_MODE = 'semantic'
export const PROMPT_SECTION_NAME = 'budget-tracker:context-remaining-guidance'
export const PROMPT_SECTION_ORDER = 9800
export const ADAPTIVE_POLICY_CONTEXT_NAME = 'budget-tracker:adaptive-guidance'
export const ADAPTIVE_POLICY_CONTEXT_ORDER = 9800

// Experimental defaults. They remain model-invisible and are not exposed by
// the Web configuration surface, but can be overridden in runtime/profile
// config so controlled experiments do not require rebuilding the plugin.
export const ADAPTIVE_BAND_RATIOS = Object.freeze({
  conserve: 0.25,
  critical: 0.10,
})
export const DEFAULT_ADAPTIVE_POLICY = Object.freeze({
  conserveRatio: ADAPTIVE_BAND_RATIOS.conserve,
  criticalRatio: ADAPTIVE_BAND_RATIOS.critical,
})

/**
 * Runtime Config schema. Only promptMode is volatile/Web-editable. Adaptive
 * cutoffs are hidden experiment controls and intentionally require ordinary
 * profile/runtime configuration rather than hot Web mutation.
 */
export const Config = z.object({
  promptMode: z.union([...PROMPT_MODES]).default(DEFAULT_PROMPT_MODE).volatile(),
  adaptivePolicy: z.object({
    conserveRatio: z.number().min(0).max(1).default(DEFAULT_ADAPTIVE_POLICY.conserveRatio),
    criticalRatio: z.number().min(0).max(1).default(DEFAULT_ADAPTIVE_POLICY.criticalRatio),
  }).default({}),
})

const SEMANTIC_PROMPT_TEXT = 'context_remaining reports the remaining token budget before proactive context compaction, not the model\'s absolute context-window remainder.'
const PLANNING_PROMPT_TEXT = `${SEMANTIC_PROMPT_TEXT} Use it as a context-pressure signal when deciding how much context to spend on the current response.`

const PROMPT_TEXT = Object.freeze({
  semantic: SEMANTIC_PROMPT_TEXT,
  planning: PLANNING_PROMPT_TEXT,
  behavioral: `${PLANNING_PROMPT_TEXT} As the remaining budget decreases, actively limit avoidable context growth: prioritize essential information, avoid unnecessary restatement, keep intermediate outputs compact, and prefer completing the current task over opening large new lines of work. Do not invent numeric thresholds or treat the value as a hard limit.`,
  // Adaptive uses planning as its stable system-prompt baseline. A Harness
  // runtime-context contribution supplies the pressure-specific behavior.
  adaptive: PLANNING_PROMPT_TEXT,
})

const ADAPTIVE_POLICY_TEXT = Object.freeze({
  ample: '',
  conserve: 'Adaptive context-conservation guidance: reduce avoidable context growth. Avoid redundant restatement and low-value exploration, keep intermediate outputs and tool-result handling compact, and prefer advancing the current task. Necessary verification and exploration for correctness remain appropriate.',
  critical: 'Adaptive context-conservation guidance: context pressure is severe. Do only the work needed to finish the current task or reach a safe checkpoint. Avoid large new workstreams and nonessential exploration; prioritize finish, verify, and report.',
})

/**
 * Resolve the optional static system-prompt guidance for one configured mode.
 *
 * `semantic` only disambiguates the field. `planning` adds lightweight usage
 * guidance. `behavioral` additionally guides context-conserving behavior without
 * inventing thresholds or changing compaction policy. `adaptive` keeps the
 * `planning` baseline and adds dynamic policy through Harness runtime context.
 *
 * @param {string | undefined} mode
 * @returns {string | undefined}
 */
export function resolvePromptText(mode = DEFAULT_PROMPT_MODE) {
  if (mode === 'none') return undefined
  const text = PROMPT_TEXT[mode]
  if (text !== undefined) return text
  throw new TypeError(
    'dsh-budget-tracker: promptMode must be one of ' + PROMPT_MODES.join(', '),
  )
}

/** Resolve one model-facing adaptive policy text. */
export function resolveAdaptivePolicyText(band) {
  return ADAPTIVE_POLICY_TEXT[band]
}

/** Resolve a direct test/config value or a Schemastery volatile reference. */
export function currentPromptMode(config = {}) {
  const configured = config?.promptMode
  if (configured && typeof configured === 'object' && typeof configured.get === 'function') {
    return configured.get()
  }
  return configured ?? DEFAULT_PROMPT_MODE
}

/**
 * Resolve and validate the hidden adaptive experiment controls.
 *
 * Cross-field ordering is validated here because Schemastery validates fields
 * independently. Invalid policy config is an activation error rather than a
 * silent fallback that would contaminate an experiment.
 */
export function resolveAdaptivePolicyConfig(config = {}) {
  const configured = config?.adaptivePolicy ?? {}
  const conserveRatio = configured.conserveRatio ?? DEFAULT_ADAPTIVE_POLICY.conserveRatio
  const criticalRatio = configured.criticalRatio ?? DEFAULT_ADAPTIVE_POLICY.criticalRatio

  if (!Number.isFinite(conserveRatio) || !Number.isFinite(criticalRatio)
    || criticalRatio <= 0 || conserveRatio >= 1
    || criticalRatio >= conserveRatio) {
    throw new TypeError(
      'dsh-budget-tracker: adaptivePolicy must satisfy 0 < criticalRatio < conserveRatio < 1',
    )
  }

  return Object.freeze({ conserveRatio, criticalRatio })
}

/**
 * Register the stable system-prompt guidance plus the adaptive runtime context.
 *
 * The runtime context is marked required because the tracker guidance is an
 * operational companion to context_remaining, not optional environment prose.
 * Its provider is refreshed by Harness after pre-step, so it reads the band
 * derived from the same post-compaction state as the budget snapshot.
 */
function registerPrompt(ctx, config, adaptiveGuidanceByAgent) {
  ctx.inject(['systemPrompt'], (inner) => {
    inner.effect(() => inner.systemPrompt.section({
      name: PROMPT_SECTION_NAME,
      order: PROMPT_SECTION_ORDER,
      text: () => resolvePromptText(currentPromptMode(config)) ?? '',
      interpolate: false,
    }), 'dsh-budget-tracker system prompt')

    inner.effect(() => inner.systemPrompt.context({
      name: ADAPTIVE_POLICY_CONTEXT_NAME,
      order: ADAPTIVE_POLICY_CONTEXT_ORDER,
      text: context => adaptiveGuidanceByAgent.get(context?.agent) ?? '',
      interpolate: false,
      required: true,
    }), 'dsh-budget-tracker adaptive runtime context')
  })
}

/** Tell Settings that this plugin ships its own Web configuration page. */
function registerSettingsPresentation(ctx) {
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })
}

// The tracker intentionally follows dsh-compaction-basic's pressure semantics:
// the active compaction service for its resolved policy, the LLM service for
// the current routed model capacity, and tokenMeter for the exact pressure
// quantity used by compaction-basic.
export const inject = ['agents']

/**
 * Resolve the pressure fields that dsh-compaction-basic applies to one routed
 * provider/model pair.
 *
 * @param {object} config resolved BasicCompactionEngine config
 * @param {string} provider
 * @param {string} model
 * @returns {{ thresholdRatio: number, headroomTokens: number } | undefined}
 */
export function resolvePressurePolicy(config, provider, model) {
  if (!config || config.auto !== true) return undefined
  if (!Number.isFinite(config.thresholdRatio) || !Number.isFinite(config.headroomTokens)) {
    return undefined
  }

  const override = Array.isArray(config.modelPolicies)
    ? config.modelPolicies.find(policy => (
        policy?.provider === provider && policy?.model === model
      ))
    : undefined

  const thresholdRatio = override?.thresholdRatio ?? config.thresholdRatio
  const headroomTokens = override?.headroomTokens ?? config.headroomTokens

  if (!Number.isFinite(thresholdRatio) || !Number.isFinite(headroomTokens)) return undefined
  if (thresholdRatio <= 0 || thresholdRatio > 1 || headroomTokens < 0) return undefined

  return { thresholdRatio, headroomTokens }
}

/**
 * Reproduce dsh-compaction-basic's proactive pressure threshold:
 *
 * floor(min(
 *   contextWindow * thresholdRatio,
 *   contextWindow - reservedCompletionTokens - headroomTokens
 * ))
 *
 * @param {number | undefined} contextWindow
 * @param {number | undefined} reservedCompletionTokens
 * @param {number | undefined} thresholdRatio
 * @param {number | undefined} headroomTokens
 * @returns {number | undefined}
 */
export function calculateThresholdTokens(
  contextWindow,
  reservedCompletionTokens,
  thresholdRatio,
  headroomTokens,
) {
  if (
    !Number.isInteger(contextWindow)
    || !Number.isInteger(reservedCompletionTokens)
    || !Number.isFinite(thresholdRatio)
    || !Number.isInteger(headroomTokens)
  ) return undefined

  if (
    contextWindow <= 0
    || reservedCompletionTokens < 0
    || thresholdRatio <= 0
    || thresholdRatio > 1
    || headroomTokens < 0
  ) return undefined

  const pressureBudgetTokens =
    contextWindow - reservedCompletionTokens - headroomTokens

  if (pressureBudgetTokens <= 0) return undefined

  return Math.floor(Math.min(
    contextWindow * thresholdRatio,
    pressureBudgetTokens,
  ))
}

/**
 * Remaining pressure budget before proactive compaction qualifies.
 *
 * @param {number | undefined} thresholdTokens
 * @param {number | undefined} currentPressureTokens
 * @returns {number | undefined}
 */
export function calculateContextRemaining(thresholdTokens, currentPressureTokens) {
  if (!Number.isInteger(thresholdTokens) || !Number.isFinite(currentPressureTokens)) {
    return undefined
  }
  if (thresholdTokens < 0 || currentPressureTokens < 0) return undefined
  return Math.max(0, Math.floor(thresholdTokens - currentPressureTokens))
}

/**
 * Resolve the adaptive pressure band from the relative remaining budget.
 *
 * The cutoffs are hidden runtime experiment policy, not part of the meaning of
 * context_remaining. The exact current ratio is authoritative; no hysteresis
 * or transition-specific threshold logic is applied.
 *
 * @param {number | undefined} contextRemaining
 * @param {number | undefined} thresholdTokens
 * @param {{ conserveRatio: number, criticalRatio: number }} adaptivePolicy
 * @returns {'ample' | 'conserve' | 'critical' | undefined}
 */
export function resolveAdaptiveBand(
  contextRemaining,
  thresholdTokens,
  adaptivePolicy = DEFAULT_ADAPTIVE_POLICY,
) {
  if (!Number.isInteger(contextRemaining) || !Number.isInteger(thresholdTokens)) {
    return undefined
  }
  if (thresholdTokens <= 0 || contextRemaining < 0 || contextRemaining > thresholdTokens) {
    return undefined
  }

  const remainingRatio = contextRemaining / thresholdTokens
  if (remainingRatio <= adaptivePolicy.criticalRatio) return 'critical'
  if (remainingRatio <= adaptivePolicy.conserveRatio) return 'conserve'
  return 'ample'
}

/** Build one immutable budget snapshot message without runtime dependencies. */
function createBudgetMessage(text) {
  const section = Object.freeze({ name: 'budget-tracker:context-remaining', text })
  const source = Object.freeze({
    kind: name,
    form: 'snapshot',
    sections: Object.freeze([section]),
  })
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source,
  })
}

/** Return the newest retained budget snapshot text, if one survives. */
function retainedBudgetText(session) {
  const nodes = session?.surface?.nodes
  if (!nodes || typeof session.eventAt !== 'function') return undefined
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const event = session.eventAt(nodes[index])
    if (event?.type !== 'user/message' || event.data?.source?.kind !== name) continue
    const [block] = event.data.content ?? []
    return event.data.content?.length === 1 && block?.type === 'text'
      ? block.text
      : undefined
  }
  return undefined
}

/**
 * Resolve one runtime service for an agent.
 *
 * Preset-owned services can live behind an isolate realm that agent.ctx cannot
 * read directly. AgentPresetRegistry.serviceFor() addresses that mounted subtree
 * by agent. Services not owned by the preset fall back to the agent-visible
 * context and then the host context, preserving non-Web compositions.
 */
function serviceForAgent(ctx, agent, serviceName) {
  const agentCtx = agent?.ctx
  if (!agentCtx) return undefined

  const presets = ctx.get?.('agentPresets')
  const scoped = presets?.serviceFor?.(agent, serviceName)
  if (scoped !== undefined) return scoped

  return agentCtx.get?.(serviceName)
    ?? ctx.get?.(serviceName)
}

/** Resolve the post-downstream budget state used by both model-visible outputs. */
async function resolveBudgetState(ctx, agent, signal) {
  const compaction = serviceForAgent(ctx, agent, 'compaction')
  const llm = serviceForAgent(ctx, agent, 'llm')
  const tokenMeter = serviceForAgent(ctx, agent, 'tokenMeter')
  if (typeof llm?.resolveModelInfo !== 'function'
    || typeof tokenMeter?.measure !== 'function') return undefined

  const config = compaction?.config
  const header = agent.session.requestHeader()
  if (!header) return undefined

  const provider = header.config?.provider
  const model = header.config?.model
  if (typeof provider !== 'string' || provider.length === 0
    || typeof model !== 'string' || model.length === 0) return undefined

  const policy = resolvePressurePolicy(config, provider, model)
  if (!policy) return undefined

  let info
  try {
    info = await llm.resolveModelInfo(provider, model, signal)
  } catch {
    return undefined
  }
  if (signal?.aborted) return undefined

  const contextWindow = info?.context?.contextWindow
  const reservedCompletionTokens = header.config.maxTokens ?? info?.defaultMaxTokens ?? 0
  const thresholdTokens = calculateThresholdTokens(
    contextWindow,
    reservedCompletionTokens,
    policy.thresholdRatio,
    policy.headroomTokens,
  )
  if (thresholdTokens === undefined) return undefined

  // Deliberately totalTokens, not projectedTokens: this is the same numerator
  // dsh-compaction-basic checks. Running after next() means compaction/pruning
  // performed by downstream pre-step listeners is already reflected here.
  const currentPressureTokens = tokenMeter.measure(agent.session).totalTokens
  const remaining = calculateContextRemaining(thresholdTokens, currentPressureTokens)
  if (remaining === undefined) return undefined

  return {
    thresholdTokens,
    remaining,
    text: `context_remaining: ${remaining}`,
  }
}

/**
 * DeepSeek Harness plugin entry point.
 *
 * The prepended listener wraps the complete pre-step chain. It computes after
 * next(), so any dsh-compaction-basic pruning/compaction in that chain lands
 * before both the budget snapshot and the runtime-context policy are resolved.
 */
export function apply(ctx, config = {}) {
  const adaptivePolicy = resolveAdaptivePolicyConfig(config)
  const adaptiveGuidanceByAgent = new WeakMap()
  registerPrompt(ctx, config, adaptiveGuidanceByAgent)
  registerSettingsPresentation(ctx)

  return ctx.on('agent/pre-step', async (
    { agent, signal },
    next,
  ) => {
    // Capture the mode at listener entry so the static prompt assembled just
    // before pre-step and the dynamic policy decision use one configuration.
    const promptMode = currentPromptMode(config)
    const decision = await next()
    if (decision.kind === 'reject' || signal?.aborted) return decision

    const budget = await resolveBudgetState(ctx, agent, signal)
    if (signal?.aborted) return decision

    const band = promptMode === 'adaptive' && budget !== undefined
      ? resolveAdaptiveBand(budget.remaining, budget.thresholdTokens, adaptivePolicy)
      : undefined
    adaptiveGuidanceByAgent.set(agent, resolveAdaptivePolicyText(band) ?? '')

    if (budget === undefined || retainedBudgetText(agent.session) === budget.text) {
      return decision
    }

    return {
      ...decision,
      messages: [...decision.messages, createBudgetMessage(budget.text)],
    }
  }, { prepend: true })
}
