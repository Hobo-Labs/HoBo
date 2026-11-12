---
type: One-Shot Agent Instruction
title: "HoBo.CD — design and production implementation plan: one pass, fully parallel (final)"
description: "The single, fully decided design and swarm prompt for @hobo/cd. Freight is discovered by pull from any registry or Git host, or ingested from any CI by OIDC trusted publishing or in-toto/SLSA attestation. It moves through a pipeline graph with Kargo-style lineage and Harness-style verification and freezes. Fenced pull reconcilers realize it on every platform through built-in or WASM-component resolvers. Fleets are targeted by deterministic Placement, rolled out by group under a failure budget, and failed over only as a governed saga. Rails are delivered like software (shadowed, then enforced) and checked continuously as posture. Part I holds the design, the research on Kargo, Harness, Karmada and OCM, the adversarial findings and every decision. Part II is the byte-frozen contract, 25 file-disjoint work packages dispatched at once, rolling integration, the acceptance matrix and the gates."
tags: [hobo, plans, cd, delivery, promotion, reconciliation, progressive, freight, fleet, placement, failover, policy, posture, kargo, harness, karmada, ocm, one-shot, swarm]
---

# HoBo.CD — design and swarm implementation plan (final)

**Status: decided.** Every design question is answered here: Part I §I.8 for
decisions, §I.9 and `CD_DEFAULTS` (A.6) for values. Nothing waits on the owner.

**How to use this document:**

- **Coordinator:** read all of it.
  1. Make the contract commit (Part II §11 step 0).
  2. Dispatch WP1–WP25 at the same time, each to its own subagent in its own
     worktree.
  3. Run rolling integration and the gates (Part II §7, §11).
- **Each agent:** receives the dispatch packet: Part II §1–8, Appendix A, Part I
  §I.8 and its own WP section in §9.
- **Reviewers:** read Part I.

Repo facts were verified at `e2fbbbae` (2026-11-11). Re-verify any path you
touch, and report drift instead of rediscovering the inventory.

# Part I — Design

Part I is for the coordinator and human reviewers. It explains why the design
is what it is. Part II is the prompt the swarm executes. If Part II looks
wrong, read the matching Part I section before changing anything.

## I.1 Problem and scope

HoBo already has `@hobo/ci`, which builds, verifies and produces artifacts.
`@hobo/cd` is its sibling. It moves immutable artifacts through environments
(Camps), under policy, by **pull**, on **every platform**, without depending on
any CI/CD toolset.

The owner's constraints, all binding and all met by this design:

| Constraint | How the design meets it |
|---|---|
| Pull, not push, in the style of Argo CD and Flux | Freight sources poll; webhooks only nudge a poll. Per-Camp reconcilers converge on desired state they read. |
| Route by policy configuration | Gatekeeper and the policy IR gate every Delta. Rails bind Camp sets, failover, enrollment and posture. Placement is policy-checked. |
| Canary, A/B and feature flags | Strategies are lowered onto provider traffic offerings, OpenFeature flags and `OpenExperimentEngine`, and refused honestly when nothing can realize them. |
| Every platform; no Kubernetes or OCI lock-in | Built-in resolvers plus out-of-tree WASM resolver components on the existing `ResourceResolver` seam. Kubernetes, OCI, Git hosts and vendor APMs are adapters only. |
| No dependence on a specific CI/CD toolset | Any registry or Git host by polling; any CI by OIDC trusted publishing or in-toto/SLSA. CDEvents, OpenTelemetry and CloudEvents at the edges. Argo CD, Flux, Karmada and OCM are optional targets. |
| Kargo and Harness are good approximations | Kargo-style Freight lineage plus Harness-style verification, freezes and delegate, re-expressed natively (I.2). |
| Karmada and OCM are in scope, including the policy layer | Fleet Placement, fan-out, failover, double opt-in enrollment, Rails delivered as Freight, and continuous posture (I.2, I.5). |
| A natural extension of HoBo | Built on the journal, sagas, Matching, Yards/Camps, Stations/Rails, Trails, the Harness `OpenDeliveryEngine`, `@hobo/identity` SVIDs, `@hobo/registry` provenance, the policy IR and `@hobo/yard-world`. No parallel planes. |
| Production-ready in one pass; no waves, steps or phases | Frozen contracts, single-owner files and rolling integration let all 25 work packages run concurrently. Every package carries production obligations. |

## I.2 What each reference system contributed

### Kargo (Akuity): promotion lineage

- **Taken:**
  - Warehouse → **Freight source** with forward-only pull discovery.
  - **Freight** as the promotable unit; the name fits HoBo's rail vocabulary
    and avoids the release-channel clash.
  - Stage graph → **Pipeline** graph.
  - Availability `ONE_OF`/`ALL` and `requiredSoakTime`.
  - Auto-promotion `NEWEST`/`MATCH_UPSTREAM`.
  - Qualification only from verification.
  - Expiring manual approval for hotfixes.
  - Per-Stage queue with supersession.
- **Not taken:** CRDs as the API; Git as the only write target; expression
  languages for selection; GitOps-only promotion steps.

### Harness CD: verification, freezes, delegate

- **Taken:**
  - Continuous Verification's structure: thresholds, canary versus baseline,
    fail-on-no-data.
  - Freeze windows: rules plus recurring schedule, governed bypass, and
    in-flight work finishes its current stage.
  - The delegate's outbound-only network shape.
  - Policy as code at pipeline events (already present as HoBo's policy IR).
- **Not taken:**
  - ML baselines on the decision path. They are non-deterministic; HoBo uses
    Mann–Whitney U instead.
  - A delegate that executes arbitrary tasks. HoBo's agent pulls *desired
    state* and runs only typed resolvers.
  - Shell-script custom deployments. HoBo uses sandboxed WASM resolver
    components instead.

### Karmada (CNCF Graduated, September 2026): placement and failover

- **Taken:**
  - Spread constraints, extended to `provider` and `yard`, which neither
    project can express.
  - Cluster taints/tolerations → Camp taints `NO_PLACE`/`NO_RUN`.
  - Purge modes and graceful eviction → GRACEFUL failover.
  - State preservation → declared `handover_outputs`.
  - `Retain` → retained fields.
  - `WorkloadRebalancer` → explicit `rebalance`.
  - `FederatedResourceQuota` intent → the aggregate fan-out budget check.
  - Automatic `NoExecute` is disabled; Karmada itself stopped automatic
    `NoExecute` in v1.14.
  - The visible credential-rotation failure lesson.
- **Not taken:**
  - `OverridePolicy` JSON patch and tag rewriting.
  - `Divided` replica arithmetic, since most platforms have no replicas.
  - Dynamic weights.
  - Lua and webhook interpreters.
  - A background descheduler.

### Open Cluster Management (CNCF Sandbox): inventory, rollout groups, governance

- **Taken:**
  - Double opt-in registration with two separate permissions.
  - ClusterClaims → *observed* claims that only narrow.
  - ManagedClusterSet + Binding → Camp sets bound by Rails.
  - Placement predicates, prioritizers and decision groups → deterministic
    Placement with recorded score snapshots.
  - ManifestWorkReplicaSet `All`/`Progressive`/`ProgressivePerGroup` with
    concurrency, min success time, deadline, max failures and mandatory
    groups → fan-out.
  - `feedbackRules` → declared `observe_fields`.
  - `SelectivelyOrphan` → `ORPHAN_DATA`.
  - `ReadOnly` → `OBSERVE_ONLY`.
  - One rollout type for work, add-ons and policy → **Rails delivered as
    Freight**.
  - Inform-then-enforce governance with compliance status → shadow
    evaluation plus posture.
- **Not taken:**
  - CEL condition rules and Go-template hub templates, which copy secrets to
    spokes.
  - Policy controllers that mutate targets directly.
  - MQTT/gRPC/Kafka transports; Maestro solves an etcd problem HoBo does not
    have.
  - OCM rollout or placement driving HoBo deliveries.

### Standards that keep HoBo toolset-independent

- **OIDC trusted publishing** for any issuer, as shipped by npm, PyPI,
  RubyGems and crates.
- **Provenance:** in-toto Statement v1 + SLSA provenance, verified as Sigstore
  bundles.
- **Events:** CDEvents in (nudge only) and out (`dev.cdevents.*`, with
  `dev.cdeventsx.hobo.*` for HoBo-specific facts).
- **Telemetry:** OpenTelemetry CI/CD semantic conventions.
- **Webhooks:** CloudEvents.
- **Flags:** OpenFeature.
- **Health:** the Prometheus HTTP query API.
- **Inventory:** SIG-Multicluster ClusterProfile (KEP-4322).

## I.3 Concern map

| Concern | HoBo design (decision) | Borrowed from |
|---|---|---|
| Promotable unit | Freight: content-addressed, per Bindle or Rail (D2) | Kargo |
| Ingress | Pull sources; webhook nudges; OIDC push; attestations (D3) | Kargo, npm/PyPI, in-toto |
| Promotion graph and lineage | Pipeline DAG, qualification, soak, approvals (D4) | Kargo |
| Delivery transport | Per-Camp spec/status streams; conductor, agent and publisher modes (D5) | Argo/Flux pull; Karmada/OCM execution namespaces |
| Any platform | Built-in resolvers + WASM resolver components (D6) | Harness's goal, not its mechanism |
| Progressive exposure | Lowering onto traffic rungs; flags; experiments (D7, D8) | Argo Rollouts / Flagger concepts |
| Verification | Deterministic thresholds, Mann–Whitney U, probes, fail on no data (D9) | Harness CV |
| Freezes | ALLOW/FREEZE windows with RRULE (D10) | Harness |
| Data changes | Trails expand → shift → contract (D11) | HoBo-native |
| Fleet inventory and trust | Conditions, observed claims, taints, double opt-in (D19) | OCM, Karmada |
| Fleet targeting | Camp sets + deterministic Placement (D20) | OCM Placement, Karmada spread |
| Fleet rollout | Fan-out: groups, concurrency, failure budget, quorum (D21) | OCM MWRS |
| Per-target values | Camp topology properties; digest-preserving mirrors; retained fields (D22) | Karmada (re-expressed) |
| Failure handling | Governed failover and explicit rebalance (D23) | Karmada |
| Policy rollout | Rails as Freight; INFORM shadow → ENFORCE (D24) | OCM |
| Continuous compliance | Posture from observations; repair Deltas only (D25) | OCM governance |
| Existing Kubernetes fleets | `@hobo/cd-kube-fleet` as transport and inventory only (D26) | ClusterProfile, OCM, Karmada |

## I.4 Adversarial findings this design closes

Earlier drafts were attacked; each finding is closed by a decision.

- **Principle violations**
  - Push-only ingress → D3.
  - HoBo-only evidence, telemetry and approvals → D3, D17.
  - In-repo-only platform coverage → D6.
  - A bespoke agent crypto scheme → D5: JWT-SVID + DPoP.
  - A mandatory HoBo manifest → D3: in-toto subjects suffice.
- **Contract bugs**
  - B1: a lease keyed by reconciler broke single-writer → keyed by Camp.
  - B2: spec and status in one stream contended → split.
  - B3: plans inlined in events → content-addressed blobs.
  - B4: a synchronous resolved-set read → async.
- **Model gaps**
  - No lineage → D4.
  - A duplicate imperative step runner → hooks.
  - Boolean verification → D9.
  - No freezes → D10.
  - No config-only path → D2 intent `config`.
  - Migrations only a rollback boundary → D11.
  - No retention → D18.
  - No visibility → WP12, WP19.
  - No per-Camp queue → D4.
- **Fleet and policy gaps**
  - C18: explicit Camp lists only → D20, D21.
  - C19: no Camp liveness or failover → D19, D23.
  - C20: single-approval enrollment; trusted self-reports → D19.
  - C21: Rails activate everywhere at once → D24.
  - C22: admission-only policy → D25.
  - C23: no Kubernetes-fleet interop → D26.
- **Risks the fleet and policy additions introduced, and their mitigations**

  | Risk | Mitigation |
  |---|---|
  | Fan-out scale | Per-fan-out lease; independent per-Camp sagas; a 10,000-Camp load gate. |
  | Offline Camps burning the failure budget | They are *deferred*, not failed. |
  | Agents faking conditions to force failover | Self-reports never add `NO_RUN`; ≥2 signals, one Station-observed; a Rail concurrency budget. |
  | Lying claims attracting regulated data | Claims only narrow; residency uses declared regions. |
  | Failover flapping | No automatic failback. |
  | Failover exporting data | Compute-only, residency re-checked, `failover-unsafe`. |
  | Shadow evaluation cost | Only while a candidate is bound; benchmarked. |
  | Posture fighting delivery | Ownership check, `ownership-conflict`. |
  | Policy rollout bricking the fleet | INFORM gate, fan-out, rollback always allowed. |
  | Kubernetes leaking into core | Adapter package; I11 scan; single-cluster pinning. |
- **Process risks**
  - Late contract discovery → frozen contract committed before dispatch,
    rolling integration, coordinator-only amendments.
  - Prompt size → dispatch packets.
  - Unbalanced packages → 25 balanced packages.
  - Shallow "production-ready" → per-package production obligations.

## I.5 The seam between CD and the policy layer

**Policy decides what is allowed and what compliant means. CD moves versions,
including policy versions, and is the only thing that changes targets.**

| Concern | Policy layer (`@hobo/policy`; Rails in `@hobo/stations`; Gatekeeper in `@hobo/contracts`) | CD (`@hobo/cd`) |
|---|---|---|
| Which Camps a Station may target | Rail `delivery.camp_sets` (opaque JSON inside the Rail digest) | Placement reads it as `RailDeliveryRecord` |
| Residency, budget, entitlements | `@hobo/core` residency; budget and entitlement authorities; Gatekeeper | Placement and the gate evaluate and record |
| Failover permission | Rail `delivery.failover` | The failover saga executes within it |
| Enrollment approval rules | Rail `delivery.enrollment` | Enrollment enforces double opt-in |
| Posture rules, compliance semantics, OSCAL | `@hobo/policy/posture`: pure and dependency-free | Supplies observations; records compliance; proposes repair Deltas |
| Rail versions | Authoring, approval, digest | Discovery, promotion, shadow, enforce, rollback |
| Mutation of targets | Never | Reconcilers only |

## I.6 Walkthroughs

1. **Any CI, any observability vendor.**
   - GitHub Actions pushes an image to GHCR with `actions/attest`. HoBo polls
     (or is nudged), verifies the Sigstore bundle, and records Freight.
   - dev → staging → prod run under lineage, soak, approval and windows.
   - prod canaries on the best traffic rung for each Camp and verifies against
     Datadog through a `HealthSource`. No data means FAIL.
   - CDEvents and OTel spans reach the team's tools.
   - Rollback is a Delta. It is refused past a completed Trails contract, with
     the compensating expand named.
2. **Retail edge fleet: 400 stores.**
   - Agents enroll with a set-scoped token that the Rail auto-accepts.
   - A placed node runs `PROGRESSIVE_PER_GROUP` with a pilot group, a 2%
     failure budget and 95% quorum.
   - Offline stores are deferred and caught up later.
   - A bad group halts and rolls back only its failed Camps.
   - A new Rail runs INFORM, finds 6 noncompliant stores, and fails its gate.
     After the fix, it is enforced group by group.
3. **Multi-cloud active-active outage.**
   - AWS eu-west loses its lease and its health source. Two signals plus Rail
     permission produce `NO_RUN`.
   - After the toleration lapses, one governed failover selects Azure
     westeurope (same jurisdiction). It promotes the node's qualified Freight,
     verifies, cuts traffic over, and purges GRACEFUL with `ORPHAN_DATA`.
   - If the database had lived in the failing Camp, the result would be
     `failover-unsafe`.
   - Nothing fails back until someone requests `rebalance`.
4. **Brownfield OCM estate.**
   - ClusterProfiles are imported as `OBSERVE_ONLY` Camps, and posture runs at
     once.
   - Promoted Camps realize through single-cluster ManifestWorks.
   - HoBo's fan-out, verification and rollback govern. ManifestWorkReplicaSet
     is never used.

## I.7 Rejected alternatives

| Option | Why rejected |
|---|---|
| Embed or wrap Kargo, Argo Rollouts, Harness, Karmada or OCM as the engine | Toolset and Kubernetes dependence; a second scheduler and rollout engine. They remain interop targets. |
| Any expression or scripting language (Kargo expressions, CEL, Lua, Go templates) | Plan 0015 forbids it; breaks determinism and replay. Typed operators and WASM components instead. |
| ML baselines | Non-deterministic. Mann–Whitney U is the deterministic equivalent. |
| Shell-script resolvers, including an agent-only escape hatch | Untyped and unsandboxed. WASM components, agent-local bridge endpoints and typed runbook hooks cover the need (decision R2). |
| JSON-patch overrides; tag rewriting | The effective state would differ from what was recorded; breaks "promote, never rebuild". |
| Release trains across Bindles | The compatibility gate already prevents bad combinations. |
| A separate imperative pipeline engine | Two models for one job. Hooks suffice. |
| Background rescheduling; automatic failback | Unrequested churn and flapping. |
| Posture evaluated inside agents | Self-certification. Agents report facts only. |
| Broker transports (MQTT, gRPC, Kafka) | Solve a problem HoBo lacks; add an operated dependency. |
| Selector expansion at pipeline-apply time | Silent membership drift; nothing recorded. |

## I.8 Decision register (nothing is left open)

| # | Question | Decision |
|---|---|---|
| R1 | Name of the promotable unit | **Freight**. Other terms: **Placement** (selects Camps), distinct from **Matching** (selects providers and resolvers within a Yard); **Fan-out**; **Posture**; **Camp set**. The broker's `yard-placement` module keeps its name. |
| R2 | Shell-script escape hatch, even agent-only | **None.** Imperative needs use RUNBOOK hooks through the existing `RunbookExecutor`, or a WASM resolver component that calls an agent-local bridge endpoint (the `sftp-static` reference shows the pattern). |
| R3 | Where the ADR lands | **ADR-0178** in `docs/design/adr/01-architecture-core.md` (theme: architecture, matching and environments, where Deployment Sets already live), with a row in `docs/design/adr/index.md`. One ADR records D1–D26. |
| R4 | Branching and landing | The coordinator cuts `integration/hobo-cd` from `origin/main` and makes the **contract commit**: this document plus every Appendix A file plus generated code. Every WP branch `cd/wp<NN>-<slug>` starts from that commit. Landing follows the repo `sdlc` skill as one PR from `integration/hobo-cd`. |
| R5 | Plan documents | This file is the only plan document. The two earlier review files are folded into Part I and deleted. |
| R6 | Store topology | SQLite for single-node (`hobo up`, local, one conductor). Postgres (minimum PostgreSQL 16) is required when `hobo serve cd` runs more than one replica or any agent fleet exceeds one Station process. |
| R7 | Agent distribution | The agent is `hobo deploy agent run` from the existing CLI distribution. There is no separate image or binary. The air-gapped example shows offline installation. |
| R8 | Standards versions | WP16 pins the latest released CDEvents spec and WP19 the latest released OTel semantic-conventions tag that exist on the dispatch date. Each records it in `packages/cd/src/{boundary,telemetry}/STANDARDS.lock.json`, and golden tests are generated against it. Upgrades are ordinary later changes. |
| R9 | `hobo down` semantics | Unchanged: the existing teardown and `DownResult`. `ORPHAN_DATA` is the default only for fleet departure and failover purge. |
| R10 | Default availability | `ONE_OF` for list nodes (as Kargo); `QUORUM` 95% for placed nodes. |
| R11 | Ramp defaults | `CD_RAMP_DEFAULTS` in A.6: canary `[5, 25, 50, 100]`, blue/green `[100]` after verification on the idle side, experiment `[50]` held until concluded. These replace the three ramp vocabularies. |
| R12 | INFORM-node verification default | Pass only with a noncompliant ratio ≤ 2% **and** 0 shadow divergences over 24 h. A Rail intended to block something must declare its expected divergence in its node's `VerificationSpec`, so impact is acknowledged explicitly. |
| R13 | Failover default | Off (`automatic: false`). Each Rail opts in. When on: `max_concurrent: 1`, `required_signals: 2`, GRACEFUL purge, 30-minute grace. |
| R14 | Enrollment default | Two grants from separate principals. Auto-accept only for scopes the Rail lists. |
| R15 | Proof promotion list | Exactly the list in §3 of Part II. Nothing else is promoted in this change. |
| R16 | Live lanes | Vercel, Cloudflare and one Prometheus-backed verification, credential-gated; plus the `kind` lane for `@hobo/cd-kube-fleet`, gated on availability. All skip with a visible reason. |
| R17 | Every numeric default | `CD_DEFAULTS` in A.6 (frozen). The table in I.9 is generated from the same values. |

## I.9 Defaults register (mirrors `CD_DEFAULTS` in A.6)

| Area | Default |
|---|---|
| Reconciler lease | TTL 30 s, renew every 10 s; `REACHABLE=false` after 90 s without contact |
| Delivery feed | SSE heartbeat 15 s; long-poll 55 s; inline resolved set ≤ 256 KiB |
| Agent identity | SVID TTL 15 min, refresh 5 min before expiry; `CREDENTIAL_VALID=false` when < 2 min remain unrefreshed; DPoP clock skew ±60 s; bootstrap token TTL 1 h (max 24 h), single use |
| Freight sources | Poll every 5 min (minimum 30 s); backoff 1 s → 10 min; discovery limit 20 per poll |
| Service | Tick every 1 s |
| Verification | Window 10 min; ≥ 3 observations; deadline 30 min; sensitivity MEDIUM (α 0.05); fail on no data; probe timeout 5 s |
| Approvals and windows | Approval TTL 24 h; hotfix approval ≤ 72 h; window override ≤ 4 h |
| Retention | Keep 5 per Camp; retire unpromoted Freight after 30 d; delete unreferenced blobs after 7 d |
| Fan-out | `PROGRESSIVE_PER_GROUP`; group size 10%; concurrency = group size; min success 5 min; deadline 30 min; max failures 5%; rollback on halt; quorum 95% |
| Placement and inventory | `NO_RUN` toleration 5 min; score snapshot validity ≤ 24 h; `max_fanout_camps` 1,000; `required_signals` 2 |
| Failover | Automatic off; `max_concurrent` 1; GRACEFUL; grace 30 min; departure `ORPHAN_DATA` |
| Posture | Compliant interval 1 h; noncompliant interval 5 min; attributes ≤ 16 KiB per resource; remediation `inform`; INFORM window 24 h, ≤ 2% noncompliant, 0 divergences |
| Resolver components | 128 MiB memory; 30 s per call; 10⁹ fuel; ≤ 32 allowlisted hosts |
| Outbound webhooks | 8 attempts; backoff 1 s → 5 min; then dead-letter |
| Postgres | PostgreSQL ≥ 16; statement timeout 5 s; pool 10 |


# Part II — Swarm prompt

Everything below the rule is the prompt.

---

## 1. Mission

Ship `@hobo/cd`, the delivery sibling of `@hobo/ci`, production-ready, in one
concurrent pass.

- **CI** builds, verifies and produces artifacts. It can be *any* CI.
- **CD** discovers or accepts immutable **Freight**, moves it through a graph
  of Camps under policy, and makes each Camp converge by pull. It exposes
  changes progressively, verifies them, and rolls them back.

There are no waves, phases or deferred residuals. All twenty-five work packages
(§9) are dispatched at the same time, each to its own subagent in its own git
worktree. This works because shared contracts are frozen verbatim (Appendix A)
and every other touched file has exactly one owner (§8). Integration is
continuous, not a stage (§7.4).

### Production-ready means all of these

- **One path.** `hobo up`/`down`, `hobo deploy *`, broker `deliver`, pipelines,
  MCP and agents all deliver through `@hobo/cd`.
- **Toolset-independent.** No CI system, registry, Git host, observability
  vendor, GitOps engine or orchestrator is required.
  - Freight enters by pull (registry/Git/package/HTTP polling), by any OIDC CI
    (trusted publishing), by in-toto/SLSA attestation, or by inbound CDEvents.
  - Status leaves as CDEvents, OTel CI/CD spans and metrics, and CloudEvents
    webhooks.
  - Every vendor integration is an adapter behind a port.
  - An existing Karmada or Open Cluster Management hub, or a SIG-Multicluster
    ClusterProfile inventory, can be used as a transport and inventory for
    Kubernetes Camps. None is ever required.
- **Durable.** Everything rebuilds from the journal, on SQLite (single node) or
  Postgres (multi-node). Every new event body has a golden upcaster corpus
  entry.
- **Concurrency-safe.** Per-Camp fenced leases, idempotent commands,
  at-least-once delivery tolerated.
- **Secure.** Policy authorizes every mutating action. Agents hold key-bound
  JWT-SVIDs and prove possession on each request (DPoP). Credentials stay where
  the reconciler runs, and resolver components never see secrets. Webhooks
  trigger polls; they never create Freight. Records are secret-free.
  Everything is audited.
- **Fleets.** A pipeline node can target a deterministic **Placement** over
  Rail-bound Camp sets instead of a Camp list.
  - It fans out group by group under a concurrency limit and a failure budget,
    and qualifies downstream on quorum.
  - It treats unreachable Camps as deferred, not failed, and catches them up
    later.
  - It fails over from tainted Camps only as a governed, residency-checked saga.
- **Policy is delivered and observed.**
  - Rail versions are Freight. Each is shadowed (INFORM) and then enforced
    through the same pipelines, fan-out, windows and rollback.
  - Posture is evaluated continuously from reconcile observations and reported
    as compliance and OSCAL assessment results.
  - Enforcement acts only through repair Deltas applied by reconcilers.
- **Every platform.** Every hosting provider has a realization path and a
  traffic profile, or refuses with a typed reason. Any other platform is
  reachable with an out-of-tree `hobo:resolver` WASM component, with no change
  to HoBo.
- **Observable and operable.** DORA four keys, reconcile lag, Freight timeline,
  pipeline graph and promotion/rollout status as projections, APIs, SSE, CLI,
  MCP and yard-world views. Health and readiness. Runbooks.
- **Recoverable.** A crash anywhere resumes by observation. Rollback is always
  available, or refused with the compensating action named. Drift is detected
  and routed.
- **Proven.** PACT on every boundary, CUE constraints, conformance suites, a
  platform matrix, chaos, the mutation policy, a feed load test, and
  credential-gated live lanes for Vercel, Cloudflare and one Prometheus-backed
  verification.

## 2. Owner constraints (binding)

1. **Pull, not push.** Discovery pulls from artifact sources. Targets converge
   on desired state they read. Nothing imperative applies a delivery change
   outside a reconciler.
2. **Every platform; no toolset dependence.** No Kubernetes, OCI, Git host,
   CI vendor or GitOps-engine assumption in the core. Those are adapters.
3. **A natural extension of HoBo.** Build on the event-sourced control plane,
   Matching, Yards/Camps, the WIT/WASM membrane, the Harness, Station routing,
   Trails, `@hobo/identity` SVIDs, `@hobo/registry` provenance and the policy
   IR. Do not add parallel ones.
4. **Best of Kargo, Harness, Karmada and OCM without their lock-in.** Take
   their semantics, never their APIs or runtimes (Part I §I.2).
5. **Everything is decided.**
   - Use the values in this prompt, `CD_DEFAULTS`/`CD_RAMP_DEFAULTS` (A.6)
     and Part I §I.8.
   - If something is still unspecified, choose the most conservative option
     consistent with the invariants (fail closed, smallest blast radius,
     reversible). Record it in your report. Never leave it open, and never
     wait for the owner.

## 3. Verified inventory

| Area | Where | State |
|---|---|---|
| CI fabric | `packages/ci`, `packages/ci-*` | Allocation routing, pipeline backends, change feed `eventsSince`. Pipeline outputs ≤16 × 1 MiB. Long-running host pattern: `ci-gh-actions/src/relay-host.ts`, `service.ts`. |
| CD plane | `packages/cloud/src/cd/*`, test `packages/cloud/test/cd-plane.test.ts` | Fixture/simulate only. `progressive-cd.ts` fails open (`healthSamples ?? [{}, {}]`). `cd-plane.ts` rollback never re-applies the prior Set. |
| `hobo up` | `packages/cli/src/cloud/yard-client.ts`, `packages/cli/src/commands/{up,down,build}.ts` | Emits `deployment.Planned/Deployed/RolledBack`. |
| Hosting transitions | `packages/cloud/src/hosting-transition/*` | PREPARE/SHIFT/VERIFY/RESTORE/RETIRE/SETTLE; observation-driven. |
| Resolver hosting provider | `packages/hobo/src/resolver-hosting-provider.ts` | `HostingTransitionProvider` over `ResourceResolver` + `TrafficRoutingPort`. |
| Resource resolvers | Port `core/src/ports/resource-resolver.ts`. Registered in `packages/hobo/src/provider-hosting-catalog.ts` | aws, azure, cloudflare, digitalocean, gcp, hetzner, hostinger, kubernetes, netlify, vercel. **None** for railway, convex, flux, webernetes, lakebed, browser-wasm. |
| Traffic routing | Port `core/src/ports/traffic-routing.ts`, offerings `traffic-routing-offerings.ts`. Adapters `connectivity/src/traffic-routing/*`; built-in profiles `profiles.ts`; 9 provider profiles | Partial coverage. |
| Station routing | `stations/src/traffic-routing/{cutover,control-loop}.ts` | Only caller of `TrafficRoutingPort.apply`. |
| Harness | `identity/src/harness-*.ts`, `gateway-weight.ts`, `feature-flag-store.ts` | `OpenDeliveryEngine` (stages, groups, approval, resume), shared with trails/replay/bindles. |
| Workload identity | `identity/src/issuer.ts` (`JwtSvidIssuer`, `verifyJwtWithJwks`) | Code. |
| Provenance | `registry/src/provenance.ts` (`PROVENANCE_STATEMENT_TYPE` in-toto v1, `SLSA_PROVENANCE_PREDICATE_TYPE`, `parseProvenanceStatement`, `SignatureVerifier`, fail-closed) | Code. No Sigstore. |
| Broker delivery | `broker/src/{planes,types,policies}.ts`, `broker.proto` `DeliveryPolicy`; `stations/src/types.ts` | `argo`/`in-proc` engines; `destination_namespace`. |
| Durable store | Port `core/src/ports/eventstore.ts`; impl `storage-sqlite/src/journal.ts`; suite `conformance/src/suites/eventstore.ts` | SQLite only. |
| Gates and policy | `contracts/src/gatekeeper.ts` (`allow`, `allow-degraded`, `deny`, `require-approval`), policy IR with OPA/Cedar adapters | Code. |
| Observability world | `packages/yard-world` (OTel spans/logs/metrics mapped onto Stations, Yards, Camps) | Code. |
| Control API | `control-api/src/server.ts`, served by `hobo serve control` (`hobo/src/serve-control-command.ts`, `hobo/src/cli.ts`) | Code. |
| WASM components | `packages/componentize`, `packages/runtimes/runtime-wasm`, port `core/src/ports/component-host.ts` | Code. |
| CLI and MCP | `cli/src/shell/verbs.ts`; `deploy` verb (role `delivery`); MCP derived (`mcp/src/tool-surface.ts`) | Code. |
| Rails | `stations/src/rail.ts`, `stations/src/types.ts` | Content-addressed Station policy profiles (`policyPacks`, `approvedProviders`, `obligationDefaults`, `guardrailEnvelope`), activation `draft`/`approved`/`active`/`retired`. A new Rail activates for every Camp at once. |
| Policy IR | `policy/src/policy-ir.ts` (phases include `observe` and `repair`; effects include `warn` and `mutate`), `oscal-export.ts`, `control-evidence-pack.ts`, seed packs | Decision-time only. No posture evaluator; OSCAL has no assessment results. `@hobo/policy` is dependency-free. |
| Yard matching | `broker/src/yard-placement/matching.ts` (`matchYard`: hard filters, lexicographic specificity, stable-id tiebreak, never registration order) | Code. Picks one Yard per request. |
| Residency | `core/src/ports/jurisdiction.ts` (`evaluateResidency`, fail-closed; `ResidencyConstraint`, `DataClassification`) | Code. |
| Camp topology | `camps/src/types.ts` (`Camp`, `ResourceMappingRule` with selector + typed properties, labels) | Code. No status, conditions, claims or taints. |
| Design only | Plan 25 (Sets, Deltas, Pipelines, Relay); drift, environment lifecycle, release channels, artifact store (M0) | No code. |

**Proofs to promote** (`src/draft/technical-proofs/`, per AGENTS.md
§ Draft-proof promotion policy): `delta-set-apply-reconcile-contract`,
`deployment-strategy-saga-templates-contract`, `stuck-rollout-convergence-contract`,
`domain-cutover-saga-contract`, `drift-detection-loop-contract`,
`autonomous-drift-remediation-contract`, `drift-orphan-sweep-contract`,
`resourceactor-reconcile-loop-contract`, `orchestrator-reconciliation-fsm-contract`,
`version-pinning-drift-guard-contract`, `hobo-relay-contract` (auth/SSRF rules only),
`artifact-repo-port-contract`, `registry-artifact-descriptor-contract`,
`release-artifact-provenance-retention-contract`, `slsa-provenance-certification-contract`,
`can-deploy-compatibility-gate-contract`, `slo-promotion-gate-contract`,
`error-budget-deploy-gate-contract`, `champion-challenger-promotion-contract`,
`hobo-delivery-port`, `slo-as-code-contract`. Plus `docs/design/proofs/hobo-50-deployment-set-delta`
and the journeys `src/draft/exp-proofs/*/{gitops-ci-journey-contract,devops-canary-rollout-journey-contract,sre-drift-remediation-journey-contract,environment-lifecycle-scope,release-channels-scope}`.

## 4. Defects this change closes

| # | Defect |
|---|---|
| C1 | Four uncoordinated delivery lanes (`up`, hosting transitions, CD plane, broker) share no desired state. |
| C2 | The CD plane runs only on fixtures. |
| C3 | Evidence fails open. |
| C4 | Rollback never re-applies the prior Set. |
| C5 | "Gateway-weighted" changes no traffic; three ramp vocabularies. |
| C6 | Kubernetes fields in a neutral broker type. |
| C7 | No Freight/artifact contract between any build and CD. |
| C8 | Imperative `deliver(set)`; no reconciler, so drift has nowhere to run. |
| C9 | Promotion semantics undecided. |
| C10 | Plan 25's Relay is a reverse tunnel, the wrong shape for pull. |
| C11 | No multi-node fenced store. |
| C12 | Six hosting providers have no resolver, and the long tail can never be covered in-tree. |
| C13 | No delivery authorization, metrics or visibility. |
| C14 | No artifact store or retention. |
| C15 | Ingress is push-only and tied to HoBo CI; evidence is HoBo-trust only. |
| C16 | No lineage: nothing stops unverified Freight from skipping environments. |
| C17 | No change windows; no data-migration sequencing; no config-only path. |
| C18 | A pipeline node lists Camp ids: no selector, groups, concurrency, failure budget or quorum. One unreachable Camp blocks `ALL` forever, and a bad release hits every Camp in the node at once. |
| C19 | Camps have no liveness, conditions or taints; nothing re-places work when a Camp or provider region dies. |
| C20 | Agent enrollment is a single approval, and agent-reported facts are unmodeled and could be trusted by accident. |
| C21 | Rail and policy changes activate everywhere at once, with no shadow period, rollout or rollback. |
| C22 | Policy is admission-time only: nothing evaluates running targets or reports compliance. |
| C23 | There is no way to use an existing Karmada/OCM estate or a Kubernetes cluster inventory. |

## 5. Design decisions (binding; recorded as one ADR)

**D1 — Package boundary.** `@hobo/cd` is a layer-3 sibling of `@hobo/ci`.

- *It owns:* Freight, ingestion and discovery, artifact store and provenance,
  Sets/Deltas, pipelines, change windows, promotion, previews, reconcilers and
  the feed, verification, rollout orchestration, delivery authorization and
  telemetry.
- *It composes:* Matching/Planner/Resolved Set (`@hobo/cloud`); Gatekeeper and
  policy (`@hobo/contracts`); `OpenDeliveryEngine` and flags (`@hobo/identity`,
  which keeps them; they are shared with Trails/Replay/Bindles and moving them
  would create a cycle); SVIDs (`@hobo/identity`); provenance parsing
  (`@hobo/registry`); traffic ports (`@hobo/core`); Station cutover
  (`@hobo/stations`); Trails.

**D2 — Freight.**

- **Freight** is the immutable, content-addressed promotion unit for one
  Bindle: a declaration hash, artifact digests by kind, source, and
  provenance. Its id is `sha256:` over the canonical manifest. Its alias is a
  deterministic two-word name derived from the id.
- **Promote** = carry the same Freight, re-run Matching per target Camp, and
  apply the result as a Delta. Bytes are identical everywhere; infrastructure
  may differ, and the difference is shown as `infrastructure_diff`.
- Camp config lives in the declaration, so a config-only change is new Freight
  with the same artifacts (Delta intent `config`).
- The name follows HoBo's rail vocabulary and avoids the release-channel clash.
- Freight has a **subject**: `BINDLE` (default) or `RAIL` (D24). For a Rail,
  `bindle` carries the Rail id, `declaration_hash` carries the Rail content
  digest, and `artifacts` is empty.

**D3 — Toolset-independent ingress; pull first.**

- **Freight sources** (Kargo "Warehouse" equivalent) hold subscriptions:
  - `OCI_REPOSITORY`: OCI distribution API;
  - `GIT_REPOSITORY`: smart-HTTP protocol v2 `ls-refs`/`fetch` against any
    host; no Git binary, no host API;
  - `PACKAGE_REGISTRY`: through the `hobo:artifact-repo` ecosystems;
  - `HTTP_INDEX`;
  - `HOBO_CI`: a structural reader over CI events;
  - `HOBO_RAIL`: a structural reader over Rail approval events (D24).
- Discovery is forward-only from a high-water mark, with regex tag filters,
  semver ranges, path filters, a discovery limit, and assembly rules
  `INDEPENDENT`/`SAME_VERSION`/`SAME_COMMIT`.
- **Webhooks only nudge.** A registry or Git webhook, or a CloudEvents/CDEvents
  POST, schedules a poll. The verified read is the source of truth; a payload
  never becomes Freight.
- **Push paths (optional):** `FreightIngest.manifest` or `.attestation`,
  authenticated by a **trusted publisher** (OIDC JWT from any issuer — GitHub,
  GitLab, CircleCI, Buildkite, Azure Pipelines, Jenkins, or a custom issuer —
  matched against `TrustedPublisherRecord` claims), or by a HoBo principal.
- **Provenance:** in-toto Statement v1 + SLSA provenance (parsed by
  `@hobo/registry`), verified as a Sigstore bundle (`sigstore@5.0.1`) or as a
  HoBo-signed attestation. Subscriptions can require provenance and pin builder
  ids and signer identities.

**D4 — Pipeline graph with lineage.**

- A **Pipeline** (one per Bindle) is a DAG of nodes. Each node names Camps and
  declares:
  - sources: Freight sources and/or upstream nodes;
  - `availability` `ONE_OF`/`ALL`;
  - `required_soak_ms`;
  - `auto_promotion` `DISABLED`/`NEWEST`/`MATCH_UPSTREAM`;
  - strategy, stage percents, a `VerificationSpec`, change windows, hooks,
    `approval_required`;
  - optionally `preview_ttl_ms` (ephemeral preview node).
- **Qualification:** `freight.Qualified{camp}` is written only from a PASS
  verification. Downstream availability is computed from qualifications, soak
  and strategy.
- **Hotfix:** `freight.Approved{camp}` is an audited, policy-gated, expiring
  bypass for one Camp.
- Each Camp has one in-flight promotion. Newer queued Freight supersedes older
  (`env.PromoteSuperseded`).
- Hooks (`RUNBOOK`, `NOTIFY`, `SUITE` at `BEFORE_APPLY`/`AFTER_CONVERGED`/
  `AFTER_QUALIFIED`/`ON_FAILURE`) replace any imperative step runner.
- No expression language.

**D5 — Pull reconciliation; spec/status split; three modes.**

- Desired state per Camp is the fold of `cd-camp-<id>` (spec). Observations go
  to `cd-camp-status-<id>` (status). The two streams never contend.
- A reconciler holds the **per-Camp** lease `cd:camp:<campId>` (fenced). It
  reads changes by cursor, fetches the resolved plan blob by digest, converges,
  reports to status, and checkpoints.
- Modes:
  - `conductor`: in a Station/Yard service; SaaS targets; broker-issued
    short-lived credentials.
  - `agent`: inside the target boundary; outbound HTTPS only; key-bound
    JWT-SVID + DPoP; local credentials. It **replaces Plan 25's reverse-tunnel
    Relay for delivery.**
  - `publisher`: GitOps; convergence known only from observation.
- Docs state plainly that a conductor still calls SaaS APIs outward.
- Each Camp has a management mode. `MANAGED` is the default. `OBSERVE_ONLY`
  reads, reports and evaluates posture, and never applies; it is used for
  brownfield adoption and for unmanaged targets.

**D6 — Realization on every platform; no new provider port methods.**

- Resource graph changes go through Orchestrator ResourceActors via attested
  apply.
- Workload versions go through `createHostingTransitionCoordinator` with the
  resolver hosting provider.
- Missing in-tree resolvers are added.
- New `@hobo/resolver-components` hosts out-of-tree **`hobo:resolver` WASM
  components**:
  - WIT world `hobo:resolver@0.1.0` with `reconcile`/`read`/`delete`/`instances`;
  - they plug into the *existing* `ResourceResolver` seam;
  - signed bundles verified through `@hobo/registry`;
  - outbound `wasi:http` restricted to a declared host allowlist (SSRF rules
    from the Relay proof);
  - credentials attached **by the host** to allowlisted requests from a
    `credentialRef`, so a component never sees a secret.
- No shell-script escape hatch.

**D7 — Progressive strategy lowered onto capabilities; refuse honestly.**

- Per Camp, rank provider traffic offerings `edge.canary` → `lb.weighted` →
  `dns.weighted` → `inprocess.weighted`, and record the rung
  (`rollout.Lowered`).
- If a canary is required and nothing is realizable, or the fallback is
  forbidden by policy, refuse with `progressive-unsupported`.
- Flags handle exposure within a version. Traffic handles exposure and A/B
  between versions. `OpenExperimentEngine` handles experiment assignment.

**D8 — One ramp engine, one traffic mutator.** `OpenDeliveryEngine` staged
records are the only rollout state machine. Station cutover is the only caller
of `TrafficRoutingPort.apply`. Ramp defaults are shared constants.

**D9 — Verification is deterministic and fails closed.**

A `VerificationSpec` carries:

- thresholds (aggregation + comparator);
- **canary-vs-baseline comparisons** using a two-sided Mann–Whitney U test
  with a normal approximation and tie correction. Sensitivity maps to α:
  LOW 0.01, MEDIUM 0.05, HIGH 0.10. A check fails only when the difference is
  significant **in the worse direction**;
- HTTP probes and verify suites;
- `fail_on_no_data` (default true), required observations, window, progress
  deadline, and error-budget ceiling.

Health sources are a port. Built in: Prometheus HTTP API, HoBo metering,
generic HTTP JSON, and HoBo posture (compliance ratio and shadow divergence,
D24). Adapters: Datadog, New Relic, CloudWatch. No ML and no model
on the decision path.

**D10 — Change windows.** `ChangeWindowRecord` (ALLOW/FREEZE, selector,
RFC 5545 RRULE subset, IANA timezone, `rollback_allowed`). The gate evaluates
windows. Rollouts check them at each stage boundary and hold when closed;
in-flight work never aborts mid-stage. Overrides are governed, expiring and
audited (`window.Overridden`). Rollback is allowed by default.

**D11 — Data migrations sequenced with Trails.** If the Freight's declaration
changes data shape, promotion runs: Trails `expand` → PREPARE/SHIFT/VERIFY →
SETTLE → soak → Trails `contract`. Rollback past a completed `contract` is
refused, naming the compensating `expand`.

**D12 — Rollback** = zero exposure, then a Delta to the predecessor Set through
the same gate.

**D13 — `hobo up` declares desired state.** It records `LOCAL_BUILD` Freight,
promotes into the deployment Camp, and an in-process conductor converges it.
The `UpResult`/`DownResult` contracts are unchanged. `down` is a teardown
Delta.

**D14 — Broker delivers through CD.** `DeliveryPolicy` becomes neutral
(`reconciler_mode`, optional `publisher`). `destination_namespace` and the
`argo` engine are deprecated on the wire, never read, and mapped to a
`cd-gitops` publisher on parse.

**D15 — Authorization.** Every mutating `CdAction` is authorized against a
policy pack (`@hobo/contracts`). Agent principals are proposal-only unless
granted (ADR-0094). Enrollment and window overrides are governed actions
(ADR-0074).

The governed actions now also cover:

- Camp sets, Placements and score reports;
- taints;
- fan-out halt, resume and rollback;
- failover approval and rebalance;
- the two enrollment grants;
- posture enforcement;
- Rail promotion.

**D16 — Durability.** A new `@hobo/storage-postgres` passes
`suites/eventstore.ts`. SQLite stays the default.

**D17 — Boundaries are standards.**

- Outbound: CDEvents (`dev.cdevents.*`; HoBo-specific facts as
  `dev.cdeventsx.hobo.*`), OTel CI/CD semantic-convention spans and metrics
  over OTLP/HTTP JSON, CloudEvents webhooks.
- Inbound: CDEvents (nudge only), OIDC trusted publishing, in-toto/SLSA,
  Sigstore.
- OpenFeature remains the flag API.

**D18 — Retention.** Keep any Freight deployed anywhere, plus
`keep_per_camp` predecessors, plus anything under a legal-hold label. Retire
the rest after `keep_unpromoted_ms` (`freight.Retired`). Delete unreferenced
blobs after `blob_grace_ms` (`artifact.Deleted`).

**D19 — Camp inventory and double opt-in enrollment.**

- **Status.** Every Camp has a `CampStatusRecord` on `cd-camp-inventory-<id>`.
  It carries conditions, observed claims and taints.
  - Conditions: `READY`, `REACHABLE`, `LEASED`, `CREDENTIAL_VALID`,
    `CLAIMS_CONSISTENT`, `POSTURE_COMPLIANT`.
  - Each condition names its source: `station`, `reconciler`, `health-source`
    or `operator`.
- **Derivation.**
  - `REACHABLE` and `LEASED` come from Station-observed lease activity.
  - `CREDENTIAL_VALID` comes from SVID expiry and refresh. An expiring or failed
    rotation is a visible condition, never silent. (Karmada's push mode lost
    its watch silently on rotation until it was fixed.)
  - `CLAIMS_CONSISTENT` comes from comparing claims with declared topology.
- **Claims are observed facts** reported in reconcile observations (platform,
  version, claimed region, capacity hints). They can only narrow placement
  (I19). A contradiction with declared topology sets
  `CLAIMS_CONSISTENT=false` and taints the Camp `NO_PLACE`.
- **Taints.**
  - `NO_PLACE` blocks new placement and promotion. The system adds it
    automatically when a Camp is unreachable, its lease is lost, its credential
    is invalid or its claims are inconsistent.
  - `NO_RUN` makes the Camp a failover candidate. It comes only from an
    operator, or from a Rail-permitted rule with at least
    `required_signals` (default 2) independent signals, one of them
    Station-observed. (Karmada stopped adding `NoExecute` automatically in
    v1.14.)
- **Enrollment is double opt-in.**
  1. An agent enrolls its public key with a single-use bootstrap token whose
     scope names a Camp set. The result is `ENROLLMENT_STATE_PENDING`.
  2. Feed access then needs two separate grants: `reconciler.approve-key` and
     `reconciler.accept`. They must come from different principals when the
     Rail sets `separate_approvers`.
  3. A Rail `auto_accept_scopes` entry that matches the token scope replaces
     both grants, and that is recorded (I24).

**D20 — Camp sets and Placement.**

- **Camp sets.** A `CampSetRecord` groups Camps by selector or id. A Rail's
  `delivery.camp_sets` binds sets to its Station, and Placement sees only
  bound sets. The Rail carries `delivery` as an opaque JSON object inside its
  content digest; `@hobo/cd` parses it as `RailDeliveryRecord`.
- **Placement.** A `PlacementRecord` holds:
  - Camp sets and a predicate selector;
  - `required_claims`;
  - `count` (0 = all eligible);
  - spread constraints over `yard`, `provider`, `region`, `jurisdiction` or a
    Camp label;
  - score weights;
  - tolerations;
  - groups and a default group size.
- **`decide` is pure (I18):**
  1. Candidates are the bound sets ∩ the predicate, `MANAGED` Camps only.
  2. Exclude Camps with untolerated taints, missing `required_claims`, Rail
     `approvedProviders` violations, or a residency failure. Residency uses
     `@hobo/core` `evaluateResidency` for the subject's classifications and
     constraints against each Camp's **declared** Yard regions; claims never
     count.
  3. Order by weighted unexpired score snapshots, then Camp id.
  4. Take `count` while satisfying spread. If the minimum groups cannot be
     met, refuse with `placement-unsatisfiable`.
  5. Form named groups by selector, in declaration order, then chunk the
     remainder by the default size.
- The decision records the inventory digest and score-snapshot digests, plus
  every candidate's exclusion codes.
- **Scores.** A score is a `ScoreSnapshotRecord` reported by an authorized
  source with a `valid_until`. Expired snapshots are ignored, never
  extrapolated. This is OCM's `AddOnPlacementScore` made replayable.
- **Aggregate check.** The gate compares the decision's Camp count with Rail
  `max_fanout_camps` and entitlements, and the summed cost quotes with the
  Station budget. These are the existing pricing and budget authorities; there
  is no new quota system. (This is the `FederatedResourceQuota` intent.)

**D21 — Fan-out.**

- A node either lists `camp_ids` or names a `placement` with a
  `FanoutRecord`. Never both.
- Fan-out only *schedules* ordinary per-Camp promotions. Gate, windows,
  verification and lineage apply per Camp unchanged.
- **Strategies:**
  - `ALL`: every Camp at once;
  - `PROGRESSIVE`: rolling over the ordered decision, at most
    `max_concurrency` (count or percent) at a time;
  - `PROGRESSIVE_PER_GROUP`: one group at a time.

  Mandatory groups run first and must all succeed.
- **Per-Camp outcomes:**
  - **succeeded**: `freight.Qualified` plus `min_success_ms`;
  - **failed**: rejection, apply failure, verification FAIL or INCONCLUSIVE,
    or `progress_deadline_ms` elapsed;
  - **deferred**: when its turn comes, the Camp is `NO_PLACE`-tainted,
    unreachable or in a closed window. Deferred Camps never count against
    `max_failures` and do count against quorum.
- **Halt.** Exceeding `max_failures` (count or percent of the decision) halts
  the fan-out (`fanout.Halted`). With `rollback_on_halt`, the failed Camps
  roll back per D12. Resume and rollback are governed actions.
- **Downstream.** Availability from a placed node uses `AVAILABILITY_QUORUM`:
  `min_qualified` (count or percent of the decision), plus every mandatory
  group.
- **Late entry.** `AUTO_PROMOTION_MATCH_NODE` applies to Camps that enter the
  node later: joined a set, were deferred, recovered, or are a replacement.
  They converge to the node's current qualified Freight, never to in-flight
  Freight.
- **Departure.** A Camp that leaves the decision is handled by a `depart` Delta
  per the node's `DepartureAction`. The default `ORPHAN_DATA` removes compute,
  keeps data resources, and records them.
- **Control.** One controller per fan-out (lease `cd:fanout:<id>`). Newer
  Freight supersedes an in-flight fan-out at the next group boundary.

**D22 — Per-Camp values stay in topology; mirrors keep digests; retained
fields.**

- **No OverridePolicy.** Per-Camp values are Camp properties and
  `ResourceMappingRule`s (`@hobo/camps`). They are typed, already inputs to
  Matching (D2), and captured in the Set digest.
  - Changing them is a `topology` Delta (`SET_ORIGIN_TOPOLOGY`) through the
    same gate, with the diff shown.
  - JSON-patch overrides are forbidden.
- **Artifact mirrors.** A Yard or Camp may map an artifact coordinate prefix
  to a local registry (property `hobo.cd/mirror`). The digest never changes.
  If the mirror cannot serve that digest, convergence fails; nothing is
  substituted. Tag rewriting is forbidden.
- **Retained fields.** Fields owned by controllers on the target side
  (autoscaler replicas, provider-managed runtime versions) are excluded from
  drift and reported as `retained`. They are declared in three places:
  - a component's `describe`;
  - the in-tree table `reconcile/retained.ts`;
  - the Camp mapping-rule property `hobo.cd/retain`.

**D23 — Failover and rebalance are governed sagas.**

- **Trigger.** A `NO_RUN` taint that a placed node's tolerations do not cover
  within `toleration_ms` records `failover.Proposed` for each affected
  Camp × node.
- **Execution** needs Rail `delivery.failover.automatic` or an approval. At
  most `max_concurrent` failovers run per Station.
- **Saga:**
  1. Placement re-decides one replacement, excluding tainted Camps and
     respecting spread, residency and bindings.
  2. Promote the node's **current qualified** Freight (intent `failover`,
     `SET_ORIGIN_FAILOVER`), with the declared `handover_outputs` from the
     source's last observation as typed inputs.
  3. Verify; the result must be PASS.
  4. Station cutover shifts traffic.
  5. Purge the source per `PurgeMode`:
     - `GRACEFUL` (default): only after the replacement qualifies. On timeout,
       keep both and escalate.
     - `NEVER`.
     - `IMMEDIATE`: only if the Rail sets `allow_immediate_purge` and the
       source Camp holds none of the Bindle's data resources.

  The purge uses the node's `DepartureAction`.
- **Failover moves compute only.** If the Bindle's data resources live in the
  source Camp, or are unreachable from the replacement, the failover is refused
  with `failover-unsafe`. The remediation names a Trails replica handover.
- **No automatic failback.** `rebalance` is an explicit, governed command. It
  re-decides the placement, records the moves, and runs them as GRACEFUL moves
  under the node's fan-out limits.

**D24 — Policy is delivered like software.**

- A Rail version is Freight with subject `RAIL`. The `HOBO_RAIL` subscription
  discovers it when a Rail is approved. Rail pipelines use the same graph,
  windows, approvals, fan-out and verification as workloads.
- A node's `policy_mode` decides what promotion does:
  - **`INFORM`** binds the Rail as the Camp's **candidate**. The enforced Rail
    still decides. The gate also evaluates the candidate and records
    `policy.ShadowDecided` (with divergence), and posture evaluates the
    candidate.
  - **`ENFORCE`** makes it the Camp's enforced Rail.
- Binding changes (`policy.BindingChanged`) are written to the Camp's spec
  stream, by promotion only. One writer per Camp still holds.
- An INFORM node verifies on `HOBO_POSTURE` series (noncompliant ratio,
  divergence count) with the usual thresholds. An ENFORCE node requires a
  qualified INFORM node upstream (I23).
- Rollback restores the previous enforced digest through the gate. It is always
  allowed in windows.
- A Camp with no binding uses its Station's active Rail, so existing behavior
  is unchanged.

**D25 — Posture: continuous compliance with one mutator.**

- **Rules.** Posture rules are policy-IR rules in phase `observe`, in the
  packs a Rail's `delivery.posture` binds.
  - A rule matches resources by kind and classification.
  - It asserts `require` or `forbid` over declared attributes, with a fixed
    operator set: `eq`, `neq`, `in`, `not-in`, `exists`, `absent`, `lt`,
    `lte`, `gt`, `gte`, `semver-gte`.
  - It carries severity and control ids. There is no expression language.
- **Inputs.** The reconciler reports only the attributes the bound packs
  declare (`observe_fields`). They are secret-free and bounded to 16 KiB per
  resource.
- **Evaluation.** A Station-side posture service evaluates each Camp with the
  pure evaluator in `@hobo/policy/posture`.
  - It runs at the binding's `compliant_interval_ms` or
    `noncompliant_interval_ms`.
  - It appends `compliance.Observed`, naming the observation position it used,
    to `cd-compliance-<id>`.
  - On a state change it appends `compliance.Changed` and updates
    `POSTURE_COMPLIANT`.
  - Agents never evaluate posture; they report facts.
- **Remediation** follows the binding's mode:
  - `inform`: record only.
  - `inform-only`: cannot be raised to `enforce` by a parent.
  - `enforce`, on a field the Set owns: drift, so the reconciler re-applies
    the Set.
  - `enforce`, on an unowned field the resolver can set:
    `posture.RemediationProposed`, then a `posture-remediate` Delta through
    the gate, applied by the reconciler.
  - A rule that contradicts a Set-owned value is `ownership-conflict`. Nothing
    is mutated. The conflict is recorded, and the gate refuses promotions that
    keep the violation until the declaration changes (I22).
- **Evidence.** `@hobo/policy` maps compliance records into OSCAL assessment
  results beside the existing export.
- `OBSERVE_ONLY` Camps get posture in `inform` only.

**D26 — Kubernetes fleet managers are transports, never brains.**

- A new adapter package, `@hobo/cd-kube-fleet`, has three parts:
  - **ClusterProfile import.** SIG-Multicluster ClusterProfiles (KEP-4322)
    become Camps in a Yard. They are `OBSERVE_ONLY` until promoted to
    `MANAGED`, and their properties and status become observed claims.
  - **OCM realizer.** One ManifestWork per Camp in the hub's cluster namespace.
    Status comes from feedback rules, and deletion follows `DepartureAction`
    (orphan rules).
  - **Karmada realizer.** Resource templates plus a PropagationPolicy pinned to
    exactly one member cluster (`clusterAffinity.clusterNames`, `Duplicated`).
    Status comes from the binding.
- HoBo deliveries never use ManifestWorkReplicaSet rollout, OCM Placement or
  the Karmada scheduler, failover or overrides. Each would be a second rollout
  or placement engine (D8).
- No message-broker transport (MQTT, gRPC, Kafka). The journal and cursor feed
  already scale and already resume over intermittent links. A broker would add
  an operated dependency.

## 6. Invariants (each needs a named test)

- **I1** Promote, never rebuild: target Set digests equal the Freight's.
- **I2** Reconcilers are the only delivery mutators (architecture test over
  call sites).
- **I3** In `agent` mode the Station holds no target credential and opens no
  connection to the agent.
- **I4** One writer per Camp: the lease is keyed by Camp; a stale fence is
  refused.
- **I5** Fail closed: no data means FAIL; an ambiguous provider outcome is
  resolved by observation only.
- **I6** Capability honesty: unsatisfiable means refused; fallbacks are
  policy-permitted and recorded.
- **I7** Rollback is a Delta through the same gate.
- **I8** Replayable and deterministic: injected `now`; no RNG, network or model
  in decisions; replay equals live.
- **I9** Secret-free records, and resolver components never receive secret
  material.
- **I10** Authorized: every mutation has a recorded decision; agents propose by
  default.
- **I11** Neutral core: `@hobo/cd` imports no `provider-*`, `iac-*`,
  `runtime-*`, `ci*`, `broker`, `cli`, `hobo` or `resolver-components`, and
  names no Kubernetes/OCI-runtime/Git-host/Argo/Flux/vendor-APM type outside
  `adapters/` and `verification/sources/`.
- **I12** Idempotent commands.
- **I13** Yanked or retired Freight never starts or continues a promotion.
- **I14** Every hosting provider resolves to a realization path and a traffic
  profile, or a typed refusal.
- **I15** Trigger, don't trust: no webhook or CDEvent payload creates Freight
  without a verified read or a verified attestation.
- **I16** Lineage: Freight reaches a node only via availability (upstream
  qualification per strategy, plus soak) or an unexpired approval.
- **I17** Windows: no apply or stage advance while a window is closed, except
  a permitted rollback or a recorded override.
- **I18** Placement is deterministic. The same placement, recorded inventory
  digest and score-snapshot digests always produce the same decision,
  independent of input order. Expired scores are ignored. Replay uses the
  recorded inputs.
- **I19** Claims narrow, never grant. An observed claim can exclude a Camp. It
  never satisfies residency, a required capability or a Rail binding.
- **I20** Fan-out is bounded.
  - Never more than `max_concurrency` Camps are in flight.
  - Mandatory groups finish before others start.
  - The fan-out halts when failures exceed `max_failures`.
  - Deferred Camps never count as failures.
- **I21** Failover is safe.
  - Never automatic unless the Rail allows it, and within the Rail's
    concurrency budget.
  - The replacement passes residency and bindings.
  - GRACEFUL never purges the source before the replacement qualifies.
  - Data resources never move.
  - No automatic failback.
- **I22** One mutator for policy too. Posture enforcement changes a target only
  through a repair Delta applied by that Camp's reconciler. It never overwrites
  a Set-owned value; that is `ownership-conflict`.
- **I23** Shadow before enforce. A Rail becomes a Camp's enforced Rail only
  after a qualified INFORM node upstream, or an unexpired approval. While bound
  in INFORM, the enforced Rail alone decides.
- **I24** Double opt-in. No reconciler reads a Camp's feed without both
  recorded grants (`reconciler.approve-key`, `reconciler.accept`), or a
  recorded Rail auto-accept that matches the bootstrap token's scope.

## 7. Parallel-work contract (repeat in every dispatch)

1. **Dispatch packet.** Each agent receives Part II §1–8, Appendix A, Part I
   §I.8 (decision register) and its own WP section, nothing else.
2. **Frozen files** (Appendix A) are already in your base commit. Before
   dispatch, the coordinator makes the *contract commit* on
   `integration/hobo-cd`: this document, every Appendix A file and the
   generated code.
   - Branch `cd/wp<NN>-<slug>` from that commit.
   - Never edit a frozen file.
   - If one is wrong, report it and keep working on everything it doesn't
     affect.
3. **Ownership.** Edit only paths you own (§8). Read anything. Code against
   frozen ports and existing repo APIs. Write your own fakes in your own
   `test/` folder.
4. **Rolling integration.** Commit small and often. The coordinator merges
   every pushed commit into `integration/hobo-cd` continuously and runs
   `typecheck`, `lint:boundaries` and affected tests. A failure is sent to the
   owner immediately. Fix integration failures before new features.
5. **Contract amendments.** Only the coordinator amends a frozen file. An
   amendment is broadcast as a full byte-identical replacement plus a one-line
   reason. Every agent applies it verbatim on receipt. Amendments are rare and
   additive where possible.
6. **Isolation.** Your package is green in isolation (typecheck + your tests).
   Lines that can only compile after merge exist only in WP18 and are marked
   `// binds at merge (plan 0024)`.
7. **Method.** Strict red/green; the repo `sdlc` implementer → reviewer loop;
   protobuf first, CUE constraints, parse-don't-validate, PACT on every
   boundary, generated types only (AGENTS.md § architecture rules).
8. **Docs.** Each source folder you create gets a `README.md`. Shared docs
   belong to WP21.
9. **Dependencies.** Do not commit `pnpm-lock.yaml`. The only new external
   dependencies are `sigstore@5.0.1` (frozen in A.1) and `pg@8.22.0` (WP17,
   same version `@hobo/ci` uses). The fleet and policy work adds none.
   `@hobo/cd-kube-fleet` speaks the Kubernetes API over `HttpTransport`, with
   no client library.
10. **CI and commits.** No GitHub Actions dependence; never touch
    `.github/workflows/`. Conventional scoped commits. Report in
    `.sdlc/report.json`: files, tests, gates, proofs promoted, residual risks.
    An empty residual list is expected.
11. **Production obligations for every WP.** Typed failure modes with
    remediation, metrics emitted through `TelemetrySink`, a runbook entry
    handed to WP21 as a section file under your `README.md`, PACT for every
    boundary you own, and the mutation policy met.

## 8. File ownership (exhaustive)

Frozen files (Appendix A) belong to no one and are written by everyone.

| WP | Owns |
|---|---|
| WP1 | `packages/cd/src/{freight,ingest}/**`, `packages/cd/test/{freight,ingest}/**`, `packages/cd/contracts/{freight,ingest}.*`, `packages/cd/data-models/freight.cue` |
| WP2 | `packages/cd/src/sources/**`, `packages/cd/test/sources/**`, `packages/cd/contracts/sources.*`, `packages/cd/data-models/sources.cue` |
| WP3 | `packages/cd/src/{artifacts,provenance}/**`, `packages/cd/test/{artifacts,provenance}/**`, `packages/cd/contracts/artifacts.*`, `packages/cd/data-models/artifacts.cue` |
| WP4 | `packages/cd/src/sets/**`, `packages/cd/test/sets/**`, `packages/cd/data-models/sets.cue` |
| WP5 | `packages/cd/src/{pipelines,windows}/**`, `packages/cd/test/{pipelines,windows}/**`, `packages/cd/data-models/{pipelines,windows}.cue` |
| WP6 | `packages/cd/src/promotion/**`, `packages/cd/src/adapters/{planning,gatekeeper,approval,trails,hooks}.ts`, `packages/cd/test/promotion/**`, `packages/cd/data-models/promotion.cue`, `packages/hobo/src/runbook-command.ts` + test |
| WP7 | `packages/cd/src/reconcile/**`, `packages/cd/src/adapters/{orchestrator,hosting-transition}.ts`, `packages/cd/test/reconcile/**`, `packages/cd/data-models/reconcile.cue`; **deletes** `packages/cloud/src/cd/{attested-apply,cd-plane,progressive-cd,analysis-adapter,incident-a2h,fixtures,index}.ts`, `packages/cloud/test/cd-plane.test.ts`; edits `packages/cloud/src/index.ts` (`resolved-set.ts`, `secret-free.ts` stay) |
| WP8 | `packages/resolver-components/**` (new package) |
| WP9 | `packages/cd/src/verification/**`, `packages/cd/test/verification/**`, `packages/cd/data-models/verification.cue` |
| WP10 | `packages/cd/src/rollout/**`, `packages/cd/src/adapters/{harness,traffic}.ts`, `packages/cd/test/rollout/**`, `packages/cd/data-models/rollout.cue` |
| WP11 | `packages/cd/src/{feed,agent}/**`, `packages/cd/test/{feed,agent}/**`, `packages/cd/contracts/feed.*` |
| WP12 | `packages/cd/src/service/**`, `packages/cd/test/service/**`, `packages/control-api/**` |
| WP13 | `packages/providers/{provider-railway,provider-convex,provider-flux,provider-webernetes}/**` |
| WP14 | `packages/providers/{provider-lakebed,provider-browser-wasm,provider-vercel,provider-netlify,provider-neon,provider-upstash,provider-prisma-postgres,provider-kafka,provider-ttl-sh,provider-agentv,provider-ax}/**`, `packages/connectivity/src/traffic-routing/profiles.ts`, `packages/hobo/src/{provider-hosting-catalog,resolver-hosting-provider}.ts` + tests |
| WP15 | `packages/cli/src/cloud/yard-client.ts`, `packages/cli/src/commands/{up,down,build}.ts`, `packages/cli/package.json`, their tests |
| WP16 | `packages/cd/src/boundary/**`, `packages/cd/test/boundary/**`, `packages/cd-gitops/**`, `packages/broker/**`, `packages/stations/src/{types,rail}.ts` + their tests |
| WP17 | `packages/storage-postgres/**` (new package) |
| WP18 | `packages/cd/src/compose/**`, `packages/cd/test/compose/**`, `packages/hobo/src/{deploy-command,incident-command,compose,index,cli,serve-control-command}.ts`, new `packages/hobo/src/cd-*.ts`, `packages/hobo/package.json`, `packages/hobo/CD.md`, `packages/cli/src/shell/verbs.ts`, `packages/mcp/**` (only if parity needs it) |
| WP19 | `packages/cd/src/{authz,telemetry}/**`, `packages/cd/test/{authz,telemetry}/**`, `packages/yard-world/**` |
| WP20 | `packages/conformance/src/suites/cd-*.ts`, `packages/conformance/src/index.ts`, `features/hobo-cd-*.feature`, `features/steps/hobo-cd-*.ts`, `examples/cd-*/**`, CD entries in chaos/mutation/load lane config |
| WP22 | `packages/cd/src/{inventory,placement}/**`, `packages/cd/test/{inventory,placement}/**`, `packages/cd/data-models/{inventory,placement}.cue` |
| WP23 | `packages/cd/src/{fanout,failover}/**`, `packages/cd/test/{fanout,failover}/**`, `packages/cd/data-models/{fanout,failover}.cue` |
| WP24 | `packages/cd/src/posture/**`, `packages/cd/test/posture/**`, `packages/cd/data-models/posture.cue`, `packages/policy/src/posture/**`, `packages/policy/test/posture/**`, `packages/policy/package.json` (adds the `./posture` export only) |
| WP25 | `packages/cd-kube-fleet/**` (new package) |
| WP21 | `packages/cd/{README.md,LICENSE}`, `packages/cd/data-models/README.md`, `packages/conformance/src/boundaries.ts`, `turbo.json`, `konsistent.json`, root `README.md`, `PRODUCT.md`, `CLAUDE.md`, `AGENTS.md`, `GAPS.md`, `docs/**` except `docs/plans/0024-hobo-cd-swarm-instruction.md`, `site/public/llms*.txt`, `src/draft/**/README.md` status notes |

The coordinator alone edits `scripts/promotions.json`, `pnpm-lock.yaml`, the
frozen files (by amendment) and `integration/hobo-cd`.

## 9. Work packages (dispatch all twenty-five now)

### WP1 — Freight ledger and ingestion (C7, C15, D2, D3, D18)

- **Build:**
  - `createFreightLedger`: record, yank, approve (expiring, governed),
    qualify (accepts only PASS results), lookup by id or alias, list,
    qualifications/approvals, and the retention sweep (`retire`) per D18.
  - `createFreightIngest`:
    - `manifest` — parse `hobo.freight-manifest/v1`;
    - `attestation` — parse the in-toto Statement through `@hobo/registry`;
      subjects become artifacts; verify through `ProvenanceVerifier`;
    - `cdevent` — `artifact.published`/`artifact.packaged`: map the purl to
      matching sources and schedule polls; create Freight only when the event
      carries a verifiable attestation.
  - `createTrustedPublisherVerifier`: OIDC discovery + JWKS over
    `HttpTransport` via `verifyJwtWithJwks`; `iss`/`aud`/`exp`/`nbf` checks
    with injected clock skew; required claims equal per `TrustedPublisherRecord`;
    JWKS cache honoring `Cache-Control`; maps to a `PrincipalRef` of kind
    `workload`.
  - Export `writeFreightManifest` so `hobo build` (WP15) and any CI emit the
    same document.
- **Promote:** `release-artifact-provenance-retention-contract`,
  `slsa-provenance-certification-contract`.
- **Accept:**
  - Identical manifests give identical ids and aliases.
  - Unverified or mismatched digests are refused with typed reasons.
  - GitHub and GitLab OIDC fixtures pass; a token from an unconfigured issuer,
    a wrong audience, or a missing required claim is refused.
  - A CDEvent without an attestation schedules polls and creates nothing (I15).
  - Retention never retires Freight deployed anywhere, inside rollback depth,
    or under legal hold.
  - PACT for the manifest, attestation and publisher-token boundaries.

### WP2 — Freight sources: pull discovery (C15, D3, I15)

- **Build:** `createFreightSources` and one `SubscriptionDriver` per kind.
  - **OCI:** distribution API tags list with pagination, manifest digest via
    `HEAD`, the referrers API for attestations, `WWW-Authenticate` bearer
    token flow.
  - **Git:** smart-HTTP v2 `ls-refs` with branch/tag filters; path filters by
    fetching tree objects for the candidate commit (packfile parse of tree
    objects only); host-neutral.
  - **Package registries:** through artifact-repo ecosystem metadata (npm,
    PyPI, Maven, NuGet, crates, RubyGems).
  - **HTTP index:** JSON list of `{version, url, digest}`.
  - **HOBO_CI:** a structural `CiEventReader` (frozen type), so no `@hobo/ci`
    import.

  Also:
  - Selection strategies, a forward-only high-water mark per subscription, the
    discovery limit, and assembly rules producing one Freight per qualifying
    combination.
  - `require_provenance` with builder/signer pins, verified through
    `ProvenanceVerifier`.
  - `nudge`: authenticated webhook receivers for generic CloudEvents/CDEvents,
    GitHub, GitLab, Bitbucket, Gitea/Forgejo, Harbor, Docker Hub, GHCR, ECR
    (EventBridge), and Artifact Registry (Pub/Sub push). Each verifies its
    signature or token, maps to sources, and schedules polls only.
  - `tick` polls on interval with jittered, deterministic backoff.
- **Accept:**
  - Discovery against recorded fixtures for every kind.
  - Older tags are never discovered after a newer one.
  - `SAME_COMMIT` pairs an image and a declaration from one commit.
  - Unsigned images under `require_provenance` are skipped with a reason.
  - A forged webhook is refused; a valid webhook creates no Freight by itself.
  - Rate-limit responses back off.
  - PACT per driver.
- **Fleet and policy (D24):** a `HOBO_RAIL` driver over the frozen `RailEventReader`. It
  produces one Freight per approved Rail digest: subject `RAIL`, `bindle` =
  Rail id, `declaration_hash` = Rail digest, no artifacts.
  - *Accept:* the same digest approved twice yields one Freight; retired Rails
    are not discovered.

### WP3 — Artifact store and provenance (C14, D3)

- **Build:**
  - `createArtifactStore`:
    - filesystem: content-addressed, write-then-rename, fsync, digest
      re-verified on read;
    - S3-compatible: SigV4 via `@hobo/core` `aws-sigv4`, multipart above
      64 MiB, conditional create, per-call credentials via
      `CredentialResolver`;
    - memory.
  - `list` and `delete`, used by the retention sweep.
  - `createArtifactVerifier`: store-backed digest check; registry digest at
    coordinate (OCI manifest digest; npm `dist.integrity`; NuGet catalog hash;
    PyPI `digests.sha256`; Maven `.sha256`/`.sha1`; crates `cksum`; RubyGems
    `sha`).
  - `createProvenanceVerifier`:
    - in-toto/SLSA via `@hobo/registry` `parseProvenanceStatement`;
    - Sigstore bundles via `sigstore@5.0.1` (`verify` with certificate-identity
      and issuer policy);
    - HoBo JWT attestations via registry `SignatureVerifier`.

    Subjects must match the artifacts exactly. Builder and signer pins are
    enforced. Fails closed.
- **Promote:** `artifact-repo-port-contract`, `registry-artifact-descriptor-contract`.
- **Accept:**
  - Corruption is detected on read.
  - Partial uploads are never visible.
  - A Sigstore bundle from a GitHub `actions/attest` fixture verifies; a
    tampered subject digest fails.
  - A wrong signer identity fails.
  - Each ecosystem verifier passes on fixtures and fails on mismatch.
  - SigV4 matches AWS test vectors.
  - No credential appears in an event or error.

### WP4 — Sets, Deltas, desired state (C1, C8, B1–B4)

- **Build:** `createDesiredState` → `DesiredStateReader & DeltaLedger`.
  - Spec stream `cd-camp-<id>` with expected-version appends; status stream
    `cd-camp-status-<id>`.
  - Delta open/update/apply/reject. Apply stores the canonical secret-free
    Resolved Set as a blob (`ArtifactStore`, kind `ARTIFACT_KIND_PACKAGE`,
    media type `application/vnd.hobo.resolved-set+json`) and emits
    `set.Created` with digest and size.
  - `resolved()` fetches and verifies the blob.
  - `changes()` streams by position.
  - `status()` folds the status stream.
  - Legacy fold: `deployment.Planned/Deployed/RolledBack` → Sets with
    `SET_ORIGIN_LEGACY_FOLD`.
- **Promote:** `delta-set-apply-reconcile-contract`, HOBO-50 projection.
- **Accept:**
  - Golden journal fold.
  - Legacy estates get a current Set.
  - Concurrent applies: one wins.
  - Observations never conflict with applies.
  - A blob digest mismatch is refused.
  - Upcaster corpus entries for `set.Created` and `delta.*`.

### WP5 — Pipeline graph and change windows (C16, C17, D4, D10, I16, I17)

- **Build:**
  - `createPipelineController`:
    - validate graphs: acyclic, nodes non-empty, sources and upstream nodes
      exist, Camps belong to the Bindle's project, preview nodes are leaves;
    - availability: qualification sets per strategy, soak measured from the
      upstream `env.Promoted` time, unexpired approvals; each available Freight
      returns its `via` reasons;
    - `tick`: for each node with auto-promotion, choose `NEWEST` or
      `MATCH_UPSTREAM` and request promotion with idempotency key
      `pipeline:<p>:<node>:<freight>`;
    - `pipeline.FreightAvailable` facts.
  - `createChangeWindows`:
    - the RRULE subset `FREQ=DAILY|WEEKLY|MONTHLY|YEARLY`, `BYDAY`,
      `BYMONTHDAY`, `BYMONTH`, `BYHOUR`, `BYMINUTE`, `INTERVAL`, `COUNT`,
      `UNTIL`;
    - IANA zones via `Intl` with the clock injected; DST-correct;
    - FREEZE dominates ALLOW;
    - governed, expiring overrides.
- **Accept:**
  - Kargo parity cases: `ONE_OF` versus `ALL`; soak not yet elapsed;
    `MATCH_UPSTREAM` with a single upstream only; an approval bypasses only its
    Camp and only until expiry.
  - Cycles are refused.
  - The fleet and policy cases below.
  - Windows across DST transitions in `America/Chicago` and `Europe/London`
    golden tests.
  - A freeze beginning mid-tick blocks the request.

- **Fleet and policy (D21, D24):**
  - Validate exactly one of `camp_ids`/`placement` per node.
  - `policy_mode` appears only in `RAIL` pipelines, and an `ENFORCE` node needs
    an `INFORM` node upstream.
  - `AVAILABILITY_QUORUM` uses the fan-out decision and mandatory groups.
  - `tick` starts fan-outs through `FanoutController` for placed nodes, and
    requests `MATCH_NODE` promotions for Camps entering a node.
  - *Accept:*
    - quorum 95% qualifies with 3 of 400 deferred;
    - a failed mandatory group blocks availability;
    - `ENFORCE` without `INFORM` upstream is refused at apply;
    - `MATCH_NODE` never selects in-flight Freight.

### WP6 — Promotion saga, gate, previews, Trails (C9, D2, D11, D12, I7, I13)

- **Build:** `createPromotionService` (a `defineSaga` over
  `cd-promotion-<id>`), in order:
  1. authorize;
  2. refuse yanked/retired Freight;
  3. enforce lineage (I16) unless an approval covers the target;
  4. per-Camp queue and supersession;
  5. resolve (`SetResolver`);
  6. Delta with `infrastructure_diff`;
  7. gate (policy, compat, trust freshness, residency, windows);
  8. approval (A2H or CloudEvents webhook approver);
  9. BEFORE_APPLY hooks;
  10. Trails `expand` when needed;
  11. apply;
  12. `RolloutOrchestrator`;
  13. AFTER_CONVERGED hooks;
  14. verification;
  15. `freight.Qualified` → AFTER_QUALIFIED hooks → `env.Promoted`;
  16. Trails `contract` after soak.

  ON_FAILURE hooks fire on any failure. Environment groups use compensation.
  `rollback` per D12, refusing past a completed contract. Previews: ephemeral
  Camps (`env.Cloned`, TTL, sweep → `env.Expired` + teardown Delta). Intent
  `config`.

  Adapters:
  - `planning.ts`: the same planner path as `yard-client.ts` `pureplan`;
  - `gatekeeper.ts`: `evaluateGatekeeper` + trust + residency + compat +
    `ChangeWindows`;
  - `approval.ts`: A2H + CloudEvents webhook approver with signed callback;
  - `trails.ts`;
  - `hooks.ts`: runbook through `RunbookExecutor`, notify through
    `NotificationPort` (CloudEvents HTTP binding), suite through `VerifyPort`.

  `runbook-command.ts` exports `createRunbookExecutor` with `hobo runbook`
  unchanged.
- **Promote:** `can-deploy-compatibility-gate-contract`,
  `champion-challenger-promotion-contract`.
- **Accept:**
  - I1 across two providers.
  - The diff is exact.
  - A duplicate key creates one promotion.
  - Unqualified Freight is refused at prod.
  - Supersession keeps only the newest.
  - A group failure compensates.
  - Rollback past contract is refused with the expand named.
  - An agent principal gets a proposal only.
  - A preview tears down at TTL.
- **Fleet and policy (D20–D25):**
  - Intents `topology`, `failover`, `depart` and `posture-remediate`.
  - Subject `RAIL`: step 11 writes the binding through `CampPolicy.bind`
    instead of a Set, and rollback restores it.
  - `gatekeeper.ts`:
    - evaluates the candidate Rail in shadow: the frozen `ShadowRecorder`
      port (implemented by WP24) supplies the candidate pack, and WP6
      evaluates it with `evaluateGatekeeper`, records the decision through
      the port, and returns `GateVerdict.shadow`;
    - refuses Deltas that keep a recorded `ownership-conflict`
      (`PostureService.conflicts`);
    - evaluates the fan-out aggregate (Camp count against Rail
      `max_fanout_camps` and entitlements; summed cost quotes against the
      Station budget) when `PromoteRequest.fanoutId` is set.
  - *Accept:*
    - a shadow divergence is recorded while the enforced decision stands;
    - after ENFORCE the next Delta is decided by the new Rail;
    - an aggregate over budget is refused before any Camp starts.

### WP7 — Reconcilers, realizers, drift (C8, D5, D6, I2–I5)

- **Build:** `createCampReconciler`, a loop per Camp lease (`cd:camp:<id>`):
  1. feed → for each change, fetch the blob;
  2. `observe` if current, else `converge`;
  3. status events (`ReconcileStarted` → `StatusObserved` → `Converged` /
     `ReconcileBlocked`);
  4. checkpoint, renew, and back off with jitter derived from
     hash(reconcilerId, camp).

  Periodic re-observation → `resource.DriftDetected` → `DriftPolicy`
  (reconcile, propose `drift.DiffProposed`, ignore, escalate). Orphan sweep.
  `createInProcessTransport` over `claimSubscription` (partition = Camp).

  Adapters:
  - `orchestrator.ts`: graph changes through `runOrchestrator` + attested
    apply, rebuilt from the deleted sources without the C3/C4 defects;
  - `hosting-transition.ts`: versions through
    `createHostingTransitionCoordinator` with an injected
    `HostingTransitionProvider`.

  Delete the old CD plane (§8).
- **Promote:** `resourceactor-reconcile-loop-contract`, `drift-detection-loop-contract`,
  `autonomous-drift-remediation-contract`, `drift-orphan-sweep-contract`,
  `version-pinning-drift-guard-contract`, `orchestrator-reconciliation-fsm-contract`.
- **Accept:**
  - Two reconcilers with **different ids** on one Camp: one writes, the other
    is fenced out (I4).
  - A crash between execute and observe does not repeat the mutation.
  - Only changed nodes reconcile.
  - Checkpoint resume.
  - Drift routes per class.
  - A missing blob blocks with a reason.
  - The I2 architecture test.
- **Fleet and policy (D5, D19, D21, D22, D25):**
  - `reconcile/retained.ts` and the retained-field merge.
  - Observations carry `kind`, `classification`, the declared `attributes`
    (trimmed to `observe_fields`, 16 KiB per resource, secret-scanned),
    `retained`, `claims` and `handover`.
  - `OBSERVE_ONLY` never calls a mutating path.
  - Departure honours `DepartureAction` and records orphans.
  - `topology` Deltas reconcile like any Set.
  - *Accept:*
    - an autoscaler-owned replica change is not drift;
    - an `OBSERVE_ONLY` Camp produces zero mutating calls (architecture test);
    - `ORPHAN_DATA` keeps the database and records it;
    - an oversized attribute is truncated with a reason, never dropped
      silently.

### WP8 — `@hobo/resolver-components` (C12, D6, I9)

- **Build:**
  - WIT package `hobo:resolver@0.1.0`. Its world imports `wasi:http/outgoing-handler`
    (host-mediated) and `hobo:resolver/host` (`log`,
    `authorized-fetch(request, credential-ref)`), and exports
    `resolver { describe, reconcile, read, delete, instances }`. Records
    mirror `ResolveRequest`/`ResolveOutcome` from
    `core/src/ports/resource-resolver.ts`.
  - The host adapter `componentResolvers(options): readonly ResourceResolver[]`
    (return type frozen here):
    - loads signed component bundles (verified via `@hobo/registry`);
    - instantiates through `runtime-wasm`/component-host;
    - enforces the declared host allowlist and the Relay proof's SSRF rules
      (no private ranges unless agent-mode local allowlist; no redirects
      off-allowlist);
    - injects credentials host-side;
    - CPU/memory/time limits;
    - deterministic `describe` caching.
  - A conformance kit (`resolver-components/conformance`) every component must
    pass.
  - Two reference components:
    - `http-artifact-upload`: generic PUT-to-endpoint plus a health probe,
      which covers many static hosts and appliances;
    - `sftp-static`: through an agent-local SFTP bridge endpoint.
  - `componentize` build recipe and authoring docs.
- **Accept:**
  - A component that calls a non-allowlisted host is denied.
  - A component cannot read the credential value: a test component that tries
    to exfiltrate through the response body is caught by the secret scanner.
  - Limits trip deterministically.
  - The reference components pass the conformance kit and the CD platform
    matrix.
- **Fleet and policy (D22):** `describe` returns `retained-fields` per resource class, and
  `read` may return attributes, which the host trims to the declared
  `observe_fields`.
  - *Accept:* a component's retained field is never reported as drift.

### WP9 — Verification engine and health sources (C3, D9, I5)

- **Build:**
  - `createVerificationEngine`: runs `VerificationSpec` over a window with
    required observations and a deadline, emitting `verification.Started`,
    `rollout.EvidenceObserved` and `verification.Completed` with per-check
    outcomes.
  - Thresholds per aggregation.
  - Mann–Whitney U as specified in D9, implemented in `verification/stats.ts`
    with golden vectors (including ties and n<8 exact-table fallback).
  - Probes (HTTP via `HttpTransport`, status and ratio) and suites
    (`VerifyPort`).
  - `fail_on_no_data` defaults to true.
  - Health sources in `verification/sources/`:
    - `prometheus.ts` (HTTP API `query_range`, step aligned to the window);
    - `hobo-metering.ts`;
    - `http-json.ts` (a JSON pointer to a numeric array);
    - `datadog.ts`, `newrelic.ts`, `cloudwatch.ts` (SigV4).

    Cohort selection uses a declared label (Prometheus, Datadog tag, New Relic
    attribute, CloudWatch dimension).
- **Promote:** `slo-promotion-gate-contract`, `error-budget-deploy-gate-contract`,
  `slo-as-code-contract`.
- **Accept:**
  - Statistical golden vectors.
  - Canary significantly worse → FAIL; significantly better → PASS.
  - No data → FAIL.
  - Deadline → INCONCLUSIVE → treated as FAIL by rollout.
  - Each source passes PACT fixtures.
  - Replay reproduces every verdict.
- **Fleet and policy (D24):** `verification/sources/hobo-posture.ts` reads the
  `noncompliant_ratio` and `shadow_divergence_count` series from the
  compliance and shadow projections, through the frozen `PostureSeriesReader`.
  - *Accept:* a window without compliance records is no data, so FAIL.

### WP10 — Rollout orchestrator (C3, C4, C5, D7, D8, D12)

- **Build:** `createRolloutOrchestrator`:
  - lowering per D7 (`rollout.Lowered`);
  - strategies as staged `OpenDeliveryEngine` records with Camps as target
    groups;
  - `CD_RAMP_DEFAULTS` and `CD_DEFAULTS` from A.6, never local constants;
  - traffic only via Station cutover;
  - `VerificationEngine` at each stage;
  - window checks at stage boundaries (hold, never abort mid-stage);
  - experiments hold until `experiment.Concluded`;
  - canary capacity reserved through the hosting budget authority;
  - rollback per D12;
  - `tick` enforces deadlines.

  Adapters: `harness.ts` (`RolloutEngine` over `OpenDeliveryEngine`) and
  `traffic.ts` (`TrafficShifter` over `executeRoutingCutover`). Keep Flagger-
  and Argo-Rollouts-shaped analysis as optional `HealthSource`s. Remove every
  fail-open default.
- **Promote:** `deployment-strategy-saga-templates-contract`, `stuck-rollout-convergence-contract`,
  `domain-cutover-saga-contract`, `hobo-delivery-port`.
- **Accept:**
  - FAIL → rollback.
  - Provider success with split traffic → non-converged.
  - Required canary with no rung → `progressive-unsupported`.
  - A freeze mid-rollout holds at the next boundary and resumes when open.
  - Replay is identical.

### WP11 — Delivery feed and agent identity (C10, D5, I3)

- **Build:**
  - `createDeliveryFeedHandler` under `/v1/cd/`:
    - leases (claim, renew, release; per Camp);
    - `GET feed` (SSE `DeliveryFeedFrame`; inline resolved set ≤256 KiB,
      otherwise digest only; heartbeat; back-pressure; resume after
      checkpoint);
    - `GET blobs/{digest}`;
    - `POST observations` and `POST checkpoints` (fenced);
    - `POST enrollments`, `POST svid/refresh`.
  - `createAgentEnrollment`:
    - single-use scoped token;
    - enroll a public JWK → `@hobo/identity` issues a JWT-SVID with `cnf.jkt`
      (RFC 7800) binding the key;
    - every request carries the SVID + a DPoP proof (RFC 9449: `htm`, `htu`,
      `iat`, `jti`, `ath`) checked against `cnf.jkt` with a durable `jti`
      replay store;
    - refresh before expiry;
    - revocation effective on the next request.
  - `createHttpTransport` (agent client). Agent egress obeys the SSRF rules.
- **Promote:** `hobo-relay-contract` (auth, SSRF and deny-by-default only).
- **Accept:**
  - PACT agent↔feed for every route and error.
  - DPoP replay is refused; a key mismatch is refused.
  - A revoked agent is refused at once.
  - Station-only egress converges a target.
  - The Station double never holds a target credential.
  - SSE resumes without gaps or duplicates.
  - Load baseline: 1,000 Camps / 50 agents, p99 frame and checkpoint latency
    recorded.
- **Fleet and policy (D19, I24):**
  - Bootstrap tokens are scoped to a Camp set.
  - `enroll` returns `ENROLLMENT_STATE_PENDING`; `approveKey` and `accept` are
    separate governed actions, honouring Rail `separate_approvers` and
    `auto_accept_scopes`.
  - The feed refuses pending reconcilers with `enrollment-incomplete`.
  - Refresh outcomes are reported to `CampInventory`.
  - *Accept:*
    - one grant alone is refused;
    - the same principal for both grants under `separate_approvers` is refused;
    - an auto-accept scope works and is recorded;
    - a token used for a Camp outside its scope is refused.

### WP12 — Service host and control API (C13)

- **Build:**
  - `createCdService`, modelled on the CI relay host: a tick loop over
    `sources`, `pipelines`, `promotions`, `rollouts`, `verification`, previews
    and retention; runs reconcilers; readiness reflects store, leases and
    source health; drain releases leases.
  - In `control-api`: mount the feed; read APIs `GET /v1/cd/pipelines/{name}`
    (graph with per-node current Freight and availability),
    `/v1/cd/freight/{id}` (timeline across Camps),
    `/v1/cd/promotions?camp=`, `/v1/cd/camps/{id}/status`; SSE
    `/v1/cd/stream`; OpenAPI.
- **Accept:**
  - Readiness flips on store loss.
  - Drain completes within the deadline.
  - The APIs match OpenAPI (PACT).
  - The stream resumes by `Last-Event-ID`.
- **Fleet and policy:**
  - The service ticks inventory, fan-out, failover and posture.
  - New read APIs:
    - `GET /v1/cd/camps?set=&taint=&condition=`
    - `/v1/cd/camps/{id}/inventory`
    - `/v1/cd/placements/{name}/decisions/{id}`
    - `/v1/cd/fanouts/{id}`
    - `/v1/cd/failovers?state=`
    - `/v1/cd/compliance?camp=&rail=`
  - The same facts are on the SSE stream.

### WP13 — Provider coverage A (C12, I14)

- **Build:** for railway, convex, flux and webernetes: a resolver registry for
  every hosting product, plus a `TrafficRoutingProviderProfile` (kind `other`
  when the union lacks one; do not edit `@hobo/core`). Respect ADR-0144 limits;
  declare absent capabilities absent. Export `<name>ResolverRegistry` and
  `<NAME>_TRAFFIC_ROUTING_PROFILE`.
- **Accept:** resolver conformance on fixtures; credential-gated live lanes;
  typed `RESOLVER_PRODUCT_UNSUPPORTED` where applicable.

### WP14 — Provider coverage B and registration (C12, I14)

- **Build:**
  - WP13's deliverables for lakebed and browser-wasm.
  - Traffic profiles wherever missing (audit vercel and netlify against
    `profiles.ts`).
  - Audit the data and transport providers (neon, upstash, prisma-postgres,
    kafka, ttl-sh, agentv, ax): each needs a realization path or a typed
    refusal.
  - Register everything, including WP13's frozen names, in
    `provider-hosting-catalog.ts`, and add an `extraResolvers?: readonly ResourceResolver[]`
    option there for component resolvers (WP18 passes WP8's output).
- **Accept:**
  - A catalog test enumerates `packages/providers/*` and asserts I14.
  - Existing resolver hosting tests stay green.

### WP15 — `hobo up` / `down` / `build` on desired state (D13)

- **Build:**
  - `build` writes `.hobo/freight.json` via `writeFreightManifest` and stores
    bytes in the configured artifact store.
  - `up` records `LOCAL_BUILD` Freight, promotes into the deployment Camp, runs
    an in-process conductor `reconcileOnce` loop with streamed progress, and
    maps the result to the unchanged `UpResult`.
  - `--to <freight|alias>` and `--rollback`.
  - `down` is a teardown Delta.
  - `--anonymous` deploy-and-claim works.
- **Accept:**
  - Existing `up`/`down`/transcript tests pass in meaning.
  - The journal shows `freight.Recorded` → `set.Created` →
    `deployment.Converged`.
  - Re-running `up` on an unchanged estate creates no duplicates.

### WP16 — Neutral broker, `@hobo/cd-gitops`, outbound boundary (C6, D14, D17)

- **Build:**
  - **Broker:** add `reconciler_mode` and `publisher`; deprecate
    `destination_namespace`; map legacy `argo` input to a publisher;
    `createReconcilerDeliveryPlane({ requestPromotion })`; move
    `renderArgoApplication` to `cd-gitops`; neutral `stations/src/types.ts`;
    an upcaster for persisted delivery facts.
  - **`@hobo/cd-gitops`:** a `PublisherPort` rendering a Set as an Argo CD
    `Application` or a Flux `Kustomization`, committed via the host's HTTP API
    (GitHub, GitLab, Gitea/Forgejo, Bitbucket adapters), with observation via
    the engine's status API.
  - **`cd/src/boundary`:**
    - pin the CDEvents spec version per Part I §I.8 R8 in
      `src/boundary/STANDARDS.lock.json`;
    - CDEvents projection: `service.deployed`/`upgraded`/`rolledback`/`removed`,
      `environment.*`, `artifact.published` (on `freight.Recorded`), and
      `dev.cdeventsx.hobo.*` for HoBo-specific facts;
    - a CloudEvents webhook sink (HTTP binding, HMAC-signed, retry with
      backoff, dead-letter);
    - a `NotificationPort` implementation.
- **Accept:**
  - Legacy Argo policy still delivers via the publisher.
  - I11 scan.
  - Publisher output is byte-stable.
  - Convergence only on observation.
  - CDEvents are golden-pinned and name their spec version.
  - Webhook signatures verify and retries are bounded.
- **Fleet and policy (D20):** `Rail` gains an optional opaque `delivery` JSON object. It is
  part of the canonical content and the digest, and `parseRail` passes it
  through unchanged. Stations never interprets it; `@hobo/cd` parses it as
  `RailDeliveryRecord`.
  - *Accept:* the Rail digest changes when `delivery` changes; legacy Rails
    parse unchanged.

### WP17 — `@hobo/storage-postgres` (C11, D16)

- **Build:** `DurableEventStore` on Postgres: expected-version append,
  `readAll` by global position, `commit` with staged effects, fenced
  subscription leases (row locks + monotonic tokens), checkpoints, snapshots.
  Migrations in the style of `packages/ci/db`. Pool config with statement
  timeouts.
- **Accept:**
  - Passes `suites/eventstore.ts` unmodified.
  - Two-process fence test.
  - Lease failover with no lost or duplicate checkpoint.
  - Container-backed lane, skipped with a visible reason when unavailable.

### WP18 — Composition, CLI, MCP, operator surface (C2)

- **Build:**
  - `composeContinuousDelivery` binds every factory and adapter. Store
    selection: SQLite by default, Postgres when configured.
  - Component resolvers into the catalog via `extraResolvers`.
  - CI bridge as a `HOBO_CI` subscription.
  - `hobo deploy` subcommands:
    - `freight record|list|show|yank|approve`
    - `source define|list|poll`
    - `pipeline apply|show|list`
    - `window define|list|override`
    - `promote` (with `--propose`), `status`, `logs`, `rollback`, `reconcile`
    - `preview create|list`
    - `verify show`
    - `agent token|enroll|run|revoke`
    - `publisher define`, `metrics`
    - `hosting-*` kept.
  - `hobo serve cd` (conductor service) through `serve-control-command.ts`.
    `--simulate` is the only fixture path, labelled. Migrate
    `incident-command.ts` to the new rollback.
  - Write `packages/hobo/CD.md` and update the `deploy` help in `verbs.ts`. No
    new canonical verb.
  - Pipelines, sources and windows can also be authored as code: a
    `hobo.delivery.ts` module exporting records, applied by
    `hobo deploy pipeline apply --file`.
  - **Fleet and policy:**
    - Compose inventory, placement, fan-out, failover, Camp policy and
      posture.
    - `TopologyReader` comes from `@hobo/camps`/`@hobo/yards`, and
      `RailDeliveryReader` from the Stations Rail `delivery` object.
    - `RailEventReader` and `PostureSeriesReader` come from the journal.
    - When configured, wire `@hobo/cd-kube-fleet` realizers and the
      ClusterProfile import.
    - New subcommands:
      - `campset define|list`
      - `camp list|show|taint|untaint|manage`
      - `placement define|decide|show`
      - `scores report`
      - `fanout show|halt|resume|rollback`
      - `failover list|approve`
      - `rebalance`
      - `compliance show`
      - `agent approve-key|accept`

      Rails promote through `promote` with Rail Freight.
- **Accept:**
  - `assertToolSurfaceParity`.
  - No fixture without `--simulate`.
  - Every refusal has a code and a next step.
  - Agent and human sessions get identical structures.
  - `--format json|text`.

### WP19 — Governance and telemetry (C13, D15, D17)

- **Build:**
  - `createCdAuthorizer`: a policy pack rule per `CdAction`; decisions
    recorded; agents proposal-only by default.
  - `createCdTelemetry`: DORA (deployment frequency, lead time
    `freight.Recorded` → `env.Promoted` per Camp, change failure rate, time to
    restore), reconcile lag, health.
  - `createTelemetrySink`: OTLP/HTTP JSON exporter over `HttpTransport` (no
    SDK dependency), batching and retry.
  - Pin the semantic-conventions version per Part I §I.8 R8 in
    `src/telemetry/STANDARDS.lock.json`.
  - Span and metric names and attributes follow the OTel CI/CD semantic
    conventions (`cicd.pipeline.*`, `cicd.pipeline.run.*`,
    `cicd.pipeline.task.*`, `cicd.pipeline.result`), plus `hobo.freight.id`,
    `hobo.camp.id`, `deployment.environment.name`.
  - **yard-world:** map CD spans to Camps and Stations; add Freight-timeline
    and pipeline-graph model views.
  - Alert rules and SLOs for the CD plane, handed to WP21.
  - **Fleet and policy:**
    - Rules for every new `CdAction`, with separation of duties for the two
      enrollment grants.
    - Metrics `hobo.cd.fanout.camps{state}`, `hobo.cd.failover.count{state}`,
      `hobo.cd.compliance.noncompliant_ratio`,
      `hobo.cd.policy.shadow_divergence`.
    - yard-world fleet views: Camps by condition and taint, and a compliance
      heatmap by Rail and control.
- **Accept:**
  - DORA metrics match hand-computed fixtures.
  - Span attributes validate against the semconv registry snapshot pinned in
    the test.
  - yard-world renders a promotion trace.
  - An unauthorized action is refused with a recorded decision.

### WP20 — Conformance, platform matrix, behavior, chaos

- **Build:**
  - Conformance suites for `Realizer`, `TrafficShifter`, `HealthSource`,
    `PublisherPort`, `ReconcilerTransport`, `ArtifactStore`,
    `ArtifactVerifier`, `ProvenanceVerifier`, `SubscriptionDriver`.
  - **Platform matrix:** one Freight across every traffic rung and none, every
    artifact kind, a built-in resolver and a WASM-component resolver.
  - **Toolset matrix:** the same Freight ingested via OCI polling, Git
    polling, GitHub OIDC push, GitLab OIDC push, an in-toto attestation, a
    CDEvent nudge and HoBo CI. Each must yield the same Freight id.
  - Cucumber journeys: dev → staging → prod lineage; canary auto-rollback on a
    Mann–Whitney failure; freeze hold and resume; hotfix approval; drift
    remediation; agent proposal; preview lifecycle; GitOps publisher.
  - Chaos lane: kill a reconciler mid-converge, partition an agent, store
    failover, source registry outage.
  - Mutation and load entries for `packages/cd` and `packages/resolver-components`.
  - Runnable `examples/cd-github-actions`, `examples/cd-gitlab`,
    `examples/cd-airgap-agent`.
  - **Fleet and policy:**
    - Conformance suites for `PlacementEngine` (permutation determinism),
      `FanoutController`, `PostureEvaluator` and `CampInventory`.
    - Journeys: retail edge fleet (400 Camps); regional failover across
      providers; Rail inform → enforce; brownfield ClusterProfile import to
      managed.
    - Chaos: an agent flapping conditions (never `NO_RUN`); mass lease loss
      (failover budget holds; nothing purged early).
    - Load: 10,000 Camps, one fan-out, Postgres, p99 controller tick < 1 s.
    - Examples: `examples/cd-edge-fleet`, `examples/cd-policy-rollout`.
- **Accept:**
  - The matrices run offline.
  - Every §10 row has a named test.
  - Chaos never ends wedged.

### WP21 — Registration and documentation

- **Build:**
  - ADR-0178, recording D1–D26, as a `## ADR-0178` section in
    `docs/design/adr/01-architecture-core.md`, with an index row in
    `docs/design/adr/index.md` (Part I §I.8 R3).
  - Glossary: Freight, Freight source, Subscription, Pipeline (graph),
    Qualification, Approval (Freight), Change window, Reconciler, Delivery
    feed, Resolver component, Preview environment, Camp set, Placement,
    Placement decision, Fan-out, Quorum, Taint, Toleration, Failover,
    Rebalance, Policy binding (inform/enforce), Posture, Compliance; sharpen
    Deployment Set/Delta and distinguish Placement (Camps) from Matching
    (providers and resolvers).
  - `event-families.md` rows for every `CD_EVENTS` name.
  - Register `packages/{cd,cd-gitops,cd-kube-fleet,storage-postgres,resolver-components}` in
    `KNOWN_PACKAGE_PATHS`, `turbo.json`, `konsistent.json`,
    `package-namespaces.md`, `npm-publish-allowlist.md`.
  - Correct the stated package counts in `README.md`, `PRODUCT.md`,
    `CLAUDE.md`.
  - New `docs/design/continuous-delivery.md`.
  - Rewrite Plan 25's Sets/Deltas/Pipelines/Relay to D2/D4/D5.
  - Resolve copy-versus-re-resolve in `patterns/gitops-runbook-promotion.md`.
  - Update `drift-reconciliation.md`, `environment-lifecycle.md`,
    `release-channels.md` (Freight ≠ release channel), `artifact-store.md`,
    `contracts-policy-flags.md`, `cli-spec.md`, and the competitor rows
    (`argo-cd.md`, `flux-cd.md`, `kargo` (new if absent), `harness.md`,
    `octopus-deploy.md`, `karmada` and `open-cluster-management` (new if
    absent)).
  - Update `governance-planes.md` (posture and compliance), `stations.md`
    (Rail `delivery`), and `contracts-policy-flags.md` (shadow decisions).
  - Runbooks under `docs/runbooks/cd/`, assembled from WP sections.
  - Resolver-component authoring guide.
  - Upgrade notes for `DeliveryPolicy`.
  - `GAPS.md` closures (append only).
  - README "HoBo.CD" section; `llms*.txt`; `docs/plans/index.md` row;
    `docs/plans/hobo-cd/sdlc-state.md`.
- **Accept:** the `docs:*` gates pass, and no document claims a capability the
  merged build lacks.

### WP22 — Camp inventory and Placement (C18, C19, C20, D19, D20, I18, I19)

- **Build:**
  - `createCampInventory`:
    - fold `cd-camp-inventory-<id>`;
    - `observe` merges conditions and claims, and records each condition's
      source;
    - `tick` derives `REACHABLE`/`LEASED` from Station-observed lease activity,
      `CREDENTIAL_VALID` from SVID expiry and refresh results, and
      `CLAIMS_CONSISTENT` by comparing claims with `TopologyReader`;
    - adds and clears automatic `NO_PLACE` taints;
    - adds `NO_RUN` only from an operator, or from a Rail rule meeting
      `required_signals` with at least one Station-observed signal;
    - Camp sets: `defineSet`, plus membership from selectors over topology;
    - `snapshot` returns a canonical, digest-stable view.
  - `createPlacementEngine`:
    - `define` validates spread keys, group selectors and sizes;
    - `reportScores` (authorized) stores snapshots;
    - `decide` follows D20 exactly as a pure function
      (`placement/decide.ts`) over `(placement, snapshot, scores, residency,
      railDelivery, atMs)`;
    - every exclusion has a code (`taint-not-tolerated`, `claim-missing`,
      `residency-conflict:<code>`, `provider-not-approved`, `set-not-bound`,
      `observe-only`);
    - `placement-unsatisfiable` names the unmet spread key;
    - decisions are recorded as `placement.Decided`.
- **Accept:**
  - Property test: any permutation of inventory and score order yields a
    byte-identical decision.
  - Expired scores are ignored.
  - A claim of `region=eu-west-1` on a Camp declared in `us-east-1` taints it
    `NO_PLACE` and never satisfies an EU residency constraint.
  - An unbound set is invisible.
  - Spread `provider min 3` with two providers is `placement-unsatisfiable`.
  - Agent-reported `REACHABLE=false` alone never adds `NO_RUN`.
  - A silent SVID refresh failure surfaces as `CREDENTIAL_VALID=false` within
    one tick.
  - Upcaster corpus entries for `camp.*`, `campset.*` and `placement.*`.

### WP23 — Fan-out, failover and rebalance (C18, C19, D21, D23, I20, I21)

- **Build:**
  - `createFanoutController`, a `defineSaga` over `cd-fanout-<id>` holding
    lease `cd:fanout:<id>`:
    - start from a recorded decision;
    - request per-Camp promotions with idempotency key
      `fanout:<id>:<camp>`;
    - classify each Camp as succeeded, failed or deferred per D21;
    - enforce concurrency, mandatory groups and the failure budget;
    - `fanout.Progressed` per transition;
    - halt, resume and rollback (D12 per failed Camp);
    - supersede at a group boundary;
    - departure Deltas per `DepartureAction`;
    - `MATCH_NODE` catch-up requests for Camps entering the node after the
      fan-out completes.
  - `createFailoverController`:
    - `tick` proposes failovers for untolerated `NO_RUN` taints;
    - the D23 saga, with states `PROPOSED` → `REPLACING` → `VERIFYING` →
      `SHIFTING` → `PURGING` → `COMPLETED`, or `REFUSED`/`ABANDONED`;
    - Rail `automatic`, `max_concurrent` and `allow_immediate_purge`;
    - the `failover-unsafe` check over the Bindle's data resources and Junction
      reachability;
    - `handover_outputs` passed from the source's last observation;
    - traffic shifts only through the rollout traffic adapter (Station
      cutover);
    - `rebalance` records moves and runs them as GRACEFUL moves under the
      node's fan-out limits.
- **Accept:**
  - 400 Camps, `PROGRESSIVE_PER_GROUP`, 3 unreachable:
    - the 3 are deferred, not failed;
    - quorum 95% qualifies;
    - they catch up on reconnect.
  - A mandatory group failure blocks the remaining groups.
  - Exceeding 2% failures halts, and `rollback_on_halt` restores the failed
    Camps only.
  - Never more than `max_concurrency` in flight, under chaos.
  - Failover:
    - the replacement passes residency;
    - GRACEFUL keeps the source until the replacement qualifies;
    - a data resource in the source Camp gives `failover-unsafe`;
    - no failback when the taint clears.
  - Two concurrent failovers with `max_concurrent: 1` serialize.
  - Rebalance is refused without authorization.

### WP24 — Policy delivery and posture (C21, C22, D24, D25, I22, I23)

- **Build (in `@hobo/policy`, dependency-free):**
  - `posture/` holds:
    - the observe-phase posture rule format (kinds, classifications,
      `require`/`forbid`, the fixed operator set, severity, control ids,
      `observe_fields`) as a policy-IR rule profile;
    - `evaluatePosture(rules, observation)`, pure and deterministic, returning
      per-rule, per-resource findings;
    - `observeFields(packs)`;
    - `toOscalAssessmentResults(records)` beside `oscal-export.ts`.
  - A `./posture` export in `packages/policy/package.json`.
- **Build (in `@hobo/cd`):**
  - `createCampPolicy`:
    - fold `policy.BindingChanged` from Camp spec streams;
    - `bind` is called by promotion only (INFORM sets the candidate; ENFORCE
      swaps the enforced Rail and clears the candidate);
    - `restore` for rollback;
    - Camps without a binding resolve to the Station's active Rail.
  - `createShadowRecorder` (`posture/shadow.ts`) gives the gate the
    candidate Rail and its resolved pack, and records `policy.ShadowDecided`.
  - `createPostureService`:
    - evaluate due Camps from the latest status observation with the pure
      evaluator;
    - append `compliance.Observed` and `compliance.Changed`;
    - update `POSTURE_COMPLIANT`;
    - apply remediation per D25, including ownership checks against the
      current Set and `ownership-conflict` findings consumed by the gate;
    - in `OBSERVE_ONLY`, inform only.
  - The `ComplianceRecord` and shadow projections that `HOBO_POSTURE` reads.
- **Accept:**
  - Inform → enforce journey:
    - while INFORM, the enforced Rail alone decides;
    - divergences are recorded;
    - an ENFORCE node without a qualified INFORM upstream is refused;
    - rollback restores the previous digest.
  - `inform-only` cannot be escalated by a parent `enforce`.
  - A posture rule that contradicts a Set-owned value mutates nothing and
    yields `ownership-conflict`. The next promotion that keeps the violation is
    refused.
  - An unowned-field `enforce` produces a gated `posture-remediate` Delta
    applied by the reconciler (I2 architecture test).
  - Evaluator golden vectors for every operator.
  - OSCAL assessment results validate against the pinned OSCAL schema.
  - Replay reproduces every compliance record.

### WP25 — `@hobo/cd-kube-fleet` (C23, D26)

- **Build:**
  - The package with `package.json`, `tsconfig`, `vitest.config.ts`,
    `LICENSE` and `README.md`. It depends on `@hobo/cd` and `@hobo/core`,
    with no Kubernetes client library: it talks to the Kubernetes API over
    `HttpTransport` with bearer or exec credentials from `CredentialResolver`.
  - `clusterProfileInventory`:
    - list and watch `multicluster.x-k8s.io/v1alpha1` ClusterProfiles;
    - map each to a `CampTopology` (`OBSERVE_ONLY`) and its properties and
      status to observed claims;
    - credentials via the ClusterProfile access providers, resolved
      host-side, never recorded.
  - `ocmRealizer(): Realizer`:
    - one ManifestWork per Camp (`hobo-<camp>-<setdigest8>`) in the hub's
      cluster namespace;
    - feedback rules generated from `observe_fields`;
    - `deleteOption` from `DepartureAction`;
    - converge only on observed Applied/Available plus HoBo verification.
  - `karmadaRealizer(): Realizer`:
    - resource templates plus a PropagationPolicy pinned to one cluster
      (`Duplicated`, `clusterAffinity.clusterNames: [<member>]`);
    - observation from the ResourceBinding aggregated status;
    - no OverridePolicy.
  - Recorded fixtures for both hubs, and a kind-based lane gated on
    availability with a visible skip reason.
- **Accept:**
  - The realizers pass the `Realizer` conformance suite.
  - A HoBo fan-out over OCM-backed Camps creates N single-cluster
    ManifestWorks, never a ManifestWorkReplicaSet.
  - The Karmada output is pinned to exactly one cluster.
  - ClusterProfile import yields `OBSERVE_ONLY` Camps that posture can
    evaluate.
  - No Kubernetes type crosses into `@hobo/cd` (I11 scan).

## 10. Adversarial acceptance matrix

| Scenario | Required outcome | Owner |
|---|---|---|
| Two reconcilers, different ids, one Camp | One writer; the other fenced | WP7 |
| Crash after execute, before observe | Resume by observation; no repeat | WP7 |
| Observations under heavy apply load | No spec-stream conflicts | WP4 |
| Postgres lease holder dies | Another resumes; no lost or duplicate checkpoint | WP17 |
| Forged registry webhook | Refused; no poll | WP2 |
| Valid webhook for an unsigned image under `require_provenance` | Poll runs; image skipped with reason | WP2 |
| CDEvent `artifact.published` without attestation | Polls scheduled; no Freight | WP1 |
| OIDC token from an unconfigured issuer | Refused | WP1 |
| Sigstore bundle with a tampered subject | Refused | WP3 |
| Freight not qualified in staging promoted to prod | Refused (lineage) | WP6 |
| Approval expired before promotion | Refused | WP5 |
| Two Freights queued for one Camp | Newest proceeds; older superseded | WP6 |
| Health source returns no data | FAIL; no qualification | WP9 |
| Canary error rate significantly worse | FAIL → rollback | WP9/WP10 |
| Provider reports success, traffic still split | Non-converged; verdict at deadline | WP10 |
| Canary required, no traffic capability | `progressive-unsupported` | WP10 |
| Freeze starts mid-rollout | Holds at next boundary; resumes when open | WP10 |
| Promotion requested during a freeze, no override | `AWAITING_WINDOW` | WP6 |
| Rollback past a completed Trails contract | Refused; expand named | WP6 |
| Same promotion requested twice | One promotion | WP6 |
| Two Camps on different providers | Identical digests; diff shown | WP6 |
| Agent principal applies directly | Proposal only | WP19 |
| DPoP proof replayed | Refused | WP11 |
| Revoked agent mid-feed | Refused on next request | WP11 |
| Agent with Station-only egress | Converges; no target credential at the Station | WP11 |
| Resolver component calls a non-allowlisted host | Denied | WP8 |
| Resolver component tries to exfiltrate a credential | Impossible; scanner proves it | WP8 |
| Resolved-plan blob missing at agent | Blocked with reason | WP7 |
| Artifact corrupted at rest | Detected; promotion blocked | WP3 |
| Retention sweep with Freight deployed in prod | Prod Freight kept | WP1 |
| Air-gapped Yard, egress disabled | Promotes via local source and agent | WP20 |
| Same Freight via seven ingress paths | Same Freight id | WP20 |
| Journal replay of a full pipeline run | Identical state | WP20 |
| Inventory listed in a different order | Byte-identical placement decision | WP22 |
| Agent claims a region it is not declared in | `NO_PLACE`; never satisfies residency | WP22 |
| Agent reports itself unreachable 100 times | No `NO_RUN`; no failover | WP22 |
| Spread `provider min 3` with two providers | `placement-unsatisfiable` | WP22 |
| 3 of 400 Camps offline during fan-out | Deferred, not failed; caught up later | WP23 |
| Failures exceed the budget mid-fan-out | Halt; failed Camps rolled back only | WP23 |
| Mandatory pilot group fails | Remaining groups never start | WP23 |
| Provider region dies; Rail permits automation | One governed failover at a time; residency holds; source kept until replacement qualifies | WP23 |
| Failover when the database lives in the failing Camp | `failover-unsafe`; Trails handover named | WP23 |
| Tainted Camp recovers | No automatic failback | WP23 |
| New Rail bound INFORM | Enforced Rail decides; divergences recorded | WP24 |
| Rail ENFORCE without qualified INFORM | Refused | WP5/WP24 |
| Posture rule contradicts a Set-owned value | `ownership-conflict`; no mutation; next violating promotion refused | WP24 |
| Posture `enforce` on an unowned field | Gated repair Delta applied by the reconciler | WP24 |
| `inform-only` binding under a parent `enforce` | Stays inform | WP24 |
| Reconciler with only one enrollment grant | `enrollment-incomplete` | WP11 |
| Fan-out cost exceeds Station budget | Refused before any Camp starts | WP6 |
| HoBo fan-out over OCM-backed Camps | N single-cluster ManifestWorks; no ManifestWorkReplicaSet | WP25 |
| Autoscaler changes replicas on target | Retained; not drift | WP7 |

## 11. Merge and gates (coordinator)

0. Before dispatch, cut `integration/hobo-cd` from `origin/main`. Make the
   contract commit (§7.2). Run `pnpm install && pnpm run codegen`, and check
   that `typecheck` passes on the empty modules. Then dispatch WP1–WP25 at
   once.
1. Rolling integration runs throughout (§7.4). When all reports are in, merge
   `integration/hobo-cd`. Frozen files must be identical; any conflict there
   is a contract violation.
2. Run `pnpm install`, `pnpm run codegen`, `pnpm run promotions:check -- --update`,
   and record the promoted proofs in `scripts/promotions.json`.
3. Full gate, with failures returned to owners until green:
   `pnpm agent:check -- --base=origin/main`, `architecture:guard`,
   `standards:check`, `codegen:check`, `generated:guard`, `lint:boundaries`,
   `lint:test-deps`, `konsistent`, `promotions:check`, `test:schema`,
   `draft:artifacts`, `draft:cascade`, `test:behavior`, `test:chaos`,
   `test:mutation`, `lint:slop:changed`, `licenses:check`, `case:check`, all
   package tests, the `docs:*` gates, and the live lanes when credentials are
   present.
4. Update `docs/plans/hobo-cd/sdlc-state.md`; land per the sdlc skill.

**Done when:**

- [ ] C1–C23 are closed.
- [ ] I1–I24 each have a passing test.
- [ ] Every §10 row passes.
- [ ] The toolset matrix yields one Freight id from seven ingress paths.
- [ ] Every hosting provider passes I14, and a WASM-component resolver passes
      the platform matrix.
- [ ] No fixture is reachable without `--simulate`.
- [ ] `hobo up` deploys through a reconciler.
- [ ] The broker delivers through CD.
- [ ] A 400-Camp fan-out, a regional failover and a Rail inform → enforce
      journey pass end to end.
- [ ] Every gate is green.
- [ ] Every residual list is empty.

## 12. Forbidden

- A second rollout state machine, approval system, budget ledger, event
  envelope, delivery lane, step runner or policy/expression language
  (including CEL).
- New provider port methods; edits to `@hobo/core` port shapes.
- Kubernetes/OCI-runtime/Git-host/Argo/Flux/vendor types in `@hobo/cd` outside
  `adapters/` and `verification/sources/`.
- A reverse tunnel for delivery; shell-script resolvers.
- Freight created from an unverified webhook or event payload.
- ML or model calls on any decision path; clock, RNG or network in decisions.
- Raw secrets in any record, log, or resolver-component memory.
- Defaults that pass on absent evidence; silent strategy downgrades.
- A new canonical CLI verb; hand-written MCP tools.
- Moving `OpenDeliveryEngine` or proto messages between existing packages.
- New `.js/.mjs/.cjs` files; hand-edited generated files; edits to frozen
  proofs or frozen contract files (except by coordinator amendment).
- Anything under `.github/workflows/`.
- JSON-patch or override policies on resolved state; tag rewriting; mirrors
  that change a digest.
- Automatic failback, background rescheduling, or `NO_RUN` from an agent's
  self-report alone.
- Posture or policy controllers that mutate targets directly; posture
  evaluation inside agents.
- Lua, CEL or string templating in placement, posture or status
  interpretation.
- Message-broker transports for the delivery feed.
- Letting Karmada or OCM schedule, override, fail over or roll out a HoBo
  delivery.

## 13. Final report

Return:

1. the decisions as landed, with any deviation and why;
2. the contract amendments issued;
3. files per package;
4. how to exercise every surface;
5. the §10 matrix with test names;
6. the toolset and platform matrix results, plus the fleet, failover and
   policy journeys;
7. gate results;
8. explicit confirmation of every "Done when" item.

---

## Appendix A — Frozen files (byte-identical everywhere; amended only by the coordinator)

### A.1 `packages/cd/package.json`

```json
{
  "name": "@hobo/cd",
  "version": "0.0.1",
  "description": "HoBo CD: Freight discovery and ingestion from any toolset, pipeline graphs with lineage, fenced pull reconcilers, deterministic verification, capability-lowered progressive rollout, fleet placement and fan-out, governed failover, and policy delivery with posture for every platform",
  "license": "MIT",
  "type": "module",
  "publishConfig": { "access": "public" },
  "files": [
    "LICENSE",
    "dist"
  ],
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./freight": { "types": "./dist/freight/index.d.ts", "default": "./dist/freight/index.js" },
    "./ingest": { "types": "./dist/ingest/index.d.ts", "default": "./dist/ingest/index.js" },
    "./sources": { "types": "./dist/sources/index.d.ts", "default": "./dist/sources/index.js" },
    "./artifacts": { "types": "./dist/artifacts/index.d.ts", "default": "./dist/artifacts/index.js" },
    "./provenance": { "types": "./dist/provenance/index.d.ts", "default": "./dist/provenance/index.js" },
    "./sets": { "types": "./dist/sets/index.d.ts", "default": "./dist/sets/index.js" },
    "./pipelines": { "types": "./dist/pipelines/index.d.ts", "default": "./dist/pipelines/index.js" },
    "./windows": { "types": "./dist/windows/index.d.ts", "default": "./dist/windows/index.js" },
    "./promotion": { "types": "./dist/promotion/index.d.ts", "default": "./dist/promotion/index.js" },
    "./reconcile": { "types": "./dist/reconcile/index.d.ts", "default": "./dist/reconcile/index.js" },
    "./verification": { "types": "./dist/verification/index.d.ts", "default": "./dist/verification/index.js" },
    "./rollout": { "types": "./dist/rollout/index.d.ts", "default": "./dist/rollout/index.js" },
    "./feed": { "types": "./dist/feed/index.d.ts", "default": "./dist/feed/index.js" },
    "./agent": { "types": "./dist/agent/index.d.ts", "default": "./dist/agent/index.js" },
    "./service": { "types": "./dist/service/index.d.ts", "default": "./dist/service/index.js" },
    "./boundary": { "types": "./dist/boundary/index.d.ts", "default": "./dist/boundary/index.js" },
    "./telemetry": { "types": "./dist/telemetry/index.d.ts", "default": "./dist/telemetry/index.js" },
    "./authz": { "types": "./dist/authz/index.d.ts", "default": "./dist/authz/index.js" },
    "./inventory": { "types": "./dist/inventory/index.d.ts", "default": "./dist/inventory/index.js" },
    "./placement": { "types": "./dist/placement/index.d.ts", "default": "./dist/placement/index.js" },
    "./fanout": { "types": "./dist/fanout/index.d.ts", "default": "./dist/fanout/index.js" },
    "./failover": { "types": "./dist/failover/index.d.ts", "default": "./dist/failover/index.js" },
    "./posture": { "types": "./dist/posture/index.d.ts", "default": "./dist/posture/index.js" },
    "./compose": { "types": "./dist/compose/index.d.ts", "default": "./dist/compose/index.js" }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "lint": "biome check .",
    "test": "vitest run"
  },
  "dependencies": {
    "@bufbuild/protobuf": "2.12.1",
    "@hobo/cloud": "workspace:*",
    "@hobo/contracts": "workspace:*",
    "@hobo/core": "workspace:*",
    "@hobo/dispatcher": "workspace:*",
    "@hobo/events": "workspace:*",
    "@hobo/identity": "workspace:*",
    "@hobo/policy": "workspace:*",
    "@hobo/registry": "workspace:*",
    "@hobo/stations": "workspace:*",
    "@hobo/trust": "workspace:*",
    "sigstore": "5.0.1"
  }
}
```

### A.2 `packages/cd/tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "types": [
      "node"
    ]
  },
  "include": [
    "src"
  ]
}
```

### A.3 `packages/cd/vitest.config.ts`

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({
	test: {
		environment: "node",
		include: ["test/**/*.test.ts", "contracts/**/*.test.ts"],
	},
});
```

### A.4 `packages/cd/data-models/buf.yaml`

```yaml
version: v2
lint:
  use: [DEFAULT]
```

### A.5 `packages/cd/data-models/cd.proto`

```proto
syntax = "proto3";
package hobo.cd.v1;

// Frozen by docs/plans/0024 (final). Records reference each other by string id.
// Constraints live in the per-module *.cue files beside this file.

// ── Shared ──────────────────────────────────────────────────────────────────

message ReasonRecord {
  string code = 1;
  string message = 2;
  string remediation = 3;
  string subject = 4;
}

message SelectorRecord {
  map<string, string> labels = 1;
  repeated string env_types = 2;
  repeated string jurisdictions = 3;
  repeated string camp_ids = 4;
  repeated string bindles = 5;
}

// ── Artifacts and provenance ────────────────────────────────────────────────

enum ArtifactKind {
  ARTIFACT_KIND_UNSPECIFIED = 0;
  ARTIFACT_KIND_WASM_COMPONENT = 1;
  ARTIFACT_KIND_FUNCTION_BUNDLE = 2;
  ARTIFACT_KIND_STATIC_ASSETS = 3;
  ARTIFACT_KIND_OCI_IMAGE = 4;
  ARTIFACT_KIND_VM_IMAGE = 5;
  ARTIFACT_KIND_PACKAGE = 6;
  ARTIFACT_KIND_SOURCE_TREE = 7;
}

message ArtifactRef {
  string name = 1;
  ArtifactKind kind = 2;
  // sha256:<64 lowercase hex>
  string digest = 3;
  // Artifact-store locator, registry coordinate, purl or Git URL@commit.
  string coordinate = 4;
  uint64 size_bytes = 5;
  string media_type = 6;
  // oci | npm | nuget | pypi | maven | cargo | rubygems | git | http | store
  string ecosystem = 7;
}

message SourceRef {
  string repository = 1;
  string commit = 2;
  string ref = 3;
  string ci_run_id = 4;
  string ci_system = 5;
  string builder_id = 6;
}

message ProvenanceRef {
  string statement_digest = 1;
  string predicate_type = 2;
  string builder_id = 3;
  string signer_identity = 4;
  string issuer = 5;
  bool verified = 6;
  // sigstore | hobo-jwt
  string verifier = 7;
  repeated string subject_digests = 8;
}

message ArtifactStoredRecord {
  ArtifactRef artifact = 1;
  string backend = 2;
  string stored_at = 3;
}

message ArtifactDeletedRecord {
  string digest = 1;
  string backend = 2;
  string reason = 3;
  string deleted_at = 4;
}

// ── Freight ─────────────────────────────────────────────────────────────────

// hobo.freight-manifest/v1: written by any build, parsed at one boundary.
message FreightManifestRecord {
  string schema_version = 1;
  string bindle = 2;
  string declaration_hash = 3;
  repeated ArtifactRef artifacts = 4;
  SourceRef source = 5;
  repeated ProvenanceRef provenance = 6;
  map<string, string> labels = 7;
  // UNSPECIFIED reads as BINDLE. For RAIL: bindle = Rail id,
  // declaration_hash = Rail content digest, artifacts empty (D24).
  FreightSubject subject = 8;
}

enum FreightOrigin {
  FREIGHT_ORIGIN_UNSPECIFIED = 0;
  FREIGHT_ORIGIN_MANIFEST = 1;
  FREIGHT_ORIGIN_ATTESTATION = 2;
  FREIGHT_ORIGIN_SOURCE_DISCOVERY = 3;
  FREIGHT_ORIGIN_CDEVENT = 4;
  FREIGHT_ORIGIN_HOBO_CI = 5;
  FREIGHT_ORIGIN_LOCAL_BUILD = 6;
}

message FreightRecord {
  string schema_version = 1;
  string freight_id = 2;
  string alias = 3;
  FreightManifestRecord manifest = 4;
  FreightOrigin origin = 5;
  string source_name = 6;
  string recorded_by = 7;
  string recorded_at = 8;
}

message FreightYankedRecord {
  string freight_id = 1;
  string reason = 2;
  string yanked_by = 3;
  string yanked_at = 4;
}

message FreightQualifiedRecord {
  string freight_id = 1;
  string camp_id = 2;
  string pipeline = 3;
  string node = 4;
  string verification_id = 5;
  string qualified_at = 6;
}

message FreightApprovedRecord {
  string freight_id = 1;
  string camp_id = 2;
  string approved_by = 3;
  string reason = 4;
  string decision_id = 5;
  string approved_at = 6;
  string expires_at = 7;
}

message FreightRetiredRecord {
  string freight_id = 1;
  string reason = 2;
  string retired_at = 3;
}

message RetentionPolicyRecord {
  string bindle = 1;
  uint32 keep_per_camp = 2;
  uint64 keep_unpromoted_ms = 3;
  repeated string legal_hold_labels = 4;
  uint64 blob_grace_ms = 5;
}

message TrustedPublisherRecord {
  string name = 1;
  string issuer = 2;
  string audience = 3;
  // Exact-match claim constraints, e.g. repository, workflow_ref, environment.
  map<string, string> required_claims = 4;
  repeated string bindles = 5;
}

// ── Freight sources (pull discovery) ────────────────────────────────────────

enum SubscriptionKind {
  SUBSCRIPTION_KIND_UNSPECIFIED = 0;
  SUBSCRIPTION_KIND_OCI_REPOSITORY = 1;
  SUBSCRIPTION_KIND_GIT_REPOSITORY = 2;
  SUBSCRIPTION_KIND_PACKAGE_REGISTRY = 3;
  SUBSCRIPTION_KIND_HTTP_INDEX = 4;
  SUBSCRIPTION_KIND_HOBO_CI = 5;
  SUBSCRIPTION_KIND_HOBO_RAIL = 6;
}

enum SelectionStrategy {
  SELECTION_STRATEGY_UNSPECIFIED = 0;
  SELECTION_STRATEGY_SEMVER = 1;
  SELECTION_STRATEGY_NEWEST_BUILD = 2;
  SELECTION_STRATEGY_LEXICAL = 3;
  SELECTION_STRATEGY_NEWEST_COMMIT = 4;
}

message SubscriptionRecord {
  string name = 1;
  SubscriptionKind kind = 2;
  string locator = 3;
  string ecosystem = 4;
  SelectionStrategy selection = 5;
  string semver_range = 6;
  string allow_pattern = 7;
  repeated string ignore_patterns = 8;
  repeated string include_paths = 9;
  repeated string exclude_paths = 10;
  string branch = 11;
  uint32 discovery_limit = 12;
  string credential_ref = 13;
  bool require_provenance = 14;
  repeated string trusted_builder_ids = 15;
  repeated string trusted_signer_identities = 16;
  string artifact_name = 17;
  ArtifactKind artifact_kind = 18;
}

enum AssemblyRule {
  ASSEMBLY_RULE_UNSPECIFIED = 0;
  ASSEMBLY_RULE_INDEPENDENT = 1;
  ASSEMBLY_RULE_SAME_VERSION = 2;
  ASSEMBLY_RULE_SAME_COMMIT = 3;
}

message FreightSourceRecord {
  string schema_version = 1;
  string name = 2;
  string bindle = 3;
  repeated SubscriptionRecord subscriptions = 4;
  AssemblyRule assembly = 5;
  bool automatic = 6;
  uint64 poll_interval_ms = 7;
  string defined_by = 8;
}

message DiscoveredArtifactRecord {
  string source = 1;
  string subscription = 2;
  ArtifactRef artifact = 3;
  string version = 4;
  string commit = 5;
  string discovered_at = 6;
  repeated ProvenanceRef provenance = 7;
}

// ── Desired state ───────────────────────────────────────────────────────────

enum SetOrigin {
  SET_ORIGIN_UNSPECIFIED = 0;
  SET_ORIGIN_PROMOTION = 1;
  SET_ORIGIN_UP = 2;
  SET_ORIGIN_ROLLBACK = 3;
  SET_ORIGIN_DRIFT_ADOPTION = 4;
  SET_ORIGIN_TEARDOWN = 5;
  SET_ORIGIN_LEGACY_FOLD = 6;
  SET_ORIGIN_PREVIEW = 7;
  SET_ORIGIN_CONFIG = 8;
  SET_ORIGIN_TOPOLOGY = 9;
  SET_ORIGIN_FAILOVER = 10;
  SET_ORIGIN_POSTURE_REMEDIATION = 11;
  SET_ORIGIN_DEPARTURE = 12;
}

message SetRecord {
  string schema_version = 1;
  string set_id = 2;
  string tenant = 3;
  string environment = 4;
  string camp_id = 5;
  string freight_id = 6;
  string plan_hash = 7;
  string content_hash = 8;
  string predecessor_set_id = 9;
  string gate_decision_id = 10;
  SetOrigin origin = 11;
  // Content-addressed blob of the canonical, secret-free ResolvedDeploymentSet.
  string resolved_set_digest = 12;
  uint64 resolved_set_bytes = 13;
  string created_at = 14;
}

enum ChangeKind {
  CHANGE_KIND_UNSPECIFIED = 0;
  CHANGE_KIND_ADD = 1;
  CHANGE_KIND_UPDATE = 2;
  CHANGE_KIND_REMOVE = 3;
}

message ResourceChange {
  string resource = 1;
  ChangeKind kind = 2;
  string provider = 3;
  string product_id = 4;
  string before_hash = 5;
  string after_hash = 6;
}

message DeltaRecord {
  string schema_version = 1;
  string delta_id = 2;
  string camp_id = 3;
  string base_set_id = 4;
  string freight_id = 5;
  repeated ResourceChange changes = 6;
  repeated ResourceChange infrastructure_diff = 7;
  string opened_by = 8;
  bool proposal = 9;
  string opened_at = 10;
  // promote | rollback | drift-remediate | up | down | preview | config |
  // topology | failover | depart | posture-remediate
  string intent = 11;
}

message DeltaDecisionRecord {
  string delta_id = 1;
  string set_id = 2;
  string gate_decision_id = 3;
  repeated ReasonRecord reasons = 4;
  string decided_at = 5;
}

// ── Promotion ───────────────────────────────────────────────────────────────

message ObligationRef {
  string id = 1;
  string kind = 2;
  bool satisfied = 3;
  string deadline = 4;
}

enum RolloutStrategy {
  ROLLOUT_STRATEGY_UNSPECIFIED = 0;
  ROLLOUT_STRATEGY_ALL_AT_ONCE = 1;
  ROLLOUT_STRATEGY_CANARY = 2;
  ROLLOUT_STRATEGY_BLUE_GREEN = 3;
  ROLLOUT_STRATEGY_EXPERIMENT = 4;
}

enum PromotionState {
  PROMOTION_STATE_UNSPECIFIED = 0;
  PROMOTION_STATE_QUEUED = 1;
  PROMOTION_STATE_RESOLVING = 2;
  PROMOTION_STATE_AWAITING_APPROVAL = 3;
  PROMOTION_STATE_AWAITING_WINDOW = 4;
  PROMOTION_STATE_APPLYING = 5;
  PROMOTION_STATE_ROLLING_OUT = 6;
  PROMOTION_STATE_VERIFYING = 7;
  PROMOTION_STATE_PROMOTED = 8;
  PROMOTION_STATE_ROLLED_BACK = 9;
  PROMOTION_STATE_REJECTED = 10;
  PROMOTION_STATE_FAILED = 11;
  PROMOTION_STATE_SUPERSEDED = 12;
}

message PromotionRecord {
  string schema_version = 1;
  string promotion_id = 2;
  string freight_id = 3;
  string source_camp_id = 4;
  repeated string target_camp_ids = 5;
  string pipeline = 6;
  string node = 7;
  PromotionState state = 8;
  string gate_decision_id = 9;
  repeated ObligationRef obligations = 10;
  string requested_by = 11;
  string requested_at = 12;
  repeated ReasonRecord reasons = 13;
  RolloutStrategy strategy = 14;
  bool proposal = 15;
  string idempotency_key = 16;
  string fanout_id = 17;
  FreightSubject subject = 18;
}

message PreviewEnvironmentRecord {
  string camp_id = 1;
  string source_camp_id = 2;
  string freight_id = 3;
  uint64 ttl_ms = 4;
  string expires_at = 5;
  string created_by = 6;
  SourceRef source = 7;
  string pipeline = 8;
  string node = 9;
}

// ── Verification ────────────────────────────────────────────────────────────

enum HealthSourceKind {
  HEALTH_SOURCE_KIND_UNSPECIFIED = 0;
  HEALTH_SOURCE_KIND_PROMETHEUS = 1;
  HEALTH_SOURCE_KIND_HOBO_METERING = 2;
  HEALTH_SOURCE_KIND_HTTP_JSON = 3;
  HEALTH_SOURCE_KIND_DATADOG = 4;
  HEALTH_SOURCE_KIND_NEW_RELIC = 5;
  HEALTH_SOURCE_KIND_CLOUDWATCH = 6;
  HEALTH_SOURCE_KIND_HOBO_POSTURE = 7;
}

enum Cohort {
  COHORT_UNSPECIFIED = 0;
  COHORT_CANARY = 1;
  COHORT_BASELINE = 2;
  COHORT_ALL = 3;
}

message HealthQueryRecord {
  string name = 1;
  HealthSourceKind source = 2;
  string endpoint_ref = 3;
  string query = 4;
  string unit = 5;
  string credential_ref = 6;
  // Label/tag/attribute/dimension that distinguishes canary from baseline.
  string cohort_label = 7;
}

enum Comparator {
  COMPARATOR_UNSPECIFIED = 0;
  COMPARATOR_LT = 1;
  COMPARATOR_LTE = 2;
  COMPARATOR_GT = 3;
  COMPARATOR_GTE = 4;
}

enum Aggregation {
  AGGREGATION_UNSPECIFIED = 0;
  AGGREGATION_MEAN = 1;
  AGGREGATION_P50 = 2;
  AGGREGATION_P95 = 3;
  AGGREGATION_P99 = 4;
  AGGREGATION_MAX = 5;
  AGGREGATION_SUM = 6;
}

message ThresholdCheckRecord {
  HealthQueryRecord query = 1;
  Aggregation aggregation = 2;
  Comparator comparator = 3;
  double value = 4;
}

enum Direction {
  DIRECTION_UNSPECIFIED = 0;
  DIRECTION_HIGHER_IS_WORSE = 1;
  DIRECTION_LOWER_IS_WORSE = 2;
}

enum Sensitivity {
  SENSITIVITY_UNSPECIFIED = 0;
  SENSITIVITY_LOW = 1;
  SENSITIVITY_MEDIUM = 2;
  SENSITIVITY_HIGH = 3;
}

message ComparisonCheckRecord {
  HealthQueryRecord query = 1;
  Direction direction = 2;
  Sensitivity sensitivity = 3;
  uint32 min_samples = 4;
}

message ProbeCheckRecord {
  string name = 1;
  string url_ref = 2;
  uint32 expect_status = 3;
  uint64 interval_ms = 4;
  double min_success_ratio = 5;
}

message SuiteCheckRecord {
  string suite = 1;
}

message VerificationSpecRecord {
  uint64 window_ms = 1;
  uint32 required_observations = 2;
  uint64 progress_deadline_ms = 3;
  bool fail_on_no_data = 4;
  double max_error_budget_burn = 5;
  repeated ThresholdCheckRecord thresholds = 6;
  repeated ComparisonCheckRecord comparisons = 7;
  repeated ProbeCheckRecord probes = 8;
  repeated SuiteCheckRecord suites = 9;
}

enum VerificationVerdict {
  VERIFICATION_VERDICT_UNSPECIFIED = 0;
  VERIFICATION_VERDICT_PASS = 1;
  VERIFICATION_VERDICT_FAIL = 2;
  VERIFICATION_VERDICT_INCONCLUSIVE = 3;
}

message CheckOutcomeRecord {
  string check = 1;
  VerificationVerdict verdict = 2;
  double statistic = 3;
  double p_value = 4;
  uint32 samples_canary = 5;
  uint32 samples_baseline = 6;
  ReasonRecord reason = 7;
}

message VerificationResultRecord {
  string verification_id = 1;
  string freight_id = 2;
  string camp_id = 3;
  VerificationVerdict verdict = 4;
  repeated CheckOutcomeRecord checks = 5;
  string started_at = 6;
  string finished_at = 7;
  repeated ReasonRecord reasons = 8;
}

message EvidenceObservationRecord {
  string camp_id = 1;
  string signal = 2;
  bool healthy = 3;
  double value = 4;
  string observed_at = 5;
  string source = 6;
  Cohort cohort = 7;
}

// ── Rollout ─────────────────────────────────────────────────────────────────

message RolloutLoweringRecord {
  string camp_id = 1;
  RolloutStrategy strategy = 2;
  string offering_id = 3;
  repeated string fallback_from = 4;
  ReasonRecord refusal = 5;
}

message RolloutPlanRecord {
  string rollout_id = 1;
  string promotion_id = 2;
  RolloutStrategy strategy = 3;
  repeated uint32 stage_percents = 4;
  repeated string target_camp_ids = 5;
  repeated RolloutLoweringRecord lowerings = 6;
  VerificationSpecRecord verification = 7;
  string experiment_id = 8;
}

// ── Reconciliation ──────────────────────────────────────────────────────────

enum ReconcilerMode {
  RECONCILER_MODE_UNSPECIFIED = 0;
  RECONCILER_MODE_CONDUCTOR = 1;
  RECONCILER_MODE_AGENT = 2;
  RECONCILER_MODE_PUBLISHER = 3;
}

message ReconcilerRecord {
  string reconciler_id = 1;
  ReconcilerMode mode = 2;
  repeated string camp_ids = 3;
  // RFC 7638 JWK thumbprint bound into the SVID cnf.jkt.
  string key_thumbprint = 4;
  string enrolled_by = 5;
  string enrolled_at = 6;
  string revoked_at = 7;
  EnrollmentState enrollment = 8;
  // Camp-set scope of the bootstrap token.
  string bootstrap_scope = 9;
  string key_approved_by = 10;
  string accepted_by = 11;
  // Rail auto-accept scope that replaced both grants, if any.
  string auto_accepted_by_scope = 12;
}

enum ReconcileStatus {
  RECONCILE_STATUS_UNSPECIFIED = 0;
  RECONCILE_STATUS_CONVERGING = 1;
  RECONCILE_STATUS_CONVERGED = 2;
  RECONCILE_STATUS_BLOCKED = 3;
  RECONCILE_STATUS_DRIFTED = 4;
  // OBSERVE_ONLY Camps: read and reported, never applied.
  RECONCILE_STATUS_OBSERVED = 5;
}

message ResourceObservation {
  string resource = 1;
  string physical_id = 2;
  string outputs_hash = 3;
  bool healthy = 4;
  string drift_kind = 5;
  string kind = 6;
  string classification = 7;
  // Only declared observe_fields; secret-free; <= 16 KiB per resource.
  map<string, string> attributes = 8;
  // Fields owned on the target side and excluded from drift (D22).
  repeated string retained = 9;
}

message ReconcileObservationRecord {
  string camp_id = 1;
  string set_id = 2;
  string reconciler_id = 3;
  // Decimal FenceToken.
  string fence_token = 4;
  ReconcileStatus status = 5;
  repeated ResourceObservation resources = 6;
  repeated ReasonRecord reasons = 7;
  string observed_at = 8;
  repeated CampClaimRecord claims = 9;
  // Declared handover outputs (D23), secret-free.
  map<string, string> handover = 10;
}

message DeliveryFeedFrame {
  // Decimal EventPosition.
  string position = 1;
  SetRecord set = 2;
  // Inline canonical resolved set when <= 256 KiB; otherwise empty.
  string resolved_set_json = 3;
  // Attribute paths the Camp's posture packs need (D25).
  repeated string observe_fields = 4;
  CampManagement management = 5;
  PolicyBindingRecord policy = 6;
}

// ── Pipeline graph ──────────────────────────────────────────────────────────

enum Availability {
  AVAILABILITY_UNSPECIFIED = 0;
  AVAILABILITY_ONE_OF = 1;
  AVAILABILITY_ALL = 2;
  AVAILABILITY_QUORUM = 3;
}

enum AutoPromotion {
  AUTO_PROMOTION_UNSPECIFIED = 0;
  AUTO_PROMOTION_DISABLED = 1;
  AUTO_PROMOTION_NEWEST = 2;
  AUTO_PROMOTION_MATCH_UPSTREAM = 3;
  // Late entrants converge to the node's current qualified Freight (D21).
  AUTO_PROMOTION_MATCH_NODE = 4;
}

enum HookKind {
  HOOK_KIND_UNSPECIFIED = 0;
  HOOK_KIND_RUNBOOK = 1;
  HOOK_KIND_NOTIFY = 2;
  HOOK_KIND_SUITE = 3;
}

enum HookPoint {
  HOOK_POINT_UNSPECIFIED = 0;
  HOOK_POINT_BEFORE_APPLY = 1;
  HOOK_POINT_AFTER_CONVERGED = 2;
  HOOK_POINT_AFTER_QUALIFIED = 3;
  HOOK_POINT_ON_FAILURE = 4;
}

message HookRecord {
  HookKind kind = 1;
  HookPoint point = 2;
  string ref = 3;
}

message PipelineNodeRecord {
  string name = 1;
  repeated string camp_ids = 2;
  repeated string from_sources = 3;
  repeated string from_nodes = 4;
  Availability availability = 5;
  uint64 required_soak_ms = 6;
  AutoPromotion auto_promotion = 7;
  RolloutStrategy strategy = 8;
  VerificationSpecRecord verification = 9;
  repeated string windows = 10;
  repeated HookRecord hooks = 11;
  bool approval_required = 12;
  uint64 preview_ttl_ms = 13;
  repeated uint32 stage_percents = 14;
  // Exactly one of camp_ids or placement (D21).
  string placement = 15;
  FanoutRecord fanout = 16;
  QuorumRecord quorum = 17;
  DepartureAction departure = 18;
  FailoverPolicyRecord failover = 19;
  // RAIL pipelines only (D24).
  PolicyMode policy_mode = 20;
}

message PipelineRecord {
  string schema_version = 1;
  string name = 2;
  string bindle = 3;
  repeated PipelineNodeRecord nodes = 4;
  string defined_by = 5;
  // For RAIL, `bindle` holds the Rail id.
  FreightSubject subject = 6;
}

message FreightAvailabilityRecord {
  string pipeline = 1;
  string node = 2;
  string freight_id = 3;
  // Upstream node names, source names, or "approval".
  repeated string via = 4;
  string available_at = 5;
}

// ── Change windows ──────────────────────────────────────────────────────────

enum WindowKind {
  WINDOW_KIND_UNSPECIFIED = 0;
  WINDOW_KIND_ALLOW = 1;
  WINDOW_KIND_FREEZE = 2;
}

message ChangeWindowRecord {
  string name = 1;
  WindowKind kind = 2;
  SelectorRecord selector = 3;
  // RFC 5545 RRULE subset; empty means a single occurrence [starts_at, ends_at).
  string rrule = 4;
  uint64 duration_ms = 5;
  // IANA time zone, e.g. America/Chicago.
  string timezone = 6;
  string starts_at = 7;
  string ends_at = 8;
  bool rollback_allowed = 9;
  string defined_by = 10;
}

message WindowOverrideRecord {
  string window = 1;
  repeated string camp_ids = 2;
  string reason = 3;
  string decision_id = 4;
  string granted_by = 5;
  string expires_at = 6;
}

// ── Inventory (D19) ─────────────────────────────────────────────────────────

enum CampManagement {
  CAMP_MANAGEMENT_UNSPECIFIED = 0;
  CAMP_MANAGEMENT_MANAGED = 1;
  CAMP_MANAGEMENT_OBSERVE_ONLY = 2;
}

enum CampConditionType {
  CAMP_CONDITION_TYPE_UNSPECIFIED = 0;
  CAMP_CONDITION_TYPE_READY = 1;
  CAMP_CONDITION_TYPE_REACHABLE = 2;
  CAMP_CONDITION_TYPE_LEASED = 3;
  CAMP_CONDITION_TYPE_CREDENTIAL_VALID = 4;
  CAMP_CONDITION_TYPE_CLAIMS_CONSISTENT = 5;
  CAMP_CONDITION_TYPE_POSTURE_COMPLIANT = 6;
}

enum ConditionStatus {
  CONDITION_STATUS_UNSPECIFIED = 0;
  CONDITION_STATUS_TRUE = 1;
  CONDITION_STATUS_FALSE = 2;
  CONDITION_STATUS_UNKNOWN = 3;
}

enum SignalSource {
  SIGNAL_SOURCE_UNSPECIFIED = 0;
  SIGNAL_SOURCE_STATION = 1;
  SIGNAL_SOURCE_RECONCILER = 2;
  SIGNAL_SOURCE_HEALTH_SOURCE = 3;
  SIGNAL_SOURCE_OPERATOR = 4;
}

message CampConditionRecord {
  CampConditionType type = 1;
  ConditionStatus status = 2;
  SignalSource source = 3;
  string reason = 4;
  string since = 5;
}

// Observed, never trusted to grant (I19).
message CampClaimRecord {
  string name = 1;
  string value = 2;
  string reported_by = 3;
  string observed_at = 4;
}

enum TaintEffect {
  TAINT_EFFECT_UNSPECIFIED = 0;
  TAINT_EFFECT_NO_PLACE = 1;
  TAINT_EFFECT_NO_RUN = 2;
}

message TaintRecord {
  string key = 1;
  string value = 2;
  TaintEffect effect = 3;
  SignalSource source = 4;
  string reason = 5;
  string added_by = 6;
  string added_at = 7;
}

message TolerationRecord {
  string key = 1;
  // Empty value tolerates any value of the key.
  string value = 2;
  TaintEffect effect = 3;
  // 0 tolerates indefinitely.
  uint64 toleration_ms = 4;
}

message CampStatusRecord {
  string camp_id = 1;
  CampManagement management = 2;
  repeated CampConditionRecord conditions = 3;
  repeated CampClaimRecord claims = 4;
  repeated TaintRecord taints = 5;
  string updated_at = 6;
}

message CampSetRecord {
  string name = 1;
  SelectorRecord selector = 2;
  repeated string camp_ids = 3;
  string defined_by = 4;
}

enum EnrollmentState {
  ENROLLMENT_STATE_UNSPECIFIED = 0;
  ENROLLMENT_STATE_PENDING = 1;
  ENROLLMENT_STATE_ACCEPTED = 2;
  ENROLLMENT_STATE_REVOKED = 3;
}

// ── Placement and fan-out (D20, D21) ────────────────────────────────────────

message SpreadConstraintRecord {
  // yard | provider | region | jurisdiction | label:<key>
  string topology_key = 1;
  uint32 min_groups = 2;
  uint32 max_groups = 3;
}

message ScoreWeightRecord {
  string score = 1;
  double weight = 2;
}

message ScoreSnapshotRecord {
  string score = 1;
  map<string, double> by_camp = 2;
  string valid_until = 3;
  string reported_by = 4;
  string reported_at = 5;
  string digest = 6;
}

message PlacementGroupRecord {
  string name = 1;
  SelectorRecord selector = 2;
  uint32 max_size = 3;
  uint32 max_size_percent = 4;
}

message PlacementRecord {
  string schema_version = 1;
  string name = 2;
  repeated string camp_sets = 3;
  SelectorRecord predicate = 4;
  repeated string required_claims = 5;
  // 0 selects every eligible Camp.
  uint32 count = 6;
  repeated SpreadConstraintRecord spread = 7;
  repeated ScoreWeightRecord scores = 8;
  repeated TolerationRecord tolerations = 9;
  repeated PlacementGroupRecord groups = 10;
  uint32 default_group_size = 11;
  uint32 default_group_size_percent = 12;
  string defined_by = 13;
}

message PlacementCandidateRecord {
  string camp_id = 1;
  bool selected = 2;
  repeated string exclusion_codes = 3;
  double score = 4;
}

message PlacementGroupDecisionRecord {
  string name = 1;
  uint32 index = 2;
  repeated string camp_ids = 3;
  bool mandatory = 4;
}

message PlacementDecisionRecord {
  string decision_id = 1;
  string placement = 2;
  string pipeline = 3;
  string node = 4;
  string inventory_digest = 5;
  repeated string score_snapshot_digests = 6;
  repeated PlacementGroupDecisionRecord groups = 7;
  repeated PlacementCandidateRecord candidates = 8;
  repeated ReasonRecord reasons = 9;
  string decided_at = 10;
}

enum FanoutStrategy {
  FANOUT_STRATEGY_UNSPECIFIED = 0;
  FANOUT_STRATEGY_ALL = 1;
  FANOUT_STRATEGY_PROGRESSIVE = 2;
  FANOUT_STRATEGY_PROGRESSIVE_PER_GROUP = 3;
}

message FanoutRecord {
  FanoutStrategy strategy = 1;
  uint32 max_concurrency = 2;
  uint32 max_concurrency_percent = 3;
  uint64 min_success_ms = 4;
  uint64 progress_deadline_ms = 5;
  uint32 max_failures = 6;
  uint32 max_failures_percent = 7;
  repeated string mandatory_groups = 8;
  bool rollback_on_halt = 9;
}

message QuorumRecord {
  uint32 min_qualified = 1;
  uint32 min_qualified_percent = 2;
}

enum DepartureAction {
  DEPARTURE_ACTION_UNSPECIFIED = 0;
  DEPARTURE_ACTION_DELETE = 1;
  DEPARTURE_ACTION_ORPHAN = 2;
  DEPARTURE_ACTION_ORPHAN_DATA = 3;
}

enum FanoutState {
  FANOUT_STATE_UNSPECIFIED = 0;
  FANOUT_STATE_RUNNING = 1;
  FANOUT_STATE_HALTED = 2;
  FANOUT_STATE_COMPLETED = 3;
  FANOUT_STATE_ROLLED_BACK = 4;
  FANOUT_STATE_SUPERSEDED = 5;
}

message FanoutStatusRecord {
  string fanout_id = 1;
  string pipeline = 2;
  string node = 3;
  string freight_id = 4;
  string decision_id = 5;
  FanoutState state = 6;
  uint32 group_index = 7;
  repeated string pending = 8;
  repeated string in_flight = 9;
  repeated string succeeded = 10;
  repeated string failed = 11;
  repeated string deferred = 12;
  repeated ReasonRecord reasons = 13;
  string updated_at = 14;
}

// ── Failover and rebalance (D23) ────────────────────────────────────────────

enum PurgeMode {
  PURGE_MODE_UNSPECIFIED = 0;
  PURGE_MODE_GRACEFUL = 1;
  PURGE_MODE_NEVER = 2;
  PURGE_MODE_IMMEDIATE = 3;
}

message FailoverPolicyRecord {
  PurgeMode purge = 1;
  uint64 grace_ms = 2;
  // Declared, secret-free outputs of the source passed to the replacement.
  repeated string handover_outputs = 3;
}

enum FailoverState {
  FAILOVER_STATE_UNSPECIFIED = 0;
  FAILOVER_STATE_PROPOSED = 1;
  FAILOVER_STATE_REPLACING = 2;
  FAILOVER_STATE_VERIFYING = 3;
  FAILOVER_STATE_SHIFTING = 4;
  FAILOVER_STATE_PURGING = 5;
  FAILOVER_STATE_COMPLETED = 6;
  FAILOVER_STATE_REFUSED = 7;
  FAILOVER_STATE_ABANDONED = 8;
}

message FailoverRecord {
  string failover_id = 1;
  string pipeline = 2;
  string node = 3;
  string from_camp_id = 4;
  string to_camp_id = 5;
  string freight_id = 6;
  FailoverState state = 7;
  PurgeMode purge = 8;
  string trigger_taint = 9;
  string decision_id = 10;
  string promotion_id = 11;
  map<string, string> handover = 12;
  repeated ReasonRecord reasons = 13;
  string updated_at = 14;
}

message RebalanceMoveRecord {
  string from_camp_id = 1;
  string to_camp_id = 2;
}

message RebalanceRecord {
  string rebalance_id = 1;
  string pipeline = 2;
  string node = 3;
  string decision_id = 4;
  repeated RebalanceMoveRecord moves = 5;
  string reason = 6;
  string requested_by = 7;
  string requested_at = 8;
}

// ── Policy delivery and posture (D24, D25) ─────────────────────────────────

enum FreightSubject {
  FREIGHT_SUBJECT_UNSPECIFIED = 0;
  FREIGHT_SUBJECT_BINDLE = 1;
  FREIGHT_SUBJECT_RAIL = 2;
}

enum PolicyMode {
  POLICY_MODE_UNSPECIFIED = 0;
  POLICY_MODE_INFORM = 1;
  POLICY_MODE_ENFORCE = 2;
}

message PolicyBindingRecord {
  string camp_id = 1;
  string enforced_rail_digest = 2;
  string candidate_rail_digest = 3;
  string freight_id = 4;
  string promotion_id = 5;
  string bound_at = 6;
}

message ShadowDecisionRecord {
  string camp_id = 1;
  string delta_id = 2;
  string enforced_rail_digest = 3;
  string candidate_rail_digest = 4;
  string enforced_effect = 5;
  string candidate_effect = 6;
  bool diverged = 7;
  string decided_at = 8;
}

enum RemediationMode {
  REMEDIATION_MODE_UNSPECIFIED = 0;
  REMEDIATION_MODE_INFORM = 1;
  REMEDIATION_MODE_INFORM_ONLY = 2;
  REMEDIATION_MODE_ENFORCE = 3;
}

enum ComplianceState {
  COMPLIANCE_STATE_UNSPECIFIED = 0;
  COMPLIANCE_STATE_COMPLIANT = 1;
  COMPLIANCE_STATE_NONCOMPLIANT = 2;
  COMPLIANCE_STATE_UNKNOWN = 3;
  COMPLIANCE_STATE_NOT_APPLICABLE = 4;
}

message PostureFindingRecord {
  string rule = 1;
  string resource = 2;
  ComplianceState state = 3;
  string severity = 4;
  repeated string controls = 5;
  // Secret-free summary of the observed value.
  string observed = 6;
  // Set when enforcement is impossible without fighting a Set (I22).
  bool ownership_conflict = 7;
}

message ComplianceRecord {
  string camp_id = 1;
  string rail_digest = 2;
  bool candidate = 3;
  ComplianceState state = 4;
  repeated PostureFindingRecord findings = 5;
  // Decimal EventPosition of the status observation evaluated.
  string observation_position = 6;
  string evaluated_at = 7;
}

message PostureRemediationRecord {
  string camp_id = 1;
  string rule = 2;
  string resource = 3;
  RemediationMode mode = 4;
  string delta_id = 5;
  repeated ReasonRecord reasons = 6;
}

message RailPostureBindingRecord {
  string pack = 1;
  RemediationMode remediation = 2;
  uint64 compliant_interval_ms = 3;
  uint64 noncompliant_interval_ms = 4;
}

message RailFailoverRecord {
  bool automatic = 1;
  uint32 max_concurrent = 2;
  bool allow_immediate_purge = 3;
  uint32 required_signals = 4;
}

message RailEnrollmentRecord {
  bool separate_approvers = 1;
  repeated string auto_accept_scopes = 2;
}

// The Rail's opaque `delivery` object (D20), parsed by @hobo/cd.
message RailDeliveryRecord {
  string rail_digest = 1;
  repeated string camp_sets = 2;
  repeated RailPostureBindingRecord posture = 3;
  RailFailoverRecord failover = 4;
  RailEnrollmentRecord enrollment = 5;
  uint32 max_fanout_camps = 6;
}
```

### A.6 `packages/cd/src/events.ts`

```ts
// public-contract: event names, stream ids and schema ids are wire contract
// frozen by docs/plans/0024-hobo-cd-swarm-instruction.md (final).

// public-contract: every event family @hobo/cd appends.
export const CD_EVENTS = Object.freeze({
	FreightRecorded: "freight.Recorded",
	FreightYanked: "freight.Yanked",
	FreightQualified: "freight.Qualified",
	FreightApproved: "freight.Approved",
	FreightRetired: "freight.Retired",
	SourceDefined: "source.Defined",
	SourceArtifactDiscovered: "source.ArtifactDiscovered",
	PublisherTrusted: "publisher.Trusted",
	ArtifactStored: "artifact.Stored",
	ArtifactDeleted: "artifact.Deleted",
	SetCreated: "set.Created",
	DeltaOpened: "delta.Opened",
	DeltaUpdated: "delta.Updated",
	DeltaApplied: "delta.Applied",
	DeltaRejected: "delta.Rejected",
	PipelineApplied: "pipeline.Applied",
	PipelineFreightAvailable: "pipeline.FreightAvailable",
	WindowDefined: "window.Defined",
	WindowOverridden: "window.Overridden",
	EnvPromoteRequested: "env.PromoteRequested",
	EnvPromoted: "env.Promoted",
	EnvPromoteRolledBack: "env.PromoteRolledBack",
	EnvPromoteRejected: "env.PromoteRejected",
	EnvPromoteSuperseded: "env.PromoteSuperseded",
	EnvCloned: "env.Cloned",
	EnvExpired: "env.Expired",
	VerificationStarted: "verification.Started",
	VerificationCompleted: "verification.Completed",
	RolloutLowered: "rollout.Lowered",
	RolloutEvidenceObserved: "rollout.EvidenceObserved",
	ReconcilerEnrolled: "reconciler.Enrolled",
	ReconcilerRevoked: "reconciler.Revoked",
	ReconcileStarted: "deployment.ReconcileStarted",
	StatusObserved: "deployment.StatusObserved",
	Converged: "deployment.Converged",
	ReconcileBlocked: "deployment.ReconcileBlocked",
	CampStatusChanged: "camp.StatusChanged",
	CampTainted: "camp.Tainted",
	CampUntainted: "camp.Untainted",
	CampManagementChanged: "camp.ManagementChanged",
	CampDeparted: "camp.Departed",
	CampSetDefined: "campset.Defined",
	PlacementDefined: "placement.Defined",
	PlacementScoresReported: "placement.ScoresReported",
	PlacementDecided: "placement.Decided",
	FanoutStarted: "fanout.Started",
	FanoutProgressed: "fanout.Progressed",
	FanoutHalted: "fanout.Halted",
	FanoutResumed: "fanout.Resumed",
	FanoutCompleted: "fanout.Completed",
	FanoutRolledBack: "fanout.RolledBack",
	FailoverProposed: "failover.Proposed",
	FailoverStarted: "failover.Started",
	FailoverProgressed: "failover.Progressed",
	FailoverCompleted: "failover.Completed",
	FailoverRefused: "failover.Refused",
	RebalanceRequested: "rebalance.Requested",
	ReconcilerEnrollmentRequested: "reconciler.EnrollmentRequested",
	ReconcilerKeyApproved: "reconciler.KeyApproved",
	ReconcilerAccepted: "reconciler.Accepted",
	PolicyBindingChanged: "policy.BindingChanged",
	PolicyShadowDecided: "policy.ShadowDecided",
	ComplianceObserved: "compliance.Observed",
	ComplianceChanged: "compliance.Changed",
	PostureRemediationProposed: "posture.RemediationProposed",
} as const);

export type CdEventType = (typeof CD_EVENTS)[keyof typeof CD_EVENTS];

// public-contract: stream ids. Desired state (spec) and observations (status)
// live in separate per-Camp streams so they never contend.
export const CD_STREAMS = Object.freeze({
	freight: (freightId: string) => `cd-freight-${freightId}`,
	source: (name: string) => `cd-source-${name}`,
	artifact: (digest: string) => `cd-artifact-${digest}`,
	campSpec: (campId: string) => `cd-camp-${campId}`,
	campStatus: (campId: string) => `cd-camp-status-${campId}`,
	promotion: (promotionId: string) => `cd-promotion-${promotionId}`,
	pipeline: (name: string) => `cd-pipeline-${name}`,
	window: (name: string) => `cd-window-${name}`,
	verification: (verificationId: string) => `cd-verification-${verificationId}`,
	reconciler: (reconcilerId: string) => `cd-reconciler-${reconcilerId}`,
	publisher: (name: string) => `cd-publisher-${name}`,
	campInventory: (campId: string) => `cd-camp-inventory-${campId}`,
	campSet: (name: string) => `cd-campset-${name}`,
	placement: (name: string) => `cd-placement-${name}`,
	fanout: (fanoutId: string) => `cd-fanout-${fanoutId}`,
	failover: (failoverId: string) => `cd-failover-${failoverId}`,
	compliance: (campId: string) => `cd-compliance-${campId}`,
});

// public-contract: durable subscription ids. Leases are keyed by Camp so two
// reconcilers can never both write one Camp.
export const CD_SUBSCRIPTIONS = Object.freeze({
	camp: (campId: string) => `cd:camp:${campId}`,
	source: (name: string) => `cd:source:${name}`,
	fanout: (fanoutId: string) => `cd:fanout:${fanoutId}`,
	failover: (failoverId: string) => `cd:failover:${failoverId}`,
	posture: (stationId: string) => `cd:posture:${stationId}`,
	inventory: (stationId: string) => `cd:inventory:${stationId}`,
});

// public-contract: schema ids.
export const FREIGHT_MANIFEST_SCHEMA = "hobo.freight-manifest/v1" as const;
// public-contract: schema ids.
export const FREIGHT_SCHEMA = "hobo.cd.freight/v1" as const;
// public-contract: schema ids.
export const SOURCE_SCHEMA = "hobo.cd.source/v1" as const;
// public-contract: schema ids.
export const SET_SCHEMA = "hobo.cd.set/v1" as const;
// public-contract: schema ids.
export const DELTA_SCHEMA = "hobo.cd.delta/v1" as const;
// public-contract: schema ids.
export const PROMOTION_SCHEMA = "hobo.cd.promotion/v1" as const;
// public-contract: schema ids.
export const PIPELINE_SCHEMA = "hobo.cd.pipeline/v1" as const;
// public-contract: schema ids.
export const PLACEMENT_SCHEMA = "hobo.cd.placement/v1" as const;
// public-contract: media type of a stored resolved-set blob.
export const RESOLVED_SET_MEDIA_TYPE = "application/vnd.hobo.resolved-set+json" as const;
// public-contract: inline limit for resolved sets on the delivery feed.
export const FEED_INLINE_LIMIT_BYTES = 262_144 as const;
// public-contract: refusal codes.
export const PROGRESSIVE_UNSUPPORTED = "progressive-unsupported" as const;
// public-contract: refusal codes.
export const LINEAGE_UNSATISFIED = "lineage-unsatisfied" as const;
// public-contract: refusal codes.
export const WINDOW_CLOSED = "window-closed" as const;
// public-contract: refusal codes.
export const UNVERIFIED_TRIGGER = "unverified-trigger" as const;
// public-contract: refusal codes.
export const PLACEMENT_UNSATISFIABLE = "placement-unsatisfiable" as const;
// public-contract: refusal codes.
export const FAILOVER_UNSAFE = "failover-unsafe" as const;
// public-contract: refusal codes.
export const OWNERSHIP_CONFLICT = "ownership-conflict" as const;
// public-contract: refusal codes.
export const ENROLLMENT_INCOMPLETE = "enrollment-incomplete" as const;
// public-contract: refusal codes.
export const FANOUT_BUDGET_EXCEEDED = "fanout-budget-exceeded" as const;
// public-contract: refusal codes.
export const SHADOW_REQUIRED = "shadow-required" as const;
// public-contract: per-resource bound on reported posture attributes.
export const OBSERVE_ATTRIBUTES_LIMIT_BYTES = 16_384 as const;

// public-contract: every default value (Part I §I.9). Durations are milliseconds.
export const CD_DEFAULTS = Object.freeze({
	leaseTtlMs: 30_000,
	leaseRenewMs: 10_000,
	unreachableAfterMs: 90_000,
	feedHeartbeatMs: 15_000,
	feedLongPollMs: 55_000,
	svidTtlMs: 900_000,
	svidRefreshBeforeExpiryMs: 300_000,
	credentialWarningMs: 120_000,
	dpopSkewMs: 60_000,
	bootstrapTokenTtlMs: 3_600_000,
	bootstrapTokenMaxTtlMs: 86_400_000,
	sourcePollIntervalMs: 300_000,
	sourcePollIntervalMinMs: 30_000,
	sourceBackoffBaseMs: 1_000,
	sourceBackoffMaxMs: 600_000,
	sourceDiscoveryLimit: 20,
	serviceTickMs: 1_000,
	verificationWindowMs: 600_000,
	verificationRequiredObservations: 3,
	verificationProgressDeadlineMs: 1_800_000,
	verificationSensitivity: "MEDIUM",
	verificationFailOnNoData: true,
	probeTimeoutMs: 5_000,
	approvalTtlMs: 86_400_000,
	hotfixApprovalMaxMs: 259_200_000,
	windowOverrideMaxMs: 14_400_000,
	retentionKeepPerCamp: 5,
	retentionKeepUnpromotedMs: 2_592_000_000,
	retentionBlobGraceMs: 604_800_000,
	listNodeAvailability: "ONE_OF",
	placedNodeAvailability: "QUORUM",
	fanoutStrategy: "PROGRESSIVE_PER_GROUP",
	fanoutGroupSizePercent: 10,
	fanoutMinSuccessMs: 300_000,
	fanoutProgressDeadlineMs: 1_800_000,
	fanoutMaxFailuresPercent: 5,
	fanoutRollbackOnHalt: true,
	fanoutQuorumPercent: 95,
	noRunTolerationMs: 300_000,
	scoreMaxValidityMs: 86_400_000,
	maxFanoutCamps: 1_000,
	taintRequiredSignals: 2,
	failoverAutomatic: false,
	failoverMaxConcurrent: 1,
	failoverPurge: "GRACEFUL",
	failoverGraceMs: 1_800_000,
	departureAction: "ORPHAN_DATA",
	enrollmentSeparateApprovers: true,
	postureCompliantIntervalMs: 3_600_000,
	postureNoncompliantIntervalMs: 300_000,
	postureRemediation: "inform",
	informWindowMs: 86_400_000,
	informMaxNoncompliantRatio: 0.02,
	informMaxShadowDivergence: 0,
	componentMemoryBytes: 134_217_728,
	componentCallTimeoutMs: 30_000,
	componentFuel: 1_000_000_000,
	componentMaxAllowlistHosts: 32,
	webhookMaxAttempts: 8,
	webhookBackoffBaseMs: 1_000,
	webhookBackoffMaxMs: 300_000,
	postgresMinMajorVersion: 16,
	postgresStatementTimeoutMs: 5_000,
	postgresPoolSize: 10,
} as const);

// public-contract: the one set of ramp defaults (replaces three vocabularies).
export const CD_RAMP_DEFAULTS = Object.freeze({
	canary: Object.freeze([5, 25, 50, 100] as const),
	blueGreen: Object.freeze([100] as const),
	experiment: Object.freeze([50] as const),
} as const);
```

### A.7 `packages/cd/src/ports.ts`

```ts
// Frozen by docs/plans/0024-hobo-cd-swarm-instruction.md (final). Types only.
import type { ResolvedDeploymentSet } from "@hobo/cloud";
import type { GatekeeperEffect, PolicyPack } from "@hobo/contracts";
import type {
	ApplyResult,
	DataClassification,
	DurableEventStore,
	EventPosition,
	FenceToken,
	HttpTransport,
	JsonObject,
	PrincipalRef,
	ResidencyConstraint,
	RoutingPlan,
	RoutingPlanId,
	RoutingStatus,
	TrafficRoutingOfferingId,
} from "@hobo/core";
import type {
	ArtifactKind,
	ArtifactRef,
	CampClaimRecord,
	CampConditionRecord,
	CampManagement,
	CampSetRecord,
	CampStatusRecord,
	ChangeWindowRecord,
	Cohort,
	ComplianceRecord,
	DeltaRecord,
	DepartureAction,
	DiscoveredArtifactRecord,
	EnrollmentState,
	FailoverRecord,
	FailoverState,
	FanoutRecord,
	FanoutStatusRecord,
	FreightApprovedRecord,
	FreightAvailabilityRecord,
	FreightManifestRecord,
	FreightOrigin,
	FreightQualifiedRecord,
	FreightRecord,
	FreightSourceRecord,
	HealthQueryRecord,
	HealthSourceKind,
	ObligationRef,
	PipelineRecord,
	PlacementDecisionRecord,
	PlacementRecord,
	PolicyBindingRecord,
	PolicyMode,
	PostureFindingRecord,
	PostureRemediationRecord,
	PreviewEnvironmentRecord,
	PromotionRecord,
	ProvenanceRef,
	RailDeliveryRecord,
	ReasonRecord,
	RebalanceRecord,
	ReconcileObservationRecord,
	ReconcilerMode,
	ReconcilerRecord,
	RetentionPolicyRecord,
	RolloutPlanRecord,
	RolloutStrategy,
	ScoreSnapshotRecord,
	SelectorRecord,
	SetOrigin,
	SetRecord,
	ShadowDecisionRecord,
	SignalSource,
	SubscriptionKind,
	SubscriptionRecord,
	TaintEffect,
	TaintRecord,
	TrustedPublisherRecord,
	VerificationResultRecord,
	VerificationSpecRecord,
	WindowOverrideRecord,
} from "./_generated/cd_pb.js";

// ── Brands ─────────────────────────────────────────────────────────────────
export type Digest = `sha256:${string}`;
export type FreightId = string & { readonly __brand: "cd.FreightId" };
export type SetId = string & { readonly __brand: "cd.SetId" };
export type DeltaId = string & { readonly __brand: "cd.DeltaId" };
export type PromotionId = string & { readonly __brand: "cd.PromotionId" };
export type CampId = string & { readonly __brand: "cd.CampId" };
export type ReconcilerId = string & { readonly __brand: "cd.ReconcilerId" };
export type RolloutId = string & { readonly __brand: "cd.RolloutId" };
export type VerificationId = string & { readonly __brand: "cd.VerificationId" };

// ── Results and context ────────────────────────────────────────────────────
export type Refusal = Readonly<{ ok: false; reasons: readonly ReasonRecord[] }>;
export type Outcome<T> = Readonly<{ ok: true; value: T }> | Refusal;

export interface CdContext {
	readonly tenant: string;
	readonly principal: PrincipalRef;
	/** Injected clock, epoch ms. Decision code never reads a wall clock. */
	readonly now: () => number;
	readonly signal?: AbortSignal;
}

export interface CdBase {
	readonly store: DurableEventStore;
	readonly tenant: string;
	readonly now: () => number;
}

export interface CredentialResolver {
	/** Resolve a credential locator for one scoped use. Never persisted or logged. */
	resolve(ref: string, scope: string): Promise<Readonly<Record<string, string>>>;
}

export type FeedRequest = Readonly<{
	method: string;
	path: string;
	headers: Readonly<Record<string, string>>;
	body: Uint8Array;
}>;

export type FeedResponse = Readonly<{
	status: number;
	headers: Readonly<Record<string, string>>;
	body: Uint8Array | AsyncIterable<Uint8Array>;
}>;

// ── Freight and ingestion ──────────────────────────────────────────────────
export interface FreightLedger {
	record(
		input: Readonly<{ manifest: FreightManifestRecord; origin: FreightOrigin; sourceName?: string }>,
		ctx: CdContext,
	): Promise<Outcome<FreightRecord>>;
	yank(id: FreightId, reason: string, ctx: CdContext): Promise<Outcome<FreightRecord>>;
	approve(
		input: Readonly<{ freightId: FreightId; campId: CampId; reason: string; expiresAtMs: number }>,
		ctx: CdContext,
	): Promise<Outcome<FreightApprovedRecord>>;
	/** Accepts only a PASS verification for that Freight and Camp. */
	qualify(
		input: Readonly<{ freightId: FreightId; campId: CampId; pipeline: string; node: string; result: VerificationResultRecord }>,
		ctx: CdContext,
	): Promise<Outcome<FreightQualifiedRecord>>;
	get(id: FreightId): Promise<FreightRecord | undefined>;
	getByAlias(alias: string): Promise<FreightRecord | undefined>;
	isUsable(id: FreightId): Promise<boolean>;
	qualifications(id: FreightId): Promise<readonly FreightQualifiedRecord[]>;
	approvals(id: FreightId): Promise<readonly FreightApprovedRecord[]>;
	list(
		query?: Readonly<{ bindle?: string; labels?: Readonly<Record<string, string>>; limit?: number }>,
	): Promise<readonly FreightRecord[]>;
	/** Retention sweep (D18). Returns the Freight retired. */
	retire(policy: RetentionPolicyRecord, ctx: CdContext): Promise<readonly FreightRecord[]>;
}

export type VerifiedPublisher = Readonly<{ principal: PrincipalRef; publisher: string; claims: JsonObject }>;

export interface TrustedPublisherVerifier {
	trust(publisher: TrustedPublisherRecord, ctx: CdContext): Promise<Outcome<TrustedPublisherRecord>>;
	verify(token: string, ctx: CdContext): Promise<Outcome<VerifiedPublisher>>;
}

export interface ProvenanceVerifier {
	verify(
		input: Readonly<{
			statement: Uint8Array;
			bundle?: Uint8Array;
			subjects: readonly ArtifactRef[];
			trustedBuilderIds: readonly string[];
			trustedSignerIdentities: readonly string[];
		}>,
		ctx: CdContext,
	): Promise<Outcome<readonly ProvenanceRef[]>>;
}

export interface FreightIngest {
	manifest(
		input: Readonly<{ manifest: FreightManifestRecord; publisherToken?: string }>,
		ctx: CdContext,
	): Promise<Outcome<FreightRecord>>;
	attestation(
		input: Readonly<{ bindle: string; statement: Uint8Array; bundle?: Uint8Array; publisherToken?: string }>,
		ctx: CdContext,
	): Promise<Outcome<FreightRecord>>;
	/** Inbound CDEvent. Creates Freight only with a verifiable attestation; otherwise schedules polls. */
	cdevent(
		input: Readonly<{ body: Uint8Array }>,
		ctx: CdContext,
	): Promise<Outcome<Readonly<{ freight?: FreightRecord; scheduledPolls: readonly string[] }>>>;
}

// ── Freight sources (pull discovery) ───────────────────────────────────────
export type CiEventReader = (
	after: string | undefined,
	signal: AbortSignal,
) => AsyncIterable<Readonly<{ cursor: string; type: string; data: JsonObject }>>;

export type CiArtifactReader = (runId: string, path: string) => Promise<Uint8Array | undefined>;

export type DiscoveryResult = Readonly<{ artifacts: readonly DiscoveredArtifactRecord[]; cursor: string }>;

export interface SubscriptionDriver {
	readonly kind: SubscriptionKind;
	discover(
		input: Readonly<{ source: string; subscription: SubscriptionRecord; cursor?: string; signal: AbortSignal }>,
		ctx: CdContext,
	): Promise<Outcome<DiscoveryResult>>;
}

export interface FreightSources {
	define(source: FreightSourceRecord, ctx: CdContext): Promise<Outcome<FreightSourceRecord>>;
	list(): Promise<readonly FreightSourceRecord[]>;
	poll(name: string, ctx: CdContext): Promise<Outcome<readonly FreightRecord[]>>;
	/** Webhook receiver. Authenticates, maps to sources, schedules polls. Never creates Freight. */
	nudge(request: FeedRequest, ctx: CdContext): Promise<FeedResponse>;
	schedule(names: readonly string[], ctx: CdContext): Promise<void>;
	tick(ctx: CdContext): Promise<void>;
}

// ── Artifacts ──────────────────────────────────────────────────────────────
export type ArtifactStoreConfig =
	| Readonly<{ backend: "filesystem"; root: string }>
	| Readonly<{
			backend: "s3-compatible";
			endpoint: string;
			bucket: string;
			region: string;
			credentialRef: string;
			credentials: CredentialResolver;
			http: HttpTransport;
	  }>
	| Readonly<{ backend: "memory" }>;

export interface ArtifactStore {
	readonly backend: ArtifactStoreConfig["backend"];
	put(
		bytes: Uint8Array,
		meta: Readonly<{ name: string; kind: ArtifactKind; mediaType: string }>,
		ctx: CdContext,
	): Promise<ArtifactRef>;
	get(digest: Digest): Promise<Uint8Array | undefined>;
	has(digest: Digest): Promise<boolean>;
	list(signal: AbortSignal): AsyncIterable<Digest>;
	delete(digest: Digest, reason: string, ctx: CdContext): Promise<void>;
}

export interface ArtifactVerifier {
	/** Digest at its coordinate for every artifact in the manifest. */
	verify(manifest: FreightManifestRecord, ctx: CdContext): Promise<Outcome<FreightManifestRecord>>;
}

// ── Desired state ──────────────────────────────────────────────────────────
export type DesiredStateChange = Readonly<{
	position: EventPosition;
	set: SetRecord;
	/** Posture attribute paths to report (D25); empty when none are bound. */
	observeFields: readonly string[];
	management: CampManagement;
	policy?: PolicyBindingRecord;
}>;

export interface DesiredStateReader {
	current(campId: CampId): Promise<SetRecord | undefined>;
	get(setId: SetId): Promise<SetRecord | undefined>;
	history(campId: CampId, limit?: number): Promise<readonly SetRecord[]>;
	/** Fetch and verify the resolved-set blob a Set references. */
	resolved(set: SetRecord): Promise<ResolvedDeploymentSet>;
	status(campId: CampId): Promise<ReconcileObservationRecord | undefined>;
	changes(
		input: Readonly<{ campIds: readonly CampId[]; after?: EventPosition; signal: AbortSignal }>,
	): AsyncIterable<DesiredStateChange>;
}

export interface DeltaLedger {
	open(delta: DeltaRecord, ctx: CdContext): Promise<Outcome<DeltaRecord>>;
	update(delta: DeltaRecord, ctx: CdContext): Promise<Outcome<DeltaRecord>>;
	apply(
		input: Readonly<{ deltaId: DeltaId; gateDecisionId: string; resolved: ResolvedDeploymentSet; origin: SetOrigin }>,
		ctx: CdContext,
	): Promise<Outcome<SetRecord>>;
	reject(deltaId: DeltaId, reasons: readonly ReasonRecord[], ctx: CdContext): Promise<void>;
	get(deltaId: DeltaId): Promise<DeltaRecord | undefined>;
}

// ── Pipelines and windows ──────────────────────────────────────────────────
export interface PipelineController {
	apply(pipeline: PipelineRecord, ctx: CdContext): Promise<Outcome<PipelineRecord>>;
	get(name: string): Promise<PipelineRecord | undefined>;
	list(): Promise<readonly PipelineRecord[]>;
	/** Freight available to a node, newest first, each with the reasons it is available. */
	available(input: Readonly<{ pipeline: string; node: string }>): Promise<readonly FreightAvailabilityRecord[]>;
	/** Evaluate availability and auto-promotion; request promotions. Safe to repeat. */
	tick(ctx: CdContext): Promise<void>;
}

export type DeltaIntent =
	| "promote"
	| "rollback"
	| "drift-remediate"
	| "up"
	| "down"
	| "preview"
	| "config"
	| "topology"
	| "failover"
	| "depart"
	| "posture-remediate";

export type WindowEvaluation = Readonly<{
	open: boolean;
	rollbackAllowed: boolean;
	activeFreezes: readonly string[];
	overrides: readonly string[];
	nextOpenAtMs?: number;
}>;

export interface ChangeWindows {
	define(window: ChangeWindowRecord, ctx: CdContext): Promise<Outcome<ChangeWindowRecord>>;
	list(): Promise<readonly ChangeWindowRecord[]>;
	override(input: WindowOverrideRecord, ctx: CdContext): Promise<Outcome<WindowOverrideRecord>>;
	evaluate(
		input: Readonly<{
			campId: CampId;
			labels: Readonly<Record<string, string>>;
			envType: string;
			windowNames: readonly string[];
			atMs: number;
			intent: DeltaIntent;
		}>,
	): Promise<WindowEvaluation>;
}

// ── Promotion ──────────────────────────────────────────────────────────────
export interface SetResolver {
	resolve(
		input: Readonly<{ freight: FreightRecord; campId: CampId; intent: DeltaIntent; base?: SetRecord; sourceCampId?: CampId }>,
		ctx: CdContext,
	): Promise<Outcome<Readonly<{ resolved: ResolvedDeploymentSet; delta: DeltaRecord }>>>;
}

export type GateVerdict = Readonly<{
	decisionId: string;
	effect: GatekeeperEffect;
	obligations: readonly ObligationRef[];
	reasons: readonly ReasonRecord[];
	window?: WindowEvaluation;
	/** Present while a candidate Rail is bound in INFORM (D24). Never decides. */
	shadow?: ShadowVerdict;
}>;

export interface DeployGate {
	evaluate(
		input: Readonly<{
			intent: DeltaIntent;
			delta: DeltaRecord;
			freight: FreightRecord;
			resolved: ResolvedDeploymentSet;
			windows: readonly string[];
			current?: SetRecord;
		}>,
		ctx: CdContext,
	): Promise<GateVerdict>;
}

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export interface ApprovalPort {
	request(
		input: Readonly<{ subject: string; summary: string; obligations: readonly string[]; expiresAtMs: number }>,
		ctx: CdContext,
	): Promise<Readonly<{ requestId: string }>>;
	status(requestId: string): Promise<ApprovalStatus>;
}

export type PromoteRequest = Readonly<{
	freightId: FreightId;
	targets: readonly CampId[];
	idempotencyKey: string;
	pipeline?: string;
	node?: string;
	sourceCampId?: CampId;
	strategy?: RolloutStrategy;
	proposal?: boolean;
	/** Set by FanoutController; the gate then checks the fan-out aggregate. */
	fanoutId?: FanoutId;
	intent?: DeltaIntent;
}>;

export interface PromotionService {
	promote(request: PromoteRequest, ctx: CdContext): Promise<Outcome<PromotionRecord>>;
	rollback(
		input: Readonly<{ campId: CampId; reason: string; idempotencyKey: string; toSetId?: SetId }>,
		ctx: CdContext,
	): Promise<Outcome<PromotionRecord>>;
	approve(promotionId: PromotionId, ctx: CdContext): Promise<Outcome<PromotionRecord>>;
	get(promotionId: PromotionId): Promise<PromotionRecord | undefined>;
	list(query?: Readonly<{ campId?: CampId; limit?: number }>): Promise<readonly PromotionRecord[]>;
	/** Advance in-flight sagas from journal state. Safe to repeat. */
	tick(ctx: CdContext): Promise<void>;
}

export interface PreviewEnvironments {
	createPreview(
		input: Readonly<{ freightId: FreightId; sourceCampId: CampId; ttlMs: number; idempotencyKey: string; pipeline?: string; node?: string }>,
		ctx: CdContext,
	): Promise<Outcome<PreviewEnvironmentRecord>>;
	expirePreviews(ctx: CdContext): Promise<readonly PreviewEnvironmentRecord[]>;
	listPreviews(): Promise<readonly PreviewEnvironmentRecord[]>;
}

export interface RunbookExecutor {
	run(input: Readonly<{ path: string; args: JsonObject }>, ctx: CdContext): Promise<Outcome<JsonObject>>;
}

export interface VerifyPort {
	run(
		input: Readonly<{ suite: string; campId: CampId; freightId: FreightId }>,
		ctx: CdContext,
	): Promise<Outcome<JsonObject>>;
}

export interface NotificationPort {
	notify(input: Readonly<{ channel: string; subject: string; body: JsonObject }>, ctx: CdContext): Promise<void>;
}

// ── Reconciliation ─────────────────────────────────────────────────────────
export type RealizeInput = Readonly<{
	campId: CampId;
	desired: SetRecord;
	resolved: ResolvedDeploymentSet;
	reconcilerId: ReconcilerId;
	fence: FenceToken;
	signal: AbortSignal;
	previous?: SetRecord;
}>;

export interface Realizer {
	/** Drive toward `desired`. Idempotent. Never reports convergence without observation. */
	converge(input: RealizeInput, ctx: CdContext): Promise<ReconcileObservationRecord>;
	observe(input: RealizeInput, ctx: CdContext): Promise<ReconcileObservationRecord>;
}

export type ReconcilerLease = Readonly<{
	reconcilerId: ReconcilerId;
	campId: CampId;
	holderId: string;
	fence: FenceToken;
	expiresAtMs: number;
}>;

export interface ReconcilerTransport {
	/** One lease per Camp (subscription CD_SUBSCRIPTIONS.camp). */
	claim(
		input: Readonly<{ reconcilerId: ReconcilerId; campId: CampId; holderId: string; ttlMs: number }>,
	): Promise<Outcome<ReconcilerLease>>;
	renew(lease: ReconcilerLease): Promise<Outcome<ReconcilerLease>>;
	release(lease: ReconcilerLease): Promise<void>;
	/** Desired-state changes for the lease's Camp after its committed checkpoint. */
	feed(input: Readonly<{ lease: ReconcilerLease; signal: AbortSignal }>): AsyncIterable<DesiredStateChange>;
	resolved(lease: ReconcilerLease, set: SetRecord): Promise<Outcome<ResolvedDeploymentSet>>;
	report(lease: ReconcilerLease, observation: ReconcileObservationRecord): Promise<Outcome<EventPosition>>;
	checkpoint(lease: ReconcilerLease, position: EventPosition): Promise<Outcome<EventPosition>>;
}

export type DriftRoute = "reconcile" | "propose" | "ignore" | "escalate";

export interface DriftPolicy {
	route(observation: ReconcileObservationRecord, ctx: CdContext): Promise<DriftRoute>;
}

export interface CampReconciler {
	readonly reconcilerId: ReconcilerId;
	readonly mode: ReconcilerMode;
	/** Claim each Camp, read the feed, converge, report, checkpoint, renew; until aborted. */
	run(signal: AbortSignal): Promise<void>;
	/** One bounded pass (tests, `hobo up`). */
	reconcileOnce(campId: CampId, ctx: CdContext): Promise<ReconcileObservationRecord>;
}

export interface PublisherPort {
	readonly target: string;
	publish(
		input: Readonly<{ set: SetRecord; resolved: ResolvedDeploymentSet; signal: AbortSignal }>,
		ctx: CdContext,
	): Promise<Outcome<Readonly<{ revision: string }>>>;
	observe(
		input: Readonly<{ set: SetRecord; revision: string; signal: AbortSignal }>,
		ctx: CdContext,
	): Promise<ReconcileObservationRecord>;
}

// ── Verification ───────────────────────────────────────────────────────────
export type HealthSamples = Readonly<{ values: readonly number[]; fromMs: number; toMs: number }>;

export interface HealthSource {
	readonly kind: HealthSourceKind;
	query(
		input: Readonly<{ query: HealthQueryRecord; campId: CampId; cohort: Cohort; fromMs: number; toMs: number; signal: AbortSignal }>,
		ctx: CdContext,
	): Promise<Outcome<HealthSamples>>;
}

export interface VerificationEngine {
	start(
		input: Readonly<{ spec: VerificationSpecRecord; freightId: FreightId; campId: CampId; cohortAware: boolean }>,
		ctx: CdContext,
	): Promise<VerificationId>;
	get(id: VerificationId): Promise<VerificationResultRecord | undefined>;
	/** Advance running verifications; completes them at window end or deadline. */
	tick(ctx: CdContext): Promise<readonly VerificationResultRecord[]>;
}

// ── Progressive rollout ────────────────────────────────────────────────────
export interface TrafficShifter {
	offerings(campId: CampId): Promise<readonly TrafficRoutingOfferingId[]>;
	shift(input: Readonly<{ campId: CampId; plan: RoutingPlan; signal: AbortSignal }>, ctx: CdContext): Promise<ApplyResult>;
	status(campId: CampId, planId: RoutingPlanId): Promise<RoutingStatus | null>;
}

export type RolloutStatus =
	| "running"
	| "awaiting-approval"
	| "awaiting-window"
	| "halted"
	| "promoted"
	| "rolled-back"
	| "failed";

export type RolloutSnapshot = Readonly<{
	rolloutId: RolloutId;
	status: RolloutStatus;
	stageIndex: number;
	percent: number;
	reasons: readonly ReasonRecord[];
}>;

export interface RolloutEngine {
	start(plan: RolloutPlanRecord, ctx: CdContext): Promise<RolloutSnapshot>;
	advance(rolloutId: RolloutId, result: VerificationResultRecord, ctx: CdContext): Promise<RolloutSnapshot>;
	hold(rolloutId: RolloutId, reason: ReasonRecord, ctx: CdContext): Promise<RolloutSnapshot>;
	rollback(rolloutId: RolloutId, reason: string, ctx: CdContext): Promise<RolloutSnapshot>;
	get(rolloutId: RolloutId): Promise<RolloutSnapshot | undefined>;
}

export interface RolloutOrchestrator {
	plan(
		input: Readonly<{ promotion: PromotionRecord; obligations: readonly ObligationRef[]; verification: VerificationSpecRecord; stagePercents: readonly number[]; windows: readonly string[] }>,
		ctx: CdContext,
	): Promise<Outcome<RolloutPlanRecord>>;
	run(plan: RolloutPlanRecord, ctx: CdContext): Promise<RolloutSnapshot>;
	rollback(input: Readonly<{ rolloutId: RolloutId; reason: string }>, ctx: CdContext): Promise<RolloutSnapshot>;
	get(rolloutId: RolloutId): Promise<RolloutSnapshot | undefined>;
	tick(ctx: CdContext): Promise<void>;
}

// ── Feed, agents, service ──────────────────────────────────────────────────
export interface DeliveryFeedHandler {
	readonly pathPrefix: "/v1/cd/";
	handle(request: FeedRequest, signal: AbortSignal): Promise<FeedResponse>;
}

export interface AgentEnrollment {
	/** Single-use bootstrap token scoped to one Camp set (D19). */
	issueToken(
		input: Readonly<{ campSet: string; campIds: readonly CampId[]; mode: ReconcilerMode; ttlMs: number }>,
		ctx: CdContext,
	): Promise<Outcome<Readonly<{ token: string; expiresAtMs: number }>>>;
	/** Register a public JWK. PENDING until both grants or a Rail auto-accept (I24). */
	enroll(
		input: Readonly<{ token: string; publicJwk: JsonObject; claims: readonly CampClaimRecord[] }>,
		ctx: CdContext,
	): Promise<Outcome<Readonly<{ reconciler: ReconcilerRecord; state: EnrollmentState }>>>;
	/** Grant 1: the key belongs to a legitimate agent. */
	approveKey(reconcilerId: ReconcilerId, ctx: CdContext): Promise<Outcome<ReconcilerRecord>>;
	/** Grant 2: the agent may serve these Camps. */
	accept(input: Readonly<{ reconcilerId: ReconcilerId; campIds: readonly CampId[] }>, ctx: CdContext): Promise<Outcome<ReconcilerRecord>>;
	/** After acceptance, exchange a DPoP proof of key possession for a key-bound JWT-SVID (cnf.jkt). */
	activate(
		input: Readonly<{ reconcilerId: ReconcilerId; dpopProof: string }>,
		ctx: CdContext,
	): Promise<Outcome<Readonly<{ reconciler: ReconcilerRecord; svid: string; expiresAtMs: number }>>>;
	refresh(
		input: Readonly<{ svid: string; dpopProof: string }>,
		ctx: CdContext,
	): Promise<Outcome<Readonly<{ svid: string; expiresAtMs: number }>>>;
	revoke(reconcilerId: ReconcilerId, reason: string, ctx: CdContext): Promise<Outcome<ReconcilerRecord>>;
	/** Verify a request's JWT-SVID and DPoP proof (RFC 9449) with jti replay protection. */
	verify(request: FeedRequest): Promise<Outcome<ReconcilerRecord>>;
}

export interface CdService {
	start(): Promise<void>;
	ready(): boolean;
	drain(signal: AbortSignal): Promise<void>;
}

// ── Authorization and telemetry ────────────────────────────────────────────
export type CdAction =
	| "freight.record"
	| "freight.yank"
	| "freight.approve"
	| "publisher.trust"
	| "source.define"
	| "pipeline.apply"
	| "window.define"
	| "window.override"
	| "promote"
	| "rollback"
	| "approve"
	| "preview.create"
	| "reconciler.enroll"
	| "reconciler.revoke"
	| "reconciler.approve-key"
	| "reconciler.accept"
	| "drift.remediate"
	| "campset.define"
	| "camp.taint"
	| "camp.untaint"
	| "camp.manage"
	| "placement.define"
	| "placement.scores"
	| "fanout.halt"
	| "fanout.resume"
	| "fanout.rollback"
	| "failover.propose"
	| "failover.approve"
	| "rebalance"
	| "posture.enforce"
	| "rail.promote";

export interface CdAuthorizer {
	authorize(
		action: CdAction,
		subject: JsonObject,
		ctx: CdContext,
	): Promise<Outcome<Readonly<{ decisionId: string; proposalOnly: boolean }>>>;
}

export type OtelAttributes = Readonly<Record<string, string | number | boolean>>;

export type OtelSpan = Readonly<{
	name: string;
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	kind: "internal" | "server" | "client" | "producer" | "consumer";
	startMs: number;
	endMs: number;
	status: "unset" | "ok" | "error";
	attributes: OtelAttributes;
}>;

export type OtelMetricPoint = Readonly<{
	name: string;
	kind: "counter" | "histogram" | "gauge";
	value: number;
	unit: string;
	atMs: number;
	attributes: OtelAttributes;
}>;

export interface TelemetrySink {
	spans(spans: readonly OtelSpan[]): Promise<void>;
	metrics(points: readonly OtelMetricPoint[]): Promise<void>;
}

export type DoraMetrics = Readonly<{
	windowMs: number;
	deploymentFrequencyPerDay: number;
	leadTimeMsP50: number;
	changeFailureRate: number;
	timeToRestoreMsP50: number;
}>;

export type HealthReport = Readonly<{
	ok: boolean;
	checks: readonly Readonly<{ name: string; ok: boolean; detail: string }>[];
}>;

export interface CdTelemetry {
	dora(input: Readonly<{ windowMs: number; campIds?: readonly CampId[] }>, ctx: CdContext): Promise<DoraMetrics>;
	reconcileLagMs(campId: CampId, ctx: CdContext): Promise<number | undefined>;
	health(): HealthReport;
}

// ── Inventory and Placement (D19, D20) ─────────────────────────────────────
export type FanoutId = string & { readonly __brand: "cd.FanoutId" };
export type FailoverId = string & { readonly __brand: "cd.FailoverId" };

/** Declared topology of one Camp (from @hobo/camps / @hobo/yards; composed by WP18). */
export type CampTopology = Readonly<{
	campId: CampId;
	yardId: string;
	stationId: string;
	provider: string;
	/** Declared Yard regions. Residency is evaluated only against these. */
	regions: readonly string[];
	envType: string;
	labels: Readonly<Record<string, string>>;
	management: CampManagement;
}>;

export interface TopologyReader {
	camps(): Promise<readonly CampTopology[]>;
	camp(campId: CampId): Promise<CampTopology | undefined>;
}

export interface RailDeliveryReader {
	/** The Station's active Rail `delivery` object, parsed. */
	forStation(stationId: string): Promise<RailDeliveryRecord | undefined>;
	/** The Rail governing a Camp: its enforced binding, else its Station's active Rail. */
	forCamp(campId: CampId): Promise<RailDeliveryRecord | undefined>;
}

export type CampView = Readonly<{ topology: CampTopology; status: CampStatusRecord }>;

export type InventorySnapshot = Readonly<{ digest: Digest; camps: readonly CampView[] }>;

export interface CampInventory {
	status(campId: CampId): Promise<CampStatusRecord | undefined>;
	list(query?: Readonly<{ campSets?: readonly string[]; selector?: SelectorRecord }>): Promise<readonly CampView[]>;
	/** Merge conditions and claims from one source. Agent sources can never add NO_RUN. */
	observe(
		input: Readonly<{
			campId: CampId;
			source: SignalSource;
			conditions: readonly CampConditionRecord[];
			claims: readonly CampClaimRecord[];
		}>,
		ctx: CdContext,
	): Promise<Outcome<CampStatusRecord>>;
	taint(input: Readonly<{ campId: CampId; taint: TaintRecord }>, ctx: CdContext): Promise<Outcome<CampStatusRecord>>;
	untaint(
		input: Readonly<{ campId: CampId; key: string; effect: TaintEffect }>,
		ctx: CdContext,
	): Promise<Outcome<CampStatusRecord>>;
	manage(input: Readonly<{ campId: CampId; management: CampManagement }>, ctx: CdContext): Promise<Outcome<CampStatusRecord>>;
	defineSet(set: CampSetRecord, ctx: CdContext): Promise<Outcome<CampSetRecord>>;
	sets(): Promise<readonly CampSetRecord[]>;
	/** Canonical view whose digest a placement decision records. */
	snapshot(campSets: readonly string[]): Promise<InventorySnapshot>;
	/** Derive lease/credential/claims conditions and automatic NO_PLACE taints. Safe to repeat. */
	tick(ctx: CdContext): Promise<void>;
}

export type PlacementSubject = Readonly<{
	classifications: readonly DataClassification[];
	residency: readonly ResidencyConstraint[];
}>;

export interface PlacementEngine {
	define(placement: PlacementRecord, ctx: CdContext): Promise<Outcome<PlacementRecord>>;
	get(name: string): Promise<PlacementRecord | undefined>;
	reportScores(snapshot: ScoreSnapshotRecord, ctx: CdContext): Promise<Outcome<ScoreSnapshotRecord>>;
	/** Pure over recorded inputs (I18); records `placement.Decided`. */
	decide(
		input: Readonly<{
			placement: string;
			pipeline: string;
			node: string;
			stationId: string;
			subject: PlacementSubject;
			exclude?: readonly CampId[];
			count?: number;
		}>,
		ctx: CdContext,
	): Promise<Outcome<PlacementDecisionRecord>>;
	decision(decisionId: string): Promise<PlacementDecisionRecord | undefined>;
}

// ── Fan-out and failover (D21, D23) ────────────────────────────────────────
export interface FanoutController {
	start(
		input: Readonly<{
			pipeline: string;
			node: string;
			freightId: FreightId;
			decision: PlacementDecisionRecord;
			fanout: FanoutRecord;
			departure: DepartureAction;
			idempotencyKey: string;
		}>,
		ctx: CdContext,
	): Promise<Outcome<FanoutStatusRecord>>;
	get(fanoutId: FanoutId): Promise<FanoutStatusRecord | undefined>;
	list(query?: Readonly<{ pipeline?: string; node?: string; limit?: number }>): Promise<readonly FanoutStatusRecord[]>;
	/** Camps of the node's latest completed decision with their qualified Freight. */
	qualified(input: Readonly<{ pipeline: string; node: string }>): Promise<
		Readonly<{ decision?: PlacementDecisionRecord; qualifiedCampIds: readonly CampId[]; stableFreightId?: FreightId }>
	>;
	halt(fanoutId: FanoutId, reason: string, ctx: CdContext): Promise<Outcome<FanoutStatusRecord>>;
	resume(fanoutId: FanoutId, ctx: CdContext): Promise<Outcome<FanoutStatusRecord>>;
	rollback(fanoutId: FanoutId, reason: string, ctx: CdContext): Promise<Outcome<FanoutStatusRecord>>;
	/** Advance in-flight fan-outs from journal state under lease `cd:fanout:<id>`. Safe to repeat. */
	tick(ctx: CdContext): Promise<void>;
}

export interface FailoverController {
	propose(input: Readonly<{ campId: CampId; reason: string; idempotencyKey: string }>, ctx: CdContext): Promise<Outcome<readonly FailoverRecord[]>>;
	approve(failoverId: FailoverId, ctx: CdContext): Promise<Outcome<FailoverRecord>>;
	get(failoverId: FailoverId): Promise<FailoverRecord | undefined>;
	list(query?: Readonly<{ campId?: CampId; state?: FailoverState; limit?: number }>): Promise<readonly FailoverRecord[]>;
	rebalance(
		input: Readonly<{ pipeline: string; node: string; reason: string; idempotencyKey: string }>,
		ctx: CdContext,
	): Promise<Outcome<RebalanceRecord>>;
	tick(ctx: CdContext): Promise<void>;
}

// ── Policy delivery and posture (D24, D25) ─────────────────────────────────
export type RailEventReader = (
	after: string | undefined,
	signal: AbortSignal,
) => AsyncIterable<Readonly<{ cursor: string; railId: string; railDigest: Digest; status: "approved" | "active" | "retired"; stationId: string }>>;

export interface CampPolicy {
	binding(campId: CampId): Promise<PolicyBindingRecord | undefined>;
	/** Called by promotion only (subject RAIL). */
	bind(
		input: Readonly<{ campId: CampId; freight: FreightRecord; mode: PolicyMode; promotionId: PromotionId }>,
		ctx: CdContext,
	): Promise<Outcome<PolicyBindingRecord>>;
	/** Rollback: restore the previous enforced digest and clear the candidate. */
	restore(input: Readonly<{ campId: CampId; promotionId: PromotionId }>, ctx: CdContext): Promise<Outcome<PolicyBindingRecord>>;
}

export type ShadowVerdict = Readonly<{
	candidateRailDigest: Digest;
	decisionId: string;
	effect: GatekeeperEffect;
	diverged: boolean;
}>;

export interface PostureSeriesReader {
	noncompliantRatio(input: Readonly<{ campId: CampId; railDigest?: Digest; fromMs: number; toMs: number }>): Promise<readonly number[]>;
	shadowDivergence(input: Readonly<{ campId: CampId; railDigest: Digest; fromMs: number; toMs: number }>): Promise<readonly number[]>;
}

export interface PostureService {
	compliance(campId: CampId): Promise<readonly ComplianceRecord[]>;
	/** Attribute paths the Camp's bound packs need; reconcilers report only these. */
	observeFields(campId: CampId): Promise<readonly string[]>;
	/** Open ownership conflicts the gate must honour (I22). */
	conflicts(campId: CampId): Promise<readonly PostureFindingRecord[]>;
	remediations(campId: CampId): Promise<readonly PostureRemediationRecord[]>;
	/** Evaluate due Camps, append compliance, propose remediation. Safe to repeat. */
	tick(ctx: CdContext): Promise<void>;
}

export interface ShadowRecorder {
	/** The Camp's candidate Rail and its resolved pack, while bound in INFORM. */
	candidate(campId: CampId): Promise<Readonly<{ railDigest: Digest; policyPack: PolicyPack }> | undefined>;
	record(decision: ShadowDecisionRecord, ctx: CdContext): Promise<void>;
}

// ── Facade ─────────────────────────────────────────────────────────────────
export interface ContinuousDelivery {
	readonly freight: FreightLedger;
	readonly ingest: FreightIngest;
	readonly publishers: TrustedPublisherVerifier;
	readonly sources: FreightSources;
	readonly artifacts: ArtifactStore;
	readonly desired: DesiredStateReader;
	readonly deltas: DeltaLedger;
	readonly pipelines: PipelineController;
	readonly windows: ChangeWindows;
	readonly promotions: PromotionService & PreviewEnvironments;
	readonly rollouts: RolloutOrchestrator;
	readonly verification: VerificationEngine;
	readonly enrollment: AgentEnrollment;
	readonly feed: DeliveryFeedHandler;
	readonly telemetry: CdTelemetry;
	readonly authorizer: CdAuthorizer;
	readonly inventory: CampInventory;
	readonly placement: PlacementEngine;
	readonly fanout: FanoutController;
	readonly failover: FailoverController;
	readonly campPolicy: CampPolicy;
	readonly posture: PostureService;
	createReconciler(
		input: Readonly<{
			mode: ReconcilerMode;
			reconcilerId: ReconcilerId;
			campIds: readonly CampId[];
			holderId: string;
			transport?: ReconcilerTransport;
		}>,
	): CampReconciler;
}

// ── Module factory signatures (implemented in the named subpath) ───────────
export interface CdFactories {
	/** "./freight" (WP1) */
	createFreightLedger(d: CdBase & { readonly artifacts: ArtifactVerifier; readonly telemetry: TelemetrySink }): FreightLedger;
	/** "./ingest" (WP1) */
	createTrustedPublisherVerifier(d: CdBase & { readonly http: HttpTransport }): TrustedPublisherVerifier;
	/** "./ingest" (WP1) */
	createFreightIngest(
		d: CdBase & {
			readonly ledger: FreightLedger;
			readonly publishers: TrustedPublisherVerifier;
			readonly provenance: ProvenanceVerifier;
			readonly sources: FreightSources;
			readonly authorizer: CdAuthorizer;
		},
	): FreightIngest;
	/** "./sources" (WP2) */
	createFreightSources(
		d: CdBase & {
			readonly ledger: FreightLedger;
			readonly drivers: readonly SubscriptionDriver[];
			readonly provenance: ProvenanceVerifier;
			readonly authorizer: CdAuthorizer;
			readonly webhookSecrets: CredentialResolver;
		},
	): FreightSources;
	/** "./sources" (WP2) */
	createSubscriptionDrivers(
		d: Readonly<{
			http: HttpTransport;
			credentials: CredentialResolver;
			readCiEvents?: CiEventReader;
			readCiArtifact?: CiArtifactReader;
			readRailEvents?: RailEventReader;
		}>,
	): readonly SubscriptionDriver[];
	/** "./artifacts" (WP3) */
	createArtifactStore(config: ArtifactStoreConfig, d: CdBase): ArtifactStore;
	/** "./artifacts" (WP3) */
	createArtifactVerifier(d: CdBase & { readonly artifacts: ArtifactStore; readonly http: HttpTransport }): ArtifactVerifier;
	/** "./provenance" (WP3) */
	createProvenanceVerifier(d: CdBase & { readonly http: HttpTransport; readonly trustPolicy: JsonObject }): ProvenanceVerifier;
	/** "./sets" (WP4) */
	createDesiredState(d: CdBase & { readonly artifacts: ArtifactStore }): DesiredStateReader & DeltaLedger;
	/** "./pipelines" (WP5) */
	createPipelineController(
		d: CdBase & {
			readonly freight: FreightLedger;
			readonly promotions: PromotionService;
			readonly placement: PlacementEngine;
			readonly fanout: FanoutController;
			readonly topology: TopologyReader;
			readonly authorizer: CdAuthorizer;
		},
	): PipelineController;
	/** "./windows" (WP5) */
	createChangeWindows(d: CdBase & { readonly authorizer: CdAuthorizer }): ChangeWindows;
	/** "./promotion" (WP6) */
	createPromotionService(
		d: CdBase & {
			readonly freight: FreightLedger;
			readonly pipelines: PipelineController;
			readonly desired: DesiredStateReader & DeltaLedger;
			readonly resolver: SetResolver;
			readonly gate: DeployGate;
			readonly approvals: ApprovalPort;
			readonly rollouts: RolloutOrchestrator;
			readonly verification: VerificationEngine;
			readonly runbooks: RunbookExecutor;
			readonly suites: VerifyPort;
			readonly notify: NotificationPort;
			readonly campPolicy: CampPolicy;
			readonly authorizer: CdAuthorizer;
			readonly telemetry: TelemetrySink;
		},
	): PromotionService & PreviewEnvironments;
	/** "./reconcile" (WP7) */
	createCampReconciler(
		d: CdBase & {
			readonly reconcilerId: ReconcilerId;
			readonly mode: ReconcilerMode;
			readonly campIds: readonly CampId[];
			readonly holderId: string;
			readonly transport: ReconcilerTransport;
			readonly realizer: Realizer;
			readonly drift: DriftPolicy;
			readonly telemetry: TelemetrySink;
		},
	): CampReconciler;
	/** "./reconcile" (WP7) */
	createInProcessTransport(
		d: CdBase & { readonly desired: DesiredStateReader; readonly posture?: PostureService; readonly topology?: TopologyReader },
	): ReconcilerTransport;
	/** "./verification" (WP9) */
	createVerificationEngine(
		d: CdBase & { readonly sources: readonly HealthSource[]; readonly suites: VerifyPort; readonly http: HttpTransport },
	): VerificationEngine;
	/** "./verification" (WP9) */
	createHealthSources(
		d: Readonly<{ http: HttpTransport; credentials: CredentialResolver; posture?: PostureSeriesReader }>,
	): readonly HealthSource[];
	/** "./rollout" (WP10) */
	createRolloutOrchestrator(
		d: CdBase & {
			readonly engine: RolloutEngine;
			readonly traffic: TrafficShifter;
			readonly verification: VerificationEngine;
			readonly windows: ChangeWindows;
			readonly desired: DesiredStateReader & DeltaLedger;
			readonly approvals: ApprovalPort;
			readonly telemetry: TelemetrySink;
		},
	): RolloutOrchestrator;
	/** "./agent" (WP11) */
	createAgentEnrollment(
		d: CdBase & { readonly authorizer: CdAuthorizer; readonly rails: RailDeliveryReader; readonly inventory: CampInventory },
	): AgentEnrollment;
	/** "./agent" (WP11) */
	createHttpTransport(
		d: Readonly<{ baseUrl: string; http: HttpTransport; reconcilerId: ReconcilerId; privateJwk: JsonObject; svid: string; now: () => number }>,
	): ReconcilerTransport;
	/** "./feed" (WP11) */
	createDeliveryFeedHandler(
		d: CdBase & {
			readonly desired: DesiredStateReader;
			readonly enrollment: AgentEnrollment;
			readonly artifacts: ArtifactStore;
			readonly posture: PostureService;
			readonly inventory: CampInventory;
			readonly topology: TopologyReader;
		},
	): DeliveryFeedHandler;
	/** "./service" (WP12) */
	createCdService(
		d: CdBase & {
			readonly cd: ContinuousDelivery;
			readonly reconcilers: readonly CampReconciler[];
			readonly retention: readonly RetentionPolicyRecord[];
			readonly tickIntervalMs: number;
			readonly principal: PrincipalRef;
		},
	): CdService;
	/** "./authz" (WP19) */
	createCdAuthorizer(d: CdBase & { readonly policyPack: PolicyPack }): CdAuthorizer;
	/** "./telemetry" (WP19) */
	createCdTelemetry(d: CdBase): CdTelemetry;
	/** "./telemetry" (WP19) */
	createTelemetrySink(d: Readonly<{ endpoint?: string; http: HttpTransport; headers?: Readonly<Record<string, string>> }>): TelemetrySink;
	/** "./inventory" (WP22) */
	createCampInventory(
		d: CdBase & {
			readonly topology: TopologyReader;
			readonly rails: RailDeliveryReader;
			readonly desired: DesiredStateReader;
			readonly authorizer: CdAuthorizer;
			readonly telemetry: TelemetrySink;
		},
	): CampInventory;
	/** "./placement" (WP22) */
	createPlacementEngine(
		d: CdBase & {
			readonly inventory: CampInventory;
			readonly rails: RailDeliveryReader;
			readonly authorizer: CdAuthorizer;
		},
	): PlacementEngine;
	/** "./fanout" (WP23) */
	createFanoutController(
		d: CdBase & {
			readonly freight: FreightLedger;
			readonly promotions: PromotionService;
			readonly inventory: CampInventory;
			readonly desired: DesiredStateReader & DeltaLedger;
			readonly windows: ChangeWindows;
			readonly authorizer: CdAuthorizer;
			readonly telemetry: TelemetrySink;
		},
	): FanoutController;
	/** "./failover" (WP23) */
	createFailoverController(
		d: CdBase & {
			readonly pipelines: PipelineController;
			readonly inventory: CampInventory;
			readonly placement: PlacementEngine;
			readonly fanout: FanoutController;
			readonly promotions: PromotionService;
			readonly desired: DesiredStateReader & DeltaLedger;
			readonly topology: TopologyReader;
			readonly rails: RailDeliveryReader;
			readonly traffic: TrafficShifter;
			readonly authorizer: CdAuthorizer;
			readonly telemetry: TelemetrySink;
		},
	): FailoverController;
	/** "./posture" (WP24) */
	createCampPolicy(d: CdBase & { readonly authorizer: CdAuthorizer }): CampPolicy;
	/** "./posture" (WP24) */
	createShadowRecorder(
		d: CdBase & { readonly campPolicy: CampPolicy; readonly resolvePack: (railDigest: Digest) => Promise<PolicyPack> },
	): ShadowRecorder;
	/** "./posture" (WP24) */
	createPostureService(
		d: CdBase & {
			readonly desired: DesiredStateReader & DeltaLedger;
			readonly campPolicy: CampPolicy;
			readonly rails: RailDeliveryReader;
			readonly inventory: CampInventory;
			/** Policy packs by name, as policy-IR documents. */
			readonly packs: (names: readonly string[]) => Promise<readonly JsonObject[]>;
			readonly authorizer: CdAuthorizer;
			readonly telemetry: TelemetrySink;
		},
	): PostureService & PostureSeriesReader;
}
```

### A.8 `packages/cd/src/index.ts`

```ts
export * from "./_generated/cd_pb.js";
export * from "./events.js";
export type * from "./ports.js";
```

### A.9 `packages/cd/LICENSE`

Byte-identical copy of `packages/ci/LICENSE`.

### A.10 Generated

`packages/cd/src/_generated/cd_pb.ts` is the output of `pnpm run codegen` over
A.5. It is deterministic; never hand-edit it.

**Module index rule.** Each subpath in A.1 resolves to
`packages/cd/src/<module>/index.ts`. The owning WP creates it and exports the
`CdFactories` names listed for that subpath, plus any adapters it lists in its
report.

**End of instruction.**

---

## Sources (research read 2026-11-11)

- **Kargo:**
  [verification](https://docs.kargo.io/user-guide/how-to-guides/verification),
  [stages](https://main.docs.kargo.io/user-guide/how-to-guides/working-with-stages),
  [warehouses](https://docs.kargo.io/user-guide/how-to-guides/working-with-warehouses),
  [v1.8 notes](https://docs.kargo.io/release-notes/v1.8.0)
- **Harness:**
  [delegate](https://developer.harness.io/docs/platform/Delegates/delegates-overview),
  [CV](https://developer.harness.io/docs/continuous-delivery/verify/cv-concepts/machine-learning),
  [freeze](https://developer.harness.io/continuous-delivery/use-continuous-delivery/manage-deployments/deployment-freeze),
  [custom deployments](https://docs.harness.io/article/6k9t49p6mn-custom-deployment-tutorial),
  [policy](https://developer.harness.io/docs/platform/Governance/Policy-as-code/sample-policy-use-case)
- **Karmada:**
  [failover analysis](https://karmada.website.cncfstack.com/docs/userguide/failover/failover-analysis),
  [taint management](https://karmada.website.cncfstack.com/docs/userguide/failover/cluster-taint-management),
  [application failover](https://karmada.cncfstack.com/docs/v1.9/userguide/failover/application-failover),
  [override policy](https://karmada.website.cncfstack.com/docs/v1.14/reference/karmada-api/policy-resources/cluster-override-policy-v1alpha1),
  [resource interpreter](https://karmada.website.cncfstack.com/docs/reference/karmada-api/config-resources/resource-interpreter-customization-v1alpha1),
  [federated quota](https://karmada.cncfstack.com/docs/reference/karmada-api/policy-resources/federated-resource-quota-v1alpha1),
  [rebalancer](https://karmada.website.cncfstack.com/docs/userguide/scheduling/workload-rebalancer),
  [registration](https://karmada.website.cncfstack.com/docs/userguide/clustermanager/cluster-registration),
  [graduation](https://infoq.com/news/2026/09/karmada-kubernetes-cncf)
- **OCM:**
  [placement](https://main--open-cluster-management.netlify.app/docs/concepts/content-placement/_print),
  [decision groups](https://issues.redhat.com/browse/ACM-6806),
  [ManifestWorkReplicaSet](https://main--open-cluster-management.netlify.app/docs/concepts/work-distribution/manifestworkreplicaset),
  [ManifestWork](https://deploy-preview-531--open-cluster-management.netlify.app/docs/concepts/work-distribution/_print),
  [MWRS rollback proposal](https://worker-github.zxx930427.workers.dev/open-cluster-management-io/enhancements/pull/164),
  [architecture](https://main--open-cluster-management.netlify.app/docs/concepts/architecture),
  [policy API](https://main--open-cluster-management.netlify.app/docs/getting-started/integration/policy-controllers/policy),
  [governance](https://docs.redhat.com/en/documentation/red_hat_advanced_cluster_management_for_kubernetes/2.17/html/governance/governance),
  [Maestro](https://issues.redhat.com/browse/ACM-22339),
  [CNCF status](https://castrojo.github.io/jorgepilot/reports/cncf/cncf-project-moving-levels-status)
- **Standards:**
  [npm trusted publishers](https://docs.npmjs.com/trusted-publishers),
  [CDEvents](https://gh.r-mj.com/cdevents/spec/blob/main/spec.md),
  [OTel CI/CD semconv](https://opentelemetry.io/docs/specs/semconv/cicd/cicd-metrics/),
  [ClusterProfile KEP-4322](https://www.kubernetes.dev/resources/keps/4322/)
