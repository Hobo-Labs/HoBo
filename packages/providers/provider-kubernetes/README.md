# @hobo/provider-kubernetes

Kubernetes CloudProvider for HoBo, at the same structural parity as the
hyperscaler providers: an equivalence map from the `compute` port onto a
Deployment, a full allocatable Yard catalog of built-in objects, convergent
`ResourceResolver`s for them, an injected-transport apiserver driver that places
a workload on a real cluster, and the temporary/agent Environment Station
contract.

```sh
pnpm --filter @hobo/provider-kubernetes test
```

## Two lanes to a cluster

This package has two paths, and the difference matters:

| | Driver (`provisionWorkload`) | Resolvers (`kubernetesResolvers`) |
|---|---|---|
| Shape | one opinionated sequence: Namespace → Deployment → Service | one convergent `reconcile` per built-in object |
| Transport | this package's `KubernetesTransport` | `@hobo/core`'s `HttpTransport` (the `ResourceResolver` contract) |
| `kubectl proxy` | **supported**, behind an explicit opt-in | **not supported** — core's guard is HTTPS-only |
| Used by | `hobo deploy` placement | the Yard resolution path |

Neither replaces the other. What did change: `realize()` now emits the canonical
`hobo.iac-program/v1` document `@hobo/core`'s `CloudProvider` contract requires
and every other provider emits. The provider-shaped driver document it used to
return had no executor in the repo; it is still reachable as
`kubernetesDriverProgram()`, because it names the apply path the driver
implements.

## What this package does

- **Equivalence → default Resource Definitions** (`EQUIVALENCE_CLASSES` /
  `createKubernetesProvider`), with Matching's `satisfies` answering
  full/partial/none rather than fabricating parity.
- **A default Yard catalog** (`kubernetesYardSpec()`): Deployment, Service,
  Ingress, Job, CronJob, PersistentVolumeClaim and a Secret *locator* row, as
  canonical rows `@hobo/yards` parses.
- **Convergent resolvers** (`kubernetesResolvers()`) for six of those seven
  products: read-or-create against the apiserver, merge-patch on drift, and
  "already gone" as a successful delete.
- **`realize()` → `hobo.iac-program/v1`** for the primary Pulumi lane, plus the
  published Capability Manifest with declared cost facts and the projected
  ServiceAccount token posture.
- **Placement on a cluster.** `parseWorkloadPlacement` refines an authored
  option bag; `createKubernetesApiClient` creates the Namespace, Deployment and
  ClusterIP Service through an injected HTTP transport; `provisionWorkload`
  orders those three and returns a receipt.
- **Rollout truth.** `observeRollout` reads the Deployment's `/status`
  subresource and reports the phase the controller's own generation and
  conditions support.
- **Teardown that stops at what it created.** `cleanupWorkload` deletes only a
  namespace this driver created, and reports `deleting` — not `deleted` — until
  it has observed the namespace gone.
- **Temporary/agent Environment Stations:**
  `supportsAnonymousTemporaryDeploy = true`, provisioned through an
  injectable/local transport with no permanent API tokens.

## One equivalence class, a wider catalog

The cross-cloud equivalence table has one row — compute, on a Deployment —
because Kubernetes natively provides compute and nothing else in HoBo's port
vocabulary. Databases, caches, queues and object stores arrive through
*operators*: third-party software an operator installs, which this package
cannot see, let alone install. So `data`, `kv`, `queue` and `topic` have no Yard
rows, and an app that needs Postgres gets a truthful `none` here.

The Yard catalog is wider than the equivalence table, and that is not a
contradiction: a Job, an Ingress and a PersistentVolumeClaim are real
allocatable built-in objects, but they are not rows of the *cross-cloud* table,
which maps capability ports onto a provider's headline products.

## Three deliberate refusals in the resolvers

1. **The namespace is never defaulted.** A fallback to `default` would put a
   workload in the busiest namespace in most clusters — the one where an RBAC
   mistake reaches everything. `desired.namespace` is required.
2. **`"replace"` is never emitted.** A Job's pod template and a PVC's storage
   class are immutable; converging them means deleting the object, which for a
   PVC destroys data and for a Job discards a completed run. Drift is reported
   as a diagnostic.
3. **A Secret's contents never touch `desired`.** They arrive through the
   injected `resolveSecretData(logicalId)`, the same shape as every other
   credential in this repo — core refuses credential-shaped keys in a property
   bag precisely because `desired` is recorded in the event log. From there the
   discipline is mechanical and tested: material is fetched immediately before
   the call and held no longer; it goes into the request body and nowhere else;
   outputs publish the *key names*, the object `type` and the `k8s://` locator,
   never a value; and a rotation converges by comparing encoded values in
   memory, so neither version is rendered into a diagnostic. The output keys are
   deliberately named `objectType` and `locator` rather than `secretType` and
   `secretRef`, because core refuses credential-shaped keys in an outcome's
   outputs too — and is right to.

## Honest scope for the resolver lane

- **No live cluster is proven.** The resolvers are exercised against an injected
  fake transport modelling an apiserver. A real deploy additionally needs a
  cluster, credentials and network egress.
- **No `kubectl proxy`.** See the two-lanes table above.
- **No Resource Definitions are registered** for the `kubernetes.*` product ids,
  so a deploy routed through the *Yard* still fails closed at resolution
  (`YARD_BINDING_PRODUCT_UNKNOWN`).
- **Built-ins only.** Anything an operator installs — a Postgres CRD, a queue
  CRD — is out of scope by construction, not by omission.

## What it does not do

- **No kubeconfig, no credential handling.** The host supplies a
  `KubernetesTransport` that already authenticates. Nothing here reads
  `~/.kube/config`, and nothing here holds a bearer token.
- **No ingress, no LoadBalancer, no external address.** The receipt carries an
  in-cluster `http://<svc>.<ns>.svc.cluster.local:80` URL, because that is the
  only object this provider created. Advertising an external hostname would be
  claiming something it never provisioned.
- **No waiting.** `observeRollout` reads once. A driver that polls owns a
  deadline, a backoff and a cancellation story, and all three belong to the
  caller that knows what the deploy is for.
- **No deletion of anything it adopted.** An adopted namespace was the
  operator's before this deploy existed and holds objects nobody here
  enumerated.

## Parse, don't validate

Nothing in this package re-checks a value it already accepted. Untrusted input
crosses one parser and comes out as a **derived domain type** that cannot hold
the bad case:

- `parseWorkloadPlacement` turns the untrusted `.with(kubernetes.workload(...))`
  option bag into a `WorkloadPlacement`: an RFC 1123 name and namespace, a
  registry-qualified image with a tag or digest, bounded replicas, and CPU and
  memory already normalized to millicores and bytes. Kubernetes quantities are a
  suffix language — `250m`, `0.25`, `1M`, `1Mi` — and comparing them as written
  is how a limit ends up below its request. `parseCpuMillicores` and
  `parseMemoryBytes` are the only code that reads a suffix; everything
  downstream compares integers.
- `parseNamespaceRecord`, `parseDeploymentRecord` and `parseServiceRecord` turn
  apiserver JSON into records whose fields are already checked: UID-shaped uids,
  opaque `resourceVersion` tokens, a Namespace phase from the documented pair, a
  routable ClusterIP (a headless `None` is rejected, because a record built from
  one would promise an endpoint that does not exist).
- `rolloutPhaseFor` collapses a generation, an observed generation, four replica
  counters and a condition list into one of `pending | progressing | available |
  failed`. A `ProgressDeadlineExceeded` rollout whose old replicas are still
  serving reports every counter as healthy; the phase is `failed` anyway, and
  `available` is unreachable unless the controller has observed the current
  generation.
- `parseApiStatus` reads the apiserver's own `kind: "Status"` envelope, so a 409
  `AlreadyExists` (adopt the namespace) can be told apart from a 409 `Conflict`
  (stale resourceVersion), which want opposite responses.
- `NamespaceRecord.createdByHobo` makes "we created this" a field rather than an
  assumption. It is what `cleanupWorkload` reads before issuing a DELETE.

`data-models/provider_kubernetes.proto` is the design-time wire view of these
shapes and `data-models/provider_kubernetes.cue` carries the invariants the
parsers enforce (DNS-1123 labels, replica and port ranges, limit ≥ request,
`available` implying an observed current generation, retention naming its
reason). The parsed types above are the executable view of that pair.

## Why the transport guard is this package's own

Eight provider transports in this repo delegate to `guardTransport` in
`@hobo/core`. This one does not, and the reason is not "different semantics" in
the abstract — it is two of core's checks that an apiserver client cannot
satisfy, measured against the real policy:

| what core does | what an apiserver needs |
|---|---|
| `allowedHosts` must contain the hostname exactly | there is no host to write down: the apiserver is the operator's own, at an address only they know |
| the port must be empty or `443` | clusters answer on `:6443`, and `kubectl proxy` on `:8001`; `https://cluster.example.test:6443/api/v1/namespaces` is refused by core on the port before any host rule is consulted |

Expressing this package in core's policy would mean adding an `allowAnyHost` and
an `allowedPorts` escape — that is, making the two checks the guard exists for
optional, for the benefit of one caller. The `allowInsecureLoopback` flag here
covers only the `kubectl proxy` cleartext case, which is the *smallest* of the
differences, so lifting it alone would not have helped.

What is shared is the rule that actually drifted: `encodesPathSeparator` comes
from `@hobo/core`, so the percent-encoded-separator refusal has one definition
across every transport in the repo.

## Contracts

`contracts/provider-kubernetes-apiserver.pact.json` is the consumer-driven
contract for the core/v1 and apps/v1 surfaces this package calls;
`test/contract.test.ts` replays every interaction through the real client with
the fake at the HTTP seam and nowhere else. See
[`contracts/README.md`](contracts/README.md).

## Event architecture

This package is a strategy leaf: it holds no reducer, no stream, and no store.
Its job is to turn one apiserver interaction into facts a durable plane can
record, and that machinery lives in the deploy/claim planes, not here.

The flow for one placement:

1. A **command** from the deploy family — `PlaceWorkload`, `ObserveRollout`,
   `ReleaseWorkload` — is what a caller issues. `provisionWorkload`,
   `observeRollout` and `cleanupWorkload` are the effectful halves those
   commands invoke.
2. Each returns an observation, not a durable fact: a `ProvisionReceipt`, a
   `DeploymentRecord`, a `CleanupOutcome`. The deploy coordinator **actor** is
   what turns them into the **events** `WorkloadPlaced`, `NamespaceAdopted`,
   `RolloutObserved`, `RolloutFailed` and `WorkloadReleased`.
3. That actor appends the command and its events to the durable **event store**
   on the `deploy:<deploymentRef>` stream under an optimistic `expectedSeq`. The
   records here are designed to be appendable: they carry names, uids,
   `resourceVersion` tokens, counters and instants, and never a token, a
   kubeconfig or a Secret payload.
4. Folding that journal back yields a **snapshot** of the placement — the
   namespace's ownership flag, the last observed generation, the last rollout
   phase — which the next append fences against, and which is what makes a
   repeated deploy adopt rather than duplicate.
5. The rollout **projection** over that snapshot is the **materialized view**
   `hobo deploy status` renders, and it is the **read store** for the endpoint
   URL and phase. It cannot report a placement healthy while the last observed
   phase is `failed`, and it cannot report a namespace released while the last
   `CleanupOutcome` was `deleting`.

The distinction step 5 depends on is the one this package is careful about:
`deleting` is an acceptance, `deleted` is an observation, and only the second
one may retire a placement from the read model.

## Error codes

`KubernetesProviderError.code` is one of `PROVIDER_AUTH_FAILED`,
`PROVIDER_CONTRACT_CHANGED`, `PROVIDER_OPERATION_AMBIGUOUS`,
`PROVIDER_RATE_LIMITED`, `PROVISIONING_CONFLICT`, `PLACEMENT_REJECTED`,
`ROLLOUT_FAILED`, `CLEANUP_INCOMPLETE`.

A 5xx on a create is `PROVIDER_OPERATION_AMBIGUOUS`, never a retryable error: a
timed-out POST never proves the apiserver did nothing. Every message and detail
passes `redactClusterText`, because a `Status` message quotes the object that
caused it and those objects carry ServiceAccount tokens and imagePullSecrets.

## Hosting budget execution

Cluster infrastructure cost is `pricingStatus: "unknown"`, not an authoritative zero.
Budget admission must include the actual node, load balancer, volume, egress and retained
resource obligations for the selected account. A known physical identity cannot be
retargeted by changing the desired namespace or name, including on delete.

Deployment readiness requires the controller to observe the current generation and
total, updated and available replicas to equal the desired count. A surge rollout
with old available pods and new unready pods remains progressing until the old
ReplicaSet drains. Old ReplicaSet health cannot bless a new rollout. Resolver outputs `ready`, `operationConfirmed` and
`lifecycleStatus` come from that controller read; incomplete records remain unknown.
For a single-container image pinned by digest, `artifactDigest` comes from the observed
image. Independent business health is still required before traffic moves. Namespace
DELETE remains an acceptance; finalizers and billable volumes require observation.
