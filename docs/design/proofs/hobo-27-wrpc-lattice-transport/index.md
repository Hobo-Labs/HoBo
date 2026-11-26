# HOBO-27 wRPC Lattice Transport Proof

This proof backs [PLAN-20](../../wasm-runtime-wit.md#plan-20),
[ADR-0031](../../adr/01-architecture-core.md#adr-0031), and
[ADR-0069](../../adr/01-architecture-core.md#adr-0069).

The branch adds `src/draft/technical-proofs/wrpc-lattice-transport-contract`, an independent POC for the M3
NATS/JetStream lattice transport slice. It keeps the WIT contract stable while changing only the
transport/link-resolution path.

Acceptance evidence:

- `invokes the same WIT component through co-located and second-host providers with identical behavior`
- `meshes two wasmCloud hosts over NATS/JetStream and resolves a cross-host link`
- `resolves same-host cross-process links through the lattice transport`
- `classifies a NATS partition severing a mid-stream call as partial failure`
- `maps JetStream flow-control mismatch to bounded membrane backpressure`
- `publishes HOBO-27 conformance scope and declares host timing non-covered`

Scope boundary:

- Included: NATS/JetStream wRPC transport behind the call abstraction, co-located, cross-process,
  and cross-host link resolution through the same WIT contract, late-bound link table entries
  carried over the lattice, and JetStream flow-control mapped to membrane backpressure.
- Excluded: `wasmcloud-operator` or Kubernetes packaging, lattice link-migration `host-.with()`,
  provider-native adapters, and SpinKube adapters.
- Non-covered divergences are explicit: host-specific partial-failure timing and wall-clock
  scheduling jitter across hosts.

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\wrpc-lattice-transport-contract test
```
