# Connectivity Policy Enforcement Contract POC

Independent proof for HOBO-210.

This package pins the seam where connectivity tier selection and runtime read-stream routing consume
policy decisions without implementing the policy engine itself.

References:

- `docs/design/security-networking.md#plan-12` for connectivity tiers, service-to-service identity,
  and residency-sensitive networking.
- `docs/design/contracts-policy-flags.md#plan-29` for the policy decision model and deny-ceilings.
- `docs/design/adr/02-identity-security.md#adr-0060` for data governance and residency obligations.
- `docs/design/adr/02-identity-security.md#adr-0074` for mandatory policy-rule ceilings.

The proof covers:

- A prod no-public mandatory ceiling blocks a public tier at can-deploy.
- A prod no-external-egress mandatory ceiling blocks cross-Yard connectivity at can-deploy.
- `.with(...)` cannot widen a connectivity edge beyond the prod ceiling.
- Alternate public-tier names such as `tier-5`, `public-endpoint`, and `internet-mtls` normalize to
  tier 5 before policy checks, so aliasing cannot bypass the ceiling.
- A residency-tagged cross-Camp read stream is re-gated at runtime and can be pinned to an allowed
  region when the consumed policy decision carries a region-pin obligation.
- A denied runtime residency decision blocks the read stream.
- A topology sequence change makes a prior runtime allow stale and requires a fresh policy decision
  instead of grandfathering the route.

Scope boundary:

- This POC does not author policy packs or the mandatory-rule algebra; it consumes a
  `policy.Decided`-shaped decision and its constraints/evidence.
- This POC does not choose the replication topology; it gates the resulting runtime read-stream route.
- This POC does not provision tiers or implement provider/Yard control planes.

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\connectivity-policy-enforcement-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Connectivity Policy Enforcement Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
