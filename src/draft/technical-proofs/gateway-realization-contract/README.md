# HoBo gateway realization POC

This draft implements HOBO-138: the M1 skeleton that realizes the M0
`gateway()` contract from `src/draft/technical-proofs/hobo-gateway-port`.

## Scope

- Apply a gateway contract to a single local provider realization.
- TLS termination metadata and request enforcement.
- Host/path routing with longest-path match.
- Weighted traffic split selection and split-flip behavior.
- Mounted vertical UI path routing and default-closed CORS.
- Provider `.with(...)` options kept scoped to the gateway.
- Health-gated serving so an unhealthy backend is never reported as healthy.

## Out of Scope

- Cross-Camp domain routing and DNS policy.
- ACME or provider-managed certificate issuance.
- Staged domain cutover orchestration.
- WAF/rate-limit engine behavior beyond provider-option pass-through.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\gateway-realization-contract test
npm.cmd test
```

Proof note: `docs/design/proofs/hobo-138-gateway-realization/README.md`.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Gateway Realization Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
