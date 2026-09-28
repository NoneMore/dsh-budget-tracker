export const name = 'dsh-budget-tracker'

// The tracker intentionally follows dsh-compaction-basic's pressure semantics:
// systemPrompt for model visibility, tokenMeter for the exact pressure quantity
// used by compaction-basic, and compaction for its resolved policy.
export const inject = ['systemPrompt', 'tokenMeter', 'compaction']

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
 * DeepSeek Harness plugin entry point.
 *
 * The value is based on the latest durable routed request because that is also
 * what dsh-compaction-basic evaluates during agent/pre-step pressure checks.
 */
export function apply(ctx) {
  return ctx.systemPrompt.context({
    name: 'budget-tracker:context-remaining',
    order: 1000,
    text: ({ agent }) => {
      if (!agent) return ''

      // dsh-compaction-basic exposes its resolved config on the active
      // compaction service. If another backend is mounted, or auto compaction
      // is disabled, there is no dsh-compaction-basic intervention budget to
      // report.
      const config = ctx.compaction?.config
      const header = agent.session.requestHeader()
      const requestContext = agent.session.requestContext()

      if (
        !header
        || !requestContext
        || requestContext.contextWindow === undefined
        || header.config.provider !== requestContext.provider
        || header.config.model !== requestContext.model
      ) return ''

      const policy = resolvePressurePolicy(
        config,
        header.config.provider,
        header.config.model,
      )
      if (!policy) return ''

      // prepareCall() materializes an adapter-owned default maxTokens into the
      // durable request header. An absent maxTokens therefore means this route
      // reserves no declared completion budget, matching compaction-basic's
      // final fallback to zero.
      const reservedCompletionTokens = header.config.maxTokens ?? 0

      const thresholdTokens = calculateThresholdTokens(
        requestContext.contextWindow,
        reservedCompletionTokens,
        policy.thresholdRatio,
        policy.headroomTokens,
      )
      if (thresholdTokens === undefined) return ''

      // This is deliberately totalTokens, not projectedTokens: it is the exact
      // meter quantity dsh-compaction-basic compares against thresholdTokens.
      const currentPressureTokens = ctx.tokenMeter.measure(agent.session).totalTokens
      const remaining = calculateContextRemaining(
        thresholdTokens,
        currentPressureTokens,
      )

      return remaining === undefined ? '' : `context_remaining: ${remaining}`
    },
  })
}
