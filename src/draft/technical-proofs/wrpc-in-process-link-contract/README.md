# HOBO-18 wRPC In-Process Link Contract

Independent POC for the M1 in-process wRPC membrane slice.

It proves a WIT-shaped import can route through a link table to a provider export with:

- encode-route-decode call flow;
- default `boundaryMode: "live"` over `transport: "in-process"`;
- `link.Established` and `link.Called` event records;
- typed `no-route` failure for absent links;
- `deadline` present on `link.Called` without implementing deadline enforcement.

Out of scope: NATS/JetStream transport, deadline enforcement, backpressure, partial/ambiguous failure taxonomy, and wire-version negotiation.

```powershell
npm.cmd --prefix src\draft\technical-proofs\wrpc-in-process-link-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Wrpc In Process Link Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
