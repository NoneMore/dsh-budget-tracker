import { randomUUID } from 'node:crypto'

export const name = 'dsh-budget-tracker'

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

/** Build one immutable source-attributed context message without runtime deps. */
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

  const presets = ctx.get?.('agentPresets') ?? ctx.agentPresets
  const scoped = presets?.serviceFor?.(agent, serviceName)
  if (scoped !== undefined) return scoped

  return agentCtx.get?.(serviceName)
    ?? agentCtx[serviceName]
    ?? ctx.get?.(serviceName)
    ?? ctx[serviceName]
}

/** Resolve the model-visible remaining budget after downstream pre-step work. */
async function contextRemainingText(ctx, agent, signal) {
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
  return remaining === undefined ? undefined : `context_remaining: ${remaining}`
}

/**
 * DeepSeek Harness plugin entry point.
 *
 * The prepended listener wraps the complete pre-step chain. It computes after
 * next(), so any dsh-compaction-basic pruning/compaction in that chain lands
 * before the model-visible budget snapshot is measured.
 */
export function apply(ctx) {
  return ctx.on('agent/pre-step', async (
    { agent, signal },
    next,
  ) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal?.aborted) return decision

    const text = await contextRemainingText(ctx, agent, signal)
    if (text === undefined || signal?.aborted) return decision
    if (retainedBudgetText(agent.session) === text) return decision

    return {
      ...decision,
      messages: [...decision.messages, createBudgetMessage(text)],
    }
  }, { prepend: true })
}
