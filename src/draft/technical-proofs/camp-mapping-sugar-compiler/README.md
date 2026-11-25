# Camp Mapping Sugar Compiler POC

Independent POC for HOBO-82.

This package pins the compiler boundary for Camp inline mapping sugar:
`defaultProvider`, `tiers`, and `bindings` lower into ordinary Resource
Definitions before Matching runs. Matching consumes those definitions through
the existing catalog API; precedence remains only the current specificity
score, detail vector, priority, and stable id.

The POC covers:

- `defaultProvider` emits one `match: {}` definition per unique declared port
  shape.
- `tiers` emits definitions matched by service model, lowered to
  `match.resourceClass` so the current HOBO-55 specificity vector scores them.
- `bindings` emits a `resourceId`-matched definition that outranks the tier and
  default definitions for the same resource.
- Explicit platform `defineResource(...)` definitions with env/class criteria
  naturally outscore compiled `{}` defaults.
- Missing binding targets, absent tier service models, and case-folded tier
  collisions fail before ambiguous definitions reach the catalog.

## Proof Boundaries

This proof does not implement provider-shipped defaults, provider `.register()`
equivalence, Matching/scoring changes, Resource Pack imports, region/colocation,
capability negotiation, or planner execution. It only proves the author-time
lowering into the already documented Resource Definition catalog surface.

## Executable Checks

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\camp-mapping-sugar-compiler test
```

The acceptance and adversarial checks live in
`src/draft/technical-proofs/camp-mapping-sugar-compiler/test/camp-mapping-sugar-compiler.test.ts`.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Camp Mapping Sugar Compiler.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
