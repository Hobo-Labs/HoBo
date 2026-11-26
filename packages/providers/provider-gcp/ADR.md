# @hobo/provider-gcp — Architecture Evidence

The GCP `CloudProvider` (HOBO-713): completes the big-three full-IaaS/PaaS
default set, shipping the GCP row of the cross-cloud equivalence table
(control-plane.md) as default Resource Definitions behind the HOBO-87
authoring contract — factory (`createGcpProvider`), typed `.with()` builders
(`gcp.with.cloudRun/cloudSql/gcs/firestore/pubsub/memorystore`), capability
declarations + equivalence map, `realize()` emitting the primary-lane Pulumi
`IacProgram`, a runtime `client()` per port, and the published Capability
Manifest. Three independent hyperscaler adapters behind one negotiation shape
is the strongest evidence the equivalence-class model holds.

## Schema and constraints

- Protobuf records live in [`data-models/`](./data-models): equivalence
  mappings, the manifest index, declared cost facts, the keyless auth
  posture, and the realized IacProgram shapes.
- CUE constraints in `data-models/provider_gcp.cue` bound every protobuf
  message (resource classes pinned to `gcp:*`, prices to decimal strings,
  `staticSecrets` to `false`).
- PACT boundary evidence lives under [`contracts/`](./contracts): manifest
  publication, the keyless auth posture, and the realize emission — asserted
  against the recorded interactions in `test/realize.test.ts`.

## Parse, don't validate

`parsePublishedManifest` is the parse, don't validate boundary for the
published well-known documents: untrusted manifest JSON becomes a parsed
derived result (schema ids checked, static secrets rejected, non-empty
capabilities) or structured errors — no broad DTO checks downstream.
`assertLocalIacProgram` re-parses every emitted program into a derived parsed
domain program before it leaves the package boundary in tests.

## Keyless credentials (HOBO-110)

The auth document publishes `svid-federation` with
`gcp:WorkloadIdentityFederation` and a workload-identity-pool token audience:
the Yard broker mints an OIDC token for the SVID + scope and exchanges it at
GCP STS for a short-lived, scoped credential. `staticSecrets: false` is a
parse-enforced invariant — no service-account keys anywhere in this package.

## Event architecture

The provider participates in the control-plane command/event loop without
holding state of its own: `registerProviderFact`/`provider.Approved` facts
(the M0 registry stream) carry its manifest snapshot into the event store;
the Planner's Matching folds the registry materialized view and records
`match.Decided`; the ResourceActor (single-writer actor) dispatches the
realized IacProgram, and outputs land as `resource.Provisioned` facts whose
bindings feed the runtime `client()`. Read stores (registry catalog,
deployment view) rebuild from the log — the provider publishes documents,
never authoritative state; a capability-manifest snapshot is re-derivable at
any time.

## Cost facts

Declared, real list-price magnitudes per SKU (Cloud Run vCPU-hour, Firestore
write, GCS GB-month, Cloud SQL instance-hour, Pub/Sub GiB, Memorystore
GB-hour) with monthly free-tier facts — honest nonzero inputs for min-cost
ranking, marked `declared-provider` pending signed billing feeds.
