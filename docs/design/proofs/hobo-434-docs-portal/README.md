---
type: Reference
title: "HOBO-434 Docs Portal M0 Scope Proof"
description: "Source issue: HOBO-434."
tags: [hobo, design]
---

# HOBO-434 Docs Portal M0 Scope Proof

HOBO-434 is proven by the focused M0 contract at
[`src/draft/exp-proofs/dx/docs-portal-scope-contract`](../../../../src/draft/exp-proofs/dx/docs-portal-scope-contract/README.md)
and the durable scope record at [docs-portal.md](../../docs-portal.md).

## Acceptance Evidence

- User/business goal names Docs Portal as a Productization M0 scope record.
- Primary personas cover app developer, platform engineer, support operator, security reviewer,
  docs maintainer, and release owner needs.
- Scope-in lists content areas, audience paths, content inventory, navigation/search metadata,
  versioning and known-limitation rules, support/security handoffs, and M1 proof assets.
- Service, UX, security, and support boundaries state which downstream initiatives consume the
  record without taking their implementation scope.
- Dependencies link Developer Experience, release notes, compatibility, launch messaging, support,
  security verification, accessibility, and ADR-0082.
- Docs portal content areas define getting-started, API reference, architecture, operations,
  release-note, known-limitation, and security/support outcomes.
- The follow-up gate blocks M1-M4 work until M0 acceptance is recorded.

## Negative Coverage

- Validation rejects Docs Portal UI, React screens, and frontend implementation scope creep.
- Validation rejects CMS, live publishing, hosting, CDN, and preview deployment scope creep.
- Validation rejects search service, crawler, ranking, analytics, personalization, and
  recommendation scope creep.
- Validation rejects support ticket automation, helpdesk integration, and incident publishing
  scope creep.
- Validation rejects identity, RBAC, tenant-data access, or security-disclosure intake scope creep.
- Validation rejects customer-facing claims without a proof source and owner route.

## Verification

```powershell
pnpm --prefix src\draft\exp-proofs\docs-portal-scope-contract test
pnpm test:schema
pnpm run check:relevant:staged
```

The staged gate also records two package-manager repairs for this Windows ARM64
worker: PNPM installs the local Windows ARM64 optional binaries, and Turbo stays
pinned to `2.8.6` because the current `2.10.1` Windows package starts with a
missing `ghostty-vt.dll` dependency before package tests can run.
