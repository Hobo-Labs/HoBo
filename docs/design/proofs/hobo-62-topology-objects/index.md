# HOBO-62 Topology Objects Proof

This proof backs [PLAN-02](../../sdk-api.md#plan-02),
[PLAN-21](../../authoring-resources-wiring.md#plan-21),
[ADR-0011](../../adr/01-architecture-core.md#adr-0011),
[ADR-0026](../../adr/01-architecture-core.md#adr-0026), and
[ADR-0028](../../adr/01-architecture-core.md#adr-0028).

The executable POC in
[`src/draft/technical-proofs/topology-objects-contract`](../../../../src/draft/technical-proofs/topology-objects-contract)
proves the M1 first-class topology object contract.

## Acceptance Mapping

| Acceptance | Executable proof |
|---|---|
| Build `bindle -> camp -> yard -> junction` programmatically | `programmatic bindle, camp, yard, and junction compose without config files` |
| Bindle stays provider-agnostic | same test asserts no provider ids/symbols leak into the Bindle object |
| Camp id normalizes to `<env>-<provider>` and carries environment type | `camp id normalizes to env-provider form and keeps environment type` |
| Per-port resolution precedence is `bindings -> tiers -> defaultProvider` | `resolution precedence records bindings before tiers before defaultProvider` |
| Yard rejects Camps from different providers | `yard rejects camps from different providers` |
| Provider-specific options cannot appear at Bindle level | `bindle rejects provider-specific options at app scope` |
| Junction accepts one Yard and rejects zero Yards | `junction accepts one yard but rejects an empty topology` |

## Boundary

This is only the topology object contract. Planner/Matching consumption,
inferred Camp approval, cross-Camp connectivity, and secret-source config remain
out of scope for this slice.

## Verification

```sh
npm.cmd --prefix src/draft/technical-proofs/topology-objects-contract test
```
