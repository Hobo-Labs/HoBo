---
type: Reference
title: "Go/No-Go Decision Record And Risk Acceptance Workflow"
description: "Source issue: HOBO-483."
tags: [hobo, design]
---

# Go/No-Go Decision Record And Risk Acceptance Workflow

Source issue: HOBO-483.

Executable proof lives in
[`src/draft/technical-proofs/go-no-go-decision-record-contract`](../../src/draft/technical-proofs/go-no-go-decision-record-contract/README.md).
Branch evidence is summarized in
[`proofs/hobo-483-go-no-go-decision-record`](./proofs/hobo-483-go-no-go-decision-record/index.md).

## M0 Acceptance Record

HoBo v1 release decisions need a durable record so repo-public, developer-tooling, beta,
release-candidate, and GA decisions do not hide the evidence, blocker changes, accepted-risk owner,
or revisit date behind chat history. This record consumes the
[launch-blocker taxonomy](./launch-blocker-taxonomy.md) and defines the process for risk acceptance.
It does not approve any current risk. Ship-target vocabulary for which gate applies is
[ADR-0140](./adr/07-portability-extensibility.md#adr-0140) /
[`launch-ship-targets.md`](./launch-ship-targets.md); populated instances live under
[`instances/`](./instances/README.md).

## Decision Record Template

| Field | Required | Rule |
|---|---:|---|
| Gate | Yes | One of `repo-public`, `developer-tooling`, `beta`, `release-candidate`, or `GA`. |
| Decision | Yes | One of go, conditional-go, or no-go. |
| Approver role | Yes | Release owner, security owner, legal/privacy owner, support owner, or business owner. |
| Evidence links | Yes | Links to accepted proof, gate results, support/legal/security evidence, or limitation text. |
| Blocker deltas | Yes | New, resolved, downgraded, or removed-from-scope blockers since the previous decision. |
| Accepted risks | Yes | High-risk non-blockers, launch notes, or post-GA follow-ups accepted for this decision. |
| Expiry or revisit date | Yes | Date when the decision or exception must be revisited. |

`repo-public` and `developer-tooling` are interim gates for [ADR-0140](./adr/07-portability-extensibility.md#adr-0140)
Targets A and B. They do not replace beta / release-candidate / GA for hosted Target C.

## Gate Workflow

| Gate | Ship target | Decision inputs | Allowed outcomes |
|---|---|---|---|
| Repo-public | A — OSS public | Launch definition, truth-in-advertising posture, secret-scan evidence, SECURITY contact, known limitations for pre-release source, blocker delta. | Go, conditional go, or no-go. |
| Developer-tooling | B — local-first npm | Target A posture + publish allowlist/prerelease, install story, offline golden path, HONEST SCOPE package docs, support boundary, blocker delta. | Go, conditional go, or no-go. |
| Beta | C — hosted public beta | Pilot cohort, known limitations, support route, blocker delta, and evidence links. | Go, conditional go, or no-go. |
| Release-candidate | C — hosted RC | Release notes, upgrade guidance, compatibility evidence, blocker delta, and evidence links. | Go, conditional go, or no-go. |
| GA | C — hosted GA | Signed launch checklist, support handoff, legal/privacy posture, blocker delta, and evidence links. | Go, conditional go, or no-go. |

## M3 Release Candidate Evidence Gate

HOBO-468 records the V1 Release Program & Cutline M3 evidence gate in
[`v1-cutline-contract`](../../src/draft/technical-proofs/v1-cutline-contract/README.md). The gate requires:

- accepted cutline baseline, release-candidate go/no-go, blocker delta, accepted-risk register,
  cross-project handoff, and release-notes readiness evidence;
- blockers and accepted risks with owner, source evidence, disposition, mitigation, launch note or
  follow-up, and revisit date;
- release notes, support, legal/privacy, dogfood operations, launch-site messaging, and beta-pilot
  dependencies reflected in the cutline;
- follow-up issues only for missing evidence, currently the existing HOBO-475 GA handoff; and
- parent HoBo v1 Release Readiness sync when this gate changes launch risk.

This gate does not publish GA readiness, final release notes, support commitments, legal text, or
release automation. Release-candidate evidence is a conditional release-program record; GA handoff
remains a separate M4 gate.

## M4 GA Handoff Evidence Gate

HOBO-475 records the V1 Release Program & Cutline M4 GA handoff evidence gate in
[`v1-cutline-contract`](../../src/draft/technical-proofs/v1-cutline-contract/README.md). The gate requires:

- accepted cutline baseline, GA go/no-go input record, signed launch checklist, support handoff,
  legal/privacy posture, blocker delta, accepted-risk register, cross-project handoff, and
  readiness-dashboard refresh evidence;
- blockers and accepted risks with owner, source evidence, disposition, mitigation, launch note or
  follow-up, and revisit date;
- Dogfood Yard, Beta Pilot, legal/privacy, support, release notes, and launch-site dependencies
  reflected in the cutline;
- follow-up issues only for missing evidence, currently the existing HOBO-476 Dogfood Yard and
  HOBO-477 Beta Pilot M4 handoff issues; and
- parent HoBo v1 Release Readiness sync when this gate changes launch risk.

This gate accepts the release-program GA handoff record without implementing release automation,
approval UI, runtime launch gates, support tooling, customer-facing release notes, legal text, or
public GA publication. Public GA claims remain held while dependent M4 owner handoffs are open.

## Risk Acceptance Rules

Exception requests are allowed only for high-risk non-blockers, launch notes, or post-GA follow-ups.
Each exception must include:

- named owner;
- mitigation;
- launch note or follow-up;
- expiry or revisit date; and
- evidence link that supports the classification.

Launch blockers cannot be waived by exception. A launch blocker exits only when the failed gate
passes, the work is removed from launch scope, or evidence supports downgrading it without
bypassing required CI, review, security, or contract-test gates.

## Scope Out And Non-Goals

- Do not approve any current risk in this issue.
- Do not resolve launch blockers in this issue.
- Do not override required CI, review, security, or contract gates.
- Do not implement runtime policy enforcement, release automation, or approval UI.
- Do not publish customer-facing release notes or legal text from this M0 record.

## Authoritative Dependencies

- [launch-blocker-taxonomy.md](./launch-blocker-taxonomy.md) defines launch blocker, high-risk
  non-blocker, launch note, and post-GA follow-up classes.
- [release-notes-upgrade-guide.md](./release-notes-upgrade-guide.md) names release-note inputs that
  consume go/no-go decisions.
- [legal-privacy-terms-readiness.md](./legal-privacy-terms-readiness.md) names legal/privacy
  checklist items and owner lanes.
- [support-sla-channels.md](./support-sla-channels.md) names support owner and escalation lanes.

## Follow-Up Gate

M1/M2/M3/M4 go/no-go dashboard, release automation, approval UI, or risk-register execution work
must wait until this M0 record and executable proof are accepted.
