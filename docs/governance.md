# Project governance

This is the shared project convention for maintainers and contributors. It describes how to organize enduring architecture knowledge, important decisions, and change-specific work without imposing a mandatory delivery process. For behavior and usage of the plugin itself, see the [README](../README.md).

## Sources of truth and how to read them

- **Implementation:** Source code is the first authority for what the plugin currently does. Use [`index.js`](../index.js) for runtime behavior, [`client.js`](../client.js) for the Web configuration UI, [`cordis.patch.yml`](../cordis.patch.yml) for bundle wiring, and [`package.json`](../package.json) for package/runtime metadata. Nearby comments can explain localized decisions; they do not override the code.
- **Architecture:** [Architecture overview](architecture/overview.md) summarizes the currently implemented high-level structure, boundaries, and code locations. It may contain directional, non-prescriptive goals, clearly distinguished from implemented facts. It is a guide to understanding the system, not a detailed duplicate of code.
- **Verification and operation:** The [test suite](../test/) and Git/PR history provide evidence of implementation and verification. The README documents public usage and compatibility.
- **Reading priority depends on the question:** Start with architecture for orientation, code for actual implemented behavior, relevant Change materials for proposed work, and ADRs when decision history or rationale matters. Reading order is not an authority hierarchy. A proposed design or specification can describe intent without claiming that code already implements it.

## Architecture decisions

Use `docs/adr/` for consequential **architectural** decisions whose context, alternatives, and rationale are worth preserving. An ADR records what was decided and why; it is historical evidence, not the current architecture registry.

Once a decision is implemented, reflect its **architectural outcome** in the high-level architecture documentation without copying the decision's alternatives or rationale. A decision not yet implemented must not be represented as a current implementation fact.

When a new ADR fully or partially supersedes earlier decisions, identify the affected older ADRs and the scope of supersession **in the new ADR**. Do not add status fields or forward pointers to older ADRs. Earlier records may be archived under `docs/adr/archive/`, including after partial supersession; the architecture overview remains the entry point for currently implemented architectural outcomes.

## Change-centered work

A **Change** is a cohesive intention to change the project, not a task, pull request, pipeline phase, or parent of nested Changes. A Change can span multiple tasks or PRs; minor edits need not be assigned one.

When lasting work materials are useful, organize them under `specs/active/<change>/`. A Change has **no required files**: `design.md`, `spec.md`, `tasks.md`, and other materials are optional, depending on the work. The requester and project context determine which outputs belong in files rather than a discussion.

When work is completed, cancelled, or superseded, its Change materials can move to `specs/archive/<change>/` if preservation is useful. Archiving does not assert that the work was implemented, accepted, or still applies. Archived specifications are historical context, not a maintained catalog of current behavior.

Use existing issues and pull requests for changing execution state such as ownership, priorities, and progress. A `tasks.md` file should preserve a useful breakdown or dependency explanation, not mirror a live tracker. Git, tests, and PRs keep implementation/verification evidence.

These conventions do not require a fixed Design → Specify → Decompose → Implement sequence or automatic conversion between Change materials, ADRs, and architecture docs. Make only updates justified by the actual change; do not add project-wide synchronization sweeps, approval gates, mandatory files, or completeness audits.
