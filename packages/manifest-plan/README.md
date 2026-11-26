# @hobo/manifest-plan

The **plan manifest**: `ResourcePlan`, the resolved node of the deployment DAG,
and `DeploymentPlan`, the content-addressed DAG that carries it.

Decomposed out of `@hobo/cloud`'s `src/plan-types.ts` so the shape has one
owner. The schema is the contract: `data-models/resource_plan.proto` is the wire
form, `data-models/resource_plan.cue` the constraint, and `src/index.ts` the
parse-don't-validate parsed derived types that narrow both.

```ts
import { hashDeploymentPlan, parseDeploymentPlan } from "@hobo/manifest-plan";

const plan = parseDeploymentPlan(JSON.parse(body));   // or throws, naming the field
const hash = hashDeploymentPlan(plan);                // sha256 over the canonical form
```

Untrusted input is `PlanParseInput` (JSON plus the non-JSON values this boundary
refuses), not `unknown`. Parsed `realizationParameters` are `JsonObject`
(`JsonValue` fields), not `Record<string, unknown>`.

`parseDeploymentPlan` and `parseResourcePlan` are the only way to obtain a
`DeploymentPlan` or a `ResourcePlan`: both types are branded, so a raw record
cannot be cast into one and no consumer downstream has to re-validate.
`ResourcePlanAuthoring` and `DeploymentPlanAuthoring` are the unbranded planner
construction shapes; `@hobo/cloud` re-exports them as its legacy public names.

## Where this sits in the event architecture

A plan is neither a command nor an event. The `deploy` command produces one; the
`deployment.Planned` event carries it together with its hash; the deployment
saga actor replays that event out of the event store to rebuild its state; the
deployment-view projection materializes it into a read store as a materialized
view keyed by deployment id; and an actor snapshot records the plan *hash*
rather than the plan. That last one is why the digest is worth being exact
about — a snapshot that names a hash nobody else can reproduce is not a
snapshot.

## Dependencies

`@hobo/core`, and only in `test/`. Nothing in `src/` imports a workspace
package, which is the right shape for a schema package: a manifest package that
depends on another manifest package is a design error, and one that depends on
an implementation package is worse.

`ResourcePlan` does **not** reference `ResourceIntent` (`@hobo/manifest-declaration`)
or the capability shapes (`@hobo/manifest-capability`, `@hobo/manifest-request`).
It shares four *field names* with `ResourceIntent` — `name`, `port`, `deps`,
`region` — and `DeploymentPlan.objective` mirrors `ResourceIntent.objective`,
but nothing here is typed in terms of them: a plan is the output of matching an
intent against a catalog, and it names the winner (`provider`, `productId`,
`realizationParameters`) rather than the ask (`require`, `prefer`,
`negotiation`, `placement`). No structural workaround was needed and no coupling
was traded away.

## Three places the inherited wire schema does not round-trip

Each of these is a divergence from `packages/cloud/data-models/cloud.proto` and
`cloud.cue`, adopted deliberately here, with the measurement that forced it.
They matter more than usual because a `DeploymentPlan` is content-addressed and
`packages/cloud/test/planner.test.ts` pins `golden-plan.json`'s digest as a
committed constant that three suites compare against.

### 1. Optional scalars have no field presence on the wire

`cloud.proto` spells `strategy`, `region`, `deployment_id` and `product_id` as
bare proto3 singular strings. Proto3 singulars have no presence: an absent
`region` and `region: ""` are the same wire value. They are not the same plan
value, and they do not hash the same. Materializing the absent optionals of
`multi-cloud-shop-plan.json` as `""` — exactly what a decoder must do — moves
the plan hash:

```
sha256:6012432813829d6ffc013426b9792365f85ad2260c14c3f22276625a597f3421   before
sha256:f6a09e775c201c927668009b57d278e859899c6f9eceac894d1a775a72f03029   after
```

**Field:** `ResourcePlan.strategy`, `.region`, `.deploymentId`, `.productId`.
**Fixture:** `packages/cloud/test/fixtures/multi-cloud-shop-plan.json`, all five
nodes. **What is lost:** the distinction between "not decided here" and
"decided to be empty" — which for `productId` is load-bearing, because absent
means a driver must fail closed rather than infer a product from the port
(ADR-0144). This package's `.proto` marks every optional scalar `optional`, and
the parse boundary refuses a key that is present holding `undefined` or `null`
rather than normalizing it into absence.

The same problem hits `nonPortableRows`: proto3 `repeated` has no presence
either, so absent and empty collapse. `data-models/resource_plan.proto` wraps it
in a `NonPortableRows` message, whose message-typed field does carry presence.

### 2. `realizationParameters` cannot be `map<string, string>`

The inherited domain type was `Readonly<Record<string, unknown>>`; this package
narrows it to `JsonObject` (`PlanParameterValue` / `JsonValue` fields). Real
values carry non-strings: `packages/cloud/test/plan-binding-authority.test.ts`
asserts the planner emits `{ ttlSeconds: 3600, tier: "standard" }`. `cloud.proto` declares
`map<string, string>` and its comment names the intended encoding — "non-string
JSON values are carried as canonical JSON text". That encoding is not
injective:

```
{ ttlSeconds: 3600  }  ->  { ttlSeconds: "3600" }
{ ttlSeconds: "3600" }  ->  { ttlSeconds: "3600" }
```

Two distinct domain values, one wire value; decoding cannot recover which was
hashed. `cloud.cue` is stricter still and does not mention the convention at
all — `realizationParameters?: {[!~#CloudCredentialKeyPattern]: string}` rejects
`ttlSeconds: 3600` outright, so the constraint currently refuses a value the
planner produces.

**Field:** `ResourcePlan.realizationParameters`. **Fixture:** the value asserted
in `plan-binding-authority.test.ts`; there is no committed JSON fixture carrying
one, which is part of why the gap survived. **What is lost:** the JSON type of
every non-string parameter. This package uses `google.protobuf.Struct` in the
proto and a recursive `#PlanParameterValue` in the CUE, and `test/round-trip.test.ts`
proves the number survives byte-identically.

### 3. `@hobo/core`'s `sortKeys` is not the plan canonicalization

`@hobo/core` exports a `sortKeys` with the same name, signature and stated
intent as the one `@hobo/cloud` keeps private. They are different functions.
Core sorts with `localeCompare` (ICU collation); the plan digest is defined over
`Array.prototype.sort`'s default comparator (UTF-16 code unit order). They
disagree whenever two keys differ only in case or in where an underscore falls:

| keys | plan order | `@hobo/core` order |
|---|---|---|
| `Tier`, `tier` | `Tier`, `tier` | `tier`, `Tier` |
| `tierA`, `tier_2` | `tierA`, `tier_2` | `tier_2`, `tierA` |

The fixed field names of `ResourcePlan` collate identically under both, so the
divergence is invisible on the committed fixtures — the round-trip suite alone
does **not** catch a comparator swap. `realizationParameters` keys are
author-supplied, so those do fork. This package therefore carries cloud's
comparator rather than importing core's, and `test/canonical-form.test.ts` pins
the disagreement so "just reuse the shared helper" cannot land quietly.

## What the parse boundary refuses, and what it deliberately does not

Refused: a missing or empty `name`/`port`/`provider`; an absent `deps` (an empty
array is fine — absent and empty hash differently); an unknown field; an
optional field present holding `undefined` or `null`; a duplicate resource name;
a `schema` other than `hobo.deployment-plan/v1`; a credential-shaped
realization-parameter key, matching `CREDENTIAL_KEY_PATTERN` in
`packages/yards/src/canonical.ts` character for character; a non-finite number,
a function, a `Date` or any class instance inside `realizationParameters` —
each of those canonicalizes to something other than itself, so admitting one
would mean the parsed value and the hashed bytes disagree.

Deliberately admitted, each pinned by a test in the "what this boundary
deliberately admits" block:

- **A `dependencyOrder` that is not a topological order.** The producing planner
  appends the members of a dependency cycle alphabetically rather than rejecting
  the plan (`packages/cloud/src/planner/plan.ts`, "A cycle would leave nodes
  unordered; append any stragglers deterministically"). Refusing it here would
  reject plans the system emits today. A consumer that needs acyclicity must
  check for it.
- **A `deps` entry naming a resource outside the plan.** `plan.ts` skips unknown
  deps when computing the order (`if (!names.has(dep)) continue;`) rather than
  rejecting them.
- **An empty `deps` entry, and an empty `strategy`/`region`/`deploymentId`.**
  `cloud.cue` puts `!= ""` on `name`, `port`, `provider`, `productId` and the
  entries of `nonPortableRows`, and not on these. Tightening it is a change to
  the plan contract, not a change to this package, so it is reported rather than
  taken.

## Testing

`test/round-trip.test.ts` reads `@hobo/cloud`'s fixtures from their real
location rather than copying them, and asserts byte-identical canonical output
plus the digest constant `@hobo/cloud` already pins.
`test/conformance.test.ts` covers the refusals, each asserting the specific
error class, code and field path. `test/canonical-form.test.ts` pins the
comparator. `test/pact.test.ts` executes
`contracts/pacts/deployment-plan-digest.pact.json` — the boundary is
`deployment.Planned`, where every consumer must recompute `planHash` from the
plan body, so the pact is verified by hashing each interaction rather than by
being read.
