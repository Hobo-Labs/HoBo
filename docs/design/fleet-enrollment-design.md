---
type: Design
title: "HoBo CI Enrolled Execution Fleet And At-Most-Once Claims"
description: "Single-pass implementation and verification handoff for enrolled devices, joined Kubernetes clusters, durable execution claims, secure worker realization, and production-shaped E2E evidence."
status: Proposed for implementation
repository: "https://github.com/Hobo-Labs/HoBo"
baseline: "921ad419e76a4773e037dd33d095127e5846855b"
---

# HoBo CI Enrolled Execution Fleet And At-Most-Once Claims

## 0. Coding-agent execution directive

Implement this design as **one continuous, coordinated delivery**, not as a sequence of proposals or unintegrated proof branches. Use a highly parallel swarm with one integration owner, contract-first development, disjoint file ownership, frequent integration, and independent adversarial verification. Continue through implementation, migration, documentation, fault injection, production-shaped E2E, and remediation until every applicable release gate in Section 18 passes.

Do not call the result production-ready when only mocks, unit tests, or hand-authored provider contracts pass. A production-ready claim requires the real production-shaped deployment and authorized live-provider acceptance evidence in Section 18. If an external credential, test organization, cluster, or provider account is unavailable, record the precise external blocker and leave the corresponding readiness gate red; never substitute a mock and claim completion.

The fleet manager is an internal subsystem of **HoBo CI**. HoBo CI remains the product. Do not create a second general-purpose orchestration, deployment, workload-authoring, or cluster-management product.

## 1. Executive decision

Add an enrolled-execution subsystem to HoBo CI that:

1. Enrolls existing trusted-local and isolated-container workers as provider capacity.
2. Joins real Kubernetes clusters through Station/Yard Connections and explicit CI provider bindings.
3. Supports multiple engine-specific Offers on one device without oversubscribing shared capacity.
4. Introduces a strict v2 execution path with durable, transactional, fenced **at-most-once start authorization**.
5. Separates generic **RunnerSlots** from concrete **ExecutionClaims**, because GitHub may assign a runner to a different queued job than the webhook that caused provisioning.
6. Uses the official runner pre-job hook to authorize the actual job before any workflow step executes.
7. Uses deterministic external names, transactional outbox effects, monotonic worker fencing, and explicit reconciliation after uncertain effects.
8. Preserves current v1 policy, Offer, Lease, dispatcher, standalone worker, and external-provider behavior. Do not silently reinterpret v1 as start-fenced.
9. Keeps Dagger behind its existing actor/backend boundary and keeps Kubernetes optional.
10. Defers full BuildKit and Jenkins implementations; this delivery defines their guarantee/conformance boundary but does not pretend they are already portable Pipeline backends.

The central correctness rule is:

> After an external effect may have occurred, no timeout, delivery expiry, worker failure, controller failover, or backup restore may return that work to an unclaimed/runnable state without definitive external evidence or an explicitly audited operator decision.

## 2. Guarantee taxonomy and honest limitations

### 2.1 Strict HoBo-managed execution

A strict execution class guarantees:

- One durable `CiDemand` identity per `(account, engine, repository, run, job, run_attempt)`.
- One durable `ExecutionClaim` per that same job identity.
- At most one committed `start_authorized` transition for the claim.
- One execution claim per runner slot and one runner slot per execution claim.
- No automatic retry after ambiguous provisioning, registration, start, cancellation, completion, or cleanup.
- A manual GitHub rerun is a new run attempt and may receive a new claim.
- Idempotent retries by the same runner slot for the same actual job return the original authorization result.

This is **at-most-once start authorization**, not exactly-once execution. A job can fail or remain queued without running when safety cannot be established.

### 2.2 External-assignment execution

Providers that do not permit a HoBo-controlled pre-start fence receive only:

- Unique HoBo admission intent.
- Reconciled launch intent where their API permits it.
- Existing actual-assignment accounting.

They are not eligible when policy requires `start-fenced`. This includes third-party hosted runners without a HoBo hook and ARC installations without a validated strict runner template.

### 2.3 Residual limitations

State these limitations in operator documentation:

- External systems do not participate in HoBo's database transaction.
- A compromised control plane retains legitimate CI authority while compromised.
- A user-authored retry, GitHub manual rerun, reusable workflow, or external runner outside HoBo's runner group is not made idempotent by this design.
- A restored database cannot prove what external providers did after the backup; affected scopes require quarantine and reconciliation.
- Trusted-local execution is not a hostile-code sandbox.
- Engine registration controls what HoBo may provision, not what arbitrary workflow code can reach through ambient host/network access.

## 3. Existing HoBo contracts that remain authoritative

| Existing location | Existing responsibility | Required use |
| --- | --- | --- |
| `packages/ci/data-models/ci.proto` | `Offer`, `Lease`, `Pipeline`, results, usage evidence | Extend through versioned records; preserve v1 meaning and replay |
| `packages/ci/data-models/policy.proto` | Authored desired CI policy | Keep observations and worker state out of desired policy |
| `packages/ci/src/routing.ts` | Candidate filtering and provider selection | Feed pinned inventory/capacity snapshots; no live provider calls |
| `packages/ci/src/scheduler.ts` | Pipeline admission and no ambiguous cross-provider retry | Add strict execution-claim admission beside current behavior |
| `packages/ci/src/execution.ts` | Backend compatibility and `uncertain` execution outcomes | Preserve uncertain cleanup/start semantics |
| `packages/ci/src/store.ts`, `sqlite-store.ts`, `postgres-store.ts` | Transactional CI state | Add one shared store-conformance suite for strict claims and effects |
| `packages/dispatcher/src/dispatcher.ts` | Pure deterministic ranking and reservation patterns | Keep pure; do not add worker, SQL, GitHub, or Kubernetes calls |
| `packages/ci-gh-actions/src/local-runner.ts` | Trusted private host-process JIT lifecycle | Reuse for managed enrolled-local realization |
| `packages/ci-gh-actions` isolated worker | Isolated-container execution, pull/push, draining, reconciliation | Reuse rather than creating a second worker daemon |
| `packages/ci-gh-actions/src/project-providers.ts` | Closed provider shapes including local, box worker, Kubernetes, ARC, Dagger | Extend only through typed, provider-specific fields |
| `packages/ci-dagger/ADR.md` | Backend does not own scheduler, lease, cost, or failover | Preserve this dependency direction |
| `docs/design/adr/01-architecture-core.md` | Optional Kubernetes, provider adapters, durable ports, fencing/replay | Preserve all conformance and ownership rules |

### Current behavior requiring explicit migration care

- Standalone SQLite box mode is a single-admission-authority deployment. It must not become a multi-worker shared-fleet mode merely because several workers enroll.
- Existing JIT runners using the same `hobo` label can receive a job other than the demand that triggered provisioning.
- Existing external providers and ARC installations do not necessarily contain a HoBo pre-start fence.
- The current policy pool is homogeneous Linux x64. Do not silently claim ARM, Windows, or macOS support.
- Existing `CiPolicyKubernetesScaleSet` and `CiPolicyDaggerEngine` thinly reconcile/check operator-owned installations; HoBo does not install ARC or Dagger as a side effect of connection.

## 4. Goals, non-goals, and release boundary

### 4.1 Goals

- Secure enrollment and revocation of user-owned Linux x64 devices.
- Trusted-local execution without Docker for private, trusted, non-isolated jobs.
- Isolated-container execution on Docker-capable devices.
- Shared transactional admission across many enrolled workers.
- Real Kubernetes capacity through direct strict runner Pods and explicitly classified ARC bindings.
- Durable demand, capacity, effect, delivery, execution, and audit state.
- At-most-once start authorization for strict execution classes.
- Deterministic replay of all HoBo decisions from persisted facts.
- Independent Dagger pipeline execution against operator-owned engines.
- Shared per-device capacity accounting across independently admitted engines.
- Production-shaped E2E and authorized live-provider evidence.

### 4.2 Non-goals for this delivery

- A generic replacement for Kubernetes, Nomad, ARC, Jenkins, Buildx, or Dagger.
- A new public `ComputeClass`, `CapacityDomain`, or workload-authoring topology.
- A general-purpose host shell/control API.
- A custom process sandbox presented as safe for hostile public/fork code.
- Automatic Dagger/BuildKit engine installation or cache-service operation.
- Full BuildKit or Jenkins engine adapters.
- General nested/compound execution scheduling, such as automatically accounting for a GitHub job that invokes an arbitrary remote builder.
- Multi-architecture support beyond explicitly shipped and tested Linux x64 classes.
- Exactly-once external side effects or exactly-once user code.
- Automatic provider agreement purchases, pricing redesign, or dispatcher v1 changes.

### 4.3 Subsequent adapter boundary

BuildKit should be evaluated against HoBo's build-provider/build-machine boundary and must preserve stable named-builder/cache semantics. Jenkins requires native label/cloud semantics and a pre-start claim fence before it can join a strict class. Neither may be marked strict solely because it has an Offer record.

## 5. Architecture and ownership

```text
Existing HoBo CI controller
 ├── Signed webhook / authenticated pull intake and repair
 ├── Desired-policy compiler and account client
 ├── Pure Offer/dispatcher selection over pinned snapshots
 ├── Transactional CI store
 │    ├── demands and execution claims
 │    ├── runner slots and capacity groups
 │    ├── effects, outbox, and worker deliveries
 │    ├── observations, incarnations, and append-only events
 │    └── existing v1 leases and usage settlement
 ├── Durable repair and provider reconciliation
 └── Provider realization
      ├── trusted-local workers
      ├── isolated-container workers
      ├── direct Kubernetes runner Pods
      ├── ARC with explicit guarantee classification
      ├── operator-owned Dagger engines
      └── existing Sandbox/external providers

Enrollment subsystem (internal to HoBo CI)
 ├── Authenticates workers to Station-owned Connections
 ├── Authorizes specific provider Offer bindings
 ├── Accepts scoped monotonic observations
 ├── Delivers persisted effects with fencing
 ├── Issues short-lived realization credentials
 └── Supports pause, drain, revoke, and restore quarantine
```

### Ownership rules

- `@hobo/ci` owns engine-neutral claim/effect/capacity contracts, state transitions, store conformance, and replay facts.
- `@hobo/ci-gh-actions` owns GitHub demand identity, RunnerSlots, JIT reconciliation, assignment verification, and the pre-job hook.
- Existing worker implementations own typed realization, local evidence, cleanup, and drain behavior.
- The Kubernetes provider adapter owns deterministic Kubernetes realization and observations.
- `@hobo/ci-dagger` remains an execution/readiness adapter called only after shared admission.
- `@hobo/dispatcher` remains pure and deterministic.
- Station/Connection and existing identity/token-broker boundaries own provider trust and credential references.
- No new top-level `@hobo/fleet` product package is required. If code cohesion favors an internal submodule, its public dependency direction must still be `@hobo/ci` → provider adapters, never adapter → controller internals.

## 6. User-facing semantics

### 6.1 GitHub workflow contract

Managed workflows continue to use the configured HoBo pool label, initially:

```yaml
runs-on: hobo
```

Do not expose worker hostnames, cluster names, or internal provider IDs as a second workflow routing language. Provider `runsOn` values remain realization bindings.

All Offers behind one assignment label and runner group must have compatible security and execution requirements. In particular:

- Never mix trusted-local and isolated-required Offers behind one label.
- Never mix materially different isolation classes merely because their OS, architecture, and price match.
- Persistent versus ephemeral lifecycle and cache behavior must be visible in status/explain output.
- Native ARC scale sets used directly outside HoBo are not implicitly part of the managed `runs-on: hobo` contract.

### 6.2 Cluster join

“Join cluster” means connect and explicitly bind CI capacity, not surrender cluster control. Default enrollment is observation-only until an operator enables a typed provider binding. HoBo does not install ARC, Dagger, or unrelated controllers as a join side effect.

### 6.3 Device operations

- **Pause:** deny new admissions; clean up unbound registered runners where possible.
- **Drain:** deny new admissions and wait for active work up to a configured bound.
- **Revoke:** invalidate enrollment and future credential issuance; best-effort deregister/stop realization while retaining unresolved claims as uncertain.
- **Quarantine:** deny new starts and effects pending reconciliation; existing evidence remains auditable.

None of these operations claims instant termination of arbitrary code already running on a user-owned device.

### 6.4 Status and explanations

`status`/`explain` must distinguish:

- Controller readiness from account supply readiness.
- Demand observed from capacity reserved.
- Runner registered from job start authorized.
- `start-authorized`, `running`, `uncertain`, and terminal execution.
- Fixed versus elastic capacity.
- Trusted-process versus isolated execution.
- Strict start-fenced versus external-assignment guarantee.
- Queue reasons: no compatible class, isolation mismatch, stale observation, capacity exhausted, budget exhausted, revoked worker, quarantine, or provider uncertainty.

## 7. Logical records and invariants

The following TypeScript-like records illustrate semantics, not a requirement to hand-write duplicate DTOs. Define canonical Protobuf/CUE contracts and generated types first. SQL columns may differ by adapter, but uniqueness and state invariants may not.

```ts
type GitHubJobKey = {
  kind: "github-job";
  accountId: string;
  engineId: "gh-actions";
  installationId: string;
  repositoryId: string;
  runId: string;
  jobId: string;
  runAttempt: number;           // positive; GitHub rerun creates a new attempt
};

type DaggerPipelineKey = {
  kind: "dagger-pipeline";
  accountId: string;
  engineId: "dagger";
  pipelineId: string;
  pipelineDigest: string;       // same logical ID may never identify different input
};

type ExecutionKey = GitHubJobKey | DaggerPipelineKey;

type ExecutionProfile = {
  id: string;                   // stable internal profile ID, not a workflow label
  os: "linux";
  architecture: "x64";
  isolation: "trusted-process" | "isolated-container" | "kubernetes-approved" |
             "sandbox" | "operator-engine";
  lifecycle: "persistent-capacity" | "ephemeral-environment";
  guarantee: "start-fenced" | "external-assignment";
};

type CiDemand = {
  key: ExecutionKey;
  state: "observed" | "eligible" | "satisfied" | "expired-before-effect";
  firstObservedAt: string;
  lastObservedAt: string;
  policyRevision: number;
  requiredProfileId: string;
  source: "webhook" | "pull" | "scale-set" | "repair" | "pipeline";
  sourceDeliveryIds: string[];
};

type RunnerSlot = {
  id: string;
  accountId: string;
  offerId: string;
  workerBindingId?: string;
  clusterBindingId?: string;
  profileId: string;
  runnerName: string;           // hobo-<slot uuid>; unique per provider scope
  state: "reserved" | "provisioning" | "registered" | "bound" |
         "draining" | "released" | "uncertain";
  capacityGroupId?: string;
  capacityCostUnits: number;
  policyHash: string;
  offerObservationHash: string;
  quoteHash?: string;
  bindingSecretHash?: string;   // never the raw secret
  externalRunnerId?: string;
  kubernetesUid?: string;
  incarnationId: string;
  createdAt: string;
};

type ExecutionClaim = {
  id: string;
  key: ExecutionKey;
  runnerSlotId?: string;
  state: "start-authorized" | "running" | "completed" |
         "failed" | "cancelled" | "uncertain";
  profileId: string;
  policyHash: string;
  offerId: string;
  quoteHash?: string;
  startAuthorizedAt: string;    // database time; written once
  actualStartedAt?: string;
  terminalAt?: string;
  incarnationId: string;
};

type Effect = {
  id: string;
  subjectType: "runner-slot" | "execution-claim" | "worker-binding";
  subjectId: string;
  kind: string;                 // closed provider-specific effect vocabulary
  sequence: number;
  state: "planned" | "dispatching" | "confirmed" | "uncertain";
  idempotencyKey: string;
  externalLocator?: string;     // runner name, K8s namespace/name/UID, session ID
  createdAt: string;
};

type WorkerDelivery = {
  id: string;
  effectId: string;
  workerId: string;
  ownerEpoch: number;
  fence: number;
  expiresAt: string;            // database time
  state: "claimed" | "acked" | "expired" | "superseded";
};

type CapacityGroup = {
  id: string;                   // normally one enrolled device or approved shared engine
  accountId: string;
  approvedUnits: number;
  reservedUnits: number;
  seq: number;
  state: "active" | "paused" | "draining" | "revoked" | "quarantined";
};

type ControllerIncarnation = {
  id: string;
  createdAt: string;
  reason: "bootstrap" | "restore" | "explicit-fence";
};
```

### 7.1 Mandatory database invariants

- Unique `CiDemand.key` across its full execution identity.
- Unique `ExecutionClaim.key` across its full execution identity.
- Unique `ExecutionClaim.runnerSlotId` when present.
- Unique runner name within its GitHub registration scope.
- Unique `(effect.subjectType, effect.subjectId, effect.kind, effect.sequence)`.
- Unique `effect.idempotencyKey` within its provider scope.
- Unique `(workerId, observationSequence)` and monotonically increasing watermarks.
- Unique active worker delivery for an effect.
- `ExecutionClaim.startAuthorizedAt` is immutable.
- No state transition from `start-authorized`, `running`, or `uncertain` to demand/pending/reserved.
- No runner-slot transition from any post-`reserved` state back to `reserved` without evidence proving no external mutation occurred.
- Secrets, JIT configs, raw binding tokens, and credential payloads are forbidden from events and audit facts.

Tombstones required for uniqueness are retained for the complete provider replay horizon. Prefer permanent compact claim keys/hashes over time-based deletion. Retention changes require a separate correctness review.

### 7.2 Fixed capacity units

The first release uses fixed admission units, not generic bin-packing. Each device capacity group has an operator-approved ceiling; each Offer declares its unit cost. Example:

```text
Device group approvedUnits = 3
 ├── trusted-local GitHub Offer cost = 1
 └── Dagger engine Offer cost       = 2

Allowed: one GitHub + one Dagger, or three GitHub jobs if policy permits.
Denied: any combination whose admitted cost exceeds 3.
```

Approved units are admission limits, not proof of physical CPU/memory enforcement. Do not expose them as guaranteed cores or GiB. Weighted resource accounting requires a later contract tied to actual driver enforcement.

## 8. Transactional admission and effect delivery

### 8.1 Intake

- Verify webhook authenticity or authenticated pull source before persistence.
- Commit the durable inbox/demand before returning success.
- Deduplicate on the complete job key and source delivery ID.
- GitHub redelivery updates observation metadata only; it does not create another execution.
- Queue notification loss is repaired by durable scans. The queue is a wakeup, never the ledger.

### 8.2 Pure selection followed by transactional revalidation

1. Load a pinned policy/Offer/capacity snapshot.
2. Filter by execution profile, isolation, trust, freshness, guarantee, and capacity.
3. Rank compatible candidates through the existing deterministic path.
4. Begin a transaction on the authoritative primary store.
5. Conditionally update capacity using its expected sequence.
6. Revalidate policy revision, Offer observation hash, and revocation state.
7. Insert RunnerSlot, event, Effect, and Outbox in the same transaction.
8. Commit before any external call.

Illustrative capacity mutation:

```sql
UPDATE ci_capacity_group
SET reserved_units = reserved_units + :cost,
    seq = seq + 1
WHERE id = :group_id
  AND seq = :expected_seq
  AND state = 'active'
  AND reserved_units + :cost <= approved_units;
```

Exactly one row must change. Zero rows means conflict/ineligibility, not success.

No network call, wall-clock read from an application replica, or provider API lookup occurs inside the decision transaction. Use database time for persisted deadlines and expiry comparisons.

### 8.3 Worker delivery

A worker claims a persisted effect through a conditional mutation that sets `workerId`, `ownerEpoch`, `fence`, and expiry. Renewals and acknowledgments require all three identity/fence fields.

Delivery expiry has two disjoint behaviors:

- `planned`, with evidence no external mutation was attempted: the same effect ID may be delivered again.
- `dispatching` or later: create reconciliation work only; never reissue the mutation automatically.

A worker delivery lease is not an execution claim and says nothing about whether remote code stopped.

### 8.4 Effect execution

- Every external mutation carries a stable idempotency key and deterministic locator where the provider permits it.
- Record launch intent before the external call.
- A definitive pre-mutation refusal may return the effect to `planned` or release a pre-effect reservation.
- A timeout, broken connection, process crash, or ambiguous provider response moves the effect to `uncertain`.
- Reconciliation reads provider state and folds evidence. It never assumes absence from one eventually consistent read.
- Capacity remains reserved until confirmed teardown or an audited operator release decision.

## 9. GitHub RunnerSlot and pre-start claim protocol

### 9.1 Why slots are generic

Do not bind a JIT runner irreversibly to the webhook job that caused its creation. A RunnerSlot initially represents only compatible capacity. The actual job is claimed when GitHub reports assignment to that runner.

Demand reservations and capacity slots may be created for job A while GitHub assigns job B to the resulting runner. B is then claimed through the start fence; A remains unexecuted demand. This avoids unsafe job rebinding and preserves at-most-once job identity.

### 9.2 Deterministic JIT lifecycle

- Runner name is `hobo-<runner-slot-uuid>`.
- JIT configs are minted centrally; workers never receive App keys or reusable registration tokens.
- Binding credentials are random, single-use, slot-scoped, and stored only as hashes by the controller.
- JIT and binding responses use `Cache-Control: no-store` and are never logged.
- If JIT generation is ambiguous, reconcile by deterministic runner name before any second registration attempt.
- A same-named foreign runner causes quarantine; never adopt by name alone without validating scope and observed identity.

### 9.3 Official pre-job start fence

Every strict runner image contains an immutable `ACTIONS_RUNNER_HOOK_JOB_STARTED` hook outside the workspace. The official hook runs after assignment and before the job; nonzero exit prevents workflow steps and fails the job. HoBo's hook imposes its own bounded deadline because GitHub does not provide one.

The hook:

1. Reads repository, run, job, run attempt, and runner identity from the runner-provided context.
2. Presents the slot binding credential and actual job identity to the start-fence endpoint.
3. Waits for a committed authorization or idempotent prior receipt.
4. Exits zero only for that exact authorization.
5. Produces no secrets in stdout/stderr and exits nonzero on timeout, rejection, or uncertain response.

The controller verifies current assignment with GitHub using central credentials: installation/repository, job ID, run ID, run attempt, assigned runner name, status, runner group, and required execution profile. A worker-supplied local payload alone is insufficient because a malicious worker could forge it.

Implementation note: `authorizeStartFence` in `packages/ci-gh-actions/src/fleet-v2/start-fence.ts` is the parse boundary for the hook body — it zod-`safeParse`s the untrusted `unknown` input before any field is read (an `anti-slop/no-unknown-parameters` boundary waiver, mirroring `packages/ci/src/fleet-v2/parse.ts`), then cross-checks every claimed identity field against the GitHub assignment lookup.

### 9.4 Start-binding transaction

Use one global lock order: RunnerSlot → ExecutionClaim/Demand → events/outbox.

```text
BEGIN
  lock RunnerSlot by ID
  require slot.state = registered
  require slot.incarnationId = current incarnation
  require slot.profile is compatible with the actual job
  require worker/slot/provider not paused, revoked, or quarantined
  verify binding secret hash and GitHub assignment evidence

  insert ExecutionClaim(actualJobKey, slot.id, start-authorized)
    on duplicate:
      allow only idempotent retry of the same slot + same actual job
      otherwise reject

  mark RunnerSlot bound
  pin policyHash, offerId, quoteHash, and profileId
  append ci.ExecutionStartAuthorized event
COMMIT
```

The authorization response is sent only after commit. If the response is lost, an identical retry returns the prior result. A different slot attempting the same job is rejected before user steps.

### 9.5 Completion

- Provider completion and runner exit are observations, not proof of teardown.
- Settle the ExecutionClaim idempotently from corroborated provider/worker evidence.
- Stop/deregister the slot through an idempotent effect.
- Release capacity only after confirmed teardown.
- Duplicate terminal events do not settle usage or restore capacity twice.
- Cancellation is desired intent until remote stop is confirmed.

### 9.6 Fail-closed availability tradeoff

If GitHub assignment verification, the transactional store, or the start-fence endpoint cannot be reached, workflow steps must not start. The hook may retry the same idempotent request within a short bound, then fail the job. It must never allow the job optimistically and reconcile later.

### 9.7 Optional Scale Set Client demand source

The existing webhook/pull protocol remains the release demand source. If the official `actions/scaleset` adapter is included in the release, it must be a central `@hobo/ci-gh-actions` demand source feeding the same CiDemand, RunnerSlot, and ExecutionClaim contracts—not a second provisioning system or a device-side agent.

- A scale set covers only mutually compatible execution profiles and one GitHub authorization scope.
- Exactly one writer owns each scale set: the central HoBo listener or ARC.
- Reconcile from authoritative scale-set statistics, not counts of individual messages.
- Advertise only capacity that can be realized within the assignment SLA; potential cluster autoscaling is not ready capacity.
- `minRunners` consumes real capacity.
- Run continuous polling in a durable outbound worker whose deployment overlap and fencing are tested.
- Route listener messages through durable intake before RunnerSlot effects.
- If this adapter is shipped, add live scale-set failover/backlog/ownership tests to G3, G8, and G9. Otherwise record it as not included in the release manifest.

## 10. Kubernetes realization and cluster joining

### 10.1 Connection and RBAC

- Use a Station/Yard Connection for cluster identity and ownership.
- Default to namespaced Roles; no cluster-admin kubeconfig in the central controller.
- An outbound in-cluster worker may reuse the CI worker protocol when direct API connectivity is undesirable.
- Controller ServiceAccounts manage only HoBo-owned resources in approved namespaces.
- Job Pods use separate near-rightless ServiceAccounts with token automount disabled.
- No arbitrary Secret reads, foreign `pods/exec`, hostPath, hostNetwork, or privilege by default.
- Namespaces are qualified by cluster Connection; equal namespace names in different clusters are not the same tenant boundary.

### 10.2 Direct strict runner Pods

- Use deterministic names derived from RunnerSlot ID.
- Pod template includes the strict pre-job hook and required profile constraints.
- Encode node selectors, tolerations, runtime class, requests/limits, and security policy in the typed Kubernetes binding, not generic workflow labels.
- Admit initially against currently ready observed capacity. Autoscaler potential is a separate elasticity observation, not ready capacity.
- A Pending Pod is not successful dispatch and does not authorize failover.
- Eviction, node loss, and API timeouts feed reconciliation and uncertainty rules.

### 10.3 Deterministic adoption

On `AlreadyExists`, read the object and verify namespace/name, claim/slot annotations, owner reference, expected spec hash, and Kubernetes UID. Adopt only the same realization. Different UID, foreign ownership, or incompatible spec is a rejection/quarantine condition.

### 10.4 ARC

Classify each ARC binding as:

- `start-fenced` only when the runner template includes the HoBo hook and the strict conformance suite passes against the real installation.
- `external-assignment` otherwise.

ARC and a central scale-set listener may never own the same scale set. HoBo does not install/upgrade ARC during cluster join. Existing thin reconciliation remains intact.

### 10.5 Kubernetes observations

- Observations carry resource version/watermark, observed time, validity interval, and content hash.
- Watch desynchronization produces `unknown/ineligible`, not zero or full capacity.
- Do not sum informer capacity, ARC statistics, and worker reports as independent supply.
- The pure dispatcher reads persisted snapshots, never live informer state.

## 11. Dagger and multi-engine behavior

### 11.1 Dagger strict pipeline execution

- Create the ExecutionClaim before `backend.open`.
- Pin pipeline digest, account, engine endpoint, execution profile, policy, and Offer quote.
- Reuse the existing shared actor for reservation, result, uncertainty, and settlement.
- Do not reopen ambiguous work on another engine.
- Preserve positive stop-acknowledgment requirements before declaring cleanup complete.
- Native Dagger checks remain outside the strict guarantee until invoked through this actor; do not silently claim otherwise.

### 11.2 Independent multi-engine admission

Multiple Offers on one device share a CapacityGroup. Independent GitHub and Dagger claims reserve units transactionally against that group. Worker observations may report readiness but cannot raise approved capacity.

### 11.3 Nested execution limitation

A GitHub workflow invoking Dagger, BuildKit, Docker, or a remote builder directly may bypass HoBo accounting. Registration is not an ambient capability firewall. This release does not claim nested compound reservations. Document unmanaged nested execution and require explicit future composite Offer contracts before advertising hard capacity guarantees for it.

## 12. Security model

### 12.1 Trust boundaries

- The controller is trusted to admit CI and mint short-lived provider credentials; compromise is bounded by least privilege, TTLs, audit, and revocation, not claimed impossible.
- Enrolled workers are scoped realization principals, not policy administrators.
- Workflow code is untrusted relative to worker credentials and other jobs, even when repository policy trusts it to run on a persistent host.
- Kubernetes is an execution adapter, not HoBo's security foundation.

### 12.2 Credential controls

- App private keys remain central and use signing-only KMS/HSM custody where available.
- Enrollment credentials are short-lived, revocable, account/Connection scoped, and limited to session establishment and authorized observations/deliveries.
- Worker sessions require current incarnation and non-revoked binding state.
- Binding secrets, JIT configs, installation tokens, and Dagger credentials use allowlisted structured logging and secret-canary regression tests.
- Database roles separate policy/admission, start binding, realization, reconciliation, and read-only status privileges where the deployment supports them.

### 12.3 Observation and policy controls

- Observation writes are append-only/monotonic and cannot modify desired policy, provider bindings, prices, budgets, or existing claims.
- Approved capacity ceilings come from operator policy; worker claims cannot raise them.
- Policy publishing preserves spend, signals, existing claims, pauses, and leases.
- Security revocation is checked again at start binding, while already pinned financial quotes remain replay-stable.

### 12.4 Execution controls

- Trusted-local accepts only private, trusted, non-isolated jobs and rejects `isolatedRequired`.
- Public/fork/isolated-only work requires an approved isolated profile.
- Strict readiness rejects incompatible isolation classes behind one assignment label.
- Worker control APIs accept typed lifecycle operations, never arbitrary host shell commands.
- Kubernetes job Pods use restricted security contexts and default-deny network policy where required by their profile.

## 13. Recovery, failover, restore, and reconciliation

### 13.1 Ordinary controller failover

- Correctness comes from primary-store constraints and conditional mutations, not a one-replica assumption.
- New effect workers acquire new delivery fences.
- Durable repair scans recover missed wakeups and stale deliveries.
- In-flight uncertain effects reconcile before further realization.
- No global “resume all pending” operation is permitted.

### 13.2 Worker partition

- Stop issuing new deliveries to an unhealthily observed worker.
- Do not infer remote termination from heartbeat loss.
- Already authorized jobs continue or fail according to the worker/provider; HoBo reconciles evidence.
- No new start for that job is authorized automatically.

### 13.3 Backup restore

After every restore:

1. Mint a new ControllerIncarnation.
2. Invalidate previous worker sessions and slot binding credentials.
3. Quarantine every provider scope whose post-backup state is not proven complete.
4. Preserve all restored claim tombstones and fences.
5. Reconcile GitHub runners/jobs, Kubernetes objects, Dagger sessions, and worker evidence.
6. Resume admissions only after a complete reconciliation watermark for that scope.

Never expire all claims and reissue them. Never treat restored demand as proof that no post-backup claim exists. If complete reconciliation is impossible, leave the scope quarantined and require an audited operator decision.

### 13.4 Reconciliation sources

Use three-way evidence where applicable: HoBo records, provider state, and worker state. Divergence creates explicit repair evidence and alerts. Automatic repair is limited to operations whose safety is established by the effect contract; all others remain quarantined/uncertain.

### 13.5 Clocks and expiry

- Use authoritative database time for claim/delivery comparisons.
- Treat worker timestamps as observations with skew bounds.
- TTL controls delivery ownership only; it never converts execution uncertainty into runnable demand.

## 14. Implementation map

Exact filenames may follow repository conventions, but package ownership and generated-contract rules are mandatory.

### 14.1 `@hobo/ci`

Add versioned strict-v2 contracts and implementation for:

- Job identity and execution-profile parsing.
- Demand, ExecutionClaim, CapacityGroup, Effect, Outbox, WorkerDelivery, Observation, and Incarnation records.
- Closed state-transition functions and rejection codes.
- SQLite/Postgres transactional methods for intake, capacity reservation, delivery, start binding, completion, restore quarantine, and reconciliation.
- Golden replay/upcasters and store-conformance suites.
- Dagger pipeline integration through the existing scheduler actor.
- Read models for status/explain; do not derive API responses directly from mutable worker DTOs.

Do not modify dispatcher v1 hashes, sentinel behavior, persisted v1 lease meaning, or existing replay output.

### 14.2 `@hobo/ci-gh-actions`

Add:

- Demand identity normalization across webhook, pull, repair, and future scale-set intake.
- RunnerSlot provisioning and deterministic-name reconciliation.
- Central JIT claim and slot binding credential issuance.
- Strict runner pre-job hook and assignment verifier.
- Runner image packaging and preflight that proves the hook is present and immutable to the workspace.
- Worker enrollment for trusted-local and isolated-container realization.
- Guarantee classification for existing providers and ARC bindings.
- Actual-assignment evidence mapped into strict ExecutionClaims without breaking legacy accounting.

### 14.3 Existing worker implementation

Refactor only where necessary to share:

- Enrollment/session renewal and revocation.
- Fenced effect delivery.
- Typed realization and cleanup.
- Health/capability observations with monotonic sequence numbers.
- Pause, drain, revoke, and quarantine behavior.
- Local recovery journal as a cache/evidence source, never as a second shared-fleet authority.

Standalone SQLite behavior remains supported as a separate single-authority mode. Fleet workers require the shared transactional store.

### 14.4 Kubernetes provider adapter

Add or complete:

- Connection setup and observation-only join.
- Least-privilege Role/RoleBinding and optional in-cluster worker assets.
- Direct strict runner-Pod realization and deterministic adoption.
- Ready-capacity observations and watch-desync handling.
- ARC guarantee classification and strict-template conformance.
- Namespace-qualified audit and status evidence.

### 14.5 `@hobo/ci-dagger`

Make only the integration changes required to:

- Admit through strict ExecutionClaims.
- Bind the existing backend to the admitted operator-owned engine endpoint.
- Preserve positive stop acknowledgment and uncertainty behavior.
- Report readiness without implying live connectivity or budget authorization.

Do not move lease, cost, scheduler, or event ownership into this package.

### 14.6 SDK/status/documentation

Extend the existing account client and SDK policy surfaces; do not create a second remote API. Add:

- Worker/cluster enrollment and binding status.
- Execution guarantee and profile visibility.
- Demand/slot/claim/effect explanations with sensitive fields redacted.
- Pause/drain/revoke/quarantine operations.
- Restore/quarantine runbooks and production-readiness evidence documentation.

## 15. Single-pass parallel swarm plan

### 15.1 Integration model

Use one integration owner and explicit file ownership. The integration owner is the only agent allowed to change shared contracts after the contract freeze. Every workstream begins by writing its contract/adversarial tests from this document, then implements to those tests.

This is one continuous delivery with frequent small integrations, not one big-bang merge. Agents must not rewrite another workstream's state machine, weaken a test to obtain green, or mark an external gate passed from a mock.

### 15.2 Stage A — baseline and contract freeze

The integration owner and contracts workstream:

1. Pin the baseline SHA and run existing relevant tests.
2. Capture current v1 golden replay and standalone worker behavior.
3. Translate Sections 7–13 into Protobuf/CUE fixtures and SQL invariants.
4. Define package/file ownership and PACT boundaries.
5. Publish the state-transition table and rejection vocabulary to all agents.
6. Freeze the contracts unless an adversarial finding requires an integration-owned amendment.

No provider implementation begins with an unversioned private interpretation of claim or effect records.

### 15.3 Parallel workstreams

| Agent | Ownership | Required outputs | Primary dependencies |
| --- | --- | --- | --- |
| A. Contracts/model | `@hobo/ci` data models, generated fixtures, state machines, rejection codes | Schemas, CUE, valid/invalid fixtures, upcast plan, v1 golden corpus | Baseline only |
| B. Transactional stores | SQLite/Postgres strict-v2 store methods and migrations | Unique constraints, CAS/fenced mutations, outbox, lock ordering, store conformance | A |
| C. GitHub strict path | Demand normalization, RunnerSlots, JIT, pre-job hook, assignment verification | Strict GitHub lifecycle and GitHub-facing contracts | A, B |
| D. Worker enrollment | Trusted-local/isolated worker enrollment, delivery, drain/revoke, observations | Shared-fleet workers using existing realization | A, B; C for GitHub effects |
| E. Kubernetes | Join/RBAC, direct Pod realization, observations, ARC classification | Real-cluster adapter and security assets | A, B; C hook contract |
| F. Dagger/capacity | Dagger actor integration and shared device CapacityGroups | Strict Dagger admission and multi-engine accounting | A, B |
| G. Recovery/security | Reconcilers, incarnation/restore quarantine, audit, credential boundaries | Crash recovery, restore runbooks, security controls | B–F contracts |
| H. SDK/operator UX | Existing account client, enrollment/status/explain, docs | Operator journeys and truthful readiness | A–G public contracts |
| I. Independent verification | Fault harness, model-based tests, E2E, soak, security canaries | Independent evidence and defect reports | Tests written from A; execution against B–H |
| J. Integration/release | Merge order, migrations, deployment, evidence manifest, final remediation | Integrated release candidate and readiness report | All |

### 15.4 Suggested integration order

1. A merges contracts and baseline fixtures.
2. B merges store skeleton and conformance harness.
3. C, D, E, F implement independently against the frozen store API.
4. I runs contract tests continuously and injects failures at every new effect boundary.
5. G integrates recovery and security across all providers.
6. H integrates operator journeys while APIs are stable.
7. J performs migration, deployment, live acceptance, and final defect burn-down.

Frequent integration is required after each vertical slice: intake → reservation → effect → realization → start fence → settlement.

## 16. Mandatory test and adversarial matrix

### 16.1 Contract and replay

- Protobuf/CUE generated artifacts are drift-free; valid/invalid fixtures pass.
- v1 golden replay is byte-identical.
- v2 decisions pin policy, Offer, capacity, profile, and claim schema hashes.
- Observation publishers cannot mutate desired policy or bindings.
- No live provider, clock, environment, or unordered iteration affects pure decisions.

### 16.2 Transaction and fencing

`packages/ci/test/fleet-v2-store-conformance.test.ts` executes every case below against both SQLite and PostgreSQL. PostgreSQL uses a digest-pinned Testcontainers server; `HOBO_CI_TEST_POSTGRES` can name a disposable external server when no container runtime is available.

| Case | Required result |
| --- | --- |
| Two admissions race for one capacity unit | Exactly one reservation commits |
| Duplicate intake across webhook/pull/repair | One CiDemand |
| Two workers race for one effect | One active delivery/fence |
| Stale worker renews or acknowledges | No mutation |
| Worker observation sequence regresses | Rejected without state change |
| Capacity sequence changes before commit | Admission conflict and safe re-evaluation |
| Policy changes during admission | Old snapshot rejected or explicitly pinned according to contract |
| Completion delivered twice | Usage/capacity settle once |

### 16.3 GitHub start fence

| Case | Required result |
| --- | --- |
| Two slots present the same actual job | One start authorization; the other cannot run steps |
| Same slot repeats a lost binding request | Same idempotent result |
| Same slot presents two jobs | Rejected and quarantined |
| Worker forges job identity | Central GitHub verification rejects it |
| Revoked slot/worker presents a job | Rejected before steps |
| Assignment changes after reservation but before start | Actual compatible job is claimed; original demand remains unexecuted |
| Actual job has incompatible profile | Rejected before steps and surfaced as configuration/routing failure |
| Controller unavailable | No user steps execute |
| GitHub verification unavailable | No user steps execute |
| Claim committed but response lost | Idempotent same-slot retry succeeds |
| Runner exists under expected name after timeout | Adopt only after scope/identity verification |
| Foreign runner has expected name | Quarantine; never adopt |

### 16.4 Worker and multi-engine

- Twenty enrolled workers observing one queued job produce one demand and no independent local-authority launches.
- A standalone SQLite worker cannot join shared-fleet admission.
- Trusted-local rejects public, fork-PR, isolated-only, and `isolatedRequired` jobs.
- Pause, drain, revoke, and quarantine have distinct tested behavior.
- Two engines on one CapacityGroup cannot exceed approved units.
- Worker-reported capacity cannot exceed operator-approved ceilings.
- Existing standalone single-worker behavior remains unchanged.

### 16.5 Kubernetes

- Minimal Roles perform all required operations without wildcard or cluster-admin.
- Job Pod cannot read worker credentials, foreign Secrets, or use unauthorized Kubernetes APIs.
- `AlreadyExists` with same identity adopts/reconciles; different UID/spec rejects.
- Pending Pods do not produce start authorization or blind failover.
- Watch desync makes capacity unknown/ineligible.
- Eviction and node loss retain uncertainty until external evidence settles.
- ARC without the validated hook is classified external-assignment.

### 16.6 Crash cuts and restore

Inject crashes at minimum:

1. After intake commit before response.
2. After capacity reservation before outbox commit (transaction must roll back).
3. After outbox commit before wakeup.
4. After worker delivery before external call.
5. During the external call before any provider mutation.
6. After provider mutation before response.
7. After response before effect confirmation.
8. After JIT generation before registration persistence.
9. After start-claim commit before hook response.
10. After workflow start before running observation.
11. During cancellation before remote stop.
12. After remote stop before capacity release.
13. During controller primary failover.
14. During worker partition and reconnect.
15. After restoring a backup older than an actual job start.

For every cut, prove the forbidden transition does not occur and the reconciler either converges with evidence or leaves a visible uncertain/quarantined state.

### 16.7 Model-based verification

Generate random interleavings of intake, reservation, delivery, expiry, provisioning, assignment, binding, cancellation, completion, failover, and reconciliation. Assert:

- No two distinct RunnerSlots hold start authorization for one job key.
- No ExecutionClaim transitions to pending/runnable after start authorization or uncertainty.
- No stale delivery fence mutates state.
- No CapacityGroup is intentionally over-reserved.
- No terminal settlement occurs twice.
- No restore incarnation accepts prior worker/binding credentials.

## 17. Deployment and operational requirements

### 17.1 Controller

- Use the selected HoBo CI hosting/durable-store architecture; do not introduce local SQLite authority inside stateless managed Functions.
- HTTP intake commits durable state before success.
- Durable repair uses bounded batches, persisted cursors/due times, and safe overlapping invocations.
- With dependencies healthy, preserve the selected five-minute repair target and existing webhook latency goals.
- Keep customer CI commands out of API, ledger, and credential-bearing controller processes.

### 17.2 Migrations and compatibility

- Add strict v2 beside v1; do not rewrite old lease/event bodies.
- Provide generated upcasters where read models require them.
- Existing in-flight v1 leases drain under v1 settlement.
- A feature/policy flag controls strict-v2 activation per account/execution profile.
- Rollback stops new v2 admissions but does not erase claims or blindly roll back schema while v2 effects remain active.
- Document restore and rollback interactions with incarnation/quarantine.

### 17.3 Observability and alerting

Metrics/events must retain account, engine, Offer, profile, worker/cluster binding, and guarantee dimensions without exposing secrets. Alert on:

- Start-fence rejection or conflicting claim.
- Foreign deterministic runner/Kubernetes object.
- Stale-fence or stale-observation attempt.
- Token-mint anomaly.
- Stuck demand approaching provider queue expiry.
- Old uncertain effects and unreleased capacity.
- Reconciliation watermark lag.
- Worker/cluster supply unhealthy while controller remains ready.
- Restore/quarantine state and incomplete reconciliation.

### 17.4 Operator documentation

Document:

- Standalone versus shared-fleet admission.
- Trusted-local versus isolated execution.
- Strict versus external-assignment guarantees.
- Cluster join/RBAC and ARC classification.
- Multi-engine fixed capacity units and nested-execution limitation.
- Pause/drain/revoke/quarantine.
- Backup restore and manual retry policy.
- Why fail-closed start authorization can fail a job without running steps.

## 18. Production-readiness gates

All gates are mandatory for the corresponding shipped feature. A skipped gate is red, not “not applicable,” unless the feature is explicitly removed from the release manifest. Record commands, commit SHA, artifact/image digests, logs, and evidence locations for every gate.

### G0 — Baseline preservation

- Existing repository checks relevant to changed files pass.
- Existing CI/dispatcher/store/adapter suites pass.
- v1 golden replay and persisted lease semantics are unchanged.
- Standalone single-worker behavior is demonstrated unchanged.

### G1 — Contract and migration verification

- Generated Protobuf/CUE/JSON Schema artifacts are current and drift-free.
- Strict-v2 schemas, fixtures, upcasters, and rejection codes pass.
- SQLite and PostgreSQL migrations apply from the supported prior release.
- Migration, rollback, and in-flight v1 drain behavior are tested.

### G2 — Transactional store conformance

- Every test in Sections 16.1 and 16.2 passes against both store adapters.
- Tests run with independent controller/worker processes, not only function calls in one process.
- No claim decision uses a read replica or non-primary stale state.

### G3 — Strict GitHub production-shaped E2E

Using the real transactional store, real worker processes, the official Actions runner, and a strict GitHub API test double for deterministic faults:

- Exercise webhook and pull intake, capacity reservation, JIT lifecycle, actual assignment, pre-job authorization, completion, and teardown.
- Force the assigned job to differ from the demand that triggered each tested slot.
- Race multiple slots for one job and prove only one workflow-step marker is written.
- Verify fail-closed behavior for controller/GitHub verification outages.
- Verify lost hook responses, revoked workers, stale fences, and duplicate completion.

A GitHub API double is appropriate for deterministic fault injection but does not satisfy G9 live acceptance.

### G4 — Enrolled device E2E

On real Linux x64 worker hosts or production-equivalent VMs:

- Run trusted-local jobs without Docker and prove isolation-required jobs are refused.
- Run isolated-container jobs through the existing worker.
- Enroll multiple workers against one shared store and prove no independent-poller duplicate admission.
- Exercise pause, drain, revoke, restart, reconnect, and local evidence recovery.
- Run two engine Offers on one CapacityGroup and prove the configured unit ceiling is not exceeded.

### G5 — Dagger real-engine E2E

- Run the existing real Dagger acceptance lane with the pinned CLI/engine and digest-pinned commands.
- Admit through the strict actor and verify pipeline identity/digest pinning.
- Inject ambiguous startup/cleanup and prove no automatic second engine execution.
- Verify native-check documentation does not overclaim strict coverage.

### G6 — Real Kubernetes E2E

Using a real Kubernetes API server and kubelets (production-equivalent test cluster, not only client mocks):

- Join observation-only, then enable explicit direct strict runner-Pod binding.
- Verify minimal RBAC, NetworkPolicy, Pod security, and absence of worker credentials in the job environment.
- Force Pending, eviction, node loss, API timeout, `AlreadyExists`, UID change, and watch desync cases.
- Run a real GitHub job through the strict runner Pod and pre-job fence.
- If ARC strict support is shipped, install the supported ARC version and run its full strict conformance lane. Otherwise verify it is reported external-assignment.

### G7 — Security and recovery verification

- Secret canaries never appear in logs, events, Kubernetes objects, API status, or workflow output.
- Stale fences, replayed observations, foreign objects, and cross-account bindings fail closed.
- Controller failover and every Section 16.6 crash cut pass.
- Restore an older backup after real external activity and prove new incarnation, invalidation, provider-scope quarantine, and no duplicate start.
- Verify no automatic path from `start-authorized` or `uncertain` to runnable.

### G8 — Load, soak, and operability

Run a documented soak with at least 25 simulated enrolled workers, 250 logical jobs, duplicated demand deliveries, forced assignment churn, periodic worker/controller restarts, and continuous reconciliation for at least one hour. The test workload must be bounded so it exercises controller/claim behavior rather than pretending to benchmark users' CI commands.

Release targets with dependencies healthy:

- Webhook intake p95 below two seconds and always within GitHub's documented response limit.
- Durable repair of a lost wakeup within five minutes.
- No intentional capacity over-reservation.
- No duplicate start authorization or duplicate settlement.
- No unbounded growth of active deliveries/effects; tombstone growth is measured and documented.
- Status/explain identifies every artificially queued or uncertain job and its reason.

Any target change requires an explicit design amendment and justification; do not weaken a threshold merely to finish.

### G9 — Authorized live-provider staging acceptance

Deploy a staging instance using the selected HoBo CI hosting adapter, stable HTTPS origin, real transactional PostgreSQL, durable wakeups/repair, and a dedicated test GitHub App/installation. Use only authorized test repositories and provider accounts.

Required evidence:

1. A real private trusted repository executes on an enrolled trusted-local worker.
2. A real isolated-required job executes on an isolated worker.
3. Multiple real queued jobs produce assignment churn; every job attempt writes a unique execution marker, and each marker appears at most once.
4. Duplicate real webhook deliveries do not produce duplicate execution.
5. Killing the controller before start authorization produces no workflow steps; a later manual GitHub rerun is a new attempt and succeeds at most once.
6. Killing a worker after possible JIT realization reconciles without a second runner for the same slot.
7. Worker revocation prevents subsequent starts.
8. A real Kubernetes cluster executes a strict runner-Pod job.
9. A real operator-owned Dagger engine executes the strict portable-pipeline acceptance path.
10. Staging backup/restore and rollback drills complete with quarantine and no duplicate execution.

Record deployment version, non-secret configuration digest, image digests, GitHub run/job IDs, Kubernetes cluster version, Dagger version, and log/artifact evidence. Do not mutate production repositories, production Apps, or production ledgers for this lane.

If authorized live infrastructure is not available, G9 remains red and the release remains not production-ready.

### G10 — Independent final review and evidence manifest

Independent agents who did not implement the relevant component must reproduce:

- Store conformance and claim-state model tests.
- Security/RBAC tests.
- Crash/restore suite.
- Production-shaped E2E.
- Live staging evidence validation.

The release evidence manifest contains:

- Source SHA and exact changed-file summary.
- Schema/migration versions and compatibility statement.
- Commands and results for every gate.
- Test deployment and image/config digests.
- Live-provider evidence references without credentials.
- Open defects and residual limitations.
- Operational runbooks and rollback/restore evidence.
- Explicit statement of which providers are `start-fenced` versus `external-assignment`.

No open P0/P1 defect is permitted. P2 limitations must be documented with an owner and must not contradict a guarantee advertised to users.

## 19. Implementation guardrails for the swarm

1. Do not create a second policy engine, controller ledger, or generic fleet product.
2. Do not make the dispatcher effectful or non-deterministic.
3. Do not bind a strict ExecutionClaim before the actual job identity is known.
4. Do not rely on a unique database row alone to stop workflow steps; install and verify the pre-start fence.
5. Do not use application-side check-then-act where a unique constraint or conditional mutation is required.
6. Do not put provider calls inside database transactions.
7. Do not expire execution uncertainty into runnable work.
8. Do not reissue all claims after restore.
9. Do not reuse a different deterministic runner/Pod name after an ambiguous effect.
10. Do not release capacity merely because cancellation was requested or a worker stopped heartbeating.
11. Do not allow workers to publish desired policy, approved capacity, prices, or bindings.
12. Do not place trusted-local and isolated-required Offers behind one assignment label.
13. Do not mark ARC, BuildKit, Jenkins, or a hosted third-party runner strict without a real pre-start fence and conformance proof.
14. Do not silently broaden OS/architecture support.
15. Do not silently reinterpret v1 Lease records or change v1 replay/hashes.
16. Do not install ARC/Dagger or request cluster-admin merely because a cluster joined.
17. Do not claim nested builder/engine usage is reserved when HoBo cannot observe or fence it.
18. Do not weaken, skip, or convert a failing adversarial test into a snapshot update without an integration-owned correctness review.
19. Do not mark production-ready from PACTs, fakes, act, or client-only Kubernetes tests alone.
20. Keep all credentials and live-provider evidence scoped to authorized test environments.

## 20. Final handoff instruction

Begin with Stage A and publish the contract/ownership freeze. Then run workstreams A–I in parallel with J integrating continuously. Implement the strict path vertically before expanding provider breadth:

```text
one durable demand
→ one reserved RunnerSlot
→ one fenced realization effect
→ one actual pre-job ExecutionClaim
→ one workflow-step marker
→ one idempotent settlement
```

Next add multi-worker enrollment, trusted-local and isolated-container realization, direct Kubernetes Pods, Dagger admission, shared CapacityGroups, recovery/restore, operator UX, and deployment hardening. Finish only when the independent evidence manifest demonstrates every applicable gate and all discovered defects have been remediated and retested.

The product claim at completion must be precise:

> HoBo CI can enroll heterogeneous execution capacity and join Kubernetes clusters while preserving provider-native semantics. Strict HoBo-managed execution classes use durable transactional claims and a pre-start fence to authorize each workflow job attempt at most once. External-assignment providers retain a clearly disclosed weaker guarantee. Recovery favors quarantine and evidence over duplicate execution.

## 21. Primary references

Repository references are pinned to the baseline above. Relevant external protocol references:

- GitHub Actions runner scale-set client: <https://github.com/actions/scaleset>
- GitHub Actions Runner Controller: <https://github.com/actions/actions-runner-controller>
- GitHub self-hosted runner autoscaling and JIT guidance: <https://docs.github.com/en/actions/how-tos/hosting-your-own-runners/managing-self-hosted-runners/autoscaling-with-self-hosted-runners>
- GitHub runner hook environment variables: <https://docs.github.com/en/actions/reference/runners/self-hosted-runners>
- Dagger custom runner configuration: <https://docs.dagger.io/configuration/custom-runner>
- BuildKit remote driver security: <https://docs.docker.com/build/builders/drivers/remote/>
- Jenkins inbound agent protocol: <https://github.com/jenkinsci/remoting/blob/master/docs/inbound-agent.md>
