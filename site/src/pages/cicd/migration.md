---
layout: ../../layouts/Docs.astro
title: Continuous migration
description: "Placement as a standing decision: Dispatcher, dual windows, Trails, identity.continuous, and the same plan→gate→converge path as deploy."
---

# Continuous migration

HoBo’s differentiator: placement is a **standing decision**, not a historical one. When a cheaper or better-policy home opens, the platform plans the move, gates it, and converges — without a rewrite or a weekend war room.

## Same path as deploy

| Step | Deploy (`hobo up`) | Continuous migrate |
|---|---|---|
| Plan | DeploymentPlan DAG | Same |
| Gate | Gatekeeper | Same (+ can-migrate / can-trail as needed) |
| Converge | ResourceActors | Same |
| Observe | Events + inspect | Same |

There is **no** separate migration engine with different trust properties.

## What triggers re-placement

- Price / credit / free-tier ranking updates (as **ranking input**, dated sources)
- Policy or residency changes
- Reliability / SLO signals
- Explicit human or Crew proposal
- Trail recipe readiness

Dispatcher owns continuous re-entry; FinOps Crew **advises**.

## Dual windows

Schema/data duals, identity dual-path, and traffic duals (Harness weights) let you run old and new in parallel until cutover gates pass. Fail closed on integrity — never “best effort drop events.”

## Trails

App-owned recipes compose platform steps (schema dual, junction rebind, `identity.continuous`, progressive cutover). Pure identity continuous still requires **zero** Trail authoring. See [Trails](/HoBo/primitives/trails/).

## What migration is not

- Not downtime-required by default (progressive + dual)
- Not a free pass around can-deploy
- Not silent rebinding of external customer domains without policy
- Not account-hopping within a provider to reset free tiers

## Testing

[Migration fixtures](/HoBo/testing/migration/) · [Dual fixtures](/HoBo/testing/dual-fixtures/) · [Deployment rehearsal](/HoBo/testing/deployment/)

## Related

[Progressive delivery](/HoBo/cicd/progressive-delivery/) · [Control plane](/HoBo/architecture/control-plane/) · [Matching](/HoBo/reference/matching/)
