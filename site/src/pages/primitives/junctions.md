---
layout: ../../layouts/Docs.astro
title: Junctions
description: "The Junction is HoBo's most advanced primitive: cross-cloud federation of Yards — peer to peer, no shared mutable state, connectivity inferred from member manifests."
---

# Junctions

> *Junctions are where lines cross. Nobody owns a junction — that's the point.*

The **Junction** is HoBo's most advanced primitive: the federation layer that connects [Yards](/HoBo/primitives/yards/) **across clouds** for hybrid and multi-cloud operation. Yards remain peers — there is no super-controller and **no shared mutable state**. The final edge of HoBo's scope model is federation, not containment.

**This is graduate-level wandering.** Most apps live happily in one camp for a long time; many never need a second yard. If you're just arriving, start with [Getting started](/HoBo/guide/getting-started/).

> **Early-stage:** Junction authoring now ships the authoring and inference surface — `junction()`, connectivity-tier selection, the federated DNS plan, per-yard plan extraction, and the trust/policy/registry federation records. It's a local derivation engine: each yard still realizes its own half, and the realization machinery lands with the multi-cloud stage (see [the trail map](/HoBo/guide/status/)).

## Wiring a junction

```ts
import { junction } from "hobo/junctions";

import awsYard from "./yards/aws";
import azureYard from "./yards/azure";

export default junction("my-app", { yards: [awsYard, azureYard] });
```

Just the members — connectivity is inferred. The junction reads the member yards' manifests and derives the cross-cloud connectivity plane (peering/tiering plus DNS), and **each yard realizes its own half**. Trust federation, signed policy packs, and signed registry bundles ride the same mechanism.

## Rules junctions enforce

- **Peer yards only.** A junction adds yards; it does not reach into them. Each yard keeps its own event log, its own control plane, its own blast radius.
- **No shared mutable state.** What crosses a junction is signed, versioned artifacts — policy packs, registry bundles, trust roots — not live coordination.
- **Policy at the border.** Data-residency, sovereignty, and egress rules attach at the junction scope: what may cross which border is an explicit, auditable decision.
- **The broker admin holds the keys.** Junction governance is also where camp inference can be switched off: a junction broker admin can require explicit, approved [camps](/HoBo/primitives/camps/), so placement stays a deliberate act instead of an inferred one. The lockdown is enforced by [the Conductor](/HoBo/primitives/stations/#the-conductor), and no narrower policy can switch inference back on.

## When to reach for a junction

- **Hybrid:** a cloud yard federated with the yard running on your own metal.
- **Multi-cloud by policy:** EU data in an EU yard, everything else wherever it's cheapest.
- **Credit surfing:** when your app's cheapest home this quarter is on the cloud that just handed you startup credits — and next quarter it isn't.
- **Exit insurance:** the practical difference between "we could leave AWS" and "we have left AWS twice this year, briefly, and nobody noticed."

## Junctions and continuous migration

A junction is where the guiding principle gets its full range. Within one camp, migration means rebalancing resources; within a yard, moving between regions; **across a junction, the Dispatcher weighs whole clouds against each other** — price, credits, egress, residency, reliability — and proposes policy-gated moves across the border. The same plan → gate → converge loop as everything else. The map got bigger; the walking stayed the same.

## Where junctions go next

- The vocabulary in one sitting: [Core concepts](/HoBo/guide/concepts/).
- The machinery that plans cross-cloud moves: [Architecture](/HoBo/architecture/).
