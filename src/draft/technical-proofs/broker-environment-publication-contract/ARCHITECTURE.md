# Broker Environment Publication Contract - Architecture Evidence

This draft package carries the architecture-guard evidence for HOBO-526. It proves the
publication boundary that turns a provider-catalog publication into an immutable
Broker Environment snapshot, without implementing the hosted broker runtime, provider
adapters, marketplace publishing UX, Yard planner, or live catalog-sync.

## Schema And Constraints

- Protobuf data shapes live in
  [`architecture/broker_environment_publication.proto`](./architecture/broker_environment_publication.proto)
  (`ProviderCapabilityPublication`, `MappingPublication`, `BrokerEnvironmentSnapshot`).
- CUE constraints live in
  [`architecture/broker_environment_publication.cue`](./architecture/broker_environment_publication.cue).
- A Pact-style boundary fixture lives in
  [`architecture/pacts/broker_environment_publication.pact.json`](./architecture/pacts/broker_environment_publication.pact.json)
  (consumer `ProviderCatalogPublisher`, provider `MetaCloudBrokerEnvironmentSnapshot`).

## Parse, Don't Validate

Untrusted publication input is parsed once at the boundary into a derived
`ParsedBrokerEnvironmentPublication` domain type covering provider capability,
catalog, mapping, approval, provenance, and provider defaults. Downstream code receives
the parsed publication and the accepted snapshot instead of re-checking raw strings, so
an accepted snapshot is a proof-carrying, frozen input to resolution.

## Event Architecture

The accepted record maps onto an event-sourced publication flow:

- **Command** - a publish request asks the broker to admit a `ParsedBrokerEnvironmentPublication`
  into a new Broker Environment snapshot.
- **Events** - a `BrokerEnvironmentSnapshotPublished` fact is appended for an accepted publication;
  a content change without a new identity is rejected rather than mutating an existing snapshot.
- **Actor** - a broker-environment-publication actor serializes publication decisions per
  Broker Environment so snapshot identity stays deterministic.
- **event store** - accepted publication events append to the broker-environment-publication
  event store as durable evidence.
- **projection** - support, security, and resolution read models fold the event stream into
  snapshot lineage and allowed-provider-default views.
- **Snapshot** - `BrokerEnvironmentSnapshot` preserves the approved, versioned, frozen input
  state and its `snapshotId` is derived from content.
- **read store** - resolution and support surfaces query read stores, never raw publication payloads.

No runtime broker resolver, provider adapter, Yard planner, marketplace UX, or policy engine is
implemented here.
