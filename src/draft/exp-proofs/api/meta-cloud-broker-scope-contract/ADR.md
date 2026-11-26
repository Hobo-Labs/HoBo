# Meta-cloud Broker Scope Contract - Architecture Evidence

HOBO-521 is an M0 scope and acceptance proof. This package does not implement a
hosted broker runtime, Yard planner, provider adapter, admin UI, Gatekeeper
change, transport, or persistence layer. It records the architecture evidence
needed before later Meta-cloud Broker issues can design live schemas or
resolution behavior.

## Schema Sources Of Truth

- **Protobuf** - `proto/meta_cloud_broker.proto` defines the M0 broker artifact
  data shapes: `ContractManifest`, `BrokerEnvironment`, `MappingContract`,
  `BrokerCatalogSnapshot`, `ResolutionReceipt`, `ResolutionRejection`, and
  `BrokerDecisionState`.
- **CUE** - `cue/meta_cloud_broker.cue` constrains every protobuf type with the
  deterministic, customer-safe rules used by this scope proof.
- **PACT** - `contracts/pacts/meta-cloud-broker-resolution.pact.json` is the
  executable contract for the boundary between a Contract Manifest submitter and
  the hosted broker resolution authority.

## Parse, Don't Validate

Broker inputs are parsed once at the broker boundary into **derived domain
types** and are not repeatedly re-validated at every consumer call site:

- A raw manifest becomes a `ParsedContractManifest` derived type only after the
  manifest digest, requested capability set, and proof source constraints pass.
- A raw Broker Environment becomes a `ParsedBrokerEnvironment` derived type only
  after environment, approval, catalog snapshot, and version-pin constraints
  pass.
- A raw mapping answer becomes a `ParsedResolutionDecision` derived type only
  after it is known to be either a receipt or a rejection with named proof mode
  and source evidence.

Following parse, don't validate, Yard and support/debugging code consume parsed
types only. Ambiguous, stale, or proofless broker decisions are unrepresentable
past the broker boundary.

## Event Architecture

The later broker runtime is intentionally deferred, but the event boundary is
named here so follow-up issues do not invent conflicting authority models:

- **Command** - `ResolveContractManifest` is the command that asks the broker to
  resolve a parsed manifest against an approved broker environment.
- **Events** - accepted commands emit `ResolutionReceiptIssued`; refused commands
  emit `ResolutionRejectionIssued`.
- **Actor** - the meta-cloud broker actor is the single writer for a manifest
  digest plus environment digest resolution stream.
- **Event store** - receipt and rejection events append to the broker resolution
  event-store; it is the authority for receipt provenance.
- **Materialized view / projection** - a projection builds the customer-safe
  broker resolution history by manifest and environment.
- **Snapshot** - snapshots bound replay cost for environment catalog projections
  without changing issued receipt authority.
- **Read store** - the support/operator read store exposes only customer-safe
  receipt/rejection metadata and never mutable planner internals.

This evidence keeps M0 scoped to acceptance and vocabulary. Runtime signing,
transport, persistence, replay mechanics, Yard receipt consumption, admin
approval screens, and Gatekeeper policy behavior remain follow-up work gated by
the accepted M0 record.
