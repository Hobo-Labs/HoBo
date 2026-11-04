# Connectivity tier IR contract POC

Independent proof for HOBO-89.

This package pins the M0 connectivity-tier contract from:

- `docs/design/security-networking.md`: logical connectivity from `bind` and the five planner-selected data-plane tiers.
- `docs/design/adr/02-identity-security.md#adr-0023`: zero-trust posture, every hop authenticated and authorized by workload identity.

The proof covers:

- `ConnectivityTier` values 1-5 and versioned `ConnectivityPlan` shape.
- JSON round-trip serialization for each tier.
- Golden `bind` edge decisions for tier 1 through tier 5.
- Fail-closed unknown or unsupported tier validation.
- Fail-closed no-resolvable-tier behavior: no silent public fallback.
- Policy-bound `.with(...)` override rejection when an override widens beyond the configured ceiling.
- Type-consumer coverage imports the package export so public `.d.mts` declarations, not private
  implementation inference, define the API/SDK surface.

Scope boundary: this POC does not provision any tier, perform Junction inference, implement Planner objective ranking, or realize provider networking. It only defines and validates the IR that those later slices consume.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Connectivity Tier Ir Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.

## Gates

- `pnpm --filter @hobo/draft-connectivity-tier-ir-contract run test` checks validation, tier decisions, and policy-widening rejection.
- `pnpm --filter @hobo/draft-connectivity-tier-ir-contract run typecheck` checks the public declaration consumer with both typed plans and untrusted JSON input.
- Root `pnpm run typecheck` explicitly includes this proof alongside `./packages/*`; `test/root-script-pins.test.ts` pins that filter so the declaration boundary cannot silently leave the main typecheck scope.
- `pnpm run draft:artifacts -- src/draft/technical-proofs/connectivity-tier-ir-contract` executes the identity example and validates the bench declaration; `pnpm --filter @hobo/draft-connectivity-tier-ir-contract exec vitest bench --root .` executes the benchmark. `pnpm run draft:cascade` checks the networking epic rollup.
