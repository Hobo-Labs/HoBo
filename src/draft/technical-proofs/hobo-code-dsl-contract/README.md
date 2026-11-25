# Hobo Code DSL Contract POC

Independent POC for HOBO-394: a small Hobo Code front-end that parses an L1
declarative source, lowers it to the same `hobo.manifest/v1` IR as an
equivalent TypeScript Bindle, emits L2 SDK stubs through the checked-in
`_generated/` discipline, and provides a deterministic formatter.

## Requirements Source

- `docs/design/authoring-resources-wiring.md#plan-21`: Hobo Code DSL,
  two-level authoring, stable canonical AST, no host imports or collection-time
  side effects.
- `docs/design/adr/01-architecture-core.md#adr-0049`: Hobo Code is the
  configuration + code DSL and adds no runtime semantics beyond the shared IR.
- `docs/design/adr/01-architecture-core.md#adr-0037`: codegen emits checked-in
  `_generated/` artifacts and `codegen --check` fails on drift.
- `docs/design/sdk-api.md#plan-02`: typed bindings and generated code are the
  authoring contract for resource bindings, steps, and workflows.

## What This Proves

- L1 source declares Yard/Camp/Bindle plus resources, `.allow()`, `bind`, steps,
  and workflows, then lowers to `hobo.manifest/v1`.
- The same fixture lowered through an equivalent TypeScript Bindle produces
  byte-identical manifest IR and the same content hash.
- L2 generated stubs pre-wire `.allow()` and the `bind` graph, and the local
  `codegen --check` command reports drift without mutating stale files.
- The canonical formatter is idempotent and produces stable declaration order.
- Declaration-time side effects and host imports fail closed during parse.
- A pure L1 no-code stack validates as deployable without body stubs.

## Scope Boundary

This does not build the production DSL grammar, TS-to-Hobo-Code transpiler, LSP,
training-engine mutation surface, or provider/runtime implementation. It is the
branch-sized contract proof for the DSL parser/lowerer/codegen seam.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\hobo-code-dsl-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Hobo Code Dsl Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
