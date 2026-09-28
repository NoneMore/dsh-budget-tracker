# dsh-budget-tracker

A deliberately tiny budget-awareness plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

It exposes exactly one model-visible budget field:

```text
context_remaining: 742381
```

No search budget, browse budget, HIGH/MEDIUM/LOW policy, replanning, or extra guidance is added.

## How it works

The plugin reads DeepSeek Harness' `contextPressure` session projection:

- `contextWindow`: the active model route's context capacity.
- `projectedTokens`: Harness' projection of prompt-side context pressure for the next request.

It injects:

```text
context_remaining: max(0, contextWindow - projectedTokens)
```

The value is contributed through `systemPrompt.context(...)`, so Harness treats it as dynamic runtime context rather than rewriting the stable system-prompt prefix.

If Harness does not yet have both a context-window value and a provider-anchored projected-token value, the plugin emits nothing instead of inventing an estimate. In practice this means the very first request of a fresh session can have no `context_remaining`; later tool-use steps get the value once usage has been reported.

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

This is inspired by the budget-awareness idea in Google's `budget-aware-agent`, but intentionally does not port its search/browse budget machinery. DeepSeek Harness already owns context measurement and projection; this plugin only surfaces the remaining context to the model.

## License

MIT
