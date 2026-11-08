# @hobo/bindles

Minimal v1 closure-builder surface for explicit Bindle authoring. Assembly creates
provider-agnostic manifest objects only — no runtime semantics (ADR-0072).

Manifest scope `policy` metadata survives parsing and canonical serialization. Budget
limits and contract-effect/resilience references therefore participate in the manifest
hash; removing or changing them changes the deployment input. Malformed policy objects
are rejected. Financial enforcement belongs to the hosting planner and shared authority
([budgeted hosting transitions](../../docs/design/hosting-budget-transitions.md)).

The canonical shared budget language is `policy.budgetPolicy` with discriminator
`hobo.budget-policy/v1`. Parsing uses `@hobo/core`'s typed policy contract and
rejects unknown controls, unsupported objectives/currencies, malformed funding
windows and per-resource placement of this shared scope policy. The complete
declaration survives serialization and participates in the manifest hash.

## Features · experiments · rollouts (Harness IfC)

```ts
import {
  features,
  declareExperiment,
  rollout,
  sessionReplay,
  APP_KIT_KINDS,
} from "@hobo/bindles";

// App Kits (api/web/service/ui/websocket/job/wasm-component) — not "membrane types".
// Session Replay (ADR-0137): every App Kit is annotated for local capture by default.
// Opt out: b.api(handler).with(sessionReplay({ enabled: false }))
void sessionReplay;
void APP_KIT_KINDS;

export const appFeatures = features({
  "new-checkout-flow": {
    state: "ENABLED",
    percentage: 10,
    variants: { control: false, treatment: true },
    defaultVariant: "control",
    killSwitch: false,
  },
});

export const checkoutExp = declareExperiment("checkout-exp", {
  flag: "new-checkout-flow",
  variants: ["control", "treatment"],
  metrics: ["conversion"],
});

export const canary = rollout({
  name: "checkout-canary",
  flag: "new-checkout-flow",
  stages: [{ percent: 5 }, { percent: 25 }, { percent: 100 }],
  traffic: "gateway-weighted",
  autoRollback: true,
});
```

Runtime evaluation and progressive composition live in `@hobo/identity`
(`FeatureFlagStore`, `createHarness`) — see [ADR-0044](../../docs/design/adr/02-identity-security.md#adr-0044)
and [ADR-0083](../../docs/design/adr/02-identity-security.md#adr-0083).

## Parse, don't validate

`bindle()` returns frozen `BindleManifest` derived types. Invalid dependency handles are
unrepresentable past the builder seam.

Nameless Bindles compile as `app`. Provider pins fail with the exported stable error code and
remediation text because provider selection belongs on a Yard.

`pnpm --filter @hobo/bindles run test:schema` vets manifest fixtures with `HOBO_CUE_BIN`,
the root `.tools/cue/v0.14.0/` cache populated by `pnpm run test:schema`, or `cue` on `PATH`.

## Event architecture

Bindle collection is modeled as a command that emits manifest snapshot events for downstream
lowering actors. Projections materialize resource descriptors and `dependsOn` relationships;
snapshots land in the read store for SDK slices — actors emit events and never mutate read models
in place.

## HTTP entrypoint typing

Component entrypoint factories may return a framework-neutral
`(Request) => Response | Promise<Response>` handler or an object with that
`fetch` signature, alongside the existing JSON/handler-object forms. This
matches what local component hosts accept; no framework types enter Bindles.
The `hello-bindle` Hono example and `multi-cloud-shop` function-handler example
are checked with their own `typecheck` scripts as well as runtime tests.
This adjusts the TypeScript behavior surface, not the manifest Protobuf/CUE
records; the existing SDK-lowering PACT tests remain the manifest boundary.
Declared component constructors accept ordinary class instances; entrypoint result typing remains unchanged.
