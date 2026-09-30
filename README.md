# dsh-budget-tracker

A deliberately tiny budget-awareness plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

It exposes exactly one model-visible budget field:

```text
context_remaining: 190000
```

No search budget, browse budget, HIGH/MEDIUM/LOW policy, replanning, or extra guidance is added.

## Compatibility

Version 0.2.3 targets DeepSeek Harness 0.2.x starting with
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
`requestHeader()`, routed model metadata, and `dsh-compaction-basic` pressure
resolution — are unchanged in `dsh-v0.2.0-rc.2` from the preceding release
candidate line, so the budget calculation itself does not need a compatibility
shim.

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
ctx.tokenMeter.measure(session).totalTokens
```

because that is the same quantity `dsh-compaction-basic` compares with `thresholdTokens` during its `agent/pre-step` pressure check.

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

On DSH Web, compaction is mounted inside each agent preset's isolated scope rather than as a host-global service. The tracker is installed once at the host level, but resolves `compaction`, `llm`, and `tokenMeter` through the current `agent.ctx` during `agent/pre-step`, so it sees the same preset-scoped compaction engine that is actually driving that session.

The tracker installs a prepended `agent/pre-step` wrapper and computes only after `next()` returns. This means any downstream pruning or proactive compaction has already completed before `context_remaining` is measured and injected into the request. A step that compacts therefore sees the **post-compaction** remaining budget, not the stale value that triggered compaction.

The first request of a fresh session has no prior durable route, so the plugin emits nothing. It also emits nothing when:

- automatic compaction is disabled with `auto: false`;
- no routed context capacity is available;
- routed model metadata cannot be resolved;
- the resolved pressure budget is invalid.

It does not fall back to the model's absolute context-window remainder, because that would give the same field two different meanings.

## Dynamic context

The value is added as a source-attributed snapshot context message after the pre-step chain settles. If the same retained value is already present, the plugin does not add a duplicate snapshot.

The model-visible text remains exactly one field:

```text
context_remaining: <tokens>
```

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

This package is plain JavaScript, has no bundled runtime dependencies, and has no build/prepare step.

## Test

```sh
npm test
```

## Design goal

This is inspired by the budget-awareness idea in Google's `budget-aware-agent`, but intentionally does not port its search/browse budget machinery. DeepSeek Harness already owns pressure measurement and compaction policy; this plugin only surfaces the remaining pre-compaction budget to the model.

## License

MIT
