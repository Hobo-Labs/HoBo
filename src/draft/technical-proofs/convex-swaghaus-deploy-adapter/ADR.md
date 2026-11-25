# ADR — Convex Swaghaus Deploy Adapter

## Context

`@hobo/provider-convex` had Management API scaffolding but no function-deploy
executor or WorkOS AuthKit gate for Examples ship of swaghaus.

The first version of this proof also asserted the executor's response shape
inline: booleans checked at the call site, a URL string passed onward untyped.
That is the failure mode "parse, don't validate" exists to remove — in the
Cloud and self-hosted lanes the deployment URL is *scraped from `convex deploy`
stdout*, so it is provider text arriving from outside the type system.

## Decision

1. Add `deployConvexApp` (injected spawn / explicit mock) and
   `requireWorkOsAuthKit` (presence-only). Secrets never enter Bindles.
2. Give the proof one parser boundary, `src/parse.ts`. The executor response,
   the ambient environment, and the impedance findings each cross it once and
   become parsed derived types (`DeployRequest`, `DeployReceipt`,
   `ShipPreflight`, `ImpedanceRecord`) over branded values. `src/ship.ts` — the
   real call path — accepts only those types.
3. Express the same invariants declaratively in
   `architecture/deploy_adapter.cue` for every message and enum in
   `architecture/deploy_adapter.proto`, including the mode/URL-family
   agreement, the `mocked` ⇔ `mode == "mock"` rule, the fail-closed credential
   rule, `block` severity belonging to `paradigm-mismatch` alone, and the
   allowed ship-phase transitions. The CUE file and the parser are a matched
   pair: changing one without the other is a bug.
4. Refuse on the preflight, not inside the executor request: a `DeployRequest`
   is only constructed for a ship that may proceed, so "credentialed or
   explicitly mocked" is true by construction rather than by inspection.
5. Document the event architecture this slice participates in without inventing
   it. The proof appends nothing and owns no stream; the README names the real
   `@hobo/cloud` families (`deployment.*`, `resource.*`, `token.*`), the
   `ResourceActor` that calls executors like this one, and the projections that
   publish the URL parsed here. A test re-reads
   `packages/cloud/src/events.ts` and fails if the README names a fact that
   catalog does not export, so the documentation cannot drift into fiction.

## Consequences

- Live Ship needs broker deploy key + WorkOS Camp secrets; CI uses `mock: true`
  or `HOBO_CONVEX_SWAGHAUS_MOCK=1`. The mock lane is marked in the parsed
  receipt (`mocked` + `mode`) and never reports a live preflight.
- A self-hosted lane can no longer claim a `convex.cloud` host, and a Cloud
  receipt must name its own deployment — both were previously unchecked.
- The proof carries no `data-models/` or `contracts/` folder: it is draft proof
  material, not a production package, so its protobuf/CUE pair lives under
  `architecture/`.

## Cascade

No epic proof or project rollup references this proof
(`src/draft/epic-proofs`, `src/draft/projects`), so this change cascades
nowhere; `pnpm run draft:cascade` is the mechanical check. When a rollup starts
consuming the parsed receipt, its ledger row and simulation must absorb the
refined types in the same diff.
