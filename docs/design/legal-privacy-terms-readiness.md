---
type: Reference
title: "Legal, Privacy, And Terms Launch Readiness"
description: "Source issue: HOBO-405."
tags: [hobo, design]
---

# Legal, Privacy, And Terms Launch Readiness

Source issue: HOBO-405.

Executable proof lives in
[`src/draft/exp-proofs/cx/legal-privacy-terms-readiness-contract`](../../src/draft/exp-proofs/cx/legal-privacy-terms-readiness-contract/README.md).
Branch evidence is summarized in
[`proofs/hobo-405-legal-privacy-terms-readiness`](./proofs/hobo-405-legal-privacy-terms-readiness/README.md).

## M0 Acceptance Record

HoBo v1 needs a launch-facing checklist that keeps public claims, support commitments, telemetry,
privacy posture, subprocessors, and legal unknowns aligned with evidence. This record defines the
checklist and its blockers without drafting final legal text or making public compliance claims.

## User And Business Goal

HoBo needs one legal/privacy/terms readiness surface that release, support, security, compliance,
and launch-communications owners can inspect before beta or GA. The checklist must show which items
are evidence-backed, which need owner input, which block launch, and which are explicit post-v1
follow-ups.

## Scope In

- Launch checklist for terms, privacy notice, data retention, telemetry,
  subprocessors/provider claims, security claims, support obligations, and customer communications.
- Owner, owning project, evidence source, customer-facing message, support action, audit evidence,
  and entitlement impact per checklist item.
- Legal/privacy unknowns classified as launch blockers or explicit post-v1 follow-ups.
- References to HoBo security, compliance/data governance, organizational governance, and scope
  records.

## Scope Out And Non-Goals

- Do not draft final customer terms, privacy policy, DPA, or legal policy text in this issue.
- Do not publish compliance, security, privacy, or provider claims without evidence.
- Do not implement a legal workflow, contract lifecycle system, billing policy, or support-desk
  product.
- Do not create downstream M1-M4 issues until this M0 checklist is accepted.

## Launch Checklist

| Domain | Owner | Owning project | Evidence source | Customer message | Support action | Audit evidence | Entitlement impact |
|---|---|---|---|---|---|---|---|
| Terms | legal owner | V1 Legal, Privacy & Terms Readiness | Legal owner approval plus release cutline signoff. | Terms are pending final legal approval; do not publish final terms from this M0 record. | Route terms questions to legal owner and release owner. | Signed launch checklist row and approval reference. | Blocks paid or public launch if final legal approval is absent. |
| Privacy notice | privacy owner | V1 Legal, Privacy & Terms Readiness | Privacy review over telemetry, retention, subprocessors, and support access. | Privacy notice must describe what HoBo collects, retains, exports, and shares before launch. | Escalate data-handling questions to privacy owner. | Privacy review reference and data map link. | Blocks launch for workflows that collect production customer data. |
| Data retention | governance owner | Compliance Evidence Pack | [Plan 46](./governance-planes.md#plan-46) classification, retention, erasure, and OCSF attestation model. | Retention commitments must distinguish product data, audit streams, telemetry, and support artifacts. | Route retention exceptions to governance owner. | Retention matrix and exported attestation evidence. | Controls whether customer data can enter beta or GA environments. |
| Telemetry | product analytics owner | Workspace & Onboarding UX | Workspace activation metrics and privacy-safe telemetry contract. | Telemetry must state purpose, PII exclusions, retention, opt-out behavior, and support/debug use. | Route telemetry opt-out and deletion requests to support owner. | Event catalog, retention policy, and opt-out handling evidence. | Beta telemetry can proceed only inside the reviewed privacy boundary. |
| Subprocessors/provider claims | vendor owner | Compliance Evidence Pack | Confirmed subprocessor/provider list and provider claim evidence. | Provider and subprocessor statements must distinguish required, optional, mocked, and unsupported services. | Escalate customer assurance requests to vendor owner. | Subprocessor list, provider claim register, and known limitations. | Blocks enterprise pilot commitments if required subprocessors are unconfirmed. |
| Security claims | security owner | Security Verification | [ADR-0023](./adr/02-identity-security.md#adr-0023) security posture, vulnerability process, SBOM/provenance, and launch-blocker gates. | Security claims must name implemented, simulated/reference, beta-only, and future-roadmap evidence. | Remove or downgrade unsupported public security claims. | Claim register row plus linked verification evidence. | Unsupported security claims cannot unlock customer-facing launch copy. |
| Support obligations | support owner | Support & Debug Tools | Support intake, severity, escalation, and debug evidence contract. | Support expectations must state response path, evidence needed, known limitations, and escalation triggers. | Route incidents through support intake with launch-blocker escalation. | Support runbook, severity table, and handoff evidence. | Defines beta and GA support boundaries without promising unowned SLAs. |
| Provider terms of service | legal owner | V1 Legal, Privacy & Terms Readiness | Per-provider review that the intended commercial model is permitted by each registered vendor's terms, against the [ADR-0129](./adr/07-portability-extensibility.md#adr-0129) invariants and the adapter `terms` references. | Providers are registered under the operator's own account; HoBo never fronts its own provider accounts, pools free-tier headroom, or resells provider capacity. | Route provider-terms and free-tier questions to the legal owner; do not promise pooled or HoBo-supplied provider capacity. | Per-provider terms URL, `reviewedOn` date, and the reviewed commercial-model determination. | Blocks paid GA if any registered provider's terms do not permit the intended commercial model. |
| Customer communications | launch communications owner | V1 Launch Site, Messaging & Demo Assets | Launch messaging claim register and release notes. | Customer-facing communications must align with evidence, known limitations, support boundaries, and release cutline. | Route unsupported or risky claims back to launch communications owner. | Claim register, release notes, and approval references. | Controls which claims can appear in beta, GA, docs, and demo assets. |

## Open Unknowns

| Unknown | Disposition | Owner | Required before |
|---|---|---|---|
| Final legal review for terms, privacy notice, and customer-facing legal copy | Launch blocker | legal owner | Public launch or paid GA |
| Confirmed v1 subprocessor/provider list | Launch blocker | vendor owner | Enterprise beta or GA customer assurance packet |
| Per-provider confirmation that the intended hosted commercial model is permitted by that vendor's terms ([ADR-0129](./adr/07-portability-extensibility.md#adr-0129)) | Launch blocker | legal owner | Paid GA of any hosted offering |
| Evidence review for public security claims | Launch blocker | security owner | Public security or compliance claims |
| Localized terms, translations, and jurisdiction-specific notices | Post-v1 follow-up | legal owner | Post-v1 expansion |
| Formal SOC2 or similar certification program | Post-v1 follow-up | compliance owner | Future certification program |

## Authoritative Dependencies

- [security-networking.md#plan-12](./security-networking.md#plan-12) defines the security posture,
  audit/compliance path, supply-chain posture, and supportable security boundaries.
- [governance-planes.md#plan-46](./governance-planes.md#plan-46) defines compliance/data
  governance, retention, erasure, attestation export, and AI-safety evidence boundaries.
- [ADR-0023](./adr/02-identity-security.md#adr-0023) requires security commitments to be verifiable
  gates, not prose.
- [ADR-0060](./adr/02-identity-security.md#adr-0060) keeps HoBo to evidence export rather than
  running a legal certification program.
- [ADR-0074](./adr/02-identity-security.md#adr-0074) defines organizational governance over HoBo's
  own control-plane actions.
- [ADR-0064](./adr/07-portability-extensibility.md#adr-0064) keeps commercial/legal business
  mechanics outside the HoBo meta-cloud implementation scope.
- [ADR-0129](./adr/07-portability-extensibility.md#adr-0129) fixes the provider-terms invariants
  the credit-routing objective depends on: registered providers are the operator's own accounts,
  free-tier headroom is never pooled or resold, no account is multiplied to reset a tier, and each
  adapter carries a dated `terms` reference.

## Follow-Up Gate

M1/M2/M3/M4 legal, privacy, support, communications, or evidence work must wait until this M0
checklist is accepted. This branch records the checklist and its executable guard; it does not fan
out downstream work.

## M1 Dogfood/alpha Evidence Gate

HOBO-457 accepts dogfood/alpha legal/privacy/terms evidence only when each required record maps to
an owning project and release cutline reference, and when blockers, accepted risks, parent readiness
updates, and follow-up boundaries are represented explicitly. The executable proof lives in
[`src/draft/technical-proofs/legal-privacy-terms-dogfood-alpha-evidence`](../../src/draft/technical-proofs/legal-privacy-terms-dogfood-alpha-evidence/README.md)
and branch evidence is summarized in
[`proofs/hobo-457-legal-privacy-terms-dogfood-alpha`](./proofs/hobo-457-legal-privacy-terms-dogfood-alpha/README.md).

Required M1 evidence:

- Terms approval path and owner routing are recorded for dogfood/alpha only.
- Privacy notice review maps telemetry, retention, support access, and subprocessors.
- Data retention classes link deletion/export expectations before dogfood data enters alpha.
- Telemetry usage states purpose, owner, retention posture, and customer-facing disclosure status.
- Subprocessor/provider claims distinguish confirmed, optional, mocked, unsupported, and unknown
  services before release wording can reference them.
- Security claims are evidence-backed or downgraded before public copy.
- Support obligations and customer communications align with known limitations and release notes.

Scope guards:

- The gate does not draft final legal terms, privacy notices, DPAs, billing terms, SLAs, or legal
  workflow product.
- Alpha evidence cannot approve paid, public, beta, release-candidate, or GA claims.
- Accepted evidence cannot create extra follow-up execution issues; missing evidence must create a
  targeted follow-up and block milestone completion.

## M2 Private Beta Evidence Gate

HOBO-464 accepts private beta legal/privacy evidence only when the beta record stays narrower than
public launch or paid GA approval. The executable proof lives in
[`src/draft/exp-proofs/cx/legal-privacy-private-beta-evidence-contract`](../../src/draft/exp-proofs/cx/legal-privacy-private-beta-evidence-contract/README.md)
and branch evidence is summarized in
[`proofs/hobo-464-legal-privacy-private-beta`](./proofs/hobo-464-legal-privacy-private-beta/README.md).

Required M2 evidence:

- M0 checklist baseline remains accepted from
  [`legal-privacy-terms-readiness-contract`](../../src/draft/exp-proofs/cx/legal-privacy-terms-readiness-contract/README.md).
- Privacy notice beta review records telemetry purpose, retention posture, customer messaging, and
  beta limitations.
- Terms beta limitation records that private beta language is not public launch, paid GA, final DPA,
  or regional legal approval.
- Subprocessor/provider beta register distinguishes required, optional, mocked, unsupported, and
  unconfirmed services for beta.
- Data retention and telemetry boundaries consume the tenant data lifecycle record before customer
  data can enter beta workflows.
- Customer assurance and support handoff routes questions to named owners without inventing
  unsupported SLA or compliance promises.
- Legal risk register maps blockers, accepted risks, mitigations, launch notes, and revisit dates
  into the release cutline.

Blockers and accepted risks remain visible:

- Public paid launch remains blocked until final terms, privacy notice, DPA, and regional notice
  approval exist.
- Enterprise assurance remains limited until subprocessor/provider evidence is complete.
- Public security, privacy, compliance, provider, and paid-launch claims remain blocked unless the
  owning evidence surface accepts them.

Follow-up execution is allowed only for missing evidence. HOBO-471 owns release-candidate
legal/privacy signoff gaps, and HOBO-478 owns GA public legal/privacy signoff gaps. This gate does
not draft final legal text, implement a legal workflow, enable billing, approve support tooling, or
publish compliance claims.

## M3 Release Candidate Evidence Gate

HOBO-471 accepts release-candidate legal/privacy evidence only when the record stays narrower than
paid GA, public regional legal approval, final DPA approval, or compliance certification. The
executable proof lives in
[`src/draft/exp-proofs/cx/legal-privacy-release-candidate-evidence-contract`](../../src/draft/exp-proofs/cx/legal-privacy-release-candidate-evidence-contract/README.md)
and branch evidence is summarized in
[`proofs/hobo-471-legal-privacy-release-candidate`](./proofs/hobo-471-legal-privacy-release-candidate/README.md).

Required M3 evidence:

- M0 checklist baseline remains accepted from
  [`legal-privacy-terms-readiness-contract`](../../src/draft/exp-proofs/cx/legal-privacy-terms-readiness-contract/README.md).
- M2 private beta legal/privacy evidence remains accepted and its release-candidate/GA gaps are
  explicit.
- Privacy release-candidate review records telemetry purpose, retention posture, data-class
  boundaries, customer messaging, and beta-to-release-candidate limitations.
- Terms release-candidate limitation records that release-candidate language is not paid GA, final
  DPA, final privacy-policy, or regional legal approval.
- Subprocessor/provider release-candidate register distinguishes confirmed, optional, mocked,
  unsupported, and still-unconfirmed services.
- Data retention and telemetry release-candidate boundaries consume tenant data lifecycle evidence
  before customer data enters release-candidate workflows.
- Customer assurance and support handoff routes questions to named owners without inventing
  unsupported SLA, compliance, DPA, or provider promises.
- Legal/privacy risk register maps blockers, accepted risks, mitigations, launch notes, and revisit
  dates into the release cutline.

Blockers and accepted risks remain visible:

- Paid GA remains blocked until final terms, privacy notice, DPA, and regional notices are approved.
- Enterprise assurance remains limited until subprocessor/provider evidence is complete.
- Public security, privacy, compliance, provider, and paid-launch claims remain blocked unless the
  owning evidence surface accepts them.

Follow-up execution is allowed only for missing evidence. HOBO-478 owns GA public legal/privacy
signoff gaps. This gate does not draft final legal text, implement a legal workflow, enable billing,
approve support tooling, or publish compliance claims.

## M4 GA Handoff Evidence Gate

HOBO-478 accepts GA legal/privacy handoff evidence only when the public launch signoff remains an
evidence record rather than final legal text, billing enablement, or broad compliance claim
publication. The executable proof lives in
[`src/draft/exp-proofs/cx/legal-privacy-ga-handoff-evidence-contract`](../../src/draft/exp-proofs/cx/legal-privacy-ga-handoff-evidence-contract/README.md)
and branch evidence is summarized in
[`proofs/hobo-478-legal-privacy-ga-handoff`](./proofs/hobo-478-legal-privacy-ga-handoff/index.md).

Required M4 evidence:

- The M0 checklist baseline remains accepted from
  [`legal-privacy-terms-readiness-contract`](../../src/draft/exp-proofs/cx/legal-privacy-terms-readiness-contract/README.md).
- The private beta baseline remains accepted from
  [`legal-privacy-private-beta-evidence-contract`](../../src/draft/exp-proofs/cx/legal-privacy-private-beta-evidence-contract/README.md).
- Final public terms/privacy/DPA signoff is recorded as evidence, not drafted or approved inside
  this proof package.
- Customer-assurance, subprocessor/provider, security/privacy claim, and release cutline owners
  each have source-backed handoff evidence.
- The release cutline reflects legal, privacy, customer-assurance, security, and release-owner
  dependencies using v1-blocker-prefixed categories.
- Parent HoBo v1 Release Readiness status is updated because this gate reduces launch risk.

Blockers and accepted risks remain visible:

- Scoped v1 GA public legal/privacy signoff is recorded as accepted evidence.
- Localized notices, jurisdiction-specific expansion, and post-GA provider/subprocessor changes
  remain accepted risks rather than hidden launch blockers.
- Unsupported SOC2/GDPR/HIPAA/all-region/compliance-certified claims remain blocked unless a
  separate owner evidence surface accepts them.

Follow-up execution is allowed only for missing evidence. This M4 gate records no missing evidence
and creates no follow-up issues. It does not draft final legal text, implement a legal workflow,
enable billing, approve commercial terms, or publish unsupported compliance claims.
