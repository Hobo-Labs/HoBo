# @hobo-draft/usage-inferred-permissions-contract

POC for HOBO-70: usage-inferred permissions and narrow-only `.allow()` contract markers.

## Contract Surface

- `buildUsagePermissionManifest(...)` lowers observed resource calls to manifest `allow` entries.
- The same grant set is baked into manifest `links` so wasm capability binding evidence and IAM
  permission evidence stay aligned.
- By default, grants equal the observed used-set with `inferred-from-usage` provenance.
- `declaredAllow` caps grants to a narrow-or-equal `.allow(...)` set and emits a
  `capabilityContract` marker.
- `dynamicAllow` grants static-analysis-invisible verbs with `declared-dynamic` provenance.
- Narrowing below observed usage records `capability.required-not-granted` for the future
  `can-deploy` gate.
- Unmarked widening beyond observed usage fails closed with `PermissionContractError`.

## Scope Boundary

This package does not implement runtime capability enforcement, IAM generation, token-broker
scoping, static-analysis coverage, or the `can-deploy` gate. It produces the manifest evidence
those later slices consume.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\usage-inferred-permissions-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Usage Inferred Permissions Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
