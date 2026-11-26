# Adversarial Scope Review

## Scope Wall

This rollup accepts Providers/IaC/Build POCs only. It does not implement Control Plane planning internals, Portability registry transport, Generation pipeline runtime internals, Networking connectivity realization, Identity token brokerage, or live provider adapters. Those are represented only as mocked service boundaries when the Providers epic consumes them.

## POC Cluster Review

| Cluster | Requirement proved | Persona / BDD | Boundary decision | Kept | Revised or discarded |
|---|---|---|---|---|---|
| Provider authoring, defaults, conformance, equivalence, manifest | A provider can be registered, selected, and rejected deterministically from signed capability facts. | Platform engineer / register provider-owned defaults | ProviderPackageRegistry, ProviderConformanceGate, EquivalenceResolverCatalog, CapabilityManifestRegistry | Package shape, defaults, capabilities, require/prefer semantics, conformance reports | No central provider enum, no live provider discovery, no unsigned manifests |
| Realize, IaC, build, driver, state, local provider | A resolved provider can emit portable deployment artifacts consumed by pluggable adapters. | Provider author / realize a Bindle resource without live providers | RealizeEmissionBoundary, IacBackendAdapter, BuildProviderAdapter, DriverTaxonomyAdapter, LocalContainerProvider | `IacProgram`, `BuildSpec`, output bindings, per-resource state, driver taxonomy | No real Pulumi/OpenTofu/Crossplane/CDKTF/Dagger/Packer/Firecracker/Vagrant execution |
| Drift, partial apply, adopt/import | Provider state drift and created-but-not-in-state failures must not pretend success. | SecOps / reject malicious and drifting provider behavior | DriftImportRefreshBoundary, PortabilityReportGate | Refresh signal, orphan sweep, adopt drift-detect-only lifecycle, rollback gating | No destructive import, no destroy without tagged orphan identity |
| Concrete provider matrix and multi-cloud shop | Provider breadth must prove the same Bindle can target multiple providers without app edits. | DevOps / run same shop Bindle on AWS and Azure | ConcreteCloudProviderMatrix, PortabilityReportGate | AWS/Azure/GCP, edge providers, self-host providers, Vercel/Fly, Kubernetes, unchanged Bindle digest | No real cloud deploy, no provider-specific option leakage |
| Generation, malicious provider, Resource Packs, execution hosts | Human and AI-generated providers can enter the ecosystem only through signed/conformant packaging. | SecOps and provider author / certify generated provider and signed pack | GenerationCertificationSandbox, ResourcePackDistribution, ExecutionHostDispatch | No-egress sandbox, bounded repair, signed Resource Pack, pinned credit-ledger dispatch | No model call, no production registry publish, no bypass of conformance |

## Drift Risks Avoided

- Copying POC code directly would create 34 parallel mini-implementations instead of one architecture harness.
- Treating provider matrix rows as real adapters would imply cloud/IaC support the repo does not have.
- Treating Resource Pack distribution as registry ownership would duplicate the Portability rollup; this reference keeps provider-side packaging only.
- Treating `generateProvider` as the generation engine would duplicate the Generation rollup; this reference keeps provider-certification inputs and outputs only.
- Treating all Done child tasks as Done for the rollup would erase the distinction between a POC and integrated epic architecture. Ledger status remains explicit.
