# Architecture Evidence

HOBO-543 is a fixture-only experience proof for plan/diff annotations.

- **Protobuf:** `architecture/vibe_plan_annotation_pseudocode.proto` defines
  annotation fixtures, proof modes, contract fixtures, and the package contract.
- **CUE:** `architecture/vibe_plan_annotation_pseudocode.cue` constrains
  annotation cases, display grouping, severity, proof mode, evidence state,
  missing-evidence behavior, fixture ids, and contract fixture paths.
- **PACT:** `architecture/pacts/vibe_plan_annotation_pseudocode.pact.json`
  captures the consumer expectation for the parsed annotation pseudocode body.
- **Parse, don't validate:** raw fixture data crosses
  `parsePlanAnnotationPseudocode` once and becomes the parsed derived type
  `PlanAnnotationPseudocode`. Rendering and scope checks consume that parsed
  derived type instead of repeating raw DTO checks.

## Event Architecture

This proof does not introduce production runtime behavior. It names the command,
event, actor, event-store, materialized view/projection, snapshot, and read store
behavior that later Plan/Diff Viewer and control-plane slices must preserve.

- Command family: `planAnnotation.acceptFixture` accepts deterministic
  annotation fixtures; `planAnnotation.rejectScopeCreep` rejects production
  policy, approval, billing, quota, live cost API, credential, UI, and launch
  claim requests.
- Event family: no new runtime event is emitted here. Future implementations
  must map policy denial and approval facts to existing `policy.Decided` /
  obligation evidence, plan facts to `deployment.*`, and SLO/capacity signals
  to the reliability event families.
- Actor behavior: no production actor is implemented. Planner, Gatekeeper,
  ResourceActor, approval owner, SRE owner, FinOps owner, and support operator
  actors consume these annotations as fixture evidence only.
- Event-store behavior: no event-store writes happen in this proof. Later
  implementations append policy, plan, approval, SLO, and support facts under
  their owning issues.
- Materialized view / projection behavior: annotations are read as projected
  plan-review facts grouped by policy, cost, capacity, approval, and readiness.
  Stale or unknown projections fail closed instead of appearing as success.
- Snapshot behavior: the parsed `PlanAnnotationPseudocode` record is the
  deterministic snapshot verified by tests and the Pact fixture.
- Read-store behavior: no durable read store is created. Consumers read the
  package README, proof note, Pact fixture, protobuf/CUE contract, and
  traceability row as the support-safe evidence store for this branch.

## Scope Boundary

No policy engine, approval runtime, billing, quota enforcement, live cloud cost
API, provider call, credential flow, production UI, customer data, or launch
claim is implemented by this proof.
