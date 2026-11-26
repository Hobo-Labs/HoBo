# @hobo/provider-kubernetes — Architecture Evidence

The Kubernetes `CloudProvider`, at the same structural parity as the
hyperscaler providers: factory (`createKubernetesProvider`), typed `.with()`
builders (`kubernetes.with.deployment/workload`), capability declarations +
equivalence map, `realize()` emitting the primary-lane Pulumi `IacProgram`, a
runtime `client()` per port, the published Capability Manifest, a full
allocatable Yard catalog (`kubernetesYardSpec()`), Yard runtime defaults, the
`yard.*` event-fold reducer, traffic-routing offerings, and convergent
`ResourceResolver`s for built-in objects — alongside the placement driver and
apiserver client this package already shipped.

## Two lanes, on purpose

This package now has two paths to a cluster, and the difference is worth
recording because it looks like duplication and is not:

- **The driver** (`src/driver.ts`, `src/client.ts`, `src/placement.ts`) is the
  opinionated path: one sequence that creates a Namespace, a Deployment and a
  ClusterIP Service for a web workload, over this package's own
  `KubernetesTransport`. It supports `kubectl proxy` — cleartext HTTP on
  loopback — behind an explicit opt-in, because that is how most people first
  touch a cluster.
- **The resolvers** (`src/resolvers.ts`) are the general path the Yard uses:
  one convergent `reconcile` per built-in object, over `@hobo/core`'s
  `HttpTransport`, which the `ResourceResolver` contract requires. That guard is
  HTTPS-only, so **the resolver path does not support `kubectl proxy`** and says
  so at construction time rather than failing three frames down.

Neither is a migration of the other. `realize()` did change: it now emits the
canonical `hobo.iac-program/v1` document `@hobo/core`'s `CloudProvider`
contract requires and every other provider emits. The provider-shaped driver
document it used to return had no executor in the repo; it is kept, by name, as
`kubernetesDriverProgram()`, because it names the apply path the driver
actually implements.

## One equivalence class, a wider catalog

The cross-cloud equivalence table has one row — compute, on a Deployment —
because Kubernetes natively provides compute and nothing else in HoBo's port
vocabulary. Databases, caches, queues and object stores arrive through
*operators*: third-party software an operator installs into a cluster, which
this package cannot see, let alone install. A `kubernetes.postgres/v1` row would
be a claim about somebody else's software, so `data`, `kv`, `queue` and `topic`
have no rows.

The Yard catalog is wider than the equivalence table, and that is not a
contradiction: a Job, a CronJob, an Ingress and a PersistentVolumeClaim are
real allocatable built-in objects, but they are not rows of the *cross-cloud*
table, which maps capability ports onto a provider's headline products.

## A guard change in `@hobo/core`, and why it belongs there

A cluster's control plane listens on 6443, and `guardTransport` refused any port
but 443. The fix was an additive `allowedPorts` on `TransportGuardPolicy`,
defaulting to 443 only — so every existing policy behaves exactly as before —
rather than a second guard implementation in this package. A second copy of a
security rule set drifts from the first, which is the failure the shared guard
exists to prevent. The port this package declares is read off the operator's own
apiserver URL: one port, never a range and never a guess.

## Three deliberate refusals in the resolvers

1. **The namespace is never defaulted.** Falling back to `default` would place a
   workload in the busiest namespace in most clusters — the one where an RBAC
   mistake reaches everything. Its absence is a typed refusal naming the fix.
2. **`"replace"` is never emitted.** A Job's pod template and a PVC's storage
   class are immutable; converging them means deleting the object, which for a
   PVC destroys data and for a Job discards a completed run. Drift is a
   diagnostic for a human.
3. **A Secret converges without its contents entering the record.** An earlier
   revision of this ADR concluded that a Secret could not be resolved at all,
   because creating one means putting material in `ResolveRequest.desired` — and
   `desired` is recorded in the event log, the plan digest, and every diagnostic
   printed from them. The premise is right and the conclusion was wrong: the
   constraint is on `desired`, not on the resolver. The contents arrive through
   an injected `resolveSecretData(logicalId)` instead, so `desired` carries only
   the Secret's `type` and its labels. Material goes into the request body and
   nowhere else, outputs publish key names rather than values, and drift is
   decided on encoded values compared in memory so a rotation converges without
   either version being written anywhere.

## Schema and constraints

- Protobuf records live in [`data-models/`](./data-models): the apiserver
  records this package already exchanged (placement request, Namespace,
  Deployment, Service, receipt, cleanup outcome) plus the provider-parity
  records (equivalence mapping, manifest index, cost fact, auth posture,
  realized IacProgram, Yard catalog row, resolver outcome).
- CUE constraints in `data-models/provider_kubernetes.cue` bound every protobuf
  message (resource classes pinned to `kubernetes:*`, product ids to
  `kubernetes.<slug>/v<n>`, prices to decimal strings, `staticSecrets` to
  `false`).
- PACT evidence lives under [`contracts/`](./contracts): the apiserver
  interactions the driver replays, and a boundary pact covering manifest
  publication, the auth posture, the realize emission, and the reconcile-twice
  convergence property.

## Parse, don't validate

`parsePublishedManifest` is the parse, don't validate boundary for the published
well-known documents. `assertLocalIacProgram` re-parses every emitted program
into a derived parsed domain program before it leaves the package boundary in
tests. `src/api.ts` parses apiserver documents into refined records rather than
handing raw bodies onward, `parseJsonRecord` does the same on the resolver path,
`resolveToken` turns an untrusted `credentialRef` into a locator or a refusal,
`objectName` and `requiredNamespace` refuse a name the apiserver would reject
rather than sending it, and `slotBinding()` in `@hobo/core` is the parse
boundary every catalog row crosses.

## Credentials

Kubernetes is the one provider here with real first-class workload identity: a
projected ServiceAccount token is audience-scoped and short-lived, so the
published posture describes that rather than approximating it. The token is
still a *locator* to this package — resolved through an injected
`resolveCredential`, never read from a kubeconfig or a projected token file by
this code — and `staticSecrets: false` is a parse-enforced claim. Apiserver
`Status` text passes through `redactClusterText` before reaching any message,
because a Status routinely quotes the object that caused it and those objects
carry tokens and imagePullSecrets.

## Event architecture

The provider participates in the control-plane command/event loop without
holding state of its own: `registerProviderFact`/`provider.Approved` facts (the
M0 registry stream) carry its manifest snapshot into the event store; the
Planner's Matching folds the registry materialized view and records
`match.Decided`; the ResourceActor (single-writer actor) dispatches the realized
IacProgram or drives the resolvers, and outputs land as `resource.Provisioned`
facts whose bindings feed the runtime `client()`.
`normalizeKubernetesYardSignal` is the provider-side fold that turns native
Namespace and Deployment signals into `yard.*` events for that same event store,
and `kubernetesEventStoreFoldDescriptor()` registers it. Read stores (registry
catalog, deployment view) rebuild from the log — the provider publishes
documents, never authoritative state; a capability-manifest snapshot is
re-derivable at any time, so no snapshot in this package is load-bearing.

## Cost facts

A structural zero rather than a transcribed one, and it says so: the Kubernetes
API charges nothing for a Deployment. The nodes it schedules onto are billed by
whoever owns the cluster — EKS, GKE, a DOKS pool, a rack — and that bill belongs
to the provider underneath, which HoBo already prices through that provider's
own facts. A nonzero figure here would double-count it, and `included: 0` keeps
the fact from reading as a free tier.
