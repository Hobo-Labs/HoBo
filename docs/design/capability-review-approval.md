---
type: Reference
title: "Capability Review & Approval Scope And Acceptance"
description: "Source issue: HOBO-423."
tags: [hobo, design]
---

# Capability Review & Approval Scope And Acceptance

Source issue: HOBO-423.

Executable proof lives in
[`src/draft/exp-proofs/cx/capability-review-approval-scope`](../../src/draft/exp-proofs/cx/capability-review-approval-scope/README.md).
Branch evidence is summarized in
[`proofs/hobo-423-capability-review-approval`](./proofs/hobo-423-capability-review-approval/README.md).

## M0 Acceptance Record

Capability Review & Approval exists to define accepted productization scope before downstream M1-M4
review queue, approval policy, trust-tier, security/conformance, yanking, and escalation work can
depend on it. It is not the marketplace UI, publisher portal, storefront, install flow,
monetization system, Registry storage, scanner integration, policy engine, approval service, or
trust badge renderer.

## User And Business Goal

HoBo needs accepted M0 scope for reviewing marketplace capabilities before it can claim any
capability is limited-beta, installable, rejected, yanked, or escalated. The accepted record must
tell marketplace operators, security reviewers, platform engineers, publisher owners, support
operators, and release owners which review states exist, which evidence is required, which owners
consume the result, and which adjacent initiatives remain out of scope.

## Primary Personas

| Persona | Need |
|---|---|
| Marketplace operator | Run review intake, triage, approval, rejection, and yanking without unclear policy ownership. |
| Security reviewer | Require security and conformance evidence before any installability or curated trust claim is made. |
| Platform engineer | Know which Registry, curated catalog, policy, and capability-spec contracts downstream implementation consumes. |
| Publisher owner | Understand what evidence a publisher must supply and why identity or ratings alone do not grant installability. |
| Support operator | Trace approval, rejection, yank, and escalation decisions to customer-safe support evidence. |

## Scope In

- Canonical review queue states from submission through triage, evidence requests, approval,
  rejection, yank, and escalation.
- Approval policy matrix distinguishing limited-beta, installable, rejected, yanked, and escalated
  outcomes.
- Trust-tier evidence requirements for publisher identity, artifact provenance, conformance,
  security review, customer warning, and deprecation/yank behavior.
- Security and conformance checklist handoffs to Registry distribution, SBOM/vulnerability
  evidence, curated catalogs, org catalogs, and support.
- Rating-signal boundary that records ratings as advisory only, never as security, conformance,
  provenance, or curation proof.
- M1-ready evidence checklist for review state model, approval matrix, trust-tier fixtures,
  security/conformance checklist, yanking, escalation, and rating-signal boundaries.

## Scope Out And Non-Goals

- Do not build marketplace review UI, publisher portal UI, storefront, install-flow UX, or support
  tooling.
- Do not build monetization, paid publisher tiers, payouts, revenue sharing, or commercial
  marketplace behavior.
- Do not build live Registry storage, artifact signing, provider-backed catalog storage, or package
  hosting.
- Do not build security scanner integration, vulnerability feed integration, or conformance runner
  implementation.
- Do not build policy engine enforcement, approval service implementation, RBAC runtime, or a
  customer-facing trust badge renderer.
- Do not create downstream M1-M4 design or implementation issues before M0 scope is accepted.

## Service, UX, Security, And Support Boundaries

| Boundary | Rule |
|---|---|
| Service | Capability Review & Approval M0 defines accepted review states, approval evidence, handoffs, and ownership boundaries; it does not build the review service, Registry storage, scanner integration, or policy runtime. |
| UX | UX scope is the future information contract for review states, outcomes, and customer warnings, not marketplace screens, publisher flows, storefronts, or install UI. |
| Security | Security scope names mandatory security/conformance review evidence and fail-closed installability boundaries without implementing scanners, conformance runners, RBAC, or policy engines. |
| Support | Support receives decision lineage, rejection/yank reasons, escalation routes, and customer-safe limitation wording; support queues, SLAs, and incident workflows remain separate. |

## Review Queue States

M1 designs must account for these review states before implementation begins:

| State | Meaning |
|---|---|
| `submitted` | Publisher or internal owner has submitted capability evidence for intake. |
| `triage` | Marketplace operator is checking completeness and routing required review. |
| `evidence-required` | Required publisher, provenance, conformance, security, or support evidence is missing. |
| `approved-limited-beta` | Capability may be exposed only with explicit limited-beta warnings and missing-evidence limits. |
| `approved-installable` | Required provenance, conformance, security review, and catalog approval evidence exists. |
| `rejected` | Capability is blocked from installability claims and customer presentation. |
| `yanked` | Previously accepted capability is removed from new selection and routed to support or migration guidance. |
| `escalated` | Review requires a named owner before customer-facing claims can change. |

## Approval Outcomes

| Outcome | Customer-visible | Owner route | Customer message |
|---|---:|---|---|
| Limited beta | Yes | Capability Review & Approval | Capability is limited-beta until security, conformance, and curation evidence are complete. |
| Installable | Yes | Capability Review & Approval | Capability is installable only with required provenance, conformance, security review, and catalog approval. |
| Rejected | No | Security Verification | Rejected capability is not presented as installable. |
| Yanked | Yes | Registry Distribution | Yanked capability is removed from new selection and routed to support or migration guidance. |
| Escalated | No | Support Workflow | Escalated capability review requires a named owner before customer-facing claims change. |

## Authoritative Dependencies

- [Marketplace publisher trust evidence](./marketplace-publisher-trust-evidence.md) defines
  publisher trust tiers, review evidence, unsupported claims, and customer-visible limitations
  consumed by this M0 scope.
- [SBOM vulnerability notice evidence](./sbom-vulnerability-notice-evidence.md) defines SBOM,
  vulnerability, provenance, and notice evidence classes for marketplace/capability bundles.
- [ADR-0062](./adr/07-portability-extensibility.md#adr-0062) pins Registry distribution as signed,
  certified artifacts rather than ad hoc marketplace installability.
- [ADR-0074](./adr/02-identity-security.md#adr-0074) pins org governance and mandatory policy as
  dependencies for approval decisions without implementing policy enforcement here.
- [ADR-0075](./adr/07-portability-extensibility.md#adr-0075) defines interface stability tiers and
  capability-spec evidence consumed by review decisions.
- [Curated catalog policy contract](../../src/draft/technical-proofs/curated-catalog-policy-contract/README.md)
  defines curated catalog approval/revoke behavior consumed as downstream enforcement.
- [Trust-tier policy contract](../../src/draft/technical-proofs/trust-tier-policy-contract/README.md) defines
  minimum trust-tier can-deploy policy consumed by review outcomes without making ratings
  sufficient for safety.

## Owning Initiative Dependencies

| Owner | Consumes from Capability Review & Approval | Boundary |
|---|---|---|
| Capability Review & Approval | Accepted review states, approval outcomes, evidence checklist, and follow-up gate. | This issue defines M0 scope and acceptance; it does not build the review service. |
| Publisher Portal | Evidence requirements and rejection/yank reasons for later publisher submission flows. | Publisher onboarding, submission UI, and maintainer administration stay in Publisher Portal. |
| Marketplace UX | Customer warning, trust-tier display, and installability outcome language. | Marketplace browse/search/install UX and trust badge rendering stay in Marketplace UX. |
| Org Catalogs | Approved/yanked outcomes for deciding what org-approved catalogs may include. | Catalog inheritance, policy enforcement, and org approval workflows stay in Org Catalogs. |
| Registry Distribution | Certification, provenance, and listing lifecycle requirements from review outcomes. | Registry storage, artifact pull/publish, signatures, and version resolution remain Registry-owned. |
| Security Verification | Mandatory security/conformance evidence and escalation classes. | Scanner integration, threat review execution, and vulnerability exceptions stay in Security Verification. |
| Support Workflow | Rejection, yank, escalation, and customer-warning lineage for triage and handoff. | Support queues, SLAs, escalation workflows, and incident communications stay outside this issue. |
| V1 Release Program & Cutline | Accepted M0 record for deciding when M1-M4 follow-up issues can be created. | Release go/no-go, cutline decisions, and downstream issue creation remain release-program scope. |

## Evidence Required For M1

| Evidence | Owner | Source | Proof mode | Proves |
|---|---|---|---|---|
| Review queue state model | Marketplace operator | This document's state table | Design record | Review states and allowed transitions are explicit before service implementation begins. |
| Approval policy matrix | Marketplace operator | This document's outcome table | Reference fixture | Limited-beta, installable, rejected, yanked, and escalated outcomes map to owners and customer wording. |
| Trust-tier evidence fixture | Publisher owner | Marketplace publisher trust evidence | Contract test | Publisher identity, provenance, conformance, security review, deprecation/yank, and warnings are present. |
| Security/conformance checklist | Security reviewer | SBOM vulnerability notice evidence | Security review | Installability claims are blocked until security and conformance evidence exists. |
| Yank escalation handoff | Support operator | Curated catalog policy contract | Support handoff | Yank, revoke, and escalation outcomes have support and catalog handoff evidence. |
| Rating signal boundary | Platform engineer | Trust-tier policy contract | Design record | Ratings are advisory and cannot substitute for identity, provenance, conformance, security review, or curation. |

## Follow-Up Gate

M1/M2/M3/M4 design or implementation issues must wait until this M0 scope record is accepted. This
branch records the gate and its executable guard; it does not create follow-up implementation
issues.
