# @hobo/junctions

Production home of `junction()`, the federation primitive that connects
[Yards](../yards) across clouds. A junction takes member Yards — just the
members — and derives the cross-cloud connectivity plane from what their
manifests declare: a peering tier per member pair, a federated DNS plan, and
the federation records (fleet trust records, signed policy packs, signed
registry bundles) that ride the same member mechanism. Each yard realizes its
own half.

**Trust is the fleet's trust record.** Federation between Yards is an exchange
of HoBo Fleet trust records (ADR-0182): each `TrustAnchorExchange` carries the
issuing Yard's witnessed `TrustRecord` envelope (`null` until that Yard has
published one; pass them as `deriveConnectivityPlan(definition, { trust })`).
The receiving Yard pins it with `acceptFederatedTrust(exchange, pinned)`, which
applies the fleet's own rule (`acceptTrust`): both signatures on first sight,
then only a record that follows the pinned one. There is no second trust format.
See [`ADR.md`](./ADR.md).

## Honest scope

This is a **local derivation engine**. Implemented: parsing member Yards into a
frozen `JunctionDefinition`, tier selection over declared manifests
(`private-network` / `cross-region` / `private-interconnect` / `overlay-mesh` /
`public-mtls`), DNS-plan derivation, per-yard plan extraction
(`planForYard`), and trust/policy/registry federation records. Not here: no
live cloud calls, no peering realization, no DNS mutation, no key exchange —
realization is each yard's job, and the realization machinery is still ahead
on the trail map.

## Usage

```ts
import { junction, deriveConnectivityPlan, planForYard } from "@hobo/junctions";

import awsYard from "./yards/aws";
import azureYard from "./yards/azure";

const app = junction("my-app", { yards: [awsYard, azureYard] });
const plan = deriveConnectivityPlan(app);
const awsHalf = planForYard(plan, awsYard.name);
```

Tier selection never widens beyond what both member manifests declare: same
provider and region gives `private-network`, same provider across regions gives
`cross-region`, different providers give `overlay-mesh` (or
`private-interconnect` when both sides declare it), and anything undeclared
falls back to `public-mtls`.

## Commands

```bash
pnpm --filter @hobo/junctions run build
pnpm --filter @hobo/junctions run typecheck
pnpm --filter @hobo/junctions run lint
pnpm --filter @hobo/junctions run test
```

## Parse, don't validate

Untrusted federation input crosses one parser boundary in
`junction(name, config)` and becomes deep-frozen derived types
(`JunctionDefinition`, `JunctionMemberManifest`); empty membership, duplicate
yard names, invalid junction names, and unknown capabilities are rejected with
typed `JunctionParseError`s at construction. Downstream derivations
(`deriveConnectivityPlan`, `planForYard`) accept only parsed values, never raw
config — parse, don't validate. Wire forms live in
`data-models/junction.proto` with CUE constraints alongside.

## Events

Deriving a plan is a command whose accepted result carries the
`junction.PlanDerived` event; the composed definition is the snapshot on
`topology.JunctionComposed`. See [`ADR.md`](./ADR.md) for the package's place
in the event architecture.
