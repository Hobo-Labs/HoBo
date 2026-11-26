# @hobo/provider-aws — Architecture Evidence

The AWS `CloudProvider` (HOBO-711): the first heavyweight full-IaaS/PaaS
default provider, shipping the AWS row of the cross-cloud equivalence table
(control-plane.md) as default Resource Definitions behind the HOBO-87
authoring contract — factory (`createAwsProvider`), typed `.with()` builders
(`aws.with.fargate/rds/s3/dynamodb/sqs/elasticache`), capability declarations
+ equivalence map, `realize()` emitting the primary-lane Pulumi `IacProgram`,
a runtime `client()` per port, and the published Capability Manifest.

## Schema and constraints

- Protobuf records live in [`data-models/`](./data-models): equivalence
  mappings, the manifest index, declared cost facts, the keyless auth
  posture, and the realized IacProgram shapes.
- CUE constraints in `data-models/provider_aws.cue` bound every protobuf
  message (resource classes pinned to `aws:*`, prices to decimal strings,
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
`sts:AssumeRoleWithWebIdentity` and `tokenAudience: sts.amazonaws.com`:
the Yard broker mints an OIDC token for the SVID + scope and exchanges it at
AWS STS for a short-lived, resource-scoped credential. `staticSecrets: false`
is a parse-enforced invariant — no long-lived keys anywhere in this package.

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

Declared, real list-price magnitudes per SKU (Fargate vCPU-hour, DynamoDB
write-request, S3 GB-month, RDS instance-hour, SQS request, ElastiCache
node-hour) with monthly free-tier facts — honest nonzero inputs for min-cost
ranking, marked `declared-provider` pending signed billing feeds.
