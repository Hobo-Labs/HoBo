---
type: Reference
title: "HOBO-501 Bootstrap Launch Smoke Matrix Proof"
description: "Source issue: HOBO-501."
tags: [hobo, design]
---

# HOBO-501 Bootstrap Launch Smoke Matrix Proof

This proof package demonstrates that HOBO-501 records accepted M1 launch smoke evidence for SaaS,
self-host, and local/dev Bootstrap Installer paths before production installer implementation can
fan out.

## Evidence

- Design record:
  [`docs/design/bootstrap-installer.md`](../../bootstrap-installer.md)
- Executable contract:
  [`src/draft/exp-proofs/dx/bootstrap-launch-smoke-matrix-contract`](../../../../src/draft/exp-proofs/dx/bootstrap-launch-smoke-matrix-contract/README.md)
- Traceability row:
  [`docs/design/traceability.md`](../../traceability.md)

## Focused Check

```powershell
pnpm --filter @hobo/bootstrap-launch-smoke-matrix-contract test
```

The check proves the HOBO-501 acceptance bullets and scope boundaries:

- SaaS, self-host, and local/dev bootstrap paths cover preflight, auth seed, first project, first
  deploy, failure recovery, and cleanup/uninstall boundary stages;
- each path names required fixtures, mocked boundaries, unsupported states, first project shape, and
  first deploy shape;
- self-host evidence preserves seed Yard, Identity handoff, zero-egress, and no ambient cloud-key
  constraints from ADR-0092 and ADR-0036;
- results feed release notes, troubleshooting, and support handoff inputs;
- scope guards reject production installer scripts, live cloud provisioning, production auth,
  customer environment scans, secret persistence, real deploy execution, and uninstall cleanup
  implementation.
