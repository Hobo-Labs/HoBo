# HOBO-26 Wire-Version Negotiation Contract

This independent POC pins the HOBO-26 membrane rule: link establishment negotiates
the highest shared WIT/wRPC minor at or above the declared compatibility floor. If
the caller/provider pair has no shared minor, or only shares a minor below the
floor, the link is rejected with a typed `version-incompatible` error before any
provider call can run.

## Scope

- Included: in-process link-establishment negotiation, below-floor rejection,
  `link.Established`/`link.Rejected` evidence, and manifest-IR recording of the
  negotiated wire minor.
- Excluded: floor policy selection, preview/experimental upcasters,
  NATS/JetStream transport details, deadlines, backpressure, and
  partial-failure handling.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\wire-version-negotiation-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Wire Version Negotiation Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
