# Project working conventions

These are project-local conventions for organizing durable architecture knowledge and change work. They do not require a particular Agent Skill or a fixed Design → Specify → Decompose → Implement sequence.

## Sources and reading

- **Implemented behavior:** The current code is the first authority. Read `index.js` for the server-side plugin and budget logic, `client.js` for its Web configuration surface, `cordis.patch.yml` for bundle wiring, and `package.json` for package metadata and compatibility constraints. Comments and documents help explain the code but do not override it.
- **High-level orientation:** [Architecture overview](docs/architecture/overview.md) summarizes implemented structure, boundaries, and code locations. Keep it at the architectural level, not as a second copy of the implementation. Clearly distinguish any directional, non-prescriptive design goals from implemented facts.
- **User-facing detail and verification:** [README.md](README.md) explains public behavior and usage; the `test/` suite and Git/PR history provide implementation and verification evidence.
- **Read according to the question:** Start with architecture documentation for system orientation, code for actual behavior, a relevant Change context for proposed work, and ADRs only when architectural decision rationale or history matters. Reading order does not change what is authoritative: proposed specifications describe intent, while code establishes what is implemented.

## Architectural decisions

Use `docs/adr/` for consequential architectural decisions whose context, alternatives, and rationale would otherwise be costly to reconstruct. ADRs record the decision and its historical reasoning; they are not the authoritative catalog of the current implementation.

Once an architectural decision is implemented, express its **architectural outcome** in the high-level architecture documentation, without copying ADR deliberation or low-level code details. Do not describe a proposed decision as already implemented.

When a new ADR fully or partly supersedes an older one, name the affected older ADR in the **new** record and explain the affected decision. Do not add status fields or forward references to old ADRs. Older ADRs may be kept under `docs/adr/archive/` as historical material, including after partial supersession.

## Change-centered work

- A **Change** is one cohesive change intention; it may span several tasks or PRs, is not nested within another Change, and is not required for trivial edits.
- When durable, change-scoped working materials are useful, place them under `specs/active/<change>/`. Files such as `design.md`, `spec.md`, and `tasks.md` are **optional**; there is no required set or order. User instructions determine whether a requested result is written to a file or delivered in conversation.
- Move materials for changes no longer being advanced to `specs/archive/<change>/` when archival is useful. Archived material is history, not proof of implementation or a maintained statement of current requirements.
- Keep volatile execution status (owners, priorities, progress) in an existing issue/PR tracker when one is used. Use `tasks.md` only for a useful durable breakdown or dependency explanation, not a duplicate tracker.
- Neither an ADR nor an architecture update is automatically required by creating, specifying, implementing, or archiving a Change. Make only changes relevant to the authorized task; do not invent approval gates, document-sync sweeps, or completeness audits.

Establish directories through useful material rather than empty placeholders, and preserve existing policy outside the scope of an authorized change.
