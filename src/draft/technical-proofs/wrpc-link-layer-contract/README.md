# HOBO-592 wRPC Link Layer Contract

Independent draft POC for S1-03: transport-agnostic wRPC link layer combining
HOBO-18 in-process routing and HOBO-26 wire-version negotiation.

Proves:

- encode-route-decode through `WrpcTransport` seam (`in-process` adapter today)
- deny-by-default link table routing with typed `no-route`
- highest shared minor negotiation at link establishment
- below-floor / no-shared-minor `version-incompatible` rejection before provider calls
- append-only `link.Established`, `link.Called`, `link.Rejected` events
- membrane PACT verified in consumer and provider directions

Out of scope: Wasmtime host skeleton (S1-02), deadline enforcement (HOBO-24),
backpressure taxonomy (HOBO-25), NATS lattice transport (HOBO-27).

```bash
pnpm --prefix src/draft/technical-proofs/wrpc-link-layer-contract test
```

## Architecture Evidence

- `architecture/wrpc_link.proto` + `architecture/wrpc_link.cue` — protobuf-first event shapes
- `architecture/pacts/wrpc-membrane.pact.json` — membrane boundary contract
- `ADR.md` — parse-don't-validate + event architecture evidence
