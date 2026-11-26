# HOBO-182 Kubernetes Provider Proof

This proof backs [PLAN-04](../../control-plane.md#plan-04), the provider
package slot in [architecture.md](../../architecture.md#monorepo--package-architecture),
[PLAN-25](../../platform-engineering.md#plan-25), [ADR-0024](../../adr/07-portability-extensibility.md#adr-0024)
portability conformance, and [ADR-0031](../../adr/01-architecture-core.md#adr-0031)
wasmCloud-on-k8s host selection.

The executable POC in
[`src/draft/technical-proofs/provider-kubernetes-contract`](../../../../src/draft/technical-proofs/provider-kubernetes-contract)
proves the Kubernetes seed provider contract:

- `@hobo/provider-kubernetes` exposes a factory, Capability Manifest, default
  Resource Definitions, and per-port clients for compute, in-cluster Postgres,
  and in-cluster Redis;
- networking (`Service`/`Ingress`) and `componentHost` (`wasmcloud-operator`)
  defaults are present in the manifest even though the shared provider
  conformance harness only has first-class suites for seed capability ports;
- `kubernetes.with.deployment/service/ingress/wasmCloudHost/postgres/redis`
  are provider-scoped option builders and only survive when the resolved
  provider is Kubernetes;
- the fixture realizes a namespace, workload, Service, Ingress, in-cluster
  Postgres, in-cluster Redis, and a wasmCloud operator host into a
  Crossplane-shaped HoBo realization graph;
- local and camp conformance are represented for the seed ports `compute`,
  `database`, and `cache`;
- missing operator CRDs, insufficient cluster capacity, Crossplane drift, and
  namespace/RBAC tenant conflicts return precise `deployment.PlanRejected`
  reasons.

Scope kept out: live kind/k3d cluster execution, the iac-crossplane backend
adapter, the component-host runtime implementation, GitOps publisher wiring,
and other providers.
