# `@hobo/manifest-capability`

The **capability manifest**: what a workload asks for, and the catalog of
semantic profiles it asks in terms of.

Decomposed out of `@hobo/capability-profiles`, which keeps the registry and the
selection algorithm and re-exports these shapes so no consumer changes.

Nothing here names a provider, a product, a region, or an account.
`postgres.database({ version: ">=16" })` is a semantic ask, not a Neon pin —
and `parseCapabilityRequirement` refuses a requirement whose keys say otherwise.

## What is in it

| | |
|---|---|
| `data-models/capability_requirement.{proto,cue}` | `CapabilityRequirement` — the ask |
| `data-models/capability_profile.{proto,cue}` | `CapabilityProfileDescriptor` and the catalog envelope |
| `src/requirement.ts` | `parseCapabilityRequirement` — parse, don't validate |
| `src/descriptor.ts` | `parseCapabilityProfile` — same, for a descriptor |
| `src/ids.ts` | `parseProfileId` and the branded `ProfileId` |
| `src/standard-profiles.ts` | `STANDARD_CAPABILITY_PROFILES`, the first-party catalog |
| `src/wire.ts` | the executable mapping between the schema and the TypeScript |
| `contracts/` | the PACT inventory (this package owns a shape, not an endpoint) |

The only workspace dependency is `@hobo/core`. A manifest package that depends
on another manifest package is a design error.

## The schema is the contract, and it is executed

A `.proto` nobody encodes against is documentation that rots. `src/wire.ts` is
the mapping the tests actually drive:

- `test/schema-correspondence.test.ts` reads both `.proto` and both `.cue`
  files *as text* and checks every message's field names against the keys the
  encoder emits, and every CUE `?:` marker against what a minimal encoding
  actually omits. The TypeScript side is derived by encoding real values, never
  listed by hand.
- `test/round-trip.test.ts` drives fixtures that **already exist in this repo**
  through the codec. Inventing fixtures is how a schema passes its own test
  while failing on real data.
- `test/conformance.test.ts` asserts each refusal by the message fragment
  unique to its branch. A matcher that a neighbouring refusal also satisfies is
  worthless.

`fromCapabilityRequirementWire` deliberately **does not** call
`parseCapabilityRequirement`. If it re-parsed, every default the parse boundary
applies would be re-derived on the way back, and a wire form that had dropped a
field entirely would still round-trip green. The round trip has to be able to
fail.

## Presence is the load-bearing part of this schema

`tsconfig.base.json` sets `exactOptionalPropertyTypes`, so **an optional field
and a field that may be `undefined` are different things**. Proto3 erases that
distinction unless you ask for presence explicitly. Two rules follow:

- optional *scalars* carry `optional`;
- optional *repeated* fields are wrapped in `StringList`, because a bare
  `repeated` cannot tell an absent list from an empty one.

The second rule is not hygiene. Every descriptor in the first-party catalog
omits `enumValues` — no profile declares an `enum` valueKind. The registry
digest is computed with `JSON.stringify`, which omits an `undefined` property
and emits `[]` for an empty array. So a bare `repeated string enum_values`
would decode all sixty descriptors' absent `enumValues` as `[]` and move the
digest:

```
with StringList (correct)  sha256:4ad6cb0f734c95599f3863736d8da56eae97f43534e257af11f9ed7beb1480ca
with bare repeated         sha256:f9bc1245949ca12f026dda5677f16168f36903cf3349bfe3e89a09aada87a636
```

The first value is what twelve committed golden offers under
`packages/recipes/test/golden/` carry as `profileRegistryDigest`, and it is
what `test/round-trip.test.ts` asserts — after a full trip through the wire.
The second is measured, not argued: a test pins it, so deleting the wrapper
fails something that explains itself rather than producing sixty mysterious
mismatches.

## A shape that does not survive byte-identically, and why that is correct

`parseCapabilityRequirement`'s doc comment says the returned requirement is
"canonically ordered so equivalent authoring order produces byte-identical
decisions". **That is true of array order and false of key order.** `features`
and `guarantees` are shallow-copied and sorted, so the element objects are the
caller's own objects, with the caller's key order:

```js
parseCapabilityRequirement({ features: [{ key, operator, value, necessity }] })
// -> [{"key":…,"operator":…,"value":…,"necessity":…}]

parseCapabilityRequirement({ features: [{ value, necessity, key, operator }] })
// -> [{"value":…,"necessity":…,"key":…,"operator":…}]   same requirement, different bytes
```

A requirement authored in the second spelling therefore does **not** round-trip
byte-identically: the wire form normalizes it to declaration order. That is the
right outcome — the wire is *more* canonical than the parse boundary, not less —
so the schema was not widened to preserve the anomaly. `test/round-trip.test.ts`
pins both halves, the defect and the repair, so neither regresses unnoticed.

The blast radius today is latent: digests that matter are computed through
`canonicalize()` in `@hobo/trust`, which sorts keys, and no production code
digests a `CapabilityRequirement` with raw `JSON.stringify`. It is a trap for
whoever adds the first one.

## Numbers

JavaScript has one number type; protobuf does not. `RequirementValue` splits
them: values satisfying `Number.isSafeInteger` travel as `int_value` (a decimal
string, per the proto3 JSON mapping), the rest as `double_value`. An `int_value`
outside exact integer range is **refused on decode** rather than silently
rounded — a threshold that changes on the way through a parser is worse than an
error. Non-finite numbers are refused on encode: JSON has no spelling for them,
and a NaN threshold is not a requirement anyone meant to write.

## Parse, don't validate

Every constrained value in this package is a **derived type**: the constraint is
discharged once, at a boundary, and the result is a type the rest of the system
cannot construct any other way.

| Boundary | Raw input | Derived type |
|---|---|---|
| `parseProfileId` | `string` | `ProfileId` — a branded type whose `unique symbol` is module-private, so it is unforgeable outside this package |
| `parseCapabilityRequirement` | `CapabilityRequirementInput` | `CapabilityRequirement` — defaults applied, lists canonically ordered, contradictions already refused |
| `parseCapabilityProfile` | `CapabilityProfileDescriptor` | `ParsedCapabilityProfile` — refinement targets parsed, evidence checked |
| `fromCapabilityRequirementWire` | `unknown` | `CapabilityRequirement` — reconstructed from the wire without re-parsing |

The point of the derived types is that downstream code never re-checks. Nothing
takes a `string` where a `ProfileId` is meant, so there is no "did someone
validate this yet?" question to get wrong. `CapabilityRequirement`'s
`realization` is a total `Readonly<Record<RealizationKind, boolean>>` and its
`portability` is `Required<PortabilityRequirementInput>` — an unset realization
kind or an unapplied portability default is *unrepresentable*, not merely
unlikely.

Validation returns a boolean and throws the knowledge away. These parse and keep
it.

## Event architecture: this package deliberately has none

Stated explicitly rather than left silent, because "no events here" and "nobody
thought about events here" look identical from outside.

A capability requirement is a **value**, not a fact. It is an input to a
decision — the ask a Bindle makes — and it is immutable, self-describing, and
has no lifecycle. Nothing in this package therefore handles a command, emits an
event, hosts an actor, writes to an event store, maintains a materialized view
or projection, takes a snapshot, or serves a read store. There is no state to
have any of those about, and inventing a `capability.RequirementParsed` event
would put a record in the log that no consumer could act on and no reader could
distinguish from a duplicate.

Where each of those responsibilities actually lives:

- **Command / event.** The decision this shape feeds produces `binding.Resolved`
  and `binding.Unavailable` in `@hobo/bindings` (ADR-0157). That is where a
  capability ask becomes a fact worth recording — because that is where a choice
  was made, and a choice is the only thing an event log is for.
- **Actor and event store.** `@hobo/storage-sqlite` and the runtime packages own
  the durable EventStore behind ports, one partition and one writer, with
  stream-head CAS and fencing (ADR-0135). This package has no writer and no
  stream.
- **Materialized view / projection / read store.** `@hobo/cloud`'s planner
  projects resolutions into plans; the catalog side of that read model is
  `@hobo/capability-profiles`'s registry, which is rebuilt in memory from the
  descriptors this package publishes rather than being read out of a store.
- **Snapshot.** The closest thing here is the profile registry digest
  (`sha256:34d2dba5…`), which is a content digest a consumer pins — a snapshot of
  *identity*, not of accumulated state. It is recomputed from the catalog every
  time and is never restored from.

If this package ever grows a mutable catalog — profiles registered at runtime
rather than compiled in — that changes, and the registration would become the
command and the event. It has not, and the digest test is what would notice.
