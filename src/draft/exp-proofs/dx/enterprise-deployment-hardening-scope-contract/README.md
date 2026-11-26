# Enterprise Deployment Hardening Scope Contract

HOBO-453 defines the M0 scope boundary for Enterprise Deployment Hardening. The
package is an executable contract that records the accepted personas, deployment
postures, boundaries, handoffs, M1 evidence, and follow-up gate before any
enterprise implementation issue can fan out.

## What This Proves

- Managed SaaS, self-hosted Yard, sovereign or air-gapped, and local-dev
  simulation postures are named with owners and promise boundaries.
- Service, UX, security, and support ownership boundaries are explicit.
- Bootstrap, upgrade, backup, tenant-isolation, admin-console, support,
  security-verification, and customer-assurance dependencies are linked.
- M1-M4 enterprise hardening work remains blocked until HOBO-453 M0 acceptance
  is recorded.
- Customer-facing enterprise readiness claims fail closed unless they name proof
  source and owner route.

## Focused Gate

```powershell
pnpm.cmd --prefix src\draft\exp-proofs\enterprise-deployment-hardening-scope-contract test
```

## Scope Boundary

This package does not build the installer, hosted control plane, live self-host
rollout, RBAC/SSO/SCIM, tenant isolation, backup/restore, support queues, SLA,
billing, legal approval, compliance certification, or enterprise sales workflow.
