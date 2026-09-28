# dsh-budget-tracker

A deliberately tiny budget-awareness plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

It exposes exactly one model-visible budget field:

```text
context_remaining: 190000
```

No search budget, browse budget, HIGH/MEDIUM/LOW policy, replanning, or extra guidance is added.

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

The tracker reproduces that formula using the active compaction service's resolved policy, including exact provider/model overrides.

For the current pressure numerator it deliberately uses:

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

The value follows the **latest durable routed request**, which is also what `dsh-compaction-basic` evaluates at the next `agent/pre-step` pressure check.

The first request of a fresh session has no prior durable route, so the plugin emits nothing. It also emits nothing when:

- automatic compaction is disabled with `auto: false`;
- no routed context capacity is available;
- the durable request header and request context disagree;
- the resolved pressure budget is invalid.

It does not fall back to the model's absolute context-window remainder, because that would give the same field two different meanings.

## Dynamic context

The value is contributed through `systemPrompt.context(...)`, so Harness treats it as dynamic runtime context rather than rewriting the stable system-prompt prefix.

The model-visible text remains exactly one field:

```text
context_remaining: <tokens>
```

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
dsh plugin --profile <profile> add github:<owner>/dsh-budget-tracker
```

This package is plain JavaScript and has no build/prepare step.

## Test

```sh
npm test
```

## Design goal

This is inspired by the budget-awareness idea in Google's `budget-aware-agent`, but intentionally does not port its search/browse budget machinery. DeepSeek Harness already owns pressure measurement and compaction policy; this plugin only surfaces the remaining pre-compaction budget to the model.

## License

MIT
