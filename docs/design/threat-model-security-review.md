---
type: Reference
title: "Threat Model & Security Review"
description: "Productization M0 scope and acceptance for v1 threat-model and security-review gates."
tags: [hobo, design]
---

# Threat Model & Security Review

This record pins the M0 Threat Model & Security Review scope for HOBO-451. It
is a launch-readiness contract, not a live scanner, exploit-runner, support
workflow, incident service, legal approval, public advisory, or release-gate
bypass implementation.

## M0 Scope Acceptance (HOBO-451)

Threat Model & Security Review owns the intake and review vocabulary that feeds
Security Verification and release cutline decisions. The M0 scope is accepted
only when the user/business goal, primary personas, scope in/out, service/UX/
security/support boundaries, owning initiative dependencies, review gates, and
follow-up gate are explicit.

Primary personas:

- Security reviewer owning threat intake, severity rationale, required-gate
  review, and fix-verification evidence.
- Release owner deciding beta, release-candidate, and GA go/no-go posture.
- Product owner mapping findings to product surfaces and follow-up ownership.
- Support operator routing customer-safe security escalation and known
  limitations.
- Customer admin reading assurance state without raw exploit notes or
  unsupported security claims.

Scope in:

- Define the threat-review goal, intake fields, and review-gate vocabulary.
- Map service, UX, security, and support boundaries.
- Map dependencies to Security Verification, Release Program & Cutline, Launch
  Support Desk & Escalation, Incident Communications, and Legal/Privacy
  readiness.
- List M1 evidence before downstream design or contract proof issues can fan
  out.
- Block M1-M4 follow-up work until M0 scope acceptance is recorded.
- Classify findings using severity, exploitability, customer-data risk,
  credential exposure, and fix-verification state.

Scope out:

- No live scanner, SAST, DAST, SIEM, exploit runner, runtime security service,
  or customer environment scan.
- No release/security gate bypass, merge protection bypass, or review waiver.
- No final advisory copy, legal terms, privacy notice, public security page,
  bug bounty, CVE CNA, or disclosure portal commitment.
- No incident service, ticketing service, customer notification, support queue,
  release dashboard, or raw exploit-note customer view.

M1 evidence required before follow-up work can start:

- accepted M0 scope record and traceability;
- threat-review intake fixture;
- beta, release-candidate, GA, fix-verification, and support/disclosure gates;
- launch-blocker taxonomy mapping;
- support escalation handoff; and
- legal/privacy/incident communication owner handoff.

Executable proof:
[`threat-model-security-review-scope-acceptance`](../../src/draft/exp-proofs/dx/threat-model-security-review-scope-acceptance/README.md).

## Intake Fields

| Field | Owner | Evidence |
|---|---|---|
| Asset surface | Product owner | Affected product, API, runtime, CLI, marketplace, tenant, or support surface. |
| Threat scenario | Security reviewer | Attacker capability, abuse path, and expected failed invariant. |
| Trust boundary | Security reviewer | Tenant, identity, provider, runtime, support, data, or public boundary crossed. |
| Exploitability | Security reviewer | Public, bounded, or theoretical exploitability with evidence source. |
| Customer impact | Release owner | Beta, RC, GA, support, or customer-assurance impact. |
| Credential or data risk | Security reviewer | Credential, tenant data, billing data, support data, or generated-artifact exposure. |
| Evidence link | Security reviewer | Fixture, proof package, design record, issue, or reproduced finding. |
| Fix-verification plan | Security reviewer | Regression, exploit reproduction, review, and release-gate rerun expectations. |

## Review Gates

| Gate | Owner | Minimum proof |
|---|---|---|
| Beta threat intake | Threat Model & Security Review | Private-beta security review intake fields are complete before beta claims. |
| Release-candidate security review | Security Verification | RC threats are classified with blocker or accepted-risk state. |
| GA security signoff | V1 Release Program & Cutline | GA state cites security, support, incident, and legal/privacy handoffs. |
| Fix-verification rerun | Security Verification | Release-affecting fixes rerun proof gates before downgrade or release. |
| Support and disclosure handoff | Launch Support Desk & Escalation | Customer-safe support/disclosure owner and unsupported-state wording are named. |

## Finding Classification

Critical findings, high findings with non-theoretical exploitability,
customer-data risk, credential exposure, and unverified release-affecting fixes
are launch blockers. Medium verified findings are high-risk non-blockers only
with release-owner approval, mitigation, expiry, and support wording. Low
verified findings route to launch notes or post-GA follow-up without bypassing
required gates.

## Proof

The M0 scope proof is
[`threat-model-security-review-scope-acceptance`](../../src/draft/exp-proofs/dx/threat-model-security-review-scope-acceptance/README.md).
