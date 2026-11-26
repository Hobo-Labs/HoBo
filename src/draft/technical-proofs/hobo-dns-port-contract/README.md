# HoBo DNS port contract POC

Independent POC for HOBO-101. It pins the M0 `hobo:dns` capability contract
used by custom-domain routing before certification, validation, or concrete
provider adapters are built.

## Scope

- WIT-style `hobo:dns` record upsert/read/delete surface.
- Pre-validation port that exposes only shadow-zone operations.
- Routing policies for failover, weighted, latency, geo, and cost routing.
- In-memory adapter for conformance and fixture tests.
- Domain routing events for shadow writes.
- Conformance guard that fails adapters mutating the live zone during a shadow
  write.

## Out of Scope

- ACME or provider-managed certificate issuance.
- The DNS/custom-domain validation gate orchestration.
- Concrete cloud DNS provider adapters.
- Live-zone promotion after validation.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\hobo-dns-port-contract test
npm.cmd test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Hobo Dns Port Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
