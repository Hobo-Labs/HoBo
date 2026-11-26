# ADR: Plan Annotation Pseudocode As Fixture Contract

## Status

Accepted for HOBO-543 proof scope.

## Context

Plan/Diff Viewer needs policy, cost, capacity, approval, and readiness annotations before later
prototype work can render review states. The proof must not implement the policy engine, approval
runtime, billing, quota enforcement, provider cost APIs, production UI, credentials, or launch
claims.

## Decision

Represent plan annotations as deterministic fixture records with a narrow parser, pseudocode
renderer, protobuf schema, CUE constraints, and Pact fixture. Each annotation carries input,
display group, severity, proof mode, evidence state, missing-evidence behavior, support owner route,
support-safe wording, accessibility notes, and a stable fixture id.

The fixture set covers:

- policy denial;
- widened permission;
- cost estimate;
- capacity warning;
- stale SLO signal; and
- missing approval.

## Consequences

- Downstream Plan/Diff Viewer, onboarding, dashboard, docs, and support examples can reuse one
  accepted vocabulary instead of inventing behavior.
- Stale, missing, or simulated evidence cannot be rendered as success.
- Live policy, cost, provider, approval, and UI behavior remains explicitly out of scope for this
  branch.
