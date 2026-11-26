# Providers, IaC & Build Adapters Reference Implementation

This epic reference implementation rolls the Providers, IaC, and Build Adapter POCs into one deterministic reference architecture slice. It is not production code: provider registries, cloud APIs, IaC engines, build tools, generation sandboxes, signed registries, and execution-host dispatch are mocked so the architecture can run locally without credentials, external services, or live network calls.

## Persona and BDD scenarios

```gherkin
Feature: Provider contract and conformance

  Persona: Platform engineer curating provider defaults

  Scenario: Register provider-owned defaults
    Given AWS, Azure, GCP, Cloudflare, Hetzner, Fly, Vercel, and Kubernetes providers publish manifests and defaults
    When the Yard registers them into the capability catalog
    Then every claimed port has conformance evidence and Matching can reject unsupported require clauses
```

```gherkin
Feature: Realize through IaC and build adapters

  Persona: Provider author shipping a certified adapter

  Scenario: Realize a Bindle resource without live providers
    Given a resolved ResourcePlan and mocked IaC, build, and driver boundaries
    When the provider emits IacProgram and BuildSpec fixtures
    Then the pipeline previews, applies, refreshes, and returns outputs as bindings
```

```gherkin
Feature: Provider safety and portability

  Persona: SecOps engineer containing untrusted provider code

  Scenario: Reject malicious and drifting provider behavior
    Given a forged report, undeclared egress, partial apply, and drift signal
    When the conformance, sandbox, and refresh gates evaluate the evidence
    Then the provider is denied, drift is recorded, and rollback requires orphan sweep
```

```gherkin
Feature: Multi-cloud provider gate

  Persona: DevOps engineer proving multi-cloud portability

  Scenario: Run the same shop Bindle on AWS and Azure
    Given one unchanged Bindle source and provider-specific mappings
    When the multi-cloud shop gate compares topology, bindings, and portability reports
    Then equivalent targets pass and unsatisfied require or option leaks fail
```

## Vertical slices

| Slice | POCs | Reference location | Notes |
|---|---|---|---|
| Provider contract and conformance catalog | HOBO-87, HOBO-93, HOBO-102, HOBO-108, HOBO-120 | `services/providers-reference-architecture.ts`, `contracts/pacts/provider-*.json` | Provider-owned defaults, capability negotiation, manifest facts, and conformance evidence. |
| Realize, IaC, build, and driver adapters | HOBO-112, HOBO-114, HOBO-131, HOBO-135, HOBO-139, HOBO-145, HOBO-149, HOBO-186, HOBO-188, HOBO-191, HOBO-195, HOBO-199, HOBO-202, HOBO-214, HOBO-217, HOBO-225 | `services/`, `simulation/fixtures/`, `contracts/pacts/*adapter*.json` | Mocked `IacProgram`, `BuildSpec`, per-resource state, import/adopt, drift, partial apply, and driver taxonomy. |
| Concrete provider matrix and portability gate | HOBO-153, HOBO-157, HOBO-161, HOBO-165, HOBO-169, HOBO-174, HOBO-178, HOBO-182, HOBO-231 | `services/`, `contracts/pacts/concrete-cloud-provider-matrix.pact.json` | AWS/Azure/GCP, edge, self-host, global VM, Kubernetes, and multi-cloud shop evidence. |
| Generated and distributed provider trust | HOBO-207, HOBO-211, HOBO-221, HOBO-228 | `services/`, `contracts/pacts/generation-certification-sandbox.pact.json`, `contracts/pacts/resource-pack-distribution.pact.json` | No-egress generation, bounded repair, malicious-provider containment, signed Resource Packs. |

## Service boundaries

All boundaries are consumer-tested with Pact-format fixtures and mocked in simulation:

- ProviderPackageRegistry
- ProviderConformanceGate
- EquivalenceResolverCatalog
- CapabilityManifestRegistry
- RealizeEmissionBoundary
- PortabilityReportGate
- IacBackendAdapter
- BuildProviderAdapter
- LocalContainerProvider
- ConcreteCloudProviderMatrix
- DriverTaxonomyAdapter
- DriftImportRefreshBoundary
- GenerationCertificationSandbox
- ResourcePackDistribution
- ExecutionHostDispatch

## Running the epic simulation

Command:

```bash
npm.cmd --prefix src/draft/epic-proofs/providers-iac-build-adapters run simulate
```

What this proves:

- Provider packages register default Resource Definitions with conformance evidence.
- `realize()` emits mocked `IacProgram` and `BuildSpec` objects consumed by mocked IaC/build/driver adapters.
- Drift, partial apply, and malicious-provider paths fail closed.
- The validated Crossplane backend proof is included in this rollup; its simulation contract is unchanged.
- The validated generateProvider loop proof is included in this rollup; its simulation and Pact evidence are unchanged.
- The latest generateProvider loop validation is absorbed; its simulation and Pact evidence remain unchanged.
- Crossplane and Pulumi backend changes are absorbed without changing preview, apply, refresh, or controller-driven behavior.
- The same multi-cloud shop Bindle remains unchanged across AWS and Azure fixtures.

Mocked boundaries:

- Provider registry, conformance gate, equivalence catalog, manifest registry, IaC adapters, build adapters, driver taxonomy, drift/import refresh, generation sandbox, resource-pack distribution, and execution-host dispatch.

Contracts:

- `contracts/pact-inventory.md`
- `contracts/pacts/*.pact.json`

## Scope control

Kept:

- Provider package shape, provider-owned default definitions, capability manifests, conformance gating, `realize()` emission, IaC/build/driver adapter seams, provider matrix, generation certification, Resource Pack distribution, drift/import/partial-apply safety, and multi-cloud shop gate shape.

Revised:

- Live provider and IaC operations are represented as mocked Pact boundaries, not production adapters.
- Distribution is represented as provider-side Resource Pack packaging, while the Portability rollup remains the broader registry/distribution owner.
- Generation is represented as provider-certification input/output, while the Generation Pipeline rollup remains the broader generation-engine owner.

Deferred:

- Real cloud APIs, real Pulumi/OpenTofu/Crossplane/CDKTF runs, real Dagger/Packer/Firecracker/Vagrant builds, production provider package publication, provider-side Pact verification, hosted registry transport, live model calls, and real executor dispatch.


Fly and Vercel provider changes are absorbed without changing preview, apply, refresh, or controller-driven behavior.

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Providers Iac Build Adapters.
- `architecture/pacts/` — PACT contract for the package boundary.
- `architecture.md` — parse-don't-validate and event-architecture evidence.
