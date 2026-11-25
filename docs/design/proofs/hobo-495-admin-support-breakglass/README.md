---
type: Reference
title: "HOBO-495 Admin Support Break-Glass Boundaries Proof"
description: "Source issue: HOBO-495."
tags: [hobo, design]
---

# HOBO-495 Admin Support Break-Glass Boundaries Proof

HOBO-495 is proven by the focused M0 contract at
[`src/draft/exp-proofs/ux/admin-support-breakglass-boundaries`](../../../../src/draft/exp-proofs/ux/admin-support-breakglass-boundaries/README.md)
and the durable boundary record at
[admin-support-breakglass-boundaries.md](../../admin-support-breakglass-boundaries.md).

## Acceptance Evidence

- Break-glass policy defines support, security, incident, and customer-admin roles.
- Access classes cover tenant data inspection, support debug context, billing adjustment review,
  policy override review, and incident-response emergency access.
- Each access class names owner, approval path, audit events, TTL, customer-notification posture,
  and revocation rule.
- Default posture is deny-by-default and least-privilege.
- Unsupported emergency actions are explicit.

## Negative Coverage

- Session evaluation refuses missing approval, self-approval, TTL excess, missing audit evidence,
  missing customer-notification decision, and unsupported actions.
- Request classification routes tooling/UI implementation out of this M0 scope.
- Scope guards reject static accounts, raw provider credentials, silent policy bypass, unbounded
  live-data mutation, indefinite sessions, and live break-glass implementation.

## Verification

```powershell
pnpm.cmd --prefix src\draft\exp-proofs\admin-support-breakglass-boundaries test
```

## Maintenance Notes

- The PR branch refreshes `pnpm-lock.yaml` workspace importers after merging current `origin/main`
  so the admin break-glass proof and concurrently merged draft proof packages remain installable
  through the normal frozen-lockfile gate.
