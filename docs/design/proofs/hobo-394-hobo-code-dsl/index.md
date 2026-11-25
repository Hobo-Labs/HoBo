# HOBO-394 Hobo Code DSL Proof

This proof pins the Hobo Code DSL front-end from
[Plan 21](../../authoring-resources-wiring.md#plan-21), the generated-code
discipline from [ADR-0037](../../adr/01-architecture-core.md#adr-0037), and the
two-level Hobo Code decision from
[ADR-0049](../../adr/01-architecture-core.md#adr-0049).

Executable proof:

- package: `src/draft/technical-proofs/hobo-code-dsl-contract`
- test command: `npm.cmd --prefix src\draft\technical-proofs\hobo-code-dsl-contract test`

Acceptance coverage:

- L1 Hobo Code parses Yard/Camp/Bindle/resources/allow/bind declarations and
  lowers to byte-identical `hobo.manifest/v1` IR as an equivalent TypeScript
  Bindle.
- L2 stub generation emits checked-in `_generated/` artifacts with `.allow()`
  pre-wired and the bind graph stitched; `codegen --check` fails on drift
  without rewriting stale files.
- The canonical formatter is idempotent and produces stable AST order.

Adversarial coverage:

- Hobo Code vs TypeScript manifest divergence is reported as a contract failure.
- Declaration-time side effects and host imports fail closed during parse.
- A pure L1 no-code stack validates as deployable with no stub body requirement.

Scope boundary:

- production grammar, LSP, TS transpiler round-trip, generation/training
  mutation, Matching, provider realization, and runtime execution are out of
  scope.
