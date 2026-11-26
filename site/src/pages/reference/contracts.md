---
layout: ../../layouts/Docs.astro
title: Contracts & Gatekeeper
description: "BoundaryContract IR, checkCompatibility, can-deploy, and Gatekeeper composition with machine-readable reasons."
---

# Contracts & Gatekeeper

## BoundaryContract (Contract IR)

Versioned producer/consumer boundary:

- `id`, `version` (semver), `mode` (`declared` \| `inferred` \| `observed` \| `promoted`)
- `edge` — kind, producer, consumer, channel, operation
- `requiredShape` — format + required/provided fields
- `contractHash` — content address (`sha256:…`)
- optional **`effects`** — [EffectSpec](/HoBo/reference/effects/)
- optional **`resilience`** — [ResilienceProfile](/HoBo/reference/effects/)

Contracts are parse-don’t-validate: invalid shapes never become live values past the boundary.

## Compatibility

Compatibility checks compare previous vs next revisions:

| Change | Result |
|---|---|
| Added provided fields | Compatible |
| Removed required/provided field consumers need | Breaking (`required-field-removed`) |
| Channel change / version regress | Breaking |
| Effect widening when effects declared | Breaking (`effect-widened`) |

## can-deploy

Given deployed contract state + candidate deployment plan → compatibility matrix + gate pass/fail events with agent-actionable reasons.

## Gatekeeper

Composes into one decision (`allow` \| `allow-degraded` \| `deny` \| `require-approval`):

1. can-deploy (contracts)
2. policy pack — **always** emits `policy.Decided`
3. obligations
4. cost/quota
5. optional secretless-config / can-migrate dimensions

Also surfaces effect summaries and optional reasons with `gate: "effects" | "resilience"`.

## Describe / export

CLI and MCP can describe a contract as human text or export an effect manifest for policy and SRE tooling.

## Testing

See [Testing: contracts](/HoBo/testing/contracts/) for harness usage.

## Related

[Testing: contracts](/HoBo/testing/contracts/) · [Testing: deployment](/HoBo/testing/deployment/)
