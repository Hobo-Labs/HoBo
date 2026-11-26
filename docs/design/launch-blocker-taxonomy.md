---
type: Reference
title: "Launch Blocker Taxonomy And Go/No-Go Exceptions"
description: "Source issue: HOBO-402."
tags: [hobo, design]
---

# Launch Blocker Taxonomy And Go/No-Go Exceptions

Source issue: HOBO-402.

Executable proof lives in
[`src/draft/exp-proofs/cx/launch-blocker-taxonomy-contract`](../../src/draft/exp-proofs/cx/launch-blocker-taxonomy-contract/README.md).
Branch evidence is summarized in
[`proofs/hobo-402-launch-blocker-taxonomy`](./proofs/hobo-402-launch-blocker-taxonomy/index.md).

## M0 Acceptance Record

HoBo v1 release decisions need one shared taxonomy so dogfood, beta, support, security,
legal/privacy, and upgrade findings do not use different blocker language. This record sits on top
of the v1 cutline and pre-launch outcome baseline; it does not fix blockers or waive gates.

## Severity Taxonomy

| Class | Go/no-go action | Ships? | Required evidence |
|---|---|---:|---|
| Launch blocker | No-go | No | Finding record, affected launch surface, owner, and failed gate or customer impact. |
| High-risk non-blocker | Conditional go | Yes | Finding record, risk impact, mitigation, rollback or pause path, expiry, and approved owner. |
| Launch note | Go with note | Yes | Customer-visible wording, support owner, and known limitation text. |
| Post-GA follow-up | Go | Yes | Follow-up owner and non-blocking rationale. |

Launch blockers cannot be waived by exception. A launch blocker exits only when the gate passes, the
work is removed from launch scope, or evidence supports downgrading it without bypassing required
CI, review, security, or contract-test gates.

## Exception Process

An exception request is allowed only for high-risk non-blockers, launch notes, or post-GA follow-ups.
It must include:

- Finding record.
- Impact.
- Mitigation.
- Expiry or review date.
- Approver role: release owner, security owner, legal/privacy owner, or support owner.

Exceptions cannot override CI, review, security, or contract-test gates. They also cannot merge
around required reviewers or turn missing evidence into a launch claim.

## Source Routing

| Source | Owner project | Decision inputs |
|---|---|---|
| Dogfood | V1 Dogfood Yard & Hosted Operations | Reproducibility, affected yard scope, rollback or pause path. |
| Beta | V1 Beta Pilot & Feedback Loop | Pilot cohort impact, feedback severity, customer-visible limitation. |
| Support | V1 Launch Support Desk & Escalation | Supportability, escalation path, customer communication. |
| Security | Threat Model & Security Review | Required security gate, exploitability, tenant or credential exposure. |
| Legal/privacy | V1 Legal, Privacy & Terms Readiness | Legal approval, privacy or data-class impact, unsupported jurisdiction. |
| Upgrade | Upgrade & Migration Engine | Rollback evidence, migration dry-run, release-note impact. |

## Example Triage Cases

| Case | Source | Class | Action |
|---|---|---|---|
| Security required gate fails | Security | Launch blocker | No-go until the gate passes or scope is removed. |
| Dogfood latency with pause path | Dogfood | High-risk non-blocker | Conditional go with release-owner approval and expiry. |
| Support known limitation | Support | Launch note | Go with release-note and support text. |
| Upgrade diff cleanup | Upgrade | Post-GA follow-up | Track after GA without changing go/no-go. |
| Beta caveat | Beta | Launch note | Go with customer-visible caveat. |
| Unsupported jurisdiction | Legal/privacy | High-risk non-blocker | Conditional go only for supported jurisdictions. |

## Scope Out

- Do not resolve blockers in this issue.
- Do not override required CI, review, security, or contract gates.
- Do not implement runtime policy enforcement.
- Do not create merge or review bypasses.

## Design Links

- [V1 cutline proof](../../src/draft/technical-proofs/v1-cutline-contract/README.md) defines launch scope boundaries.
- [Pre-launch outcome contract](./pre-launch-outcome-contract.md#surface-mapping) maps outcome
  evidence into launch go/no-go decisions.
- [ADR-0023](./adr/02-identity-security.md#adr-0023) preserves secure-by-default behavior.
- [ADR-0045](./adr/02-identity-security.md#adr-0045) keeps SLO and error-budget gates explicit.
- [ADR-0082](./adr/02-identity-security.md#adr-0082) keeps golden-suite failures tied to incident and
  handoff evidence.
- [ADR-0094](./adr/02-identity-security.md#adr-0094) keeps autonomous actions bounded and fail-closed.
