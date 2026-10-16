import z from '@deepseek-ai/schemastery'
import { randomUUID } from 'node:crypto'

export const name = 'dsh-budget-tracker'

export const PROMPT_MODES = Object.freeze(['none', 'semantic', 'planning', 'behavioral', 'adaptive'])
export const DEFAULT_PROMPT_MODE = 'semantic'
export const PROMPT_SECTION_NAME = 'budget-tracker:context-remaining-guidance'
export const PROMPT_SECTION_ORDER = 9800
export const ADAPTIVE_POLICY_SOURCE = 'dsh-budget-tracker-policy'
export const ADAPTIVE_POLICY_SECTION_NAME = 'budget-tracker:adaptive-guidance'

// Experimental implementation policy. These cutoffs are intentionally not
// exposed as runtime/Web configuration or part of context_remaining semantics.
export const ADAPTIVE_BAND_RATIOS = Object.freeze({
  conserve: 0.25,
  critical: 0.10,
})

/**
 * Runtime Config schema. The field is volatile so the Web settings surface can
 * edit it without turning prompt selection into a separate persistence system.
 */
export const Config = z.object({
  promptMode: z.union([...PROMPT_MODES]).default(DEFAULT_PROMPT_MODE).volatile(),
})

const SEMANTIC_PROMPT_TEXT = 'context_remaining reports the remaining token budget before proactive context compaction, not the model\'s absolute context-window remainder.'
const PLANNING_PROMPT_TEXT = `${SEMANTIC_PROMPT_TEXT} Use it as a context-pressure signal when deciding how much context to spend on the current response.`

const PROMPT_TEXT = Object.freeze({
  semantic: SEMANTIC_PROMPT_TEXT,
  planning: PLANNING_PROMPT_TEXT,
  behavioral: `${PLANNING_PROMPT_TEXT} As the remaining budget decreases, actively limit avoidable context growth: prioritize essential information, avoid unnecessary restatement, keep intermediate outputs compact, and prefer completing the current task over opening large new lines of work. Do not invent numeric thresholds or treat the value as a hard limit.`,
  // Adaptive uses planning as its stable system-prompt baseline. Sparse
  // post-compaction policy snapshots provide the pressure-specific behavior.
  adaptive: PLANNING_PROMPT_TEXT,
})

const ADAPTIVE_POLICY_TEXT = Object.freeze({
  ample: 'Context pressure has eased. Earlier adaptive context-conservation guidance no longer applies; use the planning baseline normally.',
  conserve: 'Updated context-conservation guidance: reduce avoidable context growth. Avoid redundant restatement and low-value exploration, keep intermediate outputs and tool-result handling compact, and prefer advancing the current task. Necessary verification and exploration for correctness remain appropriate. This supersedes earlier adaptive context-conservation guidance.',
  critical: 'Updated context-conservation guidance: context pressure is severe. Do only the work needed to finish the current task or reach a safe checkpoint. Avoid large new workstreams and nonessential exploration; prioritize finish, verify, and report. This supersedes earlier adaptive context-conservation guidance.',
})

/**
 * Resolve the optional static system-prompt guidance for one configured mode.
 *
 * `semantic` only disambiguates the field. `planning` adds lightweight usage
 * guidance. `behavioral` additionally guides context-conserving behavior without
 * inventing thresholds or changing compaction policy. `adaptive` keeps the
 * `planning` baseline and adds sparse dynamic policy snapshots after pre-step.
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
 * Register one stable system-prompt section whose text reads the current
 * volatile setting at assembly time. `none` therefore renders an empty
 * section without requiring a plugin reload.
 */
function registerPrompt(ctx, config) {
  ctx.inject(['systemPrompt'], (inner) => {
    inner.effect(() => inner.systemPrompt.section({
      name: PROMPT_SECTION_NAME,
      order: PROMPT_SECTION_ORDER,
      text: () => resolvePromptText(currentPromptMode(config)) ?? '',
      interpolate: false,
    }), 'dsh-budget-tracker system prompt')
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
 * The cutoffs are implementation policy, not user configuration and not part
 * of the meaning of context_remaining.
 *
 * @param {number | undefined} contextRemaining
 * @param {number | undefined} thresholdTokens
 * @returns {'ample' | 'conserve' | 'critical' | undefined}
 */
export function resolveAdaptiveBand(contextRemaining, thresholdTokens) {
  if (!Number.isInteger(contextRemaining) || !Number.isInteger(thresholdTokens)) {
    return undefined
  }
  if (thresholdTokens <= 0 || contextRemaining < 0 || contextRemaining > thresholdTokens) {
    return undefined
  }

  const remainingRatio = contextRemaining / thresholdTokens
  if (remainingRatio <= ADAPTIVE_BAND_RATIOS.critical) return 'critical'
  if (remainingRatio <= ADAPTIVE_BAND_RATIOS.conserve) return 'conserve'
  return 'ample'
}

/** Build one immutable source-attributed snapshot message without runtime deps. */
function createSnapshotMessage(sourceKind, sectionName, text) {
  const section = Object.freeze({ name: sectionName, text })
  const source = Object.freeze({
    kind: sourceKind,
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

function createBudgetMessage(text) {
  return createSnapshotMessage(name, 'budget-tracker:context-remaining', text)
}

function createAdaptivePolicyMessage(text) {
  return createSnapshotMessage(
    ADAPTIVE_POLICY_SOURCE,
    ADAPTIVE_POLICY_SECTION_NAME,
    text,
  )
}

/** Return the newest retained single-text snapshot from one producer. */
function retainedSnapshotText(session, sourceKind) {
  const nodes = session?.surface?.nodes
  if (!nodes || typeof session.eventAt !== 'function') return undefined
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const event = session.eventAt(nodes[index])
    if (event?.type !== 'user/message' || event.data?.source?.kind !== sourceKind) continue
    const [block] = event.data.content ?? []
    return event.data.content?.length === 1 && block?.type === 'text'
      ? block.text
      : undefined
  }
  return undefined
}

/** Return the newest retained budget snapshot text, if one survives. */
function retainedBudgetText(session) {
  return retainedSnapshotText(session, name)
}

/** Return the newest retained adaptive-policy snapshot text, if one survives. */
function retainedAdaptivePolicyText(session) {
  return retainedSnapshotText(session, ADAPTIVE_POLICY_SOURCE)
}

/**
 * Decide whether the model-visible adaptive policy needs a new snapshot.
 *
 * An ample band is silent when no policy is retained. When a restrictive
 * policy is retained, ample emits one relaxation snapshot to supersede it.
 * Switching away from adaptive follows the same clearing rule. Restrictive
 * bands are re-published whenever their matching snapshot no longer survives.
 */
function adaptivePolicyUpdateText(promptMode, band, retainedText) {
  if (promptMode !== 'adaptive') {
    if (retainedText === undefined || retainedText === ADAPTIVE_POLICY_TEXT.ample) {
      return undefined
    }
    return ADAPTIVE_POLICY_TEXT.ample
  }

  if (band === undefined) return undefined
  if (band === 'ample') {
    if (retainedText === undefined || retainedText === ADAPTIVE_POLICY_TEXT.ample) {
      return undefined
    }
    return ADAPTIVE_POLICY_TEXT.ample
  }

  const desired = ADAPTIVE_POLICY_TEXT[band]
  return retainedText === desired ? undefined : desired
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
 * before the model-visible budget snapshot and adaptive policy are resolved.
 */
export function apply(ctx, config = {}) {
  registerPrompt(ctx, config)
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

    const retainedPolicy = retainedAdaptivePolicyText(agent.session)
    let policyText = adaptivePolicyUpdateText(promptMode, undefined, retainedPolicy)

    const budget = await resolveBudgetState(ctx, agent, signal)
    if (signal?.aborted) return decision

    if (promptMode === 'adaptive' && budget !== undefined) {
      const band = resolveAdaptiveBand(budget.remaining, budget.thresholdTokens)
      policyText = adaptivePolicyUpdateText(promptMode, band, retainedPolicy)
    }

    const additions = []
    if (budget !== undefined && retainedBudgetText(agent.session) !== budget.text) {
      additions.push(createBudgetMessage(budget.text))
    }
    if (policyText !== undefined) {
      additions.push(createAdaptivePolicyMessage(policyText))
    }
    if (additions.length === 0) return decision

    return {
      ...decision,
      messages: [...decision.messages, ...additions],
    }
  }, { prepend: true })
}
