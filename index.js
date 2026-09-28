export const name = 'dsh-budget-tracker'

// Wait until all three Harness services are available. tokenMeter owns the
// contextPressure projection registered on sessionProjections.
export const inject = ['systemPrompt', 'tokenMeter', 'sessionProjections']

/**
 * Convert Harness context pressure into the one model-visible value exposed by
 * this plugin.
 *
 * @param {number | undefined} contextWindow
 * @param {number | undefined} projectedTokens
 * @returns {number | undefined}
 */
export function calculateContextRemaining(contextWindow, projectedTokens) {
  if (!Number.isFinite(contextWindow) || !Number.isFinite(projectedTokens)) return undefined
  if (contextWindow <= 0 || projectedTokens < 0) return undefined
  return Math.max(0, Math.floor(contextWindow - projectedTokens))
}

/**
 * DeepSeek Harness plugin entry point.
 *
 * The contribution is dynamic runtime context, so it is refreshed as the
 * session grows without rewriting the stable system-prompt prefix.
 */
export function apply(ctx) {
  return ctx.systemPrompt.context({
    name: 'budget-tracker:context-remaining',
    order: 1000,
    text: ({ agent }) => {
      if (!agent) return ''

      const pressure = ctx.sessionProjections
        .snapshot(agent.session)
        .values
        .contextPressure

      const remaining = calculateContextRemaining(
        pressure?.contextWindow,
        pressure?.projectedTokens,
      )

      return remaining === undefined ? '' : `context_remaining: ${remaining}`
    },
  })
}
