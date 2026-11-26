# Vibe Plan Annotation Pseudocode

Independent M1 experience proof for HOBO-543.

This package defines the plan/diff annotation pseudocode that downstream plan-review prototypes can
reuse for policy, cost, capacity, approval, and readiness context. It is an artifact proof, not a
production UI or service implementation.

## Audience

- App developer reviewer: needs plain language about what is safe, blocked, stale, or simulated.
- Platform engineer approver: needs owner routes for capacity, approval, and widened permissions.
- Security reviewer: needs policy denials and permission widening to stay visible.
- Support operator: needs customer-safe wording and evidence sources for blocked plan handoff.

## Scope

In scope:

- Annotation input, display grouping, severity, proof mode, missing-evidence behavior, and support
  owner routing.
- Fixtures for policy denial, widened permission, cost estimate, capacity warning, stale SLO signal,
  and missing approval.
- Protobuf, CUE, and Pact fixture evidence for the annotation boundary.
- Terminal-friendly accessibility notes and customer-safe support wording.

Out of scope:

- Production policy, billing, quota, approval, provider cost, or dashboard implementation.
- Live provider calls, cloud credentials, customer data, or launch claims.
- Treating stale, missing, or simulated evidence as live success.

## Acceptance Map

| Acceptance | Evidence |
|---|---|
| Scope out remains hard. | `classifyPlanAnnotationRequest` and `rejectPlanAnnotationScopeCreep` reject production policy, approval, billing, quota, live cost API, credential, dashboard, production UI, and launch-claim creep. |

## Proof

```powershell
pnpm.cmd --dir src\draft\exp-proofs\vibe-plan-annotation-pseudocode test
```

## Architecture Evidence

- `architecture/vibe_plan_annotation_pseudocode.proto` defines the fixture schema.
- `architecture/vibe_plan_annotation_pseudocode.cue` constrains proof modes, cases, grouping,
  evidence states, and missing-evidence behavior.
- `architecture/pacts/vibe_plan_annotation_pseudocode.pact.json` pins the consumer/provider fixture.
- `ADR.md` records why this stays pseudocode and reference fixture material.
- `ARCHITECTURE.md` records parse-don't-validate and event architecture evidence.
