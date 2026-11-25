---
type: Reference
title: "HOBO-442 Drift Reconciliation Proof"
description: "Source issue: HOBO-442."
tags: [hobo, design]
---

# HOBO-442 Drift Reconciliation Proof

This proof records the branch evidence for
[Drift Reconciliation](../../drift-reconciliation.md).

## Summary

- Issue: HOBO-442
- Package: [`drift-reconciliation-scope-contract`](../../../../src/draft/exp-proofs/dx/drift-reconciliation-scope-contract/README.md)
- Focused gate: `pnpm --prefix src\draft\drift-reconciliation-scope-contract test`

## Acceptance Evidence

- Goal and personas: `DRIFT_RECONCILIATION_SCOPE` names the business goal and platform engineer,
  SRE operator, support operator, and security reviewer personas.
- Scope and non-goals: exported scope records list in-scope drift classes, reconciliation states,
  evidence, and explicit provider/runtime/remediation/cleanup/support/billing exclusions.
- Dependencies and boundaries: service, UX, security, and support boundaries are mapped to owning
  initiatives plus control-plane, provider, policy, SRE, support, and cleanup dependencies.
- M1 evidence: seven follow-up proof assets are named before downstream design or implementation
  issues can fan out.
- Follow-up gate: `canCreateDriftReconciliationFollowUp` blocks M1-M4 work until accepted M0
  evidence is present.

## Adversarial Evidence

The focused tests assert fail-closed behavior for provider refresh scheduler creep, ResourceActor
runtime creep, autonomous remediation and real-cloud mutation creep, and missing source-of-truth
evidence. Classifier tests route adjacent work to Providers/IaC, Control Plane, Resource Garbage
Collection, Support Workflow, or Usage Metering instead of silently absorbing it into Drift
Reconciliation.
