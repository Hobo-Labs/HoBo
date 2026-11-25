# ADR — S2-08 provider-cloudflare draft POC

## Parse-don't-validate

This package follows **parse, don't validate**: untrusted manifest JSON crosses exactly one
parser boundary and becomes **parsed derived types** that callers consume as validated shapes.

- `parsePublishedManifest` → `PublishedManifestParseResult` (`ManifestParseError` paths on failure)
- `publishCapabilityManifest` → canonical `PublishedManifestDocuments` (deterministic digests)
- `createProviderCloudflareDraft` → frozen draft provider handle with derived capability coverage

Each parser rejects invalid auth/cost/capability shapes at the boundary so core realize paths
accept only parsed derived types.

## Event architecture

HoBo provider registration and realize flows are **commands** that emit append-only **events**
consumed by runtime **actors**. This draft POC names the families the production provider will use:

| Concern | Command / event families | Actor | Event store | Projection | Snapshot | Read store |
|---|---|---|---|---|---|---|
| Manifest publish | `provider.ManifestPublishRequested` → `provider.ManifestPublished` | ProviderRegistryActor | Camp EventStore | CapabilityManifestRegistry view | Current manifest digest | Historical manifest versions |
| hello-bindle realize | `deployment.PlanRequested` → `deployment.Planned` / `deployment.PlanRejected` | RealizeActor | Camp EventStore | DeploymentPlan projection | Latest planned graph | Realize audit trail |
| Conformance evidence | `conformance.VerifyRequested` → `conformance.Verified` | ConformanceGateActor | Camp EventStore | ProviderConformance view | Latest report ref | Camp evidence archive |

`realizeHelloBindle` emits an `IacProgram` + optional `BuildSpec` through the
`RealizeEmissionBoundary` contract. Runtime apply/preview **events** are out of scope for this
draft POC — recorded-fixture conformance only.

## Promotion path

Promotes `src/draft/technical-proofs/provider-cloudflare-contract` and
`provider-capability-manifest-contract` into the production slot
`packages/providers/provider-cloudflare/` when S2-06 (`@hobo/iac-pulumi`) merges.
