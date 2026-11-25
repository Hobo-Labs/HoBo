---
type: Reference
title: "V1 Security Verification"
description: "This record pins the v1 vulnerability disclosure and security launch-blocker process for"
tags: [hobo, design]
---

# V1 Security Verification

This record pins the M0 Security Verification scope for HOBO-441 and the v1 vulnerability
disclosure and security launch-blocker process for HOBO-494. It is a launch-readiness contract,
not a production workflow implementation.

## M0 Scope Acceptance (HOBO-441)

Security Verification owns the v1 security launch gate. The M0 scope is accepted only when the
user/business goal, primary personas, scope in/out, service/UX/security/support boundaries, owning
initiative dependencies, M1 evidence requirements, and follow-up gate are explicit.

Primary personas:

- Release owner deciding beta, RC, and paid-GA go/no-go posture.
- Security lead owning threat intake, severity disposition, blocker criteria, and fix evidence.
- Support operator routing customer-safe escalation without mutating security decisions.
- Customer admin reading assurance evidence and known limitations.
- Legal/privacy owner approving disclosure, advisory, and public-security-page posture.

Scope in:

- Define the security verification goal, launch gate vocabulary, and evidence expectations.
- Map service, UX, security, and support boundaries.
- Map dependencies to Threat Model & Security Review, V1 Release Program & Cutline, Launch Support
  Desk & Escalation, Incident Communications, and Legal/Privacy readiness.
- List M1 evidence before downstream design or contract proof issues can fan out.
- Block M1-M4 follow-up work until M0 scope acceptance is recorded.

Scope out:

- No live scanner, SIEM integration, ticketing workflow, incident service, or customer notification
  service.
- No public security page, final legal terms, privacy notice, advisory copy, external bug bounty,
  CVE CNA commitment, or vendor disclosure portal.
- No runtime security engine, Gatekeeper change, policy engine change, tenant-control
  implementation, or exploit scanning integration.

M1 evidence required before follow-up work can start:

- accepted M0 scope record and traceability;
- threat-review intake fixture;
- launch-blocker taxonomy mapping;
- vulnerability-disclosure process proof;
- fix-verification fixture; and
- support escalation handoff.

Executable proof:
[`security-verification-scope-acceptance`](../../src/draft/exp-proofs/dx/security-verification-scope-acceptance/README.md).

## Goal

HoBo v1 needs a clear path for vulnerability reports and release-blocking security findings before
beta and paid GA claims can be made. Security verification must cover report intake, triage
ownership, severity/SLA expectations, embargo handling, customer communication, and fix
verification.

## Scope In

- Public-at-GA and private-beta vulnerability intake channels.
- Severity labels with triage owners and SLA targets.
- Launch-blocker criteria that map to the v1 cutline and security verification gate.
- Embargo handling with authorized roles and audit evidence.
- Customer communication triggers and support handoff evidence.
- Fix verification evidence before a blocked release can proceed.
- Beta versus paid-GA differences.

## Scope Out

- No external bug bounty commitment unless separately approved.
- No final legal terms, privacy notices, security-page copy, or advisory text.
- No CVE CNA commitment or vendor-specific disclosure portal implementation.
- No live ticketing, support, incident, or customer-notification service.

## Intake

| Channel | Visibility | Owner | Evidence |
|---|---|---|---|
| `/.well-known/security.txt` | Public at paid GA | Security Verification | Published contact and encrypted-submission posture |
| Support security escalation | Private beta and GA | V1 Launch Support Desk & Escalation | Triage record and security-owner handoff |

Beta may use a private documented intake path before a public security page exists. Paid GA requires
a public security contact and supported reporting channel.

## Severity and SLA

| Severity | Triage SLA | Owner | Default launch posture |
|---|---:|---|---|
| Critical | 4 hours | Security lead | Blocks beta and paid GA until fixed or explicitly waived by launch owner |
| High | 24 hours | Security lead | Blocks launch when customer impact, exploitability, or unsupported claim risk exists |
| Medium | 72 hours | Security on-call | May ship as known limitation only when customer impact and exploitability are bounded |
| Low | 168 hours | Security on-call | Usually backlog or release-note item |

Every severity decision records affected phase, exploitability, customer impact, and whether the
fix is verified.

## Embargo

Embargoes are allowed only when the security lead, release owner, and legal/privacy owner agree.
The maximum default embargo is 90 days, recorded as `policy.Decided`. Embargo handling
does not relax the release blocker; it only controls disclosure timing.

## Customer Communication

Customer communication is required when impact is confirmed, a public advisory is required, a fix or
mitigation is available, or a known limitation is promoted into release notes. Evidence names the
audience, message owner, support playbook link, and publish/send timestamp.

## Fix Verification

Fix verification requires regression coverage, exploit reproduction, fix review, release-gate
rerun, and customer-impact assessment. A launch-blocking finding cannot move to a release
limitation until this evidence exists or an explicit launch-owner waiver is recorded.

## Launch-Blocker Criteria

The security verification gate and v1 cutline treat these as blockers:

- critical or high severity with public exploitability;
- confirmed customer data risk;
- a customer-facing security claim that lacks evidence;
- an unverified fix for a finding that affects beta or paid GA.

Each criterion maps to `v1-blocker.support` because the blocking outcome is a support/security
launch operation, even when legal/privacy, documentation, or productization owns part of the
evidence.

## Proof

The M0 scope proof is
[`security-verification-scope-acceptance`](../../src/draft/exp-proofs/dx/security-verification-scope-acceptance/README.md).

The HOBO-494 process proof is
[`vulnerability-disclosure-launch-blocker-contract`](../../src/draft/exp-proofs/cx/vulnerability-disclosure-launch-blocker-contract/README.md).
It validates the process record, beta/GA differences, scope-out guard for external bug bounty, and
release-blocker classification.
