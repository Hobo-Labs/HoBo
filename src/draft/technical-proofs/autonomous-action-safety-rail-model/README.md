# Autonomous Action Safety-Rail Model

This draft is the documentation-only POC for HOBO-263. The accepted decision lives in
[ADR-0094](../../../../docs/design/adr/02-identity-security.md#adr-0094); this file keeps the spike's
worked scenarios close to the branch evidence without introducing runtime code.

## Safety Envelope

Every Crew write is classified from a `SafetyEnvelope` before policy evaluation:

- actor principal and assigned Crew role
- incident id, correlation id, source signal ids, and causation links
- target tenant/project/Camp/resource and environment
- action kind, idempotency key, and proposed effect
- reversibility, compensation reference, and conformance state
- affected users/resources, spend impact, and blast-radius scope
- prior action ids, cooldown window, and self-causation evidence

If the envelope cannot be computed, the action class is `a2h-escalate`. No autonomous write is
attempted while the missing evidence is unresolved.

## Scenario Table

| Scenario | Inputs | Class | Guard |
|---|---|---|---|
| Prod provider-degraded failover | provider errors, healthy alternate Camp, reversible traffic pointer, SLO watch available | `canary-with-auto-rollback` unless org policy requires approval | step traffic, rollback on SLO/Golden breach, one failover per scope during cooldown |
| Low-risk staging scale-up | staging queue depth, budget headroom, reversible scale-down, green conformance | `auto` | cap replicas/spend, idempotency key, cooldown before another scale action |
| False-positive drift | drift signal conflicts with current projection/refresh evidence | `require-approval` or `a2h-escalate` when confidence is unknown | diagnose-only until evidence confirms actual drift |
| Runaway remediation loop | new alert is causally linked to the operator's prior remediation | `a2h-escalate` | self-causation quarantine, max attempts per incident/scope, no same-scope second write |

## Decision Rule

Class derivation is most-restrictive-wins:

1. `requiresHuman`, unknown blast radius, missing compensation, unbounded spend, or self-causation
   uncertainty -> `a2h-escalate`.
2. Irreversible, high-impact, governance-sensitive, or low-confidence writes -> `require-approval`.
3. Bounded prod/shared-scope writes with rollback and SLO/Golden abort signals ->
   `canary-with-auto-rollback`.
4. Low-impact, reversible, budgeted, conformance-green writes in non-prod or explicitly preapproved
   scopes -> `auto`.

The operator may update the incident with diagnostics at any time; the rail only gates mutations.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Autonomous Action Safety Rail Model.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
