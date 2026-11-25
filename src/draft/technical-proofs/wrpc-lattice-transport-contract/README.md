# HOBO-27 wRPC Lattice Transport Contract

Independent POC for the NATS/JetStream lattice transport behind the HoBo wRPC membrane.

It proves:

- the same WIT import can be late-bound from an in-process provider to a second-host provider without changing observable behavior;
- two wasmCloud-style hosts mesh over a NATS/JetStream subject and resolve a cross-host link;
- a same-host, different-process provider resolves through the lattice transport instead of the in-process path;
- a mid-stream NATS partition reuses the existing membrane `partial-failure` classifier;
- JetStream flow-control pressure maps to bounded membrane backpressure instead of unbounded queuing.

Out of scope: wasmCloud operator or Kubernetes packaging, lattice link-migration `host-.with()`, provider-native adapters, and SpinKube adapters.

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\wrpc-lattice-transport-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Wrpc Lattice Transport Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
