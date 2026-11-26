# HOBO-82 Camp Mapping Sugar Compiler Proof

This executable proof pins the M2 camp mapping sugar compiler from
[Plan 04](../../control-plane.md#plan-04),
[Plan 25](../../platform-engineering.md#plan-25), and
[ADR-0033](../../adr/01-architecture-core.md#adr-0033).

## Contract Surface

- `defaultProvider` compiles to catch-all Resource Definitions for each declared
  resource shape.
- `tiers` compiles to service-model definitions represented through the current
  `resourceClass` matching dimension.
- `bindings` compiles to `resourceId` definitions, so existing Matching ranks a
  binding above tier/default candidates for the same resource.
- Compiled definitions register into the same Resource Definition catalog used
  by the Matching skeleton.
- Invalid sugar fails closed before the catalog can contain ambiguous compiled
  definitions.

## Proof Boundaries

This proof intentionally does not implement provider-shipped default
definitions, provider `.register()` equivalence, Matching/scoring itself,
Resource Pack imports, or Planner execution. Those remain owned by their
provider, matching, and planner slices.

## Executable Checks

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\camp-mapping-sugar-compiler test
```

The checks live in
`src/draft/technical-proofs/camp-mapping-sugar-compiler/test/camp-mapping-sugar-compiler.test.ts`.
