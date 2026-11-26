# Adversarial Scope Review

## Accepted POC Mapping

Every accepted POC maps to the SDK & Authoring epic because it proves how app author inputs lower to `hobo:sdk` calls, `hobo.manifest/v1`, generated types, or author-time contract gates. The accepted role is reference-architecture evidence, not production package code.

## Review Decisions

| Question | Decision |
|---|---|
| Requirement proved | A single app-authoring flow can collect resources, infer least privilege, generate type surfaces, and validate manifest evidence before deploy. |
| Persona served | App developer, coding agent, platform engineer, and SDK author. |
| BDD scenario | Declare portable Bindle, catch unsafe authoring before deploy, and keep alternate front doors parity-bound. |
| Vertical slice | IfC authoring to manifest IR with local simulated proof and mocked boundaries. |
| Boundaries crossed | SDK WIT collector, manifest IR registry, coverage gate, permission gate, XAA registry, codegen workspace, local runtime, topology lowerer, DSL parser, auth contract provider, secret resolver, parity report provider. |
| PACT strategy | One focused consumer pact fixture per boundary; providers that do not exist yet are mocked and marked provider unavailable. |
| Kept implementation ideas | Deterministic manifests, narrow-only contracts, coverage fail-closed reasons, XAA least privilege, checked-in generated artifacts, local replay, canonical AST, parity lanes. |
| Discarded implementation details | POC-local helper APIs, production package naming, direct copy of test harness internals, and any cloud/provider/OAuth runtime logic. |
| Invalidated assumptions | A green lowering corpus alone is not enough for SDK parity; semantics-annex and fail-closed gates are required. |
| Edge cases | Unobserved declarations, dynamic names, scope widening, raw driver escape hatches, schema changes without version bump, hidden provider defaults, replay divergence, host imports in DSL. |
| Design conflicts | `paradigm-idiom-packages-contract` implements Data Plane package internals; this epic only records the SDK authoring opt-in marker. |
| Deferred or split | Production `@hobo/bindles`, real WIT codegen, real local runtime engine, provider realization, and live XAA brokering remain follow-ups in their owning epics. |
| Feature drift risk | Copying POC code directly would turn contract evidence into product implementation and cross the repo's design-phase boundary. |
| Simulation risk | A simulation that calls live auth registries, secret stores, providers, or cloud runtimes would be misleading; all boundaries stay fixture-backed. |
| Contract brittleness risk | Pact fixtures assert interaction shape and boundary decisions, not full business logic or UI/e2e behavior. |
| Active epic conflict | Data Plane paradigm package internals and Identity runtime token brokering stay outside this SDK reference implementation. |

## Scope-Out Items

- Live network calls, cloud deploys, provider Matching, real OAuth/ID-JAG token exchange, real secret-store reads, WIT compiler invocation, and production monorepo package code.
- Data Plane implementation of `@hobo/sql`, `@hobo/vector`, `@hobo/graph`, and `@hobo/document`.
- CLI wrapper behavior for `hobo codegen`, `hobo dev`, and `hobo up`; this epic models the SDK surfaces they consume.
