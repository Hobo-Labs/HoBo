---
type: Reference
title: "V1 Critical Path Dependencies"
description: "Source issue: HOBO-484."
tags: [hobo, design]
---

# V1 Critical Path Dependencies

Source issue: HOBO-484.

Executable proof lives in
[`src/draft/exp-proofs/dx/v1-critical-path-dependency-map-contract`](../../src/draft/exp-proofs/dx/v1-critical-path-dependency-map-contract/README.md).
Branch evidence is summarized in
[`proofs/hobo-484-v1-critical-path-dependencies`](./proofs/hobo-484-v1-critical-path-dependencies/README.md).

## M0 Acceptance Record

The V1 Release Program & Cutline needs one dependency map that shows which productization projects
block private beta, release-candidate, and GA readiness. This record maps cross-project dependencies
without implementing the dependent projects.

## Dependency Map

| Domain | Upstream project | Downstream gate | Blocker type | Owner |
|---|---|---|---|---|
| Product UX | Workspace & Onboarding UX | Private beta workspace can complete first deploy | Beta blocker | Product UX owner |
| Tenant model | Organization, Workspace & Tenant Model | Private beta tenants have accepted ownership and isolation model | Beta blocker | Tenant platform owner |
| Billing | Billing Launch Policy | Paid GA cannot start until billing limitations and payment states are accepted | GA blocker | Billing owner |
| Install | Bootstrap Installer | Private beta has SaaS, self-host, and local/dev bootstrap smoke evidence | Beta blocker | Install owner |
| Docs | V1 Release Notes & Upgrade Guide | GA release notes publish only from accepted source evidence | GA blocker | Docs owner |
| Testing | E2E Test Matrix | Release candidate cannot cut without accepted persona and smoke fixtures | RC blocker | Quality owner |
| Support | V1 Launch Support Desk & Escalation | Private beta has support severity routing and escalation owner | Beta blocker | Support owner |
| Security | Security Verification | Beta and GA block on required security verification failures | Beta blocker | Security owner |
| Compliance | Customer Assurance Evidence Packet | Enterprise or paid GA claims wait for accepted legal/privacy and assurance evidence | GA blocker | Compliance owner |
| Operations | V1 Dogfood Yard & Hosted Operations | GA handoff requires hosted operations, backup/restore, status, and dogfood evidence | GA blocker | Operations owner |

## Critical Path

Private beta blockers are product UX, tenant model, install, support, and security. These must be
accepted before HoBo can invite beta users into a supported workspace path.

Release-candidate blockers are testing evidence and fixture acceptance. These must be accepted
before HoBo can cut an RC from beta evidence.

GA blockers are billing, docs, compliance, and operations. These must be accepted before HoBo can
publish paid or broad-availability launch claims.

## Known Limitations

| Limitation | Owner | Customer disposition |
|---|---|---|
| Live customer production proof | Release owner | Dogfood and mocked-boundary evidence cannot be described as live customer production proof. |
| Final legal approval | Legal/privacy owner | Legal/privacy launch text stays pending until legal owner approval is attached. |
| Live payment provider integration | Billing owner | Payment provider integration is outside this M0 dependency map and remains a launch limitation until owned evidence exists. |
| Runtime feature implementation | Release owner | This map records sequencing and does not implement runtime, dashboard, support, security, or operations features. |

## Scope Guards

- Do not implement product UX, tenant, billing, installer, docs, test, support, security,
  compliance, or operations features in this issue.
- Do not create release go/no-go decisions; this record only maps dependency inputs.
- Do not convert dogfood, mocked-boundary, or M0 proof evidence into customer production claims.
- Do not draft final legal, payment, or support commitment text without the owning project.

## Design Links

- [V1 cutline proof](../../src/draft/technical-proofs/v1-cutline-contract/README.md) defines launch scope
  boundaries.
- [Launch blocker taxonomy](./launch-blocker-taxonomy.md) defines blocker and exception language.
- [Release notes and upgrade guide](./release-notes-upgrade-guide.md) consumes accepted evidence for
  customer-facing release copy.
- [Pre-launch outcome contract](./pre-launch-outcome-contract.md#surface-mapping) feeds value
  evidence into launch go/no-go decisions.
