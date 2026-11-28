# @hobo/bindles

Minimal v1 closure-builder surface for explicit Bindle authoring. Assembly creates
provider-agnostic manifest objects only — no runtime semantics (ADR-0072).

Manifest scope `policy` metadata survives parsing and canonical serialization. Budget
limits and contract-effect/resilience references therefore participate in the manifest
hash; removing or changing them changes the deployment input. Malformed policy objects
are rejected. Financial enforcement belongs to the hosting planner and shared authority
([budgeted hosting transitions](../../docs/design/hosting-budget-transitions.md)).

Use `b.project()` for an infrastructure project that owns or groups other
resources. It is a deployment dependency, not an HTTP entrypoint; use `b.web()`
or `b.api()` for the application that serves requests.

Ordinary HTTP handlers infer an HTTP capability without requiring a particular
execution host. Container and Wasm-component dependencies infer their actual
runtime requirements, including both when they occur together. An explicit
runtime declaration is retained alongside those inferred dependencies. To
require Wasm for an ordinary handler, declare `runtimes: ["wasm"]` explicitly;
older inferred Bindles labeled all HTTP handlers as requiring Wasm. A saved
definition retains that older requirement until it is regenerated and reviewed.

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
`featureSpecsToStoreInputs` returns flag-store inputs and omits `targeting`
when a feature does not define it.

## Continuity: HA/DR, replication and migration policy

A stateful resource (`data`, `kv`, `bucket`, `queue`, `topic`, `secret`)
declares how much a failure may lose and how HoBo keeps it moving, with the
`continuity` trait:

```ts
const journal = b.data().with(continuity({ tier: "standard" }));
const cache = b.kv().with(continuity({ tier: "rebuildable" }));
```

| tier          | loses at most | fails over after | standbys | backups    |
| ------------- | ------------- | ---------------- | -------- | ---------- |
| `rebuildable` | everything    | 1 min            | 0        | none       |
| `standard`    | 5 min         | 1 min            | 1        | daily, 7   |
| `critical`    | 30 s          | 15 s             | 2        | hourly, 48 |

Any field can be overridden: `recoveryPointMs`, `failoverAfterMs`, `standbys`,
`migration` (`continuous` keeps moving the data to the cheapest configured
backend that still meets the policy; `on-failure` moves only when the writer
fails), `backupEveryMs`/`backupsKept`, and `monthlyBudgetMicros`. A policy
that cannot keep its promise is refused (`restore` with no standby and no
backup; a recovery point under a second with standbys). The trait names no
provider; `continuityFleetPlan` in `@hobo/backend-routing` turns it into the
fleet's policy, the standbys placement asks for and the copy cadence. Schema:
`data-models/bindles.{proto,cue}` `ContinuityPolicy`.

## Cadence: when a schedule runs

A schedule declares its cadence with the `cadence` trait, a five-field cron
expression; what it runs is its one dependency (a queue gets a message, a
service is invoked):

```ts
const repair = b.schedule().dependsOn(queue).with(cadence("*/15 * * * *"));
```

The planner carries it on the intent (`ResourceIntent.cadence`) to the plan
node's realization parameters (`{ cron, target }`), where the provider runs it:
a Cloudflare Cron Trigger on the Worker, or the `schedules` entry a Vercel
deployment's `vercel.json` declares for a queue. `cadenceViolations` reports a
cadence on anything but a schedule, or a schedule that does not run exactly one
resource.

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
