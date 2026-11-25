---
type: Reference
title: "Marketplace UX Scope And Acceptance"
description: "Source issue: HOBO-421."
tags: [hobo, design]
---

# Marketplace UX Scope And Acceptance

Source issue: HOBO-421.

Executable proof lives in
[`src/draft/exp-proofs/ux/marketplace-ux-scope-contract`](../../src/draft/exp-proofs/ux/marketplace-ux-scope-contract/README.md).
Branch evidence is summarized in
[`proofs/hobo-421-marketplace-ux`](./proofs/hobo-421-marketplace-ux/README.md).

## M0 Acceptance Record

Marketplace UX defines the v1 marketplace presentation boundary for browse, search, listing detail,
trust warnings, installability outcomes, org-catalog visibility, accessibility evidence, and
support-safe next actions. It does not build marketplace UI, a storefront service, Registry storage,
install runtime, publisher portal, commercial marketplace policy, or support tooling.

## User And Business Goal

HoBo needs accepted M0 scope for Marketplace UX before marketplace screens, install flows, or public
launch claims can depend on it. The accepted record must tell app developers, workspace
administrators, marketplace operators, security reviewers, and support operators which listing
states exist, what evidence backs installability, what warnings must be shown, which owners consume
the result, and which adjacent initiatives remain out of scope.

## Primary Personas

| Persona | Need |
|---|---|
| App developer | Discover approved capabilities and understand whether a listing is preview-only, installable, blocked, deprecated, or yanked before acting. |
| Workspace administrator | See which marketplace entries are allowed by org catalog and policy without granting Marketplace UX authority over approvals. |
| Marketplace operator | Present listing state, trust tier, warnings, and limitation copy without overstating installability or registry guarantees. |
| Security reviewer | Confirm installability wording depends on review, provenance, conformance, and policy evidence rather than ratings or popularity. |
| Support operator | Route blocked, deprecated, yanked, and unsupported listings to customer-safe next actions and named owner lanes. |

## Scope In

- Marketplace browse, search, detail, warning, and install-intent information architecture for v1
  launch surfaces.
- Listing state vocabulary for hidden, preview-only, limited-beta, installable, policy-blocked,
  deprecated, and yanked entries.
- Customer-safe trust, review, org-catalog, security, conformance, deprecation, yank, and support
  wording requirements.
- Installability outcome matrix that names owner route, evidence source, and customer message before
  any visible install claim.
- Accessibility and usability evidence expectations for marketplace install, trust, warning, and
  review flows.
- M1-ready evidence checklist for browse taxonomy, outcome fixtures, warning copy, org-catalog
  filters, accessibility checks, support handoff, and scope boundaries.

## Scope Out And Non-Goals

- Do not build a live storefront, browse/search implementation, marketplace service, or install
  runtime.
- Do not build Registry storage, artifact signing, package hosting, resolver, or install-time
  verification.
- Do not define rating ranking, recommendation algorithms, paid placement, monetization, payouts,
  revenue share, or commercial marketplace policy.
- Do not build publisher portal UI, publisher onboarding, evidence upload, maintainer workflow, or
  submission tooling.
- Do not build policy engine enforcement, RBAC runtime, security scanner integration, conformance
  runner, or approval service implementation.
- Do not build support tooling, notification delivery, incident communication, or public launch-site
  implementation.
- Do not create downstream M1-M4 design or implementation issues before M0 scope is accepted.

## Service, UX, Security, And Support Boundaries

| Boundary | Rule |
|---|---|
| Service | Marketplace UX M0 defines information architecture, listing states, visible outcome semantics, and evidence handoffs; it does not build marketplace services, Registry storage, resolver, or install runtime. |
| UX | UX scope is accepted surface contract, copy, state, and accessibility evidence for later screens; no browse, search, detail, install, badge, or publisher workflow is implemented here. |
| Security | Security scope requires trust, provenance, conformance, review, policy, and owner evidence before visible installability claims; scanners, policy engines, RBAC, and approval runtime stay elsewhere. |
| Support | Support receives customer-safe blocked, deprecated, yanked, unsupported, and escalation wording with owner routes; queues, SLAs, notifications, and incident communications remain separate. |

## Marketplace Listing States

| State | Meaning |
|---|---|
| `not-visible` | Listing is hidden until required review, trust, catalog, or policy evidence exists. |
| `preview-only` | Listing can be shown with explicit warnings but cannot be presented as installable. |
| `limited-beta` | Listing is visible to allowed scopes with beta warnings and missing-evidence limits. |
| `installable` | Required provenance, conformance, security review, catalog, and policy evidence exists. |
| `blocked-by-policy` | Listing is blocked for this org, workspace, project, environment, or policy condition. |
| `deprecated` | Listing remains visible for migration or existing-use guidance but is not a default choice. |
| `yanked` | Listing is removed from new selection and routed to support or migration guidance. |

## Installability Outcomes

| Outcome | Customer-visible | Owner route | Evidence source | Customer message |
|---|---:|---|---|---|
| Not shown | No | Capability Review & Approval | Review queue states | Listing is not visible until required review and catalog evidence exists. |
| Preview with warning | Yes | Marketplace Publisher Trust Evidence | Launch limitations | Listing is preview-only and cannot be presented as installable. |
| Installable with evidence | Yes | Capability Review & Approval | Approval outcomes | Listing is installable only with required provenance, conformance, security review, catalog, and policy evidence. |
| Blocked by policy | Yes | Org Catalogs | Entry states | Listing is blocked for this org or workspace by catalog, policy, trust, or approval state. |
| Deprecated with guidance | Yes | Registry Distribution | Entry states | Listing remains visible only for migration guidance and existing-use explanation. |
| Yanked support route | Yes | Support Workflow | Review queue states | Listing is yanked from new selection and routed to support or migration guidance. |

## Authoritative Dependencies

- [Marketplace Publisher Trust Evidence](./marketplace-publisher-trust-evidence.md) defines
  publisher trust tiers, required evidence, warning text, and launch limitations consumed by
  marketplace presentation.
- [Capability Review & Approval](./capability-review-approval.md) defines review states, approval
  outcomes, yanking, escalation, and installability evidence.
- [Org Catalogs](./org-catalogs.md) defines approved catalog kinds, entry states, org visibility,
  policy pins, and support handoffs consumed by marketplace filters.
- [Accessibility and Usability Launch Baseline](./accessibility-usability-launch-baseline.md) names
  Marketplace UX as the owner for install, trust, warning, and review flow accessibility evidence.
- [Product Notifications and Lifecycle Communications](./product-notifications-lifecycle.md) defines
  marketplace and publisher lifecycle notification ownership and support-visible delivery evidence.
- [Launch Messaging Claims](./launch-messaging-claims.md) requires launch claims to have evidence
  owner, source, risk, and state before public publication.
- [ADR-0062](./adr/07-portability-extensibility.md#adr-0062) pins Registry distribution as signed,
  certified artifacts rather than UI-presented trust alone.
- [ADR-0074](./adr/02-identity-security.md#adr-0074) pins org governance and mandatory policy rules.

## Owning Initiative Dependencies

| Owner | Consumes from Marketplace UX | Boundary |
|---|---|---|
| Marketplace UX | Accepted browse taxonomy, visible listing states, installability wording, warning copy, evidence checklist, and follow-up gate. | This issue defines M0 scope and acceptance; it does not build marketplace screens or services. |
| Capability Review & Approval | Review state, approval outcome, yanking, escalation, and customer-warning evidence before visible installability claims. | Review queues, approval policy, and review service behavior remain Capability Review & Approval. |
| Marketplace Publisher Trust Evidence | Trust tier, publisher identity, provenance, conformance, security review, and warning evidence. | Trust evidence records and publisher review evidence remain outside Marketplace UX. |
| Org Catalogs | Approved entry state, scope, policy, version pin, and support handoff for workspace-visible marketplace filtering. | Catalog storage, approval workflow, registry handoff, and policy enforcement stay in Org Catalogs. |
| Publisher Portal | Marketplace warning and listing-state language for later publisher-facing submission and remediation flows. | Publisher onboarding, evidence upload, maintainer administration, and portal UI stay in Publisher Portal. |
| Registry Distribution | Signed artifact, certification, provenance, version, deprecation, and yank evidence consumed by marketplace presentation. | Registry storage, artifact pull/publish, signatures, resolver, and install verification remain Registry-owned. |
| Accessibility & Usability Quality | Required keyboard, focus, semantic, contrast, responsive, reduced-motion, screen-reader, state, and copy checks for marketplace surfaces. | Accessibility baseline defines evidence and severity; it does not own every Marketplace UX remediation. |
| Support Workflow | Blocked, deprecated, yanked, unsupported, and escalation messages with owner routes and customer-safe next actions. | Support queues, SLAs, ticket automation, incident communications, and notification delivery stay outside this issue. |
| V1 Release Program & Cutline | Accepted M0 scope for deciding when M1-M4 follow-up issues and public marketplace claims can be created. | Release go/no-go, cutline decisions, launch-site copy, and downstream issue creation remain release-program scope. |

## Evidence Required For M1

| Evidence | Owner | Proof mode | Proves |
|---|---|---|---|
| Browse taxonomy fixture | Marketplace operator | Reference fixture | Browse/search/detail surfaces can distinguish preview, installable, blocked, deprecated, and yanked listings. |
| Installability outcome matrix | Marketplace operator | Contract test | Visible install claims require owner route, evidence source, and customer-safe wording. |
| Trust warning copy register | Security reviewer | Launch claim review | Trust, review, rating, and launch-limit wording cannot overstate security or installability. |
| Org catalog filter fixture | Workspace administrator | Reference fixture | Workspace marketplace visibility consumes org catalog scope, policy, version, and support evidence. |
| Accessibility/usability checklist | Accessibility & Usability Quality | Accessibility review | Marketplace install, trust, warning, and review flows name required accessibility and usability checks. |
| Support handoff export | Support operator | Support handoff | Blocked, deprecated, yanked, unsupported, and lifecycle messages have owner and support-visible evidence. |
| Scope boundary register | Release owner | Design record | Live marketplace UI, install runtime, registry, monetization, publisher portal, scanner, policy, and support tooling stay out. |

HOBO-547 branch evidence for the trust-warning, installable-with-evidence,
policy-block, deprecated-guidance, yanked-support-route, and hidden-listing copy
states lives in
[`src/draft/exp-proofs/ux/vibe-marketplace-trust-copy-states`](../../src/draft/exp-proofs/ux/vibe-marketplace-trust-copy-states/README.md)
and
[`proofs/vibe-marketplace-trust-copy-states`](./proofs/vibe-marketplace-trust-copy-states/README.md).
It is a copy-state proof only; production UI, publisher portal UI, approval
services, scanners, policy engines, notification delivery, support queues, and
unsupported launch claims remain out of scope. The proof consumes accepted
HOBO-577 quickstart fixture ids before marketplace copy can describe preview,
policy-blocked, installable, deprecated, yanked, or hidden listing states.

HOBO-562 branch evidence for the deterministic marketplace discovery and
install-intent prototype lives in
[`src/draft/exp-proofs/ux/vibe-marketplace-discovery-prototype`](../../src/draft/exp-proofs/ux/vibe-marketplace-discovery-prototype/README.md)
and
[`proofs/vibe-marketplace-discovery-prototype`](./proofs/vibe-marketplace-discovery-prototype/README.md).
It composes accepted HOBO-546 mockup fixtures, HOBO-547 trust-copy fixtures, and
HOBO-577 quickstart fixture ids into preview-only, limited-beta, installable,
policy-blocked, deprecated, and yanked discovery paths. The proof is still a
deterministic prototype: live storefronts, registry/resolver behavior, install
runtime, ranking, monetization, publisher workflow, production UI, support
queues, and launch claims without evidence remain out of scope.

## Follow-Up Gate

M1/M2/M3/M4 marketplace screen, browse/search, install-intent, trust-warning, org-catalog filter,
accessibility, support, and launch-claim issues must wait until this M0 scope record is accepted.
This branch records the gate and executable guard; it does not create follow-up implementation
issues.
