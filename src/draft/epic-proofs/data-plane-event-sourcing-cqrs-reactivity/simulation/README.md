# Data Plane Simulation

## Running the epic simulation

Command:

```bash
npm.cmd --prefix src\draft\epic-proofs\data-plane-event-sourcing-cqrs-reactivity run simulate
```

What this proves:

- Snapshop order writes through CQRS, appends once, and reads through replay/live equivalent projections.
- Reactor and GraphQL facade produce tenant-scoped, seq-aware read models.
- Projection sink, search/embed, and governance boundaries are mocked but contract-visible.
- Lag, snapshot divergence, poison events, revoked sessions, fan-out bursts, and crypto-shred erasure fail closed.

Mocked boundaries:

- EventStore append: in-memory command runtime.
- Projection sink: deterministic sink summaries and `data.Changed` fixture.
- Subscription gateway: push collector.
- GraphQL facade: in-memory GraphQL facade runtime.
- Search/embed: in-memory full-text/vector search and local embed fixture.
- Governance/erasure: crypto-shred log/keyring.

Contracts:

- `contracts/pacts/eventstore-append-boundary.pact.json`
- `contracts/pacts/projection-sink-boundary.pact.json`
- `contracts/pacts/subscription-gateway-boundary.pact.json`
- `contracts/pacts/graphql-facade-boundary.pact.json`
- `contracts/pacts/search-embed-boundary.pact.json`
- `contracts/pacts/governance-erasure-boundary.pact.json`
