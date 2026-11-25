# Product Notification Taxonomy Contract

HOBO-506 defines the v1 product lifecycle notification taxonomy, preference boundaries, and delivery
evidence strategy. It proves launch ownership and supportability without implementing an email
service, notification center, live provider integration, or marketing automation.

## What This Proves

- Required v1 notification classes cover workspace invites, account lifecycle, onboarding nudges,
  deployment status, billing/entitlement, marketplace/publisher, and support handoff messages.
- Every class names channel choices, owner project, copy owner, trigger source, support visibility,
  and audit visibility.
- Preference policy separates transactional messages from optional nudges and routes consent,
  privacy, retention, and regional questions to Legal/Privacy readiness.
- Delivery evidence covers mocked provider boundaries, bounce/failure handling, dedupe, bounded
  retry, audit trail, and customer-safe templates.
- Scope guards keep incident communications, status-page updates, marketing email, post-v1
  notification-center work, and live delivery-service implementation out of this issue.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\product-notification-taxonomy-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Product Notification Taxonomy Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
