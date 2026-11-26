# Admin Support Break-Glass Boundaries POC

HOBO-495 proof for admin and support break-glass access boundaries.

## What This Proves

- Break-glass policy names support, security, incident, and customer-admin roles.
- Access classes cover tenant data, support debugging, billing adjustments, policy override review,
  and incident response.
- Every access class carries an owner, approval path, audit event set, TTL, customer-notification
  posture, and revocation rule.
- Default posture is deny-by-default and least-privilege.
- Unsupported emergency actions are explicit: static accounts, self-approval, provider credential
  access, silent policy bypass, unbounded live-data mutation, indefinite sessions, and tooling
  implementation.
- Session evaluation refuses missing approval, self-approval, TTL excess, missing audit evidence,
  missing customer-notification decision, and unsupported actions.

## Boundary

This package validates the M0 boundary contract. It does not build break-glass tooling, Admin
Console UI, support ticketing, billing engines, incident automation, production admin roles, static
credentials, provider access, or live customer-data mutation.

## Verification

```powershell
pnpm.cmd --prefix src\draft\exp-proofs\admin-support-breakglass-boundaries test
```

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` - protobuf data shapes and CUE constraints for the boundary record.
- `architecture/pacts/` - PACT contract for the package boundary.
- `ADR.md` - parse-don't-validate and event-architecture evidence.
