---
type: Reference
title: "HOBO-506 Product Notification Taxonomy Proof"
description: "Source issue: HOBO-506."
tags: [hobo, design]
---

# HOBO-506 Product Notification Taxonomy Proof

HOBO-506 is proven by the focused M0 contract at
[`src/draft/technical-proofs/product-notification-taxonomy-contract`](../../../../src/draft/technical-proofs/product-notification-taxonomy-contract/README.md)
and the durable design record at
[`product-notifications-lifecycle.md`](../../product-notifications-lifecycle.md).

## Acceptance Evidence

- Required v1 notification classes cover workspace invites, account lifecycle, onboarding nudges,
  deployment status, billing/entitlement, marketplace/publisher, and support handoff messages.
- Every class names channel choices, owner project, copy owner, trigger source, support visibility,
  and audit visibility.
- Preference policy distinguishes transactional messages from optional messages and routes
  consent/privacy constraints to Legal/Privacy readiness.
- Delivery evidence covers mocked provider boundaries, bounce/failure handling, dedupe, retry,
  audit trail, and customer-safe templates.
- Scope-out distinguishes incident communications, status-page updates, marketing email, post-v1
  notification-center work, and live delivery-service implementation.

## Negative Coverage

- Validation rejects live email-service/provider implementation scope creep.
- Validation rejects ownerless notification classes that would scatter lifecycle communication
  responsibility across adjacent projects.
- Readiness fails closed when optional opt-out, template review, or support audit evidence is
  missing.
- Follow-up implementation remains blocked until the M0 taxonomy is accepted.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\product-notification-taxonomy-contract test
```
