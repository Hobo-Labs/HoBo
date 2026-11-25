---
layout: ../../layouts/Docs.astro
title: Yards
description: "The Yard is the provider selection point: one provider, zero or more Camps, shared policy and control-plane scope."
---

# Yards

> *The rail yard is where a line's traffic gets sorted. One company's yard, one company's rules.*

The **Yard** is where **provider selection** lives. It composes **one provider** with zero or more [Camps](/HoBo/primitives/camps/) and carries what is shared across those camps: policy defaults, identity scope, reconciliation, and provider-global networking. It is also, not coincidentally, where HoBo's control-plane scope shows up for that provider.

**Day one? You may not need this page.** A Bindle plus the default local lane is enough — [Getting started](/HoBo/guide/getting-started/). Come back when you pin a real provider or multi-region topology.

## Building a yard

```ts
import { camp } from "hobo/camps";
import { yard } from "hobo/yards";

const prod = camp("prod", { envType: "prod" });
const staging = camp("staging", { envType: "staging" });

// Provider is required on the Yard — never on the Camp.
export default yard("aws-east", {
  provider: "aws",
  regions: ["us-east-1"],
  camps: [prod, staging],
});
```

That's the authoring shape: a name, a **provider**, optional regions/labels/requirements, and member camps (may be empty for a requested shape before live camps exist).

## Rules yards enforce

- **One provider, strictly.** A yard cannot mix providers. Multi-region within a provider = several camps under one yard. Multi-cloud = several yards under a [Junction](/HoBo/primitives/junctions/).
- **Provider is required.** Camps do not carry `defaultProvider`; the yard is the only direct selection point.
- **Camps are shapes, not Bindle owners.** Attach env camps; place Bindles via deploy/converge, not by nesting `bindle:` inside `camp(...)`.
- **Provider-native properties are refs only** — no credentials in yard properties.

## When to reach for a yard

- **Pin a provider** for prod/staging fleets.
- **Multi-region:** `prod-east` and `prod-west` camps behind one policy scope.
- **Environment fleets:** prod, staging, and ephemeral `pr-*` camps that share identity and promotion rules.
- **Governance:** one place to enforce conformant provider builds across camps.
- **Self-host control:** run a local/bare-metal yard (`hobo yard …`) when you own the control plane substrate.

## The yard is itself a bindle

HoBo's control plane ships *as a bindle*. Self-hosting is converging that bindle into a yard you operate — same tooling app teams use. No enterprise-edition fork, no second product.

## Where yards go next

- Crossing clouds: [Junctions](/HoBo/primitives/junctions/).
- Environment shapes: [Camps](/HoBo/primitives/camps/).
- Machinery: [Architecture](/HoBo/architecture/).
