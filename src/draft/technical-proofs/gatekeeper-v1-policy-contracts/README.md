# Gatekeeper v1 Policy + Contracts POC

Independent draft POC for HOBO-624 (S2-09).

Composes the Plan 29 deploy-point Gatekeeper from existing draft engines:

- **contracts** — `can-deploy` compatibility matrix (`compat.GatePassed` / `compat.GateFailed`)
- **policy** — built-in policy engine decision model (allow/deny/require-approval + obligations)
- **obligations** — `policy.ObligationCreated` → `policy.ObligationSatisfied` lifecycle
- **gatekeeper** — `hobo verify` composite decision at the Yard deploy path

Promotes decision fixtures from `src/draft/epic-proofs/contracts-policy-governance/` into a
focused vertical slice without depending on unmerged production packages.

## Acceptance (HOBO-624)

| Scenario | Proof |
|---|---|
| Seeded producer/consumer skew | `compat.GateFailed` with explainable `tenantId` skew |
| Unsafe change blocked | `policy.Decided` deny with event-sourced reason |
| Allow but require canary | `policy.ObligationCreated` for `require-canary` stays `pending` |

## Run

```bash
pnpm --prefix src/draft/technical-proofs/gatekeeper-v1-policy-contracts test
```

## Scope (out)

- Production `packages/policy/` and `packages/contracts/` packages (separate promotion slice)
- Live Yard deploy path wiring (depends on S2-04 planner merge)
- External policy-engine adapters, attestation networks, feature-flag providers

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints
- `architecture/pacts/` — PACT contract for the package boundary
- `ADR.md` — parse-don't-validate and event-architecture evidence
