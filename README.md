# dsh-budget-tracker

A deliberately tiny budget-awareness plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

It exposes exactly one model-visible budget field. The default representation remains the historical raw scalar:

```text
context_remaining: 190000
```

A hidden representation control can instead show the same budget normalized against the current proactive-compaction threshold:

```text
context_remaining: 190000 / 800000 (23.8%)
```

No search budget, browse budget, pressure label, or second model-visible budget field is added. Optional prompt modes can explain the field, guide planning, or opt into an internal relative-pressure policy. Adaptive mode also detects sudden or sustained budget consumption before the low-budget cutoffs. None of these changes the budget calculation or Harness compaction policy.

## Compatibility

Version 0.4.0 supports the latest DeepSeek Harness release candidate,
`dsh-v0.2.1-rc.2`, while retaining support for `dsh-v0.2.0-rc.2` and
later 0.2.0 builds.

```text
DeepSeek Harness: >=0.2.0-rc.2 <0.2.1-0 || >=0.2.1-rc.2 <0.3.0-0
Node.js:          ^22.19.0 || >=24.0.0
```

The two-part range is intentional. npm's default SemVer matching would
exclude `0.2.1-rc.2` from the old `>=0.2.0-rc.2 <0.3.0` peer range.
Harness's plugin compatibility gate uses `includePrerelease: true`, however,
so the old range already admitted that RC in the gate. The new range explicitly
expresses both supported RC floors and uses `-0` upper bounds to avoid
admitting unsupported `0.2.1` prereleases before `rc.2` or `0.3.0` prereleases.
Both `engines.dsh` (preferred by DSH 0.2.1's plugin compatibility checks)
and the legacy `@deepseek-ai/dsh` peer dependency declare the same range.
Profile installations use the Harness-provided runtime; the plugin does not
bundle a second DSH copy.

The APIs used by the budget tracker and the existing `none`, `semantic`,
`planning`, and `behavioral` modes — `agent/pre-step`, the token meter,
`requestHeader()`, routed model metadata, `systemPrompt.context()`, and
`dsh-compaction-basic` pressure resolution — are available in the supported
Harness line.

`adaptive` additionally requires admission-time `systemPrompt.refreshContext()`
so its policy can be selected from the same post-compaction state as
`context_remaining`. `dsh-v0.2.1-rc.2` provides that refresh, making the
adaptive mode available on the latest RC. `dsh-v0.2.0-rc.2` does not; on
that older runtime the non-adaptive modes remain usable, but selecting
`adaptive` fails explicitly instead of using a stale policy-message fallback.

## What `context_remaining` means

`context_remaining` is **not** the distance to the model's absolute context-window limit.

It is the remaining pressure budget before `dsh-compaction-basic` would qualify the session for automatic proactive compaction:

```text
context_remaining
=
max(0, compaction_threshold_tokens - current_pressure_tokens)
```

That makes the field answer the operational question a budget-aware agent actually cares about:

> How much more context can I spend before Harness starts condensing history?

## Matching dsh-compaction-basic

For a routed context window `W`, effective request completion reservation `O`, configured headroom `B`, and pressure ratio `R`, `dsh-compaction-basic` resolves:

```text
compaction_threshold_tokens
=
floor(min(W * R, W - O - B))
```

The tracker reproduces that formula using the active compaction service's resolved pressure policy, including exact provider/model overrides.

For the routed model capacity it resolves the current model metadata through Harness, matching the capacity source used by `dsh-compaction-basic`. For the completion reservation it uses the latest durable request header and falls back to the adapter's current default when that header declares no cap.

For the pressure numerator it deliberately uses:

```js
tokenMeter.measure(session).totalTokens
```

where `tokenMeter` is resolved for the current agent. This is the same quantity `dsh-compaction-basic` compares with `thresholdTokens` during its `agent/pre-step` pressure check.

Example:

```text
contextWindow             = 1,000,000
thresholdRatio            = 0.8
reservedCompletionTokens  =    32,768
headroomTokens            =    65,536

thresholdTokens           =   800,000
currentPressureTokens     =   610,000
context_remaining         =   190,000
```

## Timing semantics

The value follows the **latest durable routed provider/model**, which is also the route `dsh-compaction-basic` evaluates at the next `agent/pre-step` pressure check.

On DSH Web, presets that enable compaction (including the shipped `standard`, `ptc`, and `cordis` presets) mount it inside an isolated scope rather than as a host-global service. The tracker is installed once at the host level, resolves preset-owned services with `agentPresets.serviceFor(agent, ...)`, and falls back to services visible through the current agent/host context for shared capabilities such as `llm` and `tokenMeter`. This crosses the preset isolate boundary without requiring a host-global compaction service, so the tracker reads the same compaction engine that is actually driving that session.

The tracker installs a prepended `agent/pre-step` wrapper and computes only after `next()` returns. This means any downstream pruning or proactive compaction has already completed before `context_remaining` and the adaptive band are measured. A step that compacts therefore sees the **post-compaction** remaining budget, not the stale value that triggered compaction.

On Harness `dsh-v0.2.1-rc.2` (and builds with the same admission-time `systemPrompt.refreshContext()` API), adaptive guidance is contributed through `systemPrompt.context()`. Harness refreshes that registered context after pre-step, so the guidance used for request admission is derived from the same post-compaction state as the budget snapshot.

On a supported Harness runtime without admission-time refresh, non-adaptive modes continue to work normally. Selecting `adaptive` fails explicitly because using pre-step-stale runtime context would violate its same-step post-compaction semantics.

The first request of a fresh session has no prior durable route, so the plugin emits no budget. It also emits no budget when:

- no active compaction service is available for the agent;
- automatic compaction is disabled with `auto: false`;
- no routed context capacity is available;
- routed model metadata cannot be resolved;
- the resolved pressure budget is invalid.

It does not fall back to the model's absolute context-window remainder, because that would give the same field two different meanings.

## Budget representation

`budgetRepresentation` is a hidden, non-volatile control. It is independent of `promptMode` and is not exposed in the Web UI.

```yaml
config:
  budgetRepresentation: raw # or normalized
```

`raw` remains the default:

```text
context_remaining: 98694
```

`normalized` uses the current `thresholdTokens` as denominator and displays one decimal place:

```text
context_remaining: 98694 / 284819 (34.7%)
```

The exact unrounded ratio is used internally for adaptive band selection. Display rounding never feeds control decisions. Raw and normalized representations use the same static prompt for a given non-`none` `promptMode`; that prompt conditionally defines the normalized `R / B (P%)` notation without making representation itself part of the prompt treatment. `raw` preserves only the historical model-visible representation: this PR intentionally changes that shared non-`none` prompt baseline, so a raw run is not behaviorally identical to a pre-#11 default run.

`normalized` is a bundled relative-pressure treatment: it exposes the denominator, relative fraction/percentage, and a longer redundant representation together. A comparative improvement therefore supports the broader claim that explicit relative-pressure representation improves salience; it does not isolate the percentage component by itself.

Experiment observation is intentionally kept out of the runtime plugin. Comparative analysis can be performed later from complete canonical Harness session logs with external tooling rather than introducing a second plugin-owned trace format here.

## Prompt modes

The dynamic budget snapshot and prompt guidance are deliberately separate. Configure `promptMode` on the plugin row:

| Mode | Behavior |
| --- | --- |
| `semantic` | **Default.** Static system prompt explaining that `context_remaining` is the budget before proactive compaction, not the model's absolute context-window remainder. |
| `planning` | Includes the semantic explanation and asks the model to use the value as a context-pressure signal when deciding how much context to spend on the current response. |
| `behavioral` | Builds on `planning` and statically guides context-conserving behavior as the budget decreases: prioritize essentials, avoid unnecessary restatement, keep intermediate outputs compact, and prefer finishing current work over opening large new lines of work. It still defines no numeric thresholds. |
| `adaptive` | Uses the same static baseline as `planning`, then contributes pressure-specific and early burn-rate surge guidance through admission-refreshed Harness runtime context. Requires a runtime with `systemPrompt.refreshContext()`. |
| `none` | Adds no static prompt guidance, matching the pre-prompt behavior of the plugin. |

The bundled patch defaults to:

```yaml
config:
  promptMode: semantic
```

Unknown mode values fail plugin activation instead of silently selecting a policy. No mode changes the budget calculation or compaction policy, and no mode adds hard tool restrictions.

### Adaptive pressure policy

`adaptive` is intentionally opt-in. It derives an internal relative remaining value from the same post-compaction budget state:

```text
remaining_ratio = context_remaining / thresholdTokens
```

The current experimental defaults have three bands:

| Band | Default cutoff | Intended behavior |
| --- | ---: | --- |
| `ample` | `remaining_ratio > 0.25` | No extra adaptive guidance. The `planning` baseline remains active and useful exploration is allowed. |
| `conserve` | `0.10 < remaining_ratio <= 0.25` | Reduce avoidable context growth, redundant restatement, and low-value exploration; keep intermediate/tool-result handling compact. Necessary verification and exploration for correctness remain appropriate. |
| `critical` | `remaining_ratio <= 0.10` | Do only the work needed to finish the current task or reach a safe checkpoint; avoid large new workstreams and nonessential exploration; prioritize finish, verify, and report. |

The cutoffs are control-policy experiment inputs, not part of the meaning of `context_remaining`. They are deliberately hidden from the Web configuration surface and are non-volatile, so an experiment can pin them for a run without making them ordinary user-facing knobs. They can be overridden in runtime/profile configuration:

```yaml
config:
  promptMode: adaptive
  adaptivePolicy:
    conserveRatio: 0.25
    criticalRatio: 0.10
```

The plugin requires:

```text
0 < criticalRatio < conserveRatio < 1
```

Invalid ordering fails plugin activation rather than silently selecting a fallback policy.

Adaptive state is not stored as a second plugin-owned conversation protocol. The tracker keeps only the current per-agent guidance in process memory and exposes it as a Harness runtime-context contribution:

```text
budget-tracker:adaptive-guidance
```

Harness evaluates that provider again during admission refresh after pre-step. The contribution is:

- empty in `ample`;
- the conserve guidance in `conserve`;
- the critical guidance in `critical`;
- empty when adaptive mode is disabled or the current budget cannot be resolved.

The contribution is intentionally optional rather than `required`, so a scope that suppresses optional runtime context also suppresses adaptive guidance. Harness owns replacement of older runtime-context snapshots, so the plugin does not emit neutral "relaxation" messages or scan retained policy history.

The **remaining-ratio bands** have no hysteresis or cooldown. The exact current post-compaction ratio is authoritative. A compaction that moves the ratio from `critical` back to `ample` relaxes the pressure-band policy for that same model request.

### Early consumption surge guidance

Adaptive mode also watches **changes** in remaining budget from one pre-step admission to the next, rather than only its current level. The default surge policy (independent of the 25% / 10% pressure bands) triggers when either:

- **Single step:** at least 3 percentage points of the proactive-compaction threshold are consumed, and the remaining ratio is at most 80%.
- **Rolling five steps:** at least 6 percentage points are consumed over the last five step intervals, and the remaining ratio is at most 40%.

For example, a decrease from 82.5% to 77.5% triggers the single-step alert while still far above the 25% conserve cutoff. Five consecutive small steps taking the remaining ratio from 37.5% to 30.0% trigger the rolling alert even if no individual step crosses 3 points.

A surge briefly adds natural-language guidance to re-evaluate task scope, avoid low-value context growth, bound tool results, and reserve room for verification. It **does not** change tool permissions, context compaction, or the value/format of `context_remaining`. The warning is added to the existing adaptive Harness runtime context, not as another user message or numeric budget field. `critical` guidance takes precedence when the remaining ratio is already at or below 10%.

Alerts remain active for three admitted steps and cannot re-trigger until five measured steps after the previous trigger. This avoids repeating the warning on each step while still supporting sustained high-consumption sessions. The trend history is an ephemeral per-agent `WeakMap`; a route/model switch, effective threshold change, budget increase after compaction or pruning, or unavailable budget state resets its baseline. Restarting the plugin also restarts the baseline. No second persistent trace or ledger is created.

Like the base budget snapshot, surge measurement happens after downstream pre-step compaction and before model-request admission. It can guide the **next request**, but cannot interrupt an already-running generation mid-step.

The experimental thresholds are hidden, non-volatile profile/runtime config:

```yaml
config:
  promptMode: adaptive
  surgePolicy:
    stepDropRatio: 0.03
    windowDropRatio: 0.06
    stepMaxRemainingRatio: 0.80
    windowMaxRemainingRatio: 0.40
    windowSteps: 5
    cooldownSteps: 5
    activeSteps: 3
```

All ratios must be in `(0, 1]`. Step counts must be positive integers and `activeSteps <= cooldownSteps`. Invalid config fails plugin activation. These controls are not exposed in the Web UI or injected as numerical guidance; controlled experiments can override them while preserving the underlying budget semantics.

## Cache and context-growth behavior

`context_remaining` remains an independent, very small source-attributed snapshot because its numeric value changes frequently. Moving that high-frequency value into Harness's complete runtime-context snapshot would cause unrelated runtime-context text to be repeated whenever the number changes.

Adaptive guidance changes only with pressure bands or short-lived surge-alert transitions, so on refresh-capable Harness builds it is a good fit for `systemPrompt.context()`. Harness treats runtime context as cache-safe derived history and appends a changed current snapshot after retained history rather than rewriting the stable system-prompt prefix.

## Configure from the Web Plugins page

On DeepSeek Harness Web, the bundle ships a browser-side configuration page for the `budget-tracker` row. Open **Plugins**, open the installed `dsh-budget-tracker` bundle, then choose **Configure** on the `budget-tracker` row.

The page presents all five prompt modes as selectable options and writes `promptMode` through Harness Settings/config-editor. Changes therefore persist in the active profile configuration instead of being stored separately by this plugin. **Reset to inherited** removes the profile override and restores the value supplied by the lower configuration layer; with the bundled patch, that inherited value is `semantic`.

Only `promptMode` is exposed as a volatile Web-editable field. Budget representation and adaptive thresholds are hidden non-volatile controls; the budget calculation itself remains read-only and continues to derive from the active compaction policy. Selecting Adaptive requires a Harness runtime with admission-time `systemPrompt.refreshContext()`.

## Dynamic context

The budget value is added as a source-attributed snapshot context message after the pre-step chain settles. If the same retained value is already present, the plugin does not add a duplicate snapshot.

The dynamic model-visible budget snapshot remains exactly one field. Depending on the hidden representation it is either:

```text
context_remaining: <remaining_tokens>
```

or:

```text
context_remaining: <remaining_tokens> / <threshold_tokens> (<percent>%)
```

Adaptive mode does not add a second budget field such as `pressure_level`. The band name and thresholds remain model-invisible; only the selected natural-language guidance is contributed through Harness runtime context.

This plugin intentionally targets `dsh-compaction-basic` and expects the active `compaction` service to expose its resolved pressure-policy configuration.

## Install from a local checkout

From the directory containing this repository:

```sh
dsh plugin --profile <profile> add ./dsh-budget-tracker
```

Verify the composed layer:

```sh
dsh --profile <profile> --dump-config
```

## Install from GitHub

After the repository is public (or when your Git credentials allow access to the private repository):

```sh
dsh plugin --profile <profile> add github:NoneMore/dsh-budget-tracker
```

This package is plain JavaScript, has no build/prepare step.

## Test

```sh
npm test
```

## Design goal

This is inspired by the budget-awareness idea in Google's `budget-aware-agent`, but intentionally does not port its search/browse budget machinery. DeepSeek Harness already owns pressure measurement and compaction policy; this plugin surfaces the remaining pre-compaction budget and can optionally apply a small relative control policy without changing that underlying compaction behavior.

## License

MIT
