---
layout: ../../layouts/Docs.astro
title: Trails
description: "App-owned continuous migration recipes: steps, can-trail, dual fixtures, identity.continuous composition, and CLI observe."
---

# Trails

**Trails** are app-owned, versioned continuous migration recipes (Trails package). They compose platform capabilities — schema duals, junction rebinds, progressive cutover, `identity.continuous` — without forcing Trail authoring for pure identity continuous.

## Step kinds (conceptual)

| Kind | Role |
|---|---|
| Schema/data dual | Open dual window; cut over when safe |
| Junction rebind | Peer routing change |
| Progressive | Compose Harness weights/flags |
| `identity.continuous` | Dual-path principal continuity |
| Custom recipe | PlatformRecipe catalog entries |

## Gates

- **can-trail** — readiness/evidence before run
- **Gatekeeper** — still admits infra mutations
- **Golden oracles** — pin expected plan/run verdicts in tests

## CLI

```text
hobo trails status|plan|inspect
```

Observe and plan; do not invent parallel progressive/ETL planes.

## Rules

1. Pure identity continuous still requires **zero** Trail authoring when Matching/policy drives dual-path continuity.
2. Trails do not replace can-deploy.
3. History and run state are facts — replayable.
4. Progressive delivery prefers existing Harness.

## Related

[Continuous migration](/HoBo/cicd/migration/) · [Harness](/HoBo/reference/harness/) · [Identity](/HoBo/security/identity/) · [Migration fixtures](/HoBo/testing/migration/)
