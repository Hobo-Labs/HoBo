# @hobo/provider-kubernetes Contract POC

HOBO-182 proof package for the Kubernetes provider contract.

It models a Kubernetes-backed CloudProvider with:

- Crossplane/template driver intent for workload and infrastructure resources;
- default definitions for Deployment, Service, Ingress, wasmCloud operator host,
  in-cluster Postgres, and in-cluster Redis;
- provider-scoped `.with(kubernetes.*)` option blocks;
- provider-conformance coverage for seed ports `compute`, `database`, and
  `cache`;
- adversarial guards for missing CRDs, capacity, Crossplane drift, and
  namespace/RBAC tenant isolation.

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\provider-kubernetes-contract test
```

The runtime tests exercise the implementation directly; the type consumer uses
the package export so the public declaration surface stays aligned with
downstream API/SDK usage.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Provider Kubernetes Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
