# `@hobo/yards`

Authoring topology for **Yard** — the provider-scoped control surface that holds
Camps, policy, placement intent, and **capability binding rows** in the
Bindle ⊂ Camp ⊂ **Yard** ⊂ Junction model
([ADR-0026](../../docs/design/adr/01-architecture-core.md#adr-0026)).

This package is **thin by design**: topology objects and shape export, not the
full hosted control plane. Runtime composition lives in `@hobo/cloud` / `@hobo/hobo`
and examples such as [`self-host-yard`](../../examples/self-host-yard/README.md).

## API

```ts
import {
	yard,
	yardToShape,
	parseYardBindings,
	seedLocalhostYard,
	TOPOLOGY_CONTRACT_VERSION,
} from "@hobo/yards";

const y = yard("aws-prod", {
	provider: "aws",
	bindings: [
		{ profile: "data.relational/v1", productId: "aws:rds-postgres" },
		{ profile: "web.static/v1", productId: "aws:s3-website" },
	],
});

const shape = yardToShape(y); // shape.bindings is the canonical row set
```

### Exported surface

| Symbol | Kind | What it is |
|---|---|---|
| `TOPOLOGY_CONTRACT_VERSION` | const | Pins the authoring contract of a `Yard` record |
| `yard(name, config)` | parse | The Yard parse boundary; returns a frozen `Yard` |
| `yardToShape(yard)` | projection | Planning-shape record, including `bindings`, for consumers that must not import this package |
| `Yard` / `YardConfig` | type | Parsed Yard and its authoring input |
| `YARD_BINDING_CONTRACT` | const | `"hobo.yard-binding/v1"` |
| `YARD_BINDING_PROFILE_PATTERN` | const | Capability-profile id grammar (ADR-0151) |
| `parseYardBindings(rows, options?)` | parse | Row-set parse boundary; canonicalizes and refuses |
| `YardBindingError` / `YardBindingErrorCode` | error | Typed refusal carrying `code` and the offending `profile` |
| `YardBinding` / `YardBindingInput` | type | Parsed row and its authoring input |
| `defineYard(name, config)` | compile | Slot-keyed authoring; compiles slots to rows and returns a `Yard` via `yard()` |
| `slotOf(yard, profile)` | pure fn | Which capability slot a row's profile belongs to, for diagnostics |
| `YardSlots` / `DefineYardConfig` | type | Slot map and the slot-keyed authoring input |
| `YardDefineError` / `YardDefineErrorCode` | error | `SLOT_PROFILE_MISMATCH`, `SLOT_KEY_MISMATCH`, `YARD_REGION_CONFLICT` |
| `defineStation(name, config)` | compile | Station **registration** manifest (never containment — ADR-0131) |
| `STATION_MANIFEST_CONTRACT` | const | `"hobo.station-manifest/v1"` |
| `DefineStationConfig` / `StationManifest` | type | Station registration input and manifest |
| `StationDefineError` / `StationDefineErrorCode` | error | `STATION_NO_YARDS`, `STATION_DUPLICATE_YARD` |
| `LOCALHOST_YARD_NAME` / `LOCALHOST_PROVIDER_ID` | const | `"yard:local"` / `"local"` |
| `seedLocalhostYard(observations)` | pure fn | Builds the localhost Yard seed from host capability observations |
| `LocalhostCapabilityObservation` / `LocalhostYardSeed` | type | Seed input and output |
| `SeedProvenance` / `SeedFidelity` | type | How a seed row arose, and how faithful it is |
| `HOBO_YARDS_PACKAGE` | const | Package id string |

## Yard binding rows (ADR-0157)

A Bindle names a capability profile and says nothing about how it is satisfied.
The **Yard** is the binding authority: its rows say which of the provider's
offerings are admissible for a profile here.

Two properties are load-bearing:

- **Rows are a set, not an ordered list.** `parseYardBindings` sorts on
  `(profile, productId ?? "", connectivityId ?? "")` and refuses duplicate
  triples. Authoring order must never reach selection, because ADR-0151 fixes
  selection as hard gates followed by lexicographic ordering — never a weighted
  score. **Rows filter candidates; they never rank them.**
- **Parse checks grammar and shape only.** It does not infer a product's
  provider from its id prefix — that would make a naming convention
  load-bearing, which ADR-0144 forbids. Whether a named product actually belongs
  to this Yard's provider is a resolution-time gate run where the product
  catalog exists (`@hobo/cloud`), not here.

Refusal codes: `YARD_BINDING_PROFILE_INVALID`, `YARD_BINDING_EMPTY_CONSTRAINT`,
`YARD_BINDING_DUPLICATE`, `YARD_BINDING_CREDENTIAL_PROPERTY`,
`YARD_BINDING_PIN_CONFLICT`. A row is never silently dropped: a dropped row is a
portability lie.

## Slot authoring — `defineYard` (rows are a compile target)

Binding rows are the planner's IR. They are the right thing to *store* and the
wrong thing to *type*: authoring one by hand means typing a capability-profile
string, a product id, and an untyped property bag — no autocomplete, no slot
vocabulary, nothing that notices when a row lands under the wrong capability.

**Before** — raw rows, all strings:

```ts
const y = yard("aws-prod", {
	provider: "aws",
	regions: ["us-east-1"],
	bindings: [
		{
			profile: "data.postgres/v1",
			productId: "aws.rds-postgres/v1",
			properties: { "aws.engineVersion": "16" },
		},
		{ profile: "bucket.s3-compatible/v1", productId: "aws.s3/v1" },
	],
});
```

**After** — slots, typed end to end. The provider package emits the
`SlotBinding` records (`@hobo/core`'s `slotBinding()` parse boundary), so the
profile string is never typed by an operator:

```ts
import { defineYard, slotOf } from "@hobo/yards";
import { postgres, s3 } from "@hobo/provider-aws";

const y = defineYard("aws-prod", {
	provider: "aws",
	region: "us-east-1", // sugar for regions: ["us-east-1"]
	data: postgres({ engineVersion: "16" }),
	bucket: s3(),
});

slotOf(y, "data.postgres/v1"); // "data"
```

Both produce the **same** `Yard`: `defineYard` compiles slots to
`YardBindingInput` rows and hands them to the existing `yard()`, so
canonicalization, credential screening, duplicate and pin-conflict refusal, and
deep freezing all still happen in one place. It adds exactly three refusals of
its own:

| Code | When |
|---|---|
| `SLOT_PROFILE_MISMATCH` | The profile's family disagrees with its slot (`bucket: data.postgres/v1`), or the family is outside the slot vocabulary. The family is the profile's first dot-segment, with the ADR-0151 aliases `secret-ref`→`secretRef` and `realtime`→`webhook`. |
| `SLOT_KEY_MISMATCH` | A binding is filed under a slot key other than the one it declares. |
| `YARD_REGION_CONFLICT` | `region` and `regions` are both authored and disagree. |

One slot may carry several bindings (`bucket: [s3(), glacier()]`); the existing
`YARD_BINDING_DUPLICATE` still catches two that collapse to the same row.
Slots are compiled in the fixed `CAPABILITY_SLOTS` order, never in object-key
order, so **authoring order cannot change the resulting Yard**.

### `defineStation` — registration, not containment

A Station is control-plane **occupancy** and is never a parent of a Yard
(ADR-0131 fixes `Bindle ⊂ Camp ⊂ Yard ⊂ Junction` as the containment axis;
Station is not on it). `defineStation(name, { yards })` therefore emits a
`StationManifest` describing what a Station's conductor **brokers** — sorted
`yardRefs` plus the Yards themselves — with `station()`'s isolation defaults
(`tenant = name`, `residency = "local"`, `airgap = false`,
`trustDomain = "<name>.hobo.local"`). The composition root hands the manifest to
`station()`; this package does not import `@hobo/stations`, so Stations stay
free of Yard coupling. An empty `yards` array (`STATION_NO_YARDS`) and a
duplicate Yard name (`STATION_DUPLICATE_YARD`) are refused — a Station brokering
nothing is an authoring mistake, not an empty default.

## The localhost seed

`seedLocalhostYard(observations)` maps the Bindle catalog primitives
(`web, api, service, data, kv, bucket, queue, topic, secretRef, webhook`) onto
the local implementations that stand in for them, and returns a **real** `Yard`
— built by the same `yard()` every authored Yard goes through.

It is pure: no filesystem, no clock, no randomness. The same observations always
produce a deep-equal seed, ordering included, and presence is a union over the
observations rather than last-write-wins so input order cannot change the
answer. A primitive whose enabling capability was not observed, or which has no
local implementation at all, lands in `unavailable` with a reason naming what to
change — never silently omitted.

## Parse, don't validate

Every authored input crosses a parse boundary here and comes back as a frozen,
canonical **derived type**; there is no "validate then use the raw input" path
and no partially-valid record.

| Boundary | Input | Derived type |
|---|---|---|
| `yard(name, config)` | `YardConfig` | `Yard` (deep-frozen; string lists deduped+sorted; credential-shaped property keys refused) |
| `parseYardBindings(rows, options?)` | `readonly YardBindingInput[] \| undefined` | `readonly YardBinding[]` (canonical set; typed `YardBindingError` with a `code` on refusal) |
| `seedLocalhostYard(observations)` | `readonly LocalhostCapabilityObservation[]` | `LocalhostYardSeed` (frozen; malformed `capability:<kind>:<slug>` ids are refused) |
| `defineYard(name, config)` | `DefineYardConfig` | `Yard` — a **compile** step, not a second parse: it checks slot/profile agreement and region coherence, then delegates every other rule to `yard()` |
| `defineStation(name, config)` | `DefineStationConfig` | `StationManifest` (frozen; sorted refs; empty or duplicate registrations refused with a `code`) |

Failures throw rather than returning a degraded value, and the negative tests
assert the error **`code`**, not the message.

## Event architecture

This package is **pure and owns no aggregate**: it holds no state, appends
nothing, and starts no process. It sits upstream of the event flow.

A `yard(...)` call is the value an authoring **command** carries. The Yard actor
in the control plane is what turns that command into the `yard.Registered`
**event**, and binding-row state rides that event — there is deliberately no
`binding.Declared` fact, because a row has no independent lifecycle. That
**actor** appends into the durable **event store**, where **projections**
(materialized views) build the topology view the **read store** serves to the
planner and the dashboard, with **snapshots** backing current Yard status.
Downstream, `@hobo/bindings` emits the `binding.Resolved` / `binding.Projected`
/ `binding.Unavailable` family when these rows are actually applied at
resolution time.

## HONEST SCOPE

- **Rows are parsed, not resolved.** `parseYardBindings` proves grammar, shape,
  credential-freedom, and pin non-conflict. It cannot tell you whether
  `aws:rds-postgres` exists, whether it belongs to your provider, or whether any
  candidate survives the row — those are resolution-time gates
  (`YARD_BINDING_PRODUCT_UNKNOWN`, `YARD_BINDING_PROVIDER_MISMATCH`,
  `YARD_BINDING_EXCLUDED_ALL`) owned by the selection path in `@hobo/cloud`.
- **The localhost seed's fidelity labels are declared, not measured.** The seed
  performs no probing: it reports the fidelity the seed table asserts for each
  local stand-in (`local:in-memory-queue` is `simulated`, a local HTTP server is
  `real`). A `real` label describes the local implementation's semantics — it is
  not a claim that any runtime executed real `.wasm` bytes.
- **The seed does not discover anything.** Capability observations are an input.
  Producing them (Station discovery) belongs to `@hobo/stations`; this package
  only decides what a given set of observations entitles `yard:local` to claim,
  and fails closed when an observation is missing.
- **`SeedProvenance` includes `"declared"`, which this seed never emits.** The
  built-in table yields `"default"` (needs nothing from the host) or
  `"discovered"` (justified by an observation); `"declared"` exists for
  operator-declared rows a future authoring path will supply.
- **`defineYard` proves slot hygiene, not deployability.** Slot/profile
  agreement says the row is filed under the capability it claims; it says
  nothing about whether the product exists, belongs to this provider, or
  survives selection — same resolution-time gates as any hand-written row.
- **`defineStation` emits a manifest, it does not run a Station.** Nothing here
  registers, brokers, or reaches `@hobo/stations`; the composition root hands
  the manifest to `station()`. `yardRefs` is registration (ADR-0131), never a
  containment claim.
- **No YardRuntime, planner, or live cloud here.** Topology authoring only — do
  not equate "`@hobo/yards` exists" with "hosted Yard product".

| Concern | Status |
|---|---|
| Topology authoring (`yard()`) | Implemented |
| Binding row parse + canonicalization | Implemented |
| Slot authoring (`defineYard`, `slotOf`) | Implemented (compiles to rows; no new parse rules) |
| Station registration manifest (`defineStation`) | Implemented (manifest only; no Station runtime) |
| Binding resolution / provider coherence | **Not** this package — `@hobo/cloud`, `@hobo/bindings` |
| Localhost seed | Implemented (pure; fidelity declared, not probed) |
| Full YardRuntime / planner / live cloud | **Not** this package — see `@hobo/cloud`, `@hobo/hobo` compose |
| Package maturity | Thin topology |

## Scripts

```sh
pnpm --filter @hobo/yards test
pnpm --filter @hobo/yards build
```

## Related

- `@hobo/camps` — Camp topology objects
- `@hobo/bindings` — capability bindings, connectivity, and the resolution event family
- `@hobo/capability-profiles` — the profile ids binding rows name
- `@hobo/junctions` — cross-Yard federation topology (thin)
- `@hobo/cloud` — control-plane runtime (private)
- `examples/self-host-yard` — disk-backed Yard composition example

## Builder authoring (`buildStation` / `buildYard` / `buildCamp`)

`builder.ts` adds a callback-and-chaining front end over `defineStation`,
`defineYard` and `camp()`, giving Station, Yard and Camp the shape `bindle()`
already has. It is **additive**: `yard()`, `camp()`, `defineYard` and
`defineStation` keep working exactly as they do now.

The three entry points are named `buildStation` / `buildYard` / `buildCamp`
here because `yard` and `camp` in this workspace already name the parse
boundaries the builders compile into. `@hobo/cloud-providers` re-exports them as
`station` / `yard` / `camp`, which is the intended authoring import — see that
package's README for the full surface and its worked example.

The load-bearing property is that this is a front end, not a second parser:
every builder terminates in the existing functions, so `SLOT_KEY_MISMATCH`,
`SLOT_PROFILE_MISMATCH`, `SLOT_BINDING_CREDENTIAL_PROPERTY`,
`YARD_BINDING_DUPLICATE`, `YARD_BINDING_EMPTY_CONSTRAINT`, `STATION_NO_YARDS`,
`STATION_DUPLICATE_YARD`, `camp-provider-selection-forbidden` and
`camp-bindle-ownership-forbidden` still fire unchanged.
`test/builder.test.ts` drives each of them through the builder and pins builder
output to the `defineYard` / `defineStation` authoring of the same topology.

Determinism is preserved the same way `defineYard` preserves it: slots compile
in `CAPABILITY_SLOTS` order (the ten slot methods are installed from that
constant, so the surface cannot drift from the vocabulary), nested Camps sort by
id before reaching `yard()`, and `defineStation` already sorts its Yards.
