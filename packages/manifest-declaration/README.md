# @hobo/manifest-declaration

The **declaration manifest**: `ResourceIntent`, the provider-neutral node a
Bindle declares before planning.

A declaration says *what* is wanted — a capability class, the features it must
have, what it binds to, where it may run — and never *who* provides it.
Provider, product, SKU and region are decided later, by matching. A declaration
that leaked any of them would make the plan unportable before the Planner ever
ran, which is why the parse boundary refuses an unrecognised field outright
rather than ignoring it.

## What is in here

| Path | What it is |
|---|---|
| `data-models/resource_intent.proto` | The wire record. Field numbers inherited verbatim from `packages/cloud/data-models/cloud.proto`. |
| `data-models/resource_intent.cue` | The constraint set — one constraint per protobuf message. |
| `src/index.ts` | `parseResourceIntent`, the parse-don't-validate boundary, plus the canonical proto3-JSON codec. |
| `contracts/` | The PACT for the boundary the shape crosses, and a README explaining it. |
| `test/` | Conformance, round trip over the existing corpus, provenance, upstream parity, and the projection evidence. |

## Two types, and why

`ResourceIntent` is the **authoring** shape: mutable, non-readonly, and
field-for-field identical to the declaration in `packages/cloud/src/plan-types.ts`.
It is deliberately not branded and not readonly, because `@hobo/cloud` builds
these with object literals and assigns to `intent.region` after construction
(`packages/cloud/src/intent.ts`), and neither a brand nor a `readonly` admits
that. Re-exporting this type from `plan-types.ts` is therefore a substitution,
not a type break.

`ParsedResourceIntent` is the **parsed derived type**: branded, deeply readonly,
frozen, and obtainable only from `parseResourceIntent`. Code that holds one
never re-checks it. `toResourceIntent` converts back for the callers that still
need a literal.

`test/upstream-parity.test.ts` reads both files from disk and compares the field
lists, so the two cannot drift. It accepts either era: the interface declared
upstream and matching, or upstream re-exporting this package.

## The one value that does not round-trip, and what was done about it

`region` is the only optional **scalar** in the record. In
`packages/cloud/data-models/cloud.proto` it is declared `string region = 7;` —
a bare proto3 scalar, which has *implicit presence*: the encoder omits any field
equal to the type default, so `{"region": ""}` and a record with no region at
all produce identical bytes and decode to the same value. The TypeScript
declaration spells it `region?: string`, and under `exactOptionalPropertyTypes`
absent and `""` are different values. The wire form cannot carry the
distinction the type makes.

`packages/cloud/data-models/cloud.cue` does not close the gap either: every
other string in `#ResourceIntent` is constrained `!=""`, which is exactly what
makes the rest of the record survive that encoding, but `region?: string` is
left open. It reads like an omission rather than a decision.

Three things were done, in order of how much they help:

1. This package declares `optional string region = 7;` — the proto3 spelling of
   explicit presence. The distinction now exists on the wire.
2. The CUE constrains `region?: string & !=""`, matching every sibling field.
3. `parseResourceIntent` refuses `region: ""` with
   `resource intent $.region: must not be empty`, and refuses a `region` key
   holding `undefined` separately, so a producer cannot mint a value whose
   meaning depends on which encoder saw it.

`test/round-trip.test.ts` measures the loss rather than asserting it: it encodes
under the implicit-presence rule and shows the empty-region and absent-region
records are the same object, then shows this package refusing the input and
round-tripping a real region.

**No existing value in the repository is affected.** No `ResourceIntent`
anywhere sets `region`. The finding is about what the schema *admits*, not about
data that is currently broken — which is the only time it is cheap to fix.

## What the round trip covers, and what it does not

`test/fixtures/existing-intents.ts` holds every `ResourceIntent` value that
exists in this repository — 22 of them, transcribed from four files with an
`anchor` back to the original text, and `test/provenance.test.ts` reads each
cited file from disk and fails if its anchor is gone. Inventing fixtures is how
a schema passes its own test and fails on real data, so the corpus is checkable
rather than asserted.

Every one round-trips: parse → canonical wire record → decode → parse, compared
with `toStrictEqual` (not `toEqual`, which treats `{ region: undefined }` and
`{}` as equal and would go green on exactly the bug this suite exists to catch),
and byte-identical on the canonical form across three passes.

Honest gaps, recorded in the suite itself rather than in prose:

- **`region` and `prefer` have never been populated anywhere.** Everything this
  package asserts about them is asserted against constructed values. The round
  trip has never seen a real one.
- **No digest is taken over a `ResourceIntent` anywhere in the repository.**
  `hashDeploymentPlan` hashes a `DeploymentPlan`, which holds `ResourcePlan`
  nodes, not intents. `canonicalResourceIntentJson` is provided and is pinned
  byte-for-byte in the suite, but nothing cross-package compares it yet.
- **`packages/cloud/src/plan-types.ts` canonicalises with its own local
  `sortKeys` that sorts with the default comparator, while `@hobo/core`'s
  exported `sortKeys` sorts with `localeCompare`.** They agree on every key in
  this shape; they need not agree on an arbitrary key. This package uses core's,
  and pins the resulting bytes.

## Where this sits in the control plane

The declaration manifest is the body of a **command**, not of an event. A `hobo
plan` command carries lowered intents into the Planner **actor**; the actor
matches each against the Registry catalog and appends `match.Decided` and
`deployment.Planned` **events** to the **event store**. The deployment
**projection** and the plan **read store** are **materialized views** folded from
those events, and a **snapshot** of the projection is what a later reader loads
instead of replaying the stream.

Nothing in this package writes to any of them. A manifest package owns a shape
and its parse boundary; it owns no state, no actor and no stream.

## Does `ResourceIntent` survive as a distinct shape?

Yes, and `test/projection-evidence.test.ts` is the evidence. The decisive field
is `placement`.

`placement.affinities` and `placement.spread` are constraints whose operand is
*another node in the same plan*. The request manifest's evaluator has no channel
through which a sibling node could be seen: `SelectionInput` in
`packages/capability-profiles/src/selection.ts` is exactly `requirement`,
`registry`, `candidates`, `policy`, `nowMs`, `consumableBindingProfiles` —
a catalog of candidates and nothing about the rest of the graph. `matchResource`
in `@hobo/cloud` takes a third argument, `PlacementContext`, holding the
placements already decided. Projecting a relational constraint onto a
per-capability requirement would mean inventing that channel, which is a change
to the request manifest rather than a projection of the declaration.

Behind `placement`: `name` is the node's graph identity and `deps` names sibling
nodes by it. A capability requirement is anonymous. `objective` has nowhere to
go either — selection states in its own header that there is *deliberately* no
weighted score, so the absence is designed rather than missing.

Measured, not argued: `ResourceIntent` shares **zero** field names with
`CapabilityRequirement`, and zero with `SelectionCandidate`. The tokens the
placement vocabulary is made of — `anti-affinity`, `targetPort`, `pickN`,
`spread`, `objective`, `deps` — appear in neither file, and the test fails if
any of them ever does.

One correction to the question as it was posed: the decomposition plan compares
`ResourceIntent` to `CapabilityRequirement`, while the schema table files
`SelectionCandidate` as the request manifest. Those are not the same thing —
`SelectionCandidate` is the *offer* side, what a product advertises
(`providerId`, `implementsProfiles`, `evidenceSignatureValid`,
`sponsorExposureMinorUnits`). The answer above holds against both.
