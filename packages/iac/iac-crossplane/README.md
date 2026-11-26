# @hobo/iac-crossplane

The Kubernetes-substrate `IacProvider` (HOBO-716): resources are realized as
Crossplane **CompositeResourceClaims** — reconciliation delegated to k8s
controllers — selected by Matching whenever a Camp's substrate is Kubernetes
([control-plane.md §IaC backends](../../../docs/design/control-plane.md)).

## Model

- `preview` renders the desired claims and returns a typed diff
  (create / update on spec-drift / delete on extra claims).
- `apply` verifies the required Crossplane CRDs, resolves each resource's
  Composition selector (zero or multiple matches fail closed **before** any
  claim is applied), applies claims, waits bounded for Ready
  (`ready-timeout`), and returns outputs from claim status — resolved into
  bindings for `resource.Provisioned`.
- `refresh` reports drift when a controller mutates claim spec
  (`spec-drift`) or observed status (`status-output-drift`, judged against
  the apply-time outputs snapshot) out of band, plus `not-ready`,
  `claim-missing`, and `extra-claim`.
- `destroy` deletes claims in reverse order and returns destroyed outputs.

## Cluster lanes

- **In-memory** (`createInMemoryCrossplaneCluster`) — offline fixture
  default with stuck-claim and mutation seams (promoted from the HOBO-188
  draft proof).
- **kubectl** (`createKubectlCrossplaneCluster`) — the REAL lane over a live
  kind/k3d (or any) cluster with Crossplane installed. Claim GVK is
  configurable per platform XRD (default `hobo.dev/v1alpha1 HoboResourceClaim`);
  missing kubectl or an unreachable cluster fails closed with the typed
  `CrossplaneClusterUnavailableError`.

Both lanes pass the identical `runIacBackendConformance` suite — the same
assertion names as the Pulumi/Terraform lanes
(`preview-diff / apply-outputs / binding-outputs / refresh-clean / destroy-clean`).

## Verification

```sh
pnpm --filter @hobo/iac-crossplane build
pnpm --filter @hobo/iac-crossplane test
pnpm --filter @hobo/iac-crossplane test:contract:consumer
```

Cluster-gated tests (`describe.runIf`) additionally run the real conformance
smoke when `kubectl` reaches a cluster with Crossplane CRDs installed.
