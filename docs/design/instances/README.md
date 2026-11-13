---
type: Reference
title: "Design readiness instances"
description: "Directory for populated, dated instances of readiness dashboard, go/no-go, and accepted-risk records. Contracts remain in sibling design docs."
tags: [hobo, design, ship, instances]
---

# Design readiness instances

This directory holds **populated, dated snapshots** of release-readiness records. Contracts and templates stay in sibling design docs; instances fill the fields honestly (red is allowed).

| Contract | Instance role |
|---|---|
| [`v1-readiness-dashboard.md`](../v1-readiness-dashboard.md) | Dashboard field values at a review date |
| [`go-no-go-decision-record.md`](../go-no-go-decision-record.md) | Gate decision rows (`repo-public`, `developer-tooling`, beta, RC, GA) |
| [`launch-blocker-taxonomy.md`](../launch-blocker-taxonomy.md) | Accepted-risk / exception rows with owner, mitigation, revisit |
| [`launch-ship-targets.md`](../launch-ship-targets.md) / [ADR-0140](../adr/07-portability-extensibility.md#adr-0140) | Which ship target a decision applies to |

## Naming

Prefer:

```text
<kind>-<scope>-YYYY-MM-DD.md
```

Examples: `v1-readiness-dashboard-2026-07-30.md`, `go-no-go-repo-public-2026-07-30.md`.

## Rules

1. Every required field filled. Unknown or failing evidence is **red**, not blank-as-green.
2. Do not invent green CI URLs, npm publish dates, counsel-approved legal text, or secrets.
3. Name ship target (A / B / C) on every go/no-go instance.
4. Revisit dates are mandatory on accepted risks and conditional-go decisions.
5. New instances append; do not silently rewrite history without a supersession note.

## Current instances (2026-07-30)

| File | Kind | Status summary |
|---|---|---|
| [`v1-readiness-dashboard-2026-07-30.md`](./v1-readiness-dashboard-2026-07-30.md) | Dashboard | Honest red/yellow at gap review |
| [`go-no-go-repo-public-2026-07-30.md`](./go-no-go-repo-public-2026-07-30.md) | Gate `repo-public` | Conditional-go for Target A |
| [`go-no-go-developer-tooling-2026-07-30.md`](./go-no-go-developer-tooling-2026-07-30.md) | Gate `developer-tooling` | No-go / conditional until npm prep + honesty |
| [`accepted-risks-2026-07-30.md`](./accepted-risks-2026-07-30.md) | Accepted risks | Single maintainer, CI outage, synthetic wasm, in-memory default |
| [`residual-human-blockers-2026-07-30.md`](./residual-human-blockers-2026-07-30.md) | Human residual ledger | H-V1…H-T1 items agents cannot close |

