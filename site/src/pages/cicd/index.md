---
layout: ../../layouts/Docs.astro
title: CI/CD & continuous delivery
description: "Continuous migration, progressive delivery, generation, and delivery gates — the same plan→gate→converge loop."
---

# CI/CD & continuous delivery

Placement and delivery are **standing decisions**. Deploy, migrate, and progressive rollout share one gated path.

## CI and CD

| Half | Question | Where |
|---|---|---|
| **CI** | Where do build and test jobs run, and what do they cost? | [HoBo CI](/HoBo/ci/) |
| **CD** | How does a change reach its home, and move when a better one opens? | This section |

Both are placed the same way: ranked by the Dispatcher, admitted by policy.

## In this section

| Page | Topic |
|---|---|
| [Continuous migration](/HoBo/cicd/migration/) | Dispatcher re-placement; dual windows; Trails |
| [Progressive delivery](/HoBo/cicd/progressive-delivery/) | Harness flags, experiments, gateway weights |
| [Generation pipeline](/HoBo/cicd/generation/) | Governed AI generation under conformance |
| [GitOps operator](/HoBo/operations/gitops/) | Promote only when can-deploy is green |
| [Deployment rehearsal](/HoBo/testing/deployment/) | Offline plan / local lane / Gatekeeper tests |

## Related

[HoBo CI](/HoBo/ci/) · [Control plane](/HoBo/architecture/control-plane/) · [Trails](/HoBo/primitives/trails/) · [Harness reference](/HoBo/reference/harness/) · [Operations](/HoBo/operations/)
