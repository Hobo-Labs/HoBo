# HOBO-332 Preview Ephemeral Environments Proof

This proof maps the preview-environment design requirements to executable
vectors in
[`src/draft/technical-proofs/preview-ephemeral-environments-contract`](../../../../src/draft/technical-proofs/preview-ephemeral-environments-contract/).

## Requirements Covered

- [`platform-engineering.md#plan-25`](../../platform-engineering.md#plan-25):
  preview environments are per-PR ephemeral Camps with isolated event streams,
  `preview: { envType: "ephemeral", ttl: "72h" }`, and auto-TTL teardown.
- [`developer-experience.md#plan-07`](../../developer-experience.md#plan-07):
  `hobo env clone` seeds a preview from a baseline Camp/Set.
- [`reliability-observability-cost.md#plan-05`](../../reliability-observability-cost.md#plan-05):
  cost-sensitive Matching consumes `envType: "ephemeral"` variants for preview
  resources.

## Scope Boundary

The draft package does not implement Matching scores, Resource Definitions,
provider drivers, CI trigger wiring, or rollout strategies. It accepts resource
variant candidates and proves that the Harness preview lifecycle consumes only
the `ephemeral` variant, emits preview-stream events, and exposes the lifecycle
state transitions that later runtime slices can bind to provider operations.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\preview-ephemeral-environments-contract test
```

The acceptance tests prove PR-open creation, live URL assignment, baseline clone
copying, TTL teardown, hard-ceiling escalation, baseline projection isolation,
and deterministic PR reopen behavior.
