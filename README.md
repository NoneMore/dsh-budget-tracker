# dsh-budget-tracker

A deliberately tiny budget-awareness plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

It exposes exactly one model-visible budget field:

```text
context_remaining: 190000
```

No search budget, browse budget, or second model-visible pressure field is added. Optional prompt modes can explain the field, guide planning, or opt into an internal relative-pressure policy. None of them changes the budget calculation or Harness compaction policy.

## Compatibility

Version 0.3.0 targets DeepSeek Harness 0.2.x starting with
`dsh-v0.2.0-rc.2`.

```text
DeepSeek Harness: >=0.2.0-rc.2 <0.3.0
Node.js:          ^22.19.0 || >=24.0.0
```

The package declares `@deepseek-ai/dsh` as a peer dependency so Harness 0.2's
plugin compatibility gate can reject an incompatible runtime before activation.
Profile installations use the Harness-provided runtime; the plugin does not
bundle a second DSH copy.

The APIs this plugin relies on — `agent/pre-step`, the token meter,
`requestHeader()`, routed model metadata, `systemPrompt.context()`, and
`dsh-compaction-basic` pressure resolution — are available in the supported
Harness line. Admission-time runtime-context refresh is newer than
`dsh-v0.2.0-rc.2`, so the plugin detects that capability at runtime and keeps a
compatibility fallback for rc.2.

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

On Harness builds that expose admission-time `systemPrompt.refreshContext()`, adaptive guidance is contributed through `systemPrompt.context()`. Harness refreshes that registered context after pre-step, so the guidance used for request admission is derived from the same post-compaction state as the budget snapshot.

`dsh-v0.2.0-rc.2` already has `systemPrompt.context()`, but assembles runtime context before `agent/pre-step` and cannot refresh it during admission. On that runtime the plugin deliberately does **not** register the adaptive context provider; it falls back to the sparse source-attributed policy snapshots used by the original adaptive implementation so the same-step post-compaction semantics remain correct.

The first request of a fresh session has no prior durable route, so the plugin emits no budget. It also emits no budget when:

- no active compaction service is available for the agent;
- automatic compaction is disabled with `auto: false`;
- no routed context capacity is available;
- routed model metadata cannot be resolved;
- the resolved pressure budget is invalid.

It does not fall back to the model's absolute context-window remainder, because that would give the same field two different meanings.

## Prompt modes

The dynamic budget snapshot and prompt guidance are deliberately separate. Configure `promptMode` on the plugin row:

| Mode | Behavior |
| --- | --- |
| `semantic` | **Default.** Static system prompt explaining that `context_remaining` is the budget before proactive compaction, not the model's absolute context-window remainder. |
| `planning` | Includes the semantic explanation and asks the model to use the value as a context-pressure signal when deciding how much context to spend on the current response. |
| `behavioral` | Builds on `planning` and statically guides context-conserving behavior as the budget decreases: prioritize essentials, avoid unnecessary restatement, keep intermediate outputs compact, and prefer finishing current work over opening large new lines of work. It still defines no numeric thresholds. |
| `adaptive` | Uses the same static baseline as `planning`, then contributes pressure-specific guidance through Harness runtime context. |
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

On refresh-capable Harness builds, adaptive state is not stored as a second plugin-owned conversation protocol. The tracker keeps only the current per-agent guidance in process memory and exposes it as a required Harness runtime-context contribution:

```text
budget-tracker:adaptive-guidance
```

Harness evaluates that provider again during admission refresh after pre-step. The contribution is:

- empty in `ample`;
- the conserve guidance in `conserve`;
- the critical guidance in `critical`;
- empty when adaptive mode is disabled or the current budget cannot be resolved.

Harness owns replacement of older runtime-context snapshots on this path, so the plugin does not emit neutral "relaxation" messages or scan retained policy history.

For `dsh-v0.2.0-rc.2`, where admission refresh is unavailable, the plugin keeps a narrowly isolated compatibility path using the legacy `dsh-budget-tracker-policy` snapshot stream. That fallback emits only on policy transitions, uses a neutral relaxation snapshot to supersede a retained restrictive policy, and is skipped entirely once native admission refresh is available. If a session upgrades from the fallback path to a refresh-capable Harness, the plugin emits one neutral legacy snapshot to clear any retained old restriction before relying on native runtime context.

There is no hysteresis or cooldown on either path. The exact current post-compaction ratio is authoritative. A compaction that moves the ratio from `critical` back to `ample` relaxes policy for that same model request.

## Cache and context-growth behavior

`context_remaining` remains an independent, very small source-attributed snapshot because its numeric value changes frequently. Moving that high-frequency value into Harness's complete runtime-context snapshot would cause unrelated runtime-context text to be repeated whenever the number changes.

Adaptive policy is different: it changes only when the resolved band changes, so on refresh-capable Harness builds it is a good fit for `systemPrompt.context()`. Harness treats runtime context as cache-safe derived history and appends a changed current snapshot after retained history rather than rewriting the stable system-prompt prefix.

On rc.2 the compatibility fallback retains the original sparse policy-message cache shape. This keeps the high-frequency budget update cheap on all supported runtimes while using native runtime context wherever Harness can refresh it from post-compaction state.

## Configure from the Web Plugins page

On DeepSeek Harness Web, the bundle ships a browser-side configuration page for the `budget-tracker` row. Open **Plugins**, open the installed `dsh-budget-tracker` bundle, then choose **Configure** on the `budget-tracker` row.

The page presents all five prompt modes as selectable options and writes `promptMode` through Harness Settings/config-editor. Changes therefore persist in the active profile configuration instead of being stored separately by this plugin. **Reset to inherited** removes the profile override and restores the value supplied by the lower configuration layer; with the bundled patch, that inherited value is `semantic`.

Only `promptMode` is exposed as a volatile Web-editable field. Adaptive thresholds are hidden non-volatile experiment controls; the budget calculation itself remains read-only and continues to derive from the active compaction policy.

## Dynamic context

The budget value is added as a source-attributed snapshot context message after the pre-step chain settles. If the same retained value is already present, the plugin does not add a duplicate snapshot.

The dynamic model-visible budget snapshot remains exactly one numeric field:

```text
context_remaining: <tokens>
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
