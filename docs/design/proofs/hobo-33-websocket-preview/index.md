# HOBO-33 Websocket Preview WIT Proof

This proof records the branch-local contract package for the preview `wasi:websocket@0.0.1-draft` interface and stable `hobo:websocket@0.1.0` extension from [Plan 20](../../wasm-runtime-wit.md#plan-20) and [ADR-0075](../../adr/07-portability-extensibility.md#adr-0075).

Executable package:

- [`src/draft/technical-proofs/websocket-preview-wit-contract`](../../../../src/draft/technical-proofs/websocket-preview-wit-contract)

Evidence command:

```powershell
npm.cmd --prefix src/draft/technical-proofs/websocket-preview-wit-contract test
```

The package proves `jco` guest binding generation, a TypeScript guest server stub, manifest `interface@version@stability` metadata, static preview warnings, and fail-closed preview bump validation that requires an upcaster edge. It does not implement `ws.*` event sourcing, Streamer fan-out, provider runtime behavior, or a future ratification upcaster.
