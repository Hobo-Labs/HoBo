# HOBO-169 Provider Hetzner Proof

Branch proof path: `src/draft/technical-proofs/provider-hetzner-contract`.

## Acceptance Mapping

| Issue acceptance | Executable proof |
|---|---|
| `provider-hetzner` passes provider-conformance for `compute`, networking, volumes, and `objectStore`. | `runHetznerProviderConformance()` checks the claimed ports and S3-compatible object-store guarantees. |
| Factory plus `.with` builders, equivalence/default definitions, `realize()`, `client()`, and `capabilityManifest`. | The factory exposes scoped builders, provider-owned default definitions with equivalence ids, Terraform/Pulumi `hcloud` realization metadata, claimed-port clients, and a capability manifest. |
| Fixture provisions a server, volume, and S3-compatible bucket. | `createHetznerFixturePlan()` plus `createHetznerRuntime().provision()` returns `hcloud-server`, `hcloud-volume`, and `hetzner-s3-compatible-bucket` outputs. |
| `database{managed,require}` rejects. | `planHetznerDatabase(... negotiation: "require")` throws a managed Postgres unavailable error. |
| `database{prefer}` degrades to container Postgres with a `PlanWarning`. | `planHetznerDatabase(... negotiation: "prefer")` returns `container-postgres` plus `HETZNER_MANAGED_POSTGRES_UNAVAILABLE`. |
| Degrade appears in the `PortabilityReport`. | The same prefer path emits `db.provider-degrade.hetzner.managed-postgres`. |

## Adversarial Coverage

| Edge case | Guard |
|---|---|
| Managed DB require must not silently degrade. | Require path throws before a resource is produced. |
| S3-compatible divergence from real S3. | Conformance fails unless API, path-style, ETag, and multipart guarantees are declared. |
| k8s substrate not ready when a workload lands. | `realize()` rejects workloads whose HKE/k3s/Talos substrate is not ready. |
| vSwitch/firewall ordering. | `assertHetznerOrdering()` requires network, firewall, and volume edges before server attach. |

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\provider-hetzner-contract test
```
