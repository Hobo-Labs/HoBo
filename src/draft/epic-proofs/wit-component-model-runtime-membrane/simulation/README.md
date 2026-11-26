# WIT Runtime Membrane Simulation

## Running the epic simulation

Command:

```bash
npm.cmd --prefix src\draft\epic-proofs\wit-component-model-runtime-membrane run simulate
```

What this proves:

- runtime-local durable workflow effects;
- portable wRPC link negotiation and failure classification;
- SDK/capability parity with websocket fan-out;
- host conformance, adapter certification, and upgrade gating.

Mocked boundaries:

- WIT contract registry: deterministic fixture pins and hashes.
- Component host lifecycle: mocked host adapter.
- wRPC link transport: mocked in-process/lattice transport.
- Runtime ports: mocked EventStore, ActorHost, Queue/Clock, and Streamer.
- Capability and conformance gates: mocked decision/report providers.

Contracts:

- `contracts/pacts/wit-contract-registry.pact.json`
- `contracts/pacts/component-host-lifecycle.pact.json`
- `contracts/pacts/wrpc-link-transport.pact.json`
- `contracts/pacts/runtime-eventstore.pact.json`
- `contracts/pacts/actor-host.pact.json`
- `contracts/pacts/queue-clock.pact.json`
- `contracts/pacts/streamer-websocket.pact.json`
- `contracts/pacts/capability-grant-gate.pact.json`
- `contracts/pacts/conformance-upgrade-gate.pact.json`
