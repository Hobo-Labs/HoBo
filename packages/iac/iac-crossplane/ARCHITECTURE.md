# @hobo/iac-crossplane — Architecture Evidence

Production Kubernetes-substrate IaC backend (HOBO-716). Promotes
`src/draft/technical-proofs/iac-crossplane-backend-contract` (HOBO-188
lineage) into `packages/iac/iac-crossplane/`: the `IacProvider` the design
pins whenever a Camp's substrate is Kubernetes (control-plane.md §IaC
backends), modeling resources as Crossplane CompositeResourceClaims with
reconciliation delegated to k8s controllers.

## Schema and constraints

- Protobuf records live in [`data-models/`](./data-models): the IaC program
  spec (with composition selectors), the CompositeResourceClaim record
  (spec/specHash/status/appliedOutputs), preview diff, drift report, and
  apply outputs.
- CUE constraints in `data-models/iac_crossplane.cue` bound every protobuf
  message and enum in that schema.
- PACT consumer evidence for the IaC backend boundary lives under
  [`contracts/`](./contracts) and is exercised by `contracts/consumer`.

## Parse, don't validate

`validateIacProgram` is the single parse, don't validate boundary: an
untrusted `IacProgram` DTO becomes a frozen, derived parsed domain program
(checked apiVersion/kind/provider = crossplane, unique resources, required
`compositionSelector.matchLabels` per resource, resolvable
`${resources.X.outputs.Y}` references) before any preview or apply runs.
Callers receive derived parsed domain types instead of re-checking raw
fields; adapters depend on the `IacProvider` contract in `src/port.ts`, built
through `@hobo/core`.

## Fail-closed adversarial posture (carried from the proof)

- A stuck non-Ready claim -> bounded `ready-timeout` instead of hanging.
- A Composition selector matching zero or multiple Compositions fails closed
  (`composition-not-found` / `composition-ambiguous`) for EVERY resource
  BEFORE any claim is applied.
- Missing Crossplane CRDs fail before apply (`crd-missing`).
- Out-of-band spec mutation -> `spec-drift`; out-of-band status mutation ->
  `status-output-drift` (compared against the apply-time outputs snapshot,
  never a fabricated expectation); undesired claims -> `extra-claim`.

## Event architecture

The adapter is the Executor-facing effector in the provisioning
command/event loop: a Deploy command becomes `deployment.Planned`, the
ResourceActor (the single-writer actor over its event-store stream)
dispatches the IacProgram here, and outcomes land as `resource.Provisioned`
(claim status outputs -> bindings) / `resource.Failed` facts. Drift reports
feed the drift materialized-view projection; the deployment read stores
rebuild from the event log — the cluster is reconciled state, never the
snapshot of record.

## Cluster lanes

- `createInMemoryCrossplaneCluster` — offline fixture default (mocked lane),
  with stuck-claim and out-of-band-mutation seams.
- `createKubectlCrossplaneCluster` — the REAL lane: the same
  `CrossplaneClusterLike` surface over `kubectl` against a live kind/k3d (or
  any) cluster with Crossplane installed; claim GVK configurable per platform
  XRD; apply-time outputs snapshot rides the `hobo.dev/applied-outputs`
  annotation; missing kubectl/cluster fails closed with the typed
  `CrossplaneClusterUnavailableError`.

Both pass the identical `runIacBackendConformance` suite
(`preview-diff / apply-outputs / binding-outputs / refresh-clean / destroy-clean`)
— the same assertion names as the Pulumi and Terraform lanes.
