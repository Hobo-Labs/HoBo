---
layout: ../../layouts/Docs.astro
title: Deployment rehearsal
description: "Test deploys without a cloud: hobo plan, local lane, can-deploy compatibility, and Gatekeeper composition."
---

# Deployment rehearsal

Deploys are **plans before actions**. You can fail a gate without provisioning anything.

## Three speeds

| Speed | Command / API | Needs cloud? |
|---|---|---|
| **Plan only** | `hobo plan` | No |
| **Local lane** | `hobo up` / `hobo dev` against local Camp | No |
| **Gatekeeper** | `hobo verify` / Gatekeeper | No |

### `hobo plan`

Pure rehearsal: resolution, cost, policy verdicts. A blocked gate is a **no-op** on infrastructure — the plan output *is* the test result.

### Local lane

Full plan → gate → provision → deploy against the default local Camp. CI can run a complete deployment every commit without provider credentials.

### can-deploy + Gatekeeper

- **can-deploy** builds a compatibility matrix of candidate contracts vs deployed state.
- **Gatekeeper** composes: contracts · policy pack · obligations · cost/quota · optional secretless-config / can-migrate dimensions.
- Every evaluation records **`policy.Decided` even on allow** so “why did this pass?” is replayable.
- Decision payloads can include **effect summaries** when contracts declare EffectSpec / ResilienceProfile.

## What to assert in tests

- Breaking field removal → `compat` reasons with machine codes.
- Effect widening (when effects declared) → `effect-widened`.
- Policy deny → Gatekeeper `deny`; never treated as a transient retry class.
- Obligation pending → `require-approval`.
- Quota exceeded → `deny`.

## Suggested package tests

```bash
run the package tests
```

## Next

- [Reference: contracts](/HoBo/reference/contracts/)
- [Bridge modes](/HoBo/testing/bridge-modes/)
