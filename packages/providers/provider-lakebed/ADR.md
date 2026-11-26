# @hobo/provider-lakebed — Architecture Evidence

The Lakebed deploy-target `CloudProvider` (HOBO-714, [ADR-0127]): the named
head-on competitor's closed Capsule PaaS mapped HONESTLY onto HoBo's agnostic
ports behind the HOBO-87 authoring contract — factory
(`createLakebedProvider`), typed `.with()` builders
(`lakebed.with.capsule/reactiveDb/files`), deliberately-narrow capability
declarations, `realize()` emitting a `lakebed-deploy` DRIVER program (not
IaC), a runtime `client()` per port, and the published Capability Manifest.

## Schema and constraints

- Protobuf records live in [`data-models/`](./data-models): equivalence
  mappings, the manifest index, declared cost facts, the secretless auth
  posture, and the driver-program record.
- CUE constraints in `data-models/provider_lakebed.cue` bound every protobuf
  message (resource classes pinned to `lakebed:*`, the driver pinned to
  `lakebed-deploy`, `staticSecrets` to `false`).
- PACT boundary evidence lives under [`contracts/`](./contracts): manifest
  publication, the secretless posture, and the driver-program emission —
  asserted against the recorded interactions in `test/realize.test.ts`.

## Parse, don't validate

`parsePublishedManifest` is the parse, don't validate boundary for the
published well-known documents; `assertDriverProgram` re-parses every emitted
driver program into a frozen derived parsed domain program (unique resources,
resolvable output references) before it leaves the package boundary in tests.
Callers receive derived parsed domain types instead of re-checking raw fields.

## Honest-partial capabilities (the point of this adapter)

Capsule compute is NOT `container`; Reactive DB is NOT `postgres`; File Store
is NOT `s3-compatible`; there is no queue or cache port at all. `require`
misses surface as `partial(missing)` verdicts so Matching's author-time
remediation (ADR-0033) names a registered provider that does satisfy the
requirement — never fabricated parity with a closed runtime.

## Driver, not IaC (ADR-0127)

A closed PaaS exposes a deploy surface, not infrastructure state, so
`realize()` emits a `hobo.driver-program/v1` document targeting the
`lakebed-deploy` driver (Plan 25 driver taxonomy) — one Capsule deploy per
deployment — instead of a fake Pulumi/Terraform program.

## Event architecture

The provider participates in the control-plane command/event loop without
holding state of its own: `registerProviderFact` facts carry its manifest
snapshot into the event store, and the catalog entry registers HELD by
default — `provider.Approved` requires an explicit second `hobo add lakebed`
(deploying to the competitor's runtime is an operator decision, HOBO-710
approval gate). Matching folds the registry materialized view and records
`match.Decided`; the ResourceActor (single-writer actor) dispatches the
driver program, and outcomes land as `resource.Provisioned` facts whose
bindings feed the runtime `client()`. Read stores rebuild from the log; a
capability-manifest snapshot is re-derivable at any time.

## Credentials

Secretless-first: the Yard broker holds the vendor relationship and mints
short-lived, deployment-scoped deploy tokens per operation (HOBO-110 model).
`staticSecrets: false` is parse-enforced — no static Lakebed token anywhere.

Anonymous Temporary / agent Environment Stations use Lakebed's password-free
`lakebed deploy` path via `provisionTemporaryEnvironmentStation` (injectable
transport; default CLI strips `LAKEBED_TOKEN`). Claim later for hosted env
sync — never permanent operator tokens on the Examples stamp path.

[ADR-0127]: ../../../docs/design/adr/07-portability-extensibility.md#adr-0127
