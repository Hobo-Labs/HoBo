# @hobo/camps

Production home of `camp()`, `providerSelection()`, resolution-precedence
descriptors (`resolutionPrecedenceFor`), and offline `resolveLocalBindings` for
local Camp development. A Camp is **provider-neutral until attached to a Yard**;
the **Yard owns provider selection**, and the Camp **infers** provider from that
Yard (or from Yard placement policy). Camps do not own Bindles and do not select
cloud providers. Camps can move between Yards via Trails. See [`ADR.md`](./ADR.md)
and the [yard-first-placement ADR](../../docs/design/adr/yard-first-placement.md).

Give a Camp a `logicalId` to identify it across independently declared Yard
placements. Its `id` identifies the current placement, and the Yard determines
its provider. Attaching an existing Camp to a new Yard retains its logical ID
and its authored configuration while deriving the new Yard's provider:

```ts
import { camp } from "@hobo/camps";
import { yard } from "@hobo/yards";

const production = camp("production", { logicalId: "checkout/production" });
const east = yard("east", { provider: "aws", camps: [production] });
const west = yard("west", { provider: "gcp", camps: [production] });
// Both placements have logicalId "checkout/production".
```

Declare only the current placement in a CD topology. A live move additionally
uses a Trail to transfer state and cut over; changing the declaration alone
does not transfer data or retire the former provider's resources.

**API residual:** `defaultProvider` / `tiers` / `bindings` on `camp()` are
**rejected at parse** (`Camp must not select a cloud provider`).
`providerSelection(...)` is a descriptor helper for within-provider mapping /
tests — not a Yard substitute. Deprecated type fields document migration only
([design residual note](../../docs/design/devx-devenv-nix.md#design--code-residual-hobocamps)).

## Honest scope

Implemented: parsing/normalizing camp configs into frozen `Camp` and
`ProviderSelection` values, precedence tables (`ResolutionPrecedenceRecord`),
canonical manifest hashing (`canonicalManifestHash`, sorted-key sha256), and
`resolveLocalBindings`, which substitutes lazy `${resource.property}` tokens in
a `WiringManifest`'s env through a caller-supplied `BindingResolverPort` — and
refuses any camp whose **derived/inferred** provider is not `local`. Not here: no
deployment, no cloud provider calls, no binding resolver implementation of its own.

## Commands

```bash
pnpm --filter @hobo/camps run build
pnpm --filter @hobo/camps run typecheck
pnpm --filter @hobo/camps run lint
pnpm --filter @hobo/camps run test
```

## Parse, don't validate

Untrusted provider-mapping input crosses the `providerSelection(...)` and
`camp(...)` parser boundaries and becomes deep-frozen derived types
(`ProviderSelection`, `Camp`, `ResolutionPrecedenceRecord`); ids and env names
are normalized once at construction, resolution failures throw
`BindingResolutionError`, and downstream functions accept parsed `Camp` values,
never raw DTOs — parse, don't validate. Wire forms live in
`data-models/topology_camp.proto` with CUE constraints alongside.

## Position in the event architecture

This package hosts no actor and appends nothing to an event store itself — a
`Camp` is an immutable value object. In the platform model it is the snapshot
carried on the `topology.CampComposed` event: composing a camp is the command,
the composition actor and event store live upstream in the deployment stream,
a camp-registry projection folds composed camps into the read model, and
`resolveLocalBindings` is a read-side consumer of that mapping for local dev.
