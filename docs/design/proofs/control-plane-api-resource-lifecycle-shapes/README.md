---
type: Reference
title: "Control-Plane API Resource Lifecycle Shapes Proof"
description: "Source issue: HOBO-569."
tags: [hobo, design]
---

# HOBO-569 Control-Plane API Resource Lifecycle Shapes

This proof records the shared control-plane API shape examples for resource
lifecycle work.

Package:
[`src/draft/exp-proofs/api/control-plane-api-resource-lifecycle-shapes`](../../../../src/draft/exp-proofs/api/control-plane-api-resource-lifecycle-shapes/README.md).

## Acceptance Map

| Acceptance | Executable proof |
|---|---|
| Request/response shapes for DeploymentPlan, Deployment Set, Delta, ResourceActor state, Gatekeeper decision, drift, run inspector, logs cursor, and migration phases. | `pins the named HOBO-569 API shape vocabulary` |
| Error/refusal envelopes for policy denied, contract incompatible, provider capability partial/none, stale projection, unknown evidence, non-reactive sink, and destructive migration blocked. | `pins fail-closed refusal envelopes for every required boundary case` |
| Deterministic protobuf/CUE/Pact fixture expectations. | `keeps Pact and CUE architecture artifacts aligned with the parsed contract shape` |
| API/MCP parity. | `proves API and MCP callers receive equivalent typed results` |
| Scope-out enforcement. | `guards scope-out requests for production implementation and live state` |

## Verification

```powershell
pnpm.cmd --prefix src\draft\exp-proofs\control-plane-api-resource-lifecycle-shapes test
```

This is an exp-proof over deterministic fixtures. It does not implement a
production API, persistence, provider adapter, live support system, or
customer-data path.
