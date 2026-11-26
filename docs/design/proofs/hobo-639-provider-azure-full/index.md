# HOBO-639 Azure Full Provider Capability Manifest Proof

Executable acceptance evidence for the independent draft package at
[`src/draft/technical-proofs/s4-03-provider-azure-full-capability-manifest`](../../../../src/draft/technical-proofs/s4-03-provider-azure-full-capability-manifest/).

## Acceptance Mapping

| Requirement | Executable proof |
|---|---|
| Full S4 capability port catalog with equivalence classes and typed `.with(...)` builders. | `factory publishes full S4 capability catalog, equivalence classes, builders, and workload-identity auth` |
| `auth.json` uses workload-identity-federation for keyless brokering; static secrets rejected. | `registry ingest accepts signed manifest bundle with brokered workload-identity auth only` + `registry ingest rejects static-secret auth manifests` |
| Provider-capability conformance green for seed-mapped ports (local + camp). | `bridged provider-capability conformance passes local and camp for seed-mapped ports` |
| Extended ports (`web`, `topic`, `secret`) covered by package-local conformance. | `extended conformance covers web, topic, and secret ports without seed suites` |
| Multi-cloud-shop fixture realizes all eight ports through Pulumi-shaped nodes. | `multi-cloud-shop full fixture realizes all eight ports through Pulumi-shaped Azure nodes` |
| Azure-only `.with(...)` options surface in PortabilityReport; non-Azure options inert. | `provider-scoped .with blocks only affect Azure-resolved resources and report Azure-only features` + `non-resolved provider .with options are inert for Azure planning` |
| Registry ingest seam for S3-04 manifest discovery. | `registry ingest accepts signed manifest bundle with brokered workload-identity auth only` |

## Adversarial Mapping

| Adversarial case | Executable proof |
|---|---|
| Region missing a claimed service rejects precisely. | `adversarial availability, role mismatch, require miss, and quota exhaustion reject precisely` |
| Unsupported Azure role mappings must not silently pass. | Same test rejects `Owner` role on `orders-db`. |
| Unsatisfied `require` facts yield `deployment.PlanRejected`. | Same test rejects `global-writes` on sql. |
| Quota exhaustion mid-apply is explicit. | Same test rejects zero `service` quota with `azure-quota-throttling`. |
| Static-secret auth manifests refused at ingest. | `registry ingest rejects static-secret auth manifests` |
| Manifests without workload-identity-federation refused at ingest. | `registry ingest rejects manifests missing workload-identity-federation` |

## Local Gate

```bash
pnpm --prefix src/draft/technical-proofs/s4-03-provider-azure-full-capability-manifest test
```

## Scope Boundary

Draft POC only. Production promotion to `packages/providers/provider-azure/` waits
on S4-01 M0 acceptance record merge (HOBO-637).
