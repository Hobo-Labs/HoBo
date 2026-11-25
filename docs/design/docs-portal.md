---
type: Reference
title: "Docs Portal Scope And Acceptance"
description: "Source issue: HOBO-434."
tags: [hobo, design]
---

# Docs Portal Scope And Acceptance

Source issue: HOBO-434.

Executable proof lives in
[`src/draft/exp-proofs/dx/docs-portal-scope-contract`](../../src/draft/exp-proofs/dx/docs-portal-scope-contract/README.md).
Branch evidence is summarized in
[`proofs/hobo-434-docs-portal`](./proofs/hobo-434-docs-portal/README.md).

## M0 Acceptance Record

Docs Portal exists to define accepted productization scope before downstream M1-M4 documentation
information architecture, content inventory, search metadata, release-note routing, troubleshooting,
and support handoff work can depend on it. It is not the portal UI, a CMS, a search service,
analytics, hosting, launch marketing, support tooling, or security-disclosure intake.

## User And Business Goal

HoBo needs accepted Docs Portal scope before it can claim that developers, platform engineers,
support operators, security reviewers, docs maintainers, or release owners have a trustworthy path
through customer-facing documentation. The accepted record must name the content areas, source
owners, freshness signals, proof modes, known-limitation routing, and follow-up gate before any
portal implementation or public launch claim is made.

## Primary Personas

| Persona | Need |
|---|---|
| App developer | Find a guided first path from workspace setup to a proven deploy without relying on unsupported launch claims. |
| Platform engineer | Find architecture, provider, environment, compatibility, and operational guidance tied to accepted evidence sources. |
| Support operator | Route customer questions to approved docs, known limitations, support channels, and escalation owners. |
| Security reviewer | Confirm security, disclosure, provenance, access, and support wording has an owner and proof source before publication. |
| Docs maintainer | Maintain content inventory, navigation, versioning, search metadata, and stale-content routes without owning product implementation. |
| Release owner | Block public docs claims and follow-up issue fan-out until accepted M0 scope and proof requirements exist. |

## Scope In

- Docs Portal information architecture for getting-started, API reference, architecture, operations,
  troubleshooting, release notes, known limitations, security, and support content areas.
- Audience path map for app developers, platform engineers, support operators, security reviewers,
  docs maintainers, and release owners.
- Content inventory fixture that names source record, owner, freshness signal, proof mode, and
  customer-visible status for each launch-critical page class.
- Navigation taxonomy and searchable metadata contract for future discovery work.
- Versioning, archived-doc, known-limitation, and unsupported-state rules consumed by release notes
  and support.
- Security and support handoff routes for disclosure, vulnerable dependency notices, unsupported
  install environments, account/support channels, and incident communication links.
- M1-ready evidence checklist for content inventory, audience paths, navigation taxonomy,
  versioning, search index contract, support handoffs, and scope boundary register.

## Scope Out And Non-Goals

- Do not build React implementation, docs portal UI, portal screens, design system work, frontend
  routing, or visual theme work.
- Do not build CMS, authoring workflow, content pipeline, live publishing system, static-site
  generator, hosting, CDN, or preview deployment implementation.
- Do not build search indexing service, crawler, ranking, analytics pipeline, telemetry vendor,
  personalization, or recommendation engine.
- Do not write final customer-facing copy, launch-site copy, marketing site, public website,
  pricing page, or commercial messaging approval.
- Do not build support ticket queue, helpdesk integration, support automation, incident publishing
  workflow, or status page implementation.
- Do not build identity provider, RBAC enforcement, account access, tenant-data access, or
  security-disclosure intake implementation.
- Do not make release decisions, resolve launch blockers, certify compatibility, or claim
  production readiness without owner evidence.
- Do not create downstream M1-M4 execution issues before M0 scope is accepted.

## Service, UX, Security, And Support Boundaries

| Boundary | Rule |
|---|---|
| Service | Docs Portal M0 owns accepted content inventory, source ownership, freshness expectations, versioning rules, and M1 proof requirements. It does not build hosting, CMS, search, analytics, or publishing services. |
| UX | UX scope is information architecture, navigation vocabulary, audience paths, and customer-safe limitation wording for future documentation flows, not screens, routing, components, or visual design. |
| Security | Security scope records required proof sources, vulnerability/disclosure routes, redaction boundaries, and claim ownership before public security wording appears, without implementing auth, RBAC, tenant-data access, or disclosure intake. |
| Support | Support receives approved troubleshooting, unsupported-state, limitation, channel, and escalation routes; support queues, staffing workflows, incident publishing, and ticket automation remain separate. |

## Audience Paths And Content Areas

| Content area | Primary owner | First M1 proof |
|---|---|---|
| Getting started | Tutorials & Walkthroughs | Guided first-run path fixture. |
| API reference | SDK / Developer Experience | Source-owned reference inventory and freshness signal. |
| Architecture and concepts | Developer Experience | Concept navigation map tied to accepted design records. |
| Operations and troubleshooting | Troubleshooting Guides / Support Workflow | Troubleshooting route and owner handoff fixture. |
| Release notes and upgrades | V1 Release Notes & Upgrade Guide | Version and known-limitation register. |
| Known limitations | V1 Release Program & Cutline | Limitation owner, customer wording, and release-note route. |
| Security and support | Security Verification / Support Workflow | Security disclosure and support-channel handoff route. |

## Content Inventory Requirements

Every launch-critical page class must name:

- source record or proof package;
- owning project or initiative;
- audience path;
- proof mode;
- freshness signal;
- customer-visible status; and
- support or release owner for gaps.

## Navigation And Search Contract

M1 may define a deterministic search-index contract, but it must stay a data contract: title,
slug, audience, content area, source, owner, freshness, proof mode, and limitation state. Search
ranking, crawler infrastructure, analytics, recommendations, personalization, and hosted indexing
stay out of this issue.

## Authoritative Dependencies

- [Developer Experience](./developer-experience.md#plan-07) owns docs, dashboards, CLI, status
  pages, and developer-facing operations surfaces.
- [Release Notes and Upgrade Guide](./release-notes-upgrade-guide.md) defines release, upgrade,
  known-limitation, rollback, migration, and support-contact inputs.
- [Compatibility Matrix](./compatibility-matrix.md) defines browser, device, platform, CLI
  bootstrap, and unsupported-environment evidence.
- [Launch Messaging Claims](./launch-messaging-claims.md) defines claim states, proof-mode labels,
  evidence owners, and unsupported public claim routing.
- [Support SLA Channels](./support-sla-channels.md) defines support channels, response language,
  unsupported request classes, and owner routes.
- [Launch Support Escalation](./launch-support-escalation.md) defines escalation matrix, incident
  templates, and support gap routing.
- [Security Verification](./security-verification.md) defines vulnerability disclosure and security
  launch-blocker boundaries.
- [Accessibility Usability Launch Baseline](./accessibility-usability-launch-baseline.md) defines
  usability and accessibility evidence expectations for customer-visible launch surfaces.
- [ADR-0082](./adr/02-identity-security.md#adr-0082) keeps launch claims tied to reproducible
  verification evidence.

## Owning Initiative Dependencies

| Owner | Consumes from Docs Portal | Boundary |
|---|---|---|
| Docs Portal | Accepted content areas, audience paths, source ownership, freshness policy, and follow-up gate. | This issue defines M0 scope and acceptance; it does not build the portal UI, CMS, search, analytics, hosting, or publishing pipeline. |
| Tutorials & Walkthroughs | Guided task paths and tutorial entry points that Docs Portal may organize. | Tutorial content, recordings, and hands-on walkthrough execution stay in Tutorials & Walkthroughs. |
| Troubleshooting Guides | Issue diagnosis trees, known failure modes, and operator handoff language. | Troubleshooting content creation, diagnostic automation, and repair workflows remain outside Docs Portal. |
| V1 Release Notes & Upgrade Guide | Release, upgrade, rollback, migration, known-limitation, and support-contact inputs. | Release publication, release copy approval, and upgrade path proof stay in release-note ownership. |
| Compatibility Matrix | Supported browser, device, platform, and CLI bootstrap evidence for docs support claims. | Compatibility testing, certification, and unsupported report triage remain Compatibility Matrix scope. |
| Support Workflow | Support channel, unsupported request, severity, and escalation language for support docs. | Support queues, staffing, ticket automation, and contractual SLA approval stay outside Docs Portal. |
| Security Verification | Vulnerability disclosure, security launch blocker, and assurance boundaries for security docs. | Security intake, remediation, bug bounty, and verification operations remain Security Verification scope. |
| V1 Release Program & Cutline | Accepted M0 scope for deciding when M1-M4 docs portal follow-up issues can be created. | Release go/no-go, cutline decisions, and downstream issue creation remain release-program scope. |

## Evidence Required For M1

| Evidence | Owner | Source | Proof mode | Proves |
|---|---|---|---|---|
| Content inventory fixture | Docs maintainer | Content inventory requirements | Reference fixture | Launch-critical page classes name source record, owner, freshness signal, proof mode, and customer-visible state. |
| Audience path map | App developer | Audience paths and content areas | Design record | Each primary persona has an explicit first path through portal content before IA or UI work begins. |
| Navigation taxonomy | Docs maintainer | Navigation and search contract | Design record | Navigation categories and search metadata are accepted without implementing a search service. |
| Versioning and limitation register | Release owner | Release notes and missing evidence policy | Contract test | Versioned docs, archived docs, unsupported states, and known limitations are governed before public claims ship. |
| Search index contract | Docs maintainer | Navigation and search contract | Contract test | Searchable records name title, audience, source, freshness, and proof mode without building search infrastructure. |
| Support handoff routes | Support operator | Support SLA unsupported request classes | Support handoff | Docs route unsupported requests and troubleshooting gaps to the correct support owner. |
| Scope boundary register | Release owner | Scope out and non-goals | Release gate | Portal UI, CMS, search, analytics, support automation, security intake, hosting, and follow-up scope remain blocked until M0 acceptance. |

## Follow-Up Gate

M1/M2/M3/M4 design or implementation issues must wait until this M0 scope record is accepted. This
branch records the gate and its executable guard; it does not create follow-up implementation
issues.
