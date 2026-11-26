---
layout: ../../layouts/Docs.astro
title: Camps
description: "A Camp is an environment shape — where an app may live. Provider selection belongs on the Yard; Bindles stay provider-agnostic."
---

# Camps

> *A camp is where you stay, not who you are. Good campsites are worth appreciating — and leaving, when the rent goes up.*

The **Camp** is HoBo's second foundational primitive: the answer to *what kind of home is this?* — environment type, requirements, and preferences — **not** which cloud account or which Bindle owns the slot.

Every running app occupies a camp, but **writing one is optional**: leave it out and HoBo infers a camp from policy and approved providers. You write one to pin environment semantics yourself, or because placement is locked down to explicit camps.

## What a camp is (and is not)

| Camps **do** | Camps **do not** |
|---|---|
| Name an environment (`prod`, `staging`, `pr-123`, …) | Own a Bindle |
| Carry `envType`, labels, require/prefer constraints | Select a cloud provider |
| Declare runtime **requirements** (substrate needs) | Embed long-lived credentials |
| Attach under a [Yard](/HoBo/primitives/yards/) | Mix providers in one camp |

**Provider selection belongs on the Yard.** **Bindles stay provider-agnostic** and are placed by deployment request — not nested inside `camp(...)`.

## Authoring

```ts
import { camp } from "hobo/camps";

// Environment shape only — no bindle, no provider.
export const prod = camp("prod", {
  envType: "prod",
  require: ["durable-storage"],
  prefer: ["low-latency"],
  runtimeRequirements: ["runtime-local"],
  labels: { tier: "gold" },
});

export const staging = camp("staging", {
  envType: "staging",
});
```

Attach camps when you author a yard:

```ts
import { yard } from "hobo/yards";
import { prod, staging } from "./camps";

export default yard("aws-east", {
  provider: "aws",
  regions: ["us-east-1"],
  camps: [prod, staging],
});
```

Then converge with the CLI:

```sh
hobo plan --camp prod   # dry run: placement, cost, warnings
hobo up --camp prod     # converge
```

> **Day-one path:** you often never write a camp file. `hobo up` / `hobo dev` against the default **local lane** infers a local camp and durable SQLite journal with no cloud account. Explicit camps matter when you pin multi-env topology or platform policy requires them.

## Rules camps enforce

- **One home at a time.** Mixing providers in one camp is invalid — that's what [Yards](/HoBo/primitives/yards/) (one provider) and [Junctions](/HoBo/primitives/junctions/) (many providers) are for.
- **Runtime is a requirement, not a vendor SDK.** Camps declare substrate needs (`runtimeRequirements`); engines that satisfy them plug in behind Camp ports (EventStore, Queue, ActorHost, Clock). The **local runtime** ships today; alternate engines (Postgres-backed, Temporal, Restate, …) are on the roadmap.
- **Environment comes from the name.** `prod`, `staging`, `preview`/`pr-*`, and `dev` get sensible `envType` inference; override when your naming is more creative.
- **Rejected at parse:** `bindle`, `defaultProvider`, `tiers`, and `bindings` on `camp(...)` — those belonged to an older model. Prefer Yard provider + Bindle deploy.

## Writing a camp is optional

- **Inferred camps (the default).** With no camp declared, the Dispatcher infers one from configured code and approved providers, optimizing for price under policy.
- **Locked-down placement.** A junction broker admin can require explicit, approved camps.
- **Local camp.** `hobo dev` runs your bindle against the local runtime — offline on your laptop, with honest fidelity labels where local behavior differs from cloud.

## Camps and continuous migration

**The camp is your app's current address, not its identity.** Because the bindle is provider-agnostic and every camp exposes the same runtime contract, the Dispatcher can propose a cheaper camp at any time — and the move is the same plan → gate → converge loop as `hobo up`.

## Where camps go next

- Provider scope and multi-region: [Yards](/HoBo/primitives/yards/).
- Multi-cloud federation: [Junctions](/HoBo/primitives/junctions/).
- Bindle authoring: [Bindles](/HoBo/primitives/bindles/).
- Trail map: [Status](/HoBo/guide/status/).
