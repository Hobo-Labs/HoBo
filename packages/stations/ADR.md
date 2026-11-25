# @hobo/stations

Production home of `station()`, StationService, Rails, and the local Station client.

See [ADR Station control-plane occupancy](../../docs/design/adr/01-architecture-core.md#adr-0131)
and package [ARCHITECTURE.md](./ARCHITECTURE.md).


## CI budget-signal bridge

CI routing needs to follow the same tenant budget transitions as Station traffic
routing. `createCiBudgetRoutingBridge()` consumes the Broker's existing
`budget.ThresholdCrossed` / `budget.Recovered` facts and updates eligible CI offer
IDs through a structural, revisioned policy-client port. Shared wire contracts
belong to `@hobo/ci`; Station takes no runtime dependency on Broker or the
GitHub Actions relay.

Each account persists per-threshold signal cycles and crossed flags with its
policy update. Replayed or older cycles produce no write. Across thresholds,
the highest active configured fraction wins; recovery restores the next active
profile or the normal profile. An empty profile pauses execution admission.
This avoids an older low-threshold delivery overriding a newer high-threshold
restriction. The relay rejects discarded or regressed ordering state.

The bridge preserves account budgets, provider evidence, usage snapshots and
active leases. It rejects foreign tenants and malformed Broker facts before
network access, and rejects unknown offer IDs before mutation. Revision
conflicts remain visible to the journal subscriber for retry. `reconcile()`
applies changed profiles to persisted state without manufacturing a signal.

Verification covers actual Broker fold output through durable CI configuration
and routing, plus Pact expectations for policy reads and compare-and-swap writes.
Running jobs retain their execution identity; eligibility changes apply to
future execution rather than moving a running runner between providers.
