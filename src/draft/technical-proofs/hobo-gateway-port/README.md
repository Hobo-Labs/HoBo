# HoBo gateway port POC

This draft implements HOBO-105: the M0 contract for the `gateway()` capability.
It is isolated from the future product monorepo and uses only Node's built-in
test runner.

## Scope

- Gateway contract builder with TLS termination metadata.
- Host/path routing with longest-path match.
- `web()` and `service()` binding targets.
- Weighted traffic-split representation with validation that weights total 100.
- Provider-scoped `.with(...)` options for WAF, rate limit, and DDoS settings.
- `.mount(...)` vertical UI declaration that derives CORS origins from mounted
  UIs.
- Default-closed CORS when no vertical origins are declared.

## Out of Scope

- Domain-level cross-Camp DNS routing.
- Certificate provisioning or ACME/provider-managed cert adapters.
- Concrete cloud gateway provider adapters.
- Rate-limit/quota enforcement engines.

## Verification

```powershell
node --test .\src\draft\technical-proofs\hobo-gateway-port\test\gateway-contract.test.ts
npm.cmd test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Hobo Gateway Port.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
