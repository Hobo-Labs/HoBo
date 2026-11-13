# `@hobo/cd/posture` — policy delivery and posture

Work package WP24 of [plan 0024](../../../../docs/plans/0024-hobo-cd-swarm-instruction.md)
(C21, C22, D24, D25, I22, I23). Policy is delivered like software: a Rail
version is Freight (subject `RAIL`), shadowed in `INFORM` and then enforced
through the same pipelines, windows, fan-out and rollback as workloads.
Posture is evaluated continuously from reconcile observations, reported as
compliance and OSCAL assessment results, and enforced only through repair
Deltas that a Camp's reconciler applies.

| File | Holds |
|---|---|
| `camp-policy.ts` | `createCampPolicy` (frozen `CampPolicy`), `governingRailDigest` |
| `shadow.ts` | `createShadowRecorder` (frozen `ShadowRecorder`) |
| `service.ts` | `createPostureService` (frozen `PostureService & PostureSeriesReader`) |
| `evaluate-camp.ts` | `evaluateCamp`: one Camp × one Rail, pure over recorded inputs; `noncompliantRatio` |
| `ownership.ts` | `classifyOwnership`, `setValue`, `keptConflicts`, `applyPostureFixes` (I22) |
| `oscal.ts` | `complianceOscal`: compliance records → OSCAL 1.1.2 assessment results |
| `event-contracts.ts` | Golden upcaster corpus for the five event bodies this module appends |
| `journal.ts`, `reasons.ts` | CAS appends with idempotency keys; typed reason codes and metric names |

The rule format, the pure evaluator and the OSCAL emitter live in
[`@hobo/policy/posture`](../../../policy/src/posture/README.md), which is
dependency-free. This module supplies observations, records compliance and
proposes repair Deltas; it never evaluates inside an agent and never mutates
a target.

## Event architecture

Commands, the events they append, and the streams (the event store is the
durable `DurableEventStore` behind `CdBase.store`):

| Command | Actor | Event | Stream |
|---|---|---|---|
| `CampPolicy.bind` (promotion only, subject `RAIL`) | the Camp's spec actor | `policy.BindingChanged` (`PolicyBindingRecord`; meta `action=bind`, `mode`) | `cd-camp-<id>` (spec) |
| `CampPolicy.restore` (rollback) | the Camp's spec actor | `policy.BindingChanged` (meta `action=restore`) | `cd-camp-<id>` |
| `ShadowRecorder.record` (the gate) | the Camp's compliance actor | `policy.ShadowDecided` (`ShadowDecisionRecord`) | `cd-compliance-<id>` |
| `PostureService.tick` | the Station's posture service | `compliance.Observed`, `compliance.Changed` (`ComplianceRecord`), `posture.RemediationProposed` (`PostureRemediationRecord`) | `cd-compliance-<id>` |

- **Binding** writes go to the Camp's spec stream under stream-head CAS, so one
  writer per Camp still holds and the Sets fold (`./sets`) sees bindings in
  order. The body is exactly the protobuf JSON of `PolicyBindingRecord`.
- **Bindings fold** (`load`): the latest `policy.BindingChanged` is the
  binding; earlier ones are the history `restore` walks back through. A Camp
  with no binding resolves to its Station's active Rail
  (`governingRailDigest`), so existing behaviour is unchanged.
- **Projections (materialized views / read store):** the posture service keeps
  an in-memory read store per Camp — compliance records, shadow decisions,
  remediations and their keys — caught up from the event store by position
  (`readAll` after a cursor) before every query and tick. Status observations
  are read the same way from `cd-camp-status-<id>` (`deployment.StatusObserved`,
  written by `./reconcile`). There is no snapshot: the per-Camp compliance
  stream is the source of truth, and a snapshot of the read store could be
  added behind `catchUp` without changing a port.
- **Idempotency:** each evaluation is keyed by the count of earlier records for
  the same (Rail, candidate) pair, so two replicas evaluating the same state
  record one fact. Remediation keys are stable per (rule, resource, Set,
  ownership, fix) and Delta ids derive from them. Bindings are keyed per
  promotion, shadow decisions per (Delta, candidate).

## Parse, don't validate

- Pack documents are parsed once by `parsePosturePack` into frozen derived
  types (`PosturePack`, `PostureRule`); a pack that does not parse makes
  the evaluation `UNKNOWN` (ratio 1) and emits `hobo.cd.posture.pack_invalid`.
- Journal bodies are decoded with the generated schemas (`decode`), never
  re-validated field by field; an undecodable body is skipped by the
  projection.
- Rail digests are parsed into the `Digest` brand (`asDigest`) before use.
- [`data-models/posture.cue`](../../data-models/posture.cue) constrains every
  record this module writes; `test/posture/cue.test.ts` vets every body a
  journey appends against it.

## Semantics

- **INFORM** sets the Camp's candidate; the enforced Rail alone decides
  (I23). The gate shadows the candidate through `ShadowRecorder` and posture
  evaluates the candidate beside the enforced Rail (`candidate: true`
  records). Candidates never remediate and never drive `POSTURE_COMPLIANT`.
- **ENFORCE** swaps the enforced Rail and clears the candidate, only if the
  Rail Freight qualified on an `INFORM` pipeline node or holds an unexpired
  approval for the Camp (read from `cd-freight-<id>` and `cd-pipeline-<name>`);
  otherwise `shadow-required`.
- **restore** returns the digest enforced before the promotion's bind and
  clears the candidate; it refuses when a later bind superseded it.
- **Remediation (D25):** `inform` records only; `inform-only` can never be
  raised by a parent `enforce`; OBSERVE_ONLY Camps get `inform` only.
  `enforce` on a noncompliant `mutate` rule is classified against the
  current Set: `ownership-conflict` (nothing mutates; `conflicts()` feeds the
  gate, which refuses Deltas that keep it), `posture-drift` (the reconciler
  re-applies the Set), `posture-unremediable-retained`, or an unowned field,
  for which a `posture-remediate` Delta is opened through `DeltaLedger.open`
  after `posture.enforce` is authorized. The gate admits it and the Camp's
  reconciler applies it; `applyPostureFixes` is the plan the planning adapter
  resolves for it. The fix travels in the `posture-fix` reason
  (`message` = canonical JSON of `[{field, value}]`).
- **Series (`PostureSeriesReader`):** `noncompliantRatio` returns one sample
  per compliance record in the window (enforced records unless a Rail digest
  is named); `shadowDivergence` returns 1/0 per shadow decision for the
  candidate plus a 0 per candidate evaluation. An empty window is no data, so
  the HOBO_POSTURE verification fails (I5).

## Metrics (`TelemetrySink`)

`hobo.cd.compliance.noncompliant_ratio` (gauge), `hobo.cd.policy.shadow_divergence`,
`hobo.cd.policy.shadow_decisions`, `hobo.cd.policy.binding_changed`,
`hobo.cd.posture.evaluations`, `hobo.cd.posture.compliance_changed`,
`hobo.cd.posture.remediations{outcome}`, `hobo.cd.posture.ownership_conflicts`
(gauge), `hobo.cd.posture.pack_invalid`, `hobo.cd.posture.no_observation`.
Telemetry is advisory; a failing sink never fails a committed command.

## Failure modes

| Code | Where | Meaning | Remediation |
|---|---|---|---|
| `policy-bind-not-rail` | bind | Freight subject is not `RAIL` | Promote Bindle Freight as a Set |
| `policy-bind-digest-invalid` | bind | Rail Freight lacks a sha256 content digest | Re-record the Rail Freight |
| `policy-bind-mode-invalid` | bind | Node `policy_mode` unspecified | Set `INFORM` or `ENFORCE` |
| `policy-bind-proposal-only` | bind, restore | Principal may only propose | Approve with a granted principal |
| `shadow-required` | bind ENFORCE | No INFORM qualification and no unexpired approval (I23) | Shadow upstream first, or approve |
| `policy-restore-unknown` / `policy-restore-superseded` | restore | Promotion never bound / a later bind exists | Roll back the latest binding first |
| `policy-journal-conflict` | any append | Lost every CAS attempt | Retry; commands are idempotent |
| `policy-shadow-invalid` | record | Malformed shadow decision (thrown) | Fix the gate's record |
| `ownership-conflict` | remediation | Rule contradicts a Set-owned value (I22) | Change the declaration or retire the rule |
| `posture-drift` | remediation | Target differs from a compliant Set | Reconciler re-applies the Set |
| `posture-unremediable-retained` / `posture-unremediable-no-fix` | remediation | Fix field controller-owned / rule has no fix | Adjust the controller or the rule |
| `posture-set-unavailable` | remediation | Current Set unreadable (retried) | Check desired state and the blob |
| `posture-enforce-unauthorized` | remediation | `posture.enforce` refused (retried) | Grant it, or bind `inform` |
| `posture-delta-refused` | remediation | `DeltaLedger.open` refused (retried) | Usually another open Delta; wait |

## Runbook

- **A Rail promotion to ENFORCE is refused with `shadow-required`.** Check the
  Rail pipeline: the Freight must have `freight.Qualified` on a node whose
  `policy_mode` is `INFORM` (`cd-freight-<id>`), or an unexpired
  `freight.Approved` for the Camp. Let the INFORM node's verification pass
  (noncompliant ratio ≤ 2 %, 0 divergences over 24 h by default) or record an
  audited approval.
- **INFORM verification fails with no data.** The candidate is not evaluated:
  the posture service needs a status observation for the Camp and a
  `candidateRail` resolver (WP18 wires it from the Rail registry). Without the
  resolver candidate records are `UNKNOWN` with ratio 1 — by design.
- **Rolling back a Rail.** Roll back the promotion that bound it;
  `CampPolicy.restore` returns the previous enforced digest. If it reports
  `policy-restore-superseded`, roll back the named later promotion first.
- **A Camp is stuck `POSTURE_COMPLIANT=false` with `ownership-conflict`.** The
  Set itself declares the violating value. Change the Bindle declaration (a
  new Freight) or retire the rule from the Rail's posture packs; the gate
  refuses promotions that keep the violation until then.
- **Remediation Deltas never apply.** Look for `posture.RemediationProposed`
  with `posture-delta-refused` or `posture-enforce-unauthorized`; check the
  open Delta on the Camp's spec stream and the grant for `posture.enforce`.
  An agent-run posture service only proposes (`proposal: true`).
- **Compliance looks stale.** Evaluation runs every `compliant_interval_ms`
  (default 1 h) or `noncompliant_interval_ms` (default 5 min). Check
  `hobo.cd.posture.no_observation` (no reconcile observation) and
  `hobo.cd.posture.pack_invalid` (a pack did not parse).
- **Export evidence.** `complianceOscal(await posture.compliance(campId))`
  gives an OSCAL 1.1.2 assessment-results document.
