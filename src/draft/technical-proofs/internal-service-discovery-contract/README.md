# Internal Service Discovery Contract

Independent POC for HOBO-206. It models the internal naming half of Plan 12:
per-Camp logical names, endpoint refs, and identity-based discovery over SVID
mTLS rather than DNS round-robin.

## Proven

- `shop.api` resolves to a stable app-facing binding without exposing provider
  hostnames or IP addresses to app code.
- Cross-provider peer discovery uses the workload SVID identity layer and the
  HOBO-117 mTLS data-path evaluator.
- Provider endpoint address changes update the runtime endpoint while the
  app-facing binding remains byte-stable.
- Unknown logical names fail closed.
- Public DNS records are not used as a fallback when identity discovery cannot
  authenticate a peer.

## Boundaries

This proof consumes the HOBO-101 `hobo:dns` naming contract and the HOBO-117
mTLS data-path contract. It does not implement custom domains, public ingress,
DNS validation gates, SVID issuance, or provider-specific DNS APIs.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\internal-service-discovery-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Internal Service Discovery Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
