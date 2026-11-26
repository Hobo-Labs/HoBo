# @hobo/manifest-round-trip

The **cross-manifest verification package**. Four shapes were decomposed out of
two packages into four `@hobo/manifest-*` packages. Each of those proves its own
shape round-trips against its own fixtures. None of them can prove the thing
that actually matters afterwards: that the shape which moved is *the same shape*
the package it moved out of still hands to its callers, and that the packages
still compose.

That is this package's only job, and it is why nothing depends on it.

```ts
import { parseRoundTripReport } from "@hobo/manifest-round-trip";
```

## What is in here

| Path | What it is |
|---|---|
| `data-models/round_trip_report.proto` | The wire record of a decomposition report. |
| `data-models/round_trip_report.cue` | The constraint set — the closed outcome vocabulary, non-emptiness, and a non-empty check list. |
| `src/index.ts` | `parseRoundTripReport`, the parse boundary, plus the canonical form and its digest. |
| `contracts/pacts/selection-candidate-codec.pact.json` | The one boundary the decomposition actually cut, verified by replay. |
| `test/` | Single-owner identity, upstream parity, the cross-manifest round trip, the `ResourceIntent` question, and the boundary's refusals. |

## Why it does not depend on `@hobo/cloud`

`@hobo/cloud` is a layer-3 application package. An edge to it from here is an
`outward-dependency` and the boundary gate refuses it. So cloud's committed
fixtures and its pinned digests are read as **data** — the JSON out of
`packages/cloud/test/fixtures/`, the digest constants out of the text of cloud's
own test files.

Reading is also the stronger choice. `HELLO_BINDLE_PLAN_HASH` is transcribed
into three of cloud's test files and a fourth in `@hobo/manifest-plan`. A copied
constant cannot drift from the file it was copied from; a read one can, so
`test/round-trip.test.ts` reads all four and fails if they ever disagree. No
other test in the repository compares them.

## The four checks

### 1. One declaration per shape, checked by identity

`test/single-owner.test.ts` compares the runtime bindings
`@hobo/capability-profiles` re-exports against `@hobo/manifest-capability`'s
originals with `toBe`, not `toEqual`. Thirteen of them.

Two copies of a *structural* type are merely untidy. Two copies of these are
not:

- `ProfileId` is branded with a module-local `unique symbol`. Two declarations
  produce two different types, and a `ProfileId` parsed by one is not assignable
  to the other — a compile error at some unrelated call site months later, in a
  message that names neither package.
- `ProfileIdError`, `CapabilityProfileError` and `CapabilityRequirementError`
  are classes. Two declarations make `instanceof` false across the seam, and
  that failure is **silent**: a `catch` testing for the wrong copy falls through
  to the rethrow rather than to the handler. `toEqual` on two copies of the same
  class passes, so only identity catches it.

The four files that held the second copy —
`capability-profiles/src/{ids,descriptor,requirement,standard-profiles}.ts` —
were deleted rather than kept in sync, and the suite asserts they are gone.

### 2. Upstream parity, and one divergence that is recorded rather than papered over

`test/upstream-parity.test.ts`.

`ResourceIntent` and the placement vocabulary moved into
`@hobo/manifest-declaration`, and `packages/cloud/src/plan-types.ts` re-exports
them. Nothing is left to drift.

`ResourcePlan` and `DeploymentPlan` did **not** move. The re-export is blocked,
and the blocker is a real divergence rather than a typing artifact:

| | `@hobo/cloud` | `@hobo/manifest-plan` |
|---|---|---|
| `ResourcePlan.deps` | `string[]` | `readonly string[]` |
| `ResourcePlan.realizationParameters` | `Readonly<Record<string, unknown>>` | `Readonly<Record<string, PlanParameterValue>>` |
| `DeploymentPlan.resources` | `ResourcePlan[]` | `readonly ResourcePlan[]` |
| `DeploymentPlan.dependencyOrder` | `string[]` | `readonly string[]` |

Three of the four are `readonly`, which a mapped type removes. The fourth is a
narrowing with a reason: a `Date`, a function or an `undefined` inside
`realizationParameters` canonicalizes to something other than itself, and a
`DeploymentPlan` is content-addressed, so admitting one means the parsed value
and the hashed bytes disagree. `@hobo/manifest-plan` refuses them;
`@hobo/cloud` types the same field `unknown`, and carries that `unknown` back
through `planner/profile-matching.ts` to `@hobo/yards`' `BindingRow.properties`
— whose sibling authoring surface in `yards/src/yard.ts` already says
`JsonValue`, so `binding.ts` is the outlier and not the standard.

Closing it is a three-file narrowing across two packages. Until then the two
declarations are held in parity here: field names and optionality must match
exactly, and the list of type-text differences must be *exactly* those four, so
a fifth one appearing is a failure rather than something a reviewer has to
notice. The suite also pins the blocker itself, so the day someone narrows
`binding.ts` this suite fails and the failure is the instruction to finish the
re-export.

### 3. The cross-manifest round trip

`test/round-trip.test.ts`, three seams no single package can check:

- **The plan digest.** All four transcriptions of `HELLO_BINDLE_PLAN_HASH` are
  read out of source and must agree, and `@hobo/manifest-plan` must reproduce
  the digest from `@hobo/cloud`'s committed `golden-plan.json`, byte-identically
  against an independently written canonicalizer.
- **The declaration and the plan describe the same graph.**
  `hello-bindle.manifest.json` is lowered to `ResourceIntent`s and compared
  against `golden-plan.json`'s `ResourcePlan` nodes: same names, same ports,
  same edges as sets, and every node ordered after the nodes it depends on. The
  edges are compared as *sets* deliberately — `service` binds
  `["sessions", "assets"]` and depends on `["assets", "sessions"]`, because the
  plan is content-addressed and its ordering is load-bearing while the
  declaration's is not.
- **The candidate codec is decision-preserving.** Every candidate
  `@hobo/capability-profiles`' own selection suite exercises (35 of them, read
  out of `selection.cases.jsonl`) is put through
  `toSelectionCandidateRecord` → JSON → `fromSelectionCandidateRecord` and back
  through `selectCapabilityImplementation`, and must reach the same verdict —
  individually and as one corpus, because a codec that perturbs *ranking* rather
  than a gate only shows up when two survivors are compared against each other.

### 4. The pact

`contracts/pacts/selection-candidate-codec.pact.json` names the boundary the
decomposition actually cut: `SelectionCandidate` and its wire codec moved into
`@hobo/manifest-request`, while every gate that reads a candidate stayed in
`@hobo/capability-profiles`.

It is verified by **replay**, not by being read. Each interaction's records are
decoded and run through the gates, and the winner plus the rejection codes must
equal the recorded response. A structural comparison of keys would pass while a
widened vocabulary or a normalised absent field silently changed a verdict.

## Does `ResourceIntent` survive as a distinct shape?

**Yes.** `@hobo/manifest-declaration` reached that answer first; this package
reached it again from different sources, because agreeing with an inherited
conclusion by restating it is not checking it. `test/resource-intent.test.ts` is
the evidence, and it differs from the declaration package's in all three lines.

**1. The wire contracts, not the TypeScript.** The declaration package's
evidence reads `.ts` declarations. The schema is the contract in this repo, so
the same question is asked of the `data-models/*.proto` files. `ResourceIntent`
declares nine fields — `name`, `port`, `require`, `prefer`, `negotiation`,
`deps`, `region`, `objective`, `placement` — and shares **none** of them with
`CapabilityRequirement` or with `SelectionCandidateRecord`. The four placement
messages appear in the declaration's proto and in neither of the others.

**2. The projection, performed instead of argued about.** A grep saying a file
does not contain the token `placement` says nothing about what the code does.
So the projection is actually carried out: a real intent carrying a graph
identity, an edge, an objective and an anti-affinity rule is handed to
`parseCapabilityRequirement`, and what comes back is inspected.

All four fields are gone. **And nothing was refused.** That is the one
correction this package makes to the inherited answer: the request manifest does
not reject `name`, `deps`, `objective` or `placement`, it **silently drops**
them. A caller who projected an intent this way would get back a requirement
that looks entirely well-formed and has lost the graph. That is a worse failure
mode than a refusal, and a stronger argument for the shape surviving — a
projection that loses fields without saying so is precisely the decomposition
defect this package exists to catch.

**3. The evaluator has no operand.** `placement.affinities` and
`placement.spread` constrain a node relative to *another node in the same plan*.
`SelectionInput` is exactly `requirement`, `registry`, `candidates`, `policy`,
`nowMs`, `consumableBindingProfiles` — a catalog and nothing about the rest of
the graph — while `@hobo/cloud`'s `matchResource` takes the decided placements
as a separate `PlacementContext` argument. Projecting a relational constraint
onto a per-capability requirement means inventing that channel, which is a
change to the request manifest rather than a projection of the declaration.

Behind `placement`: `name` is the node's graph identity and `deps` names sibling
nodes by it, while a capability requirement is anonymous; and `objective` has
nowhere to go, because selection states in its own header that there is
*deliberately* no weighted score — a designed absence, not a missing field.

**What would reopen this.** If `SelectionInput` grew a field carrying decided
placements, or `CapabilityRequirement` grew a `name`, the tests above fail by
construction rather than by review. That is the point of reading both sides off
disk.

### One correction to the question as posed

The decomposition plan compares `ResourceIntent` to `CapabilityRequirement`,
while its schema table files `SelectionCandidate` as the request manifest. Those
are not the same thing: `SelectionCandidate` is the *offer* side — what a
product advertises (`providerId`, `implementsProfiles`,
`evidenceSignatureValid`, `sponsorExposureMinorUnits`) — and
`CapabilityRequirement` is the ask. The answer above is checked against both, so
it holds whichever one was meant.

## Where this sits in the event architecture

Nowhere, and that is worth stating rather than eliding. A decomposition check is
not a command and produces no event: no actor handles it, nothing is appended to
the event store, no projection folds it into a materialized view or a read
store, and no snapshot records it. It runs in CI, over source text and committed
fixtures, and its output is a report a human reads. A verification package that
started writing to a stream would be a verification package that can change what
it verifies.

## Parse, don't validate

`RoundTripReport` is the parsed derived domain type this package produces, and
`parseRoundTripReport` is the only way to obtain one — it is branded, so a raw
record cannot be cast into a report and no reader re-validates. The boundary
refuses an unknown field on either the report or a check, an empty string
anywhere, an outcome outside the closed set, an empty check list (a report with
no checks proves nothing), and two checks naming the same shape (one of them is
stale and there is no way to tell which). Every refusal names the dotted path of
the offending field, and `test/report.test.ts` asserts the class, the code and
the path rather than that something threw.

## Dependencies

The four manifest packages, and `@hobo/capability-profiles` as a
**devDependency** — the selection gates are what the codec has to keep
agreeing with, and they are only needed in `test/`.

Registered in `KNOWN_PACKAGE_PATHS` and deliberately not depended on by
anything. Classifying a verification package as something others may import
invites exactly the inward edge it exists to check.
