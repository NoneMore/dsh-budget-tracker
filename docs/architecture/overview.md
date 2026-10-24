# Architecture overview

This is a high-level map of the **current implementation**, not a specification for future behavior. Source code is authoritative for details; [the README](../../README.md) covers user-facing semantics, configuration, and compatibility.

## Runtime plugin

- [`index.js`](../../index.js) is the DeepSeek Harness plugin entry point. It registers optional prompt guidance and a prepended `agent/pre-step` listener. After the downstream pre-step chain has run, it resolves the agent's active compaction, routed model, and token-meter services, then computes the remaining budget before proactive compaction using the active pressure policy.
- The plugin surfaces that budget as a single `context_remaining` snapshot when the value can be resolved and has changed. Optional static guidance and, on supported Harness versions, admission-refreshed adaptive guidance are separate from the numeric snapshot. The plugin **observes** Harness compaction state rather than owning or modifying its compaction policy.
- [`cordis.patch.yml`](../../cordis.patch.yml) declares the bundled plugin configuration. [`package.json`](../../package.json) defines the package entry points, Web client integration, and supported runtime ranges.

## Web configuration

- [`client.js`](../../client.js) registers the Web Plugins configuration UI for `promptMode` through the Harness client integration. That surface changes prompt guidance; budget representation and adaptive thresholds are not exposed as ordinary Web-editable settings.

## Verification map

- [`test/`](../../test/) exercises the budget calculations, runtime integration behavior, config validation, representation, and Web configuration interactions.
- [`README.md`](../../README.md) is the place to look for the public meaning of `context_remaining` and compatibility constraints, rather than duplicating those details here.
