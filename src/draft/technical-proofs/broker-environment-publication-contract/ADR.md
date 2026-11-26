# Broker Environment Publication Architecture Evidence

HOBO-526 is a publication-boundary proof, not a hosted broker runtime, provider adapter,
marketplace publishing UX, Yard planner, or live catalog-sync implementation.

## Contract Evidence

- **TypeScript** - `src/broker-environment-publication.ts` exposes the public parser and immutable
  snapshot construction surface.
- **Protobuf** - `architecture/broker_environment_publication.proto` defines provider capability,
  catalog, mapping, approval, provenance, and snapshot records.
- **CUE** - `architecture/broker_environment_publication.cue` constrains every protobuf type with
  digest, approval, version, and fail-closed requirements.
- **PACT** - `architecture/pacts/broker_environment_publication.pact.json` records accepted and
  rejected publication interactions between provider/catalog publishers and the broker snapshot
  boundary.

## Parse, Don't Validate

Raw provider, catalog, mapping, approval, and provenance input crosses one parser boundary through
`publishBrokerEnvironmentSnapshot(...)`. Once parsed, it becomes a
`ParsedBrokerEnvironmentPublication` that can produce only a frozen Broker Environment snapshot or
structured fail-closed errors. Downstream resolution proof accepts the immutable snapshot, not raw
DTOs plus repeated boolean checks.

## Event Architecture

- **Command** - `PublishBrokerEnvironmentSnapshot` asks the broker boundary to parse an approved
  provider/catalog/mapping publication.
- **Actor** - the broker environment actor is the single writer for snapshot identities.
- **Events** - `brokerEnvironment.PublicationAccepted`, `brokerEnvironment.PublicationRejected`,
  and `brokerEnvironment.ShadowUpdateRejected` append to the event store.
- **Snapshot** - a Broker Environment snapshot is content-addressed and immutable.
- **Projection** - broker environment read models project accepted snapshots by version, provider,
  and catalog digest.
- **Read store** - support and resolution flows read current and historical snapshots from the read
  store without mutating issued snapshots.

Provider defaults remain `broker-validation-input` records. Final Yard deployment decisions are
issued later through Resolution Receipts or Resolution Rejections, not by this snapshot.
