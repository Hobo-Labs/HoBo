---
layout: ../../layouts/Docs.astro
title: HoBo for Platform Engineers
description: "Platform engineers write Camps, Yards, and Junctions — the typed, versioned map of where apps may live and how those places are run."
---

# HoBo for Platform Engineers

**You write [Camps](/HoBo/primitives/camps/), [Yards](/HoBo/primitives/yards/), and [Junctions](/HoBo/primitives/junctions/).** Developers describe apps; you build the map those apps roam: which providers are approved, what a production environment looks like, how a provider's camps are governed together, and how clouds federate.

## Your artifacts

```ts
// Camps: environment shapes only — no bindle ownership, no provider pick
import { camp } from "hobo/camps";

export const prodEast = camp("prod-east", {
  envType: "prod",
  prefer: ["low-latency"],
  runtimeRequirements: ["runtime-local"],
  labels: { region: "us-east-1" },
});

export const staging = camp("staging", { envType: "staging" });
```

```ts
// Yard: provider selection lives here
import { yard } from "hobo/yards";
import { prodEast, staging } from "./camps";

export const awsYard = yard("aws-east", {
  provider: "aws",
  regions: ["us-east-1"],
  camps: [prodEast, staging],
});

// Junction: yards federated across clouds — peer to peer, no shared state
import { junction } from "hobo/junctions";
export default junction("acme", { yards: [awsYard, azureYard] });
```

## What you own

- **The approved-provider set.** Camp inference and Matching draw only from providers you've approved — the Dispatcher optimizes for price *inside your fence*.
- **Golden-path camps.** Env templates for prod/staging/preview with requirements and labels already decided.
- **Yard-level governance.** Provider pin, promotion rules between camps, shared identity, provider-global networking, drift posture (`hobo drift`), reconciliation cadence.
- **Junction federation.** Which clouds peer, what connectivity is inferred, and which [policy packs](/HoBo/roles/devsecops/) apply at each border. You also hold the broker-admin switch: leave camp inference on, or lock placement down to explicit, approved camps.
- **The self-hosting decision.** The Yard control plane is itself a bindle — run HoBo's control plane with the same tooling app teams use.

## Your loop

```sh
hobo plan --camp prod-east   # dry-run any change before it lands
hobo verify                  # preflight the unified gate decision
hobo drift                   # report drift; route governed remediation
hobo up --camp prod-east     # converge when gates pass
```

## Related

[Camps](/HoBo/primitives/camps/) · [Yards](/HoBo/primitives/yards/) · [Junctions](/HoBo/primitives/junctions/) · [Trail map](/HoBo/guide/status/) · [CLI](/HoBo/guide/cli/)
