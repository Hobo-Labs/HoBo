# @hobo/recipes

The provider topology a Bindle never names, decided before anything is
provisioned.

A Bindle says "I need an HTTP API and a Postgres database". A **solution
recipe** says which Yards exist, which provider owns each one, which product
definition answers each placement, and how the cross-Yard edges are wired. The
recipe is data; the compiler that resolves it is a pure function; the
**DeploymentOffer** it produces is what a person consents to before the first
effectful provider call.

## What is in here

- `recipe.ts` — `SolutionRecipe`: versioned (`hobo.solution-recipe/v1`), id like
  `recipe.<slug>/v1`, declaring Yards (provider, resource-only, lease), Camp and
  primitive placements, preferred product definition ids, connectivity choices
  for cross-Yard edges, and the semantics the recipe claims to deliver.
- `request.ts` — `DeploymentRequest`: the provider-neutral ask, one capability
  slot per Bindle capability. A slot that names a provider is refused at the
  parse boundary.
- `compile.ts` — `compileRecipe`, the pure resolver.
- `offer.ts` — the canonical, signable `DeploymentOffer` and its acceptance
  binding.
- `prefer.ts` — `chooseRecipe`, which picks among compatible recipes.
- `policy.ts` / `widening.ts` — what a deployment is allowed to cost, claim, and
  give up, and how a downgrade is detected.
- `standard-recipes.ts` — the twelve shipped recipes as data.

## The compiler is pure

`compileRecipe` reads no clock, network, environment, or filesystem. `nowMs`,
the catalog snapshot and its digest, the evidence snapshot, and the policy are
explicit inputs. Equivalent inputs produce byte-identical output regardless of
declaration order, registration order, object key order, or object identity —
asserted in `test/metamorphic.test.ts`, since digest stability is the whole
value of the offer.

Selection reuses `selectCapabilityImplementation` from
`@hobo/capability-profiles`. This package adds no second matcher, catalog,
planner, or claim reducer.

## Hard gates before preference

Compilation fails, with structured rejections carrying the shared codes, when a
recipe does not cover every required capability exactly once, reinterprets the
primitive a slot asked for, places a workload with no Camp, crosses a Yard
boundary with no compatible binding
(`BINDING_UNAVAILABLE`), exceeds the policy's provider, claim-action, sponsor
budget, or claim-window limits (`TOO_MANY_CLAIM_ACTIONS`,
`SPONSOR_BUDGET_EXCEEDED`, `CLAIM_MODE_INSUFFICIENT`,
`BOOTSTRAP_POLICY_DENIED`), rests on a product whose evidence is stale, failed,
or unsigned (`EVIDENCE_STALE`), or weakens a required profile
(`PROFILE_INCOMPATIBLE`, `REALIZATION_DENIED`).

Preference runs only over recipes that already passed. Fewer trustworthy
provider and claim boundaries wins: the three-provider polyglot recipe never
outranks a single-provider recipe that delivers the same semantics.

## No silent widening

Postgres to generic relational, native to pack, pack to bridge, one claim to
many, provider-native claim to sponsor migration, persistent to ephemeral,
WebSocket to polling, secret-ref to plaintext, public-anonymous to sponsored —
each is refused unless policy names it **and** the offer discloses it.
`test/widening.test.ts` asserts both halves for every kind in `WIDENING_KINDS`;
a permitted-but-hidden downgrade is the failure mode worth testing for.

## The offer

`DeploymentOffer` (`hobo.deployment-offer/v1`) carries the recipe id, topology
and resolution digests, placements, providers, the claim summary (action count,
provider count, earliest deadline, atomicity), source disclosure, credential
custody, required consents, the sponsored cost cap, guest lease summaries, trust
and conformance evidence refs, a portability summary, degradation notices,
expiry, and a signature envelope.

It carries **refs only**. `assertOfferIsSecretFree` scans the canonical bytes
and refuses a claim URL, token, connection string, or private key; the offer is
built before any provider call, so there is nothing secret to leak yet and the
guard keeps it that way.

Acceptance binds to the offer, topology, **and** catalog digests. Substituting a
provider, a product, or a recipe changes a digest and invalidates the prior
consent — a new offer must be accepted.

## Recipes shipped

Each id has a golden resolved-topology fixture and a golden offer fixture under
`test/golden/`, checked by `test/golden.test.ts` (regenerate with
`HOBO_UPDATE_GOLDEN=1`).

| Recipe | Shape |
|---|---|
| `recipe.cloudflare.claimable-webhook-inbox/v1` | one Yard, one Camp, one claim, no claim-time migration |
| `recipe.vercel-prisma.claimable-issue-tracker/v1` | sponsored Vercel Yard plus resource-only Prisma Yard |
| `recipe.cloudflare-neon.portable-sql-api/v1` | two claims, Hyperdrive with a Neon-serverless fallback |
| `recipe.cloudflare-upstash.live-leaderboard/v1` | Worker plus Redis-compatible store |
| `recipe.netlify.claimable-generated-report/v1` | static-only, one-hour deadline |
| `recipe.cloudflare.claimable-generated-report/v1` | the same provider-neutral static ask on Cloudflare Pages |
| `recipe.neon.claimable-sql-sandbox/v1` | resource-only Postgres, no workload |
| `recipe.prisma.claimable-sql-sandbox/v1` | the same ask, a different product |
| `recipe.cloudflare-neon-upstash.polyglot-saas/v1` | three providers, three disclosed claims |
| `recipe.convex.local-accountless-preview/v1` | no account, no claim, ephemeral |
| `recipe.convex.selfhosted-strong-claim/v1` | self-hosted, full authority after claim |
| `recipe.convex-cloud.sponsored-transfer/v1` | sponsored, claim by project transfer |

A resource-only Yard with zero Camps is legal and is what the sandbox and
database recipes resolve to. No empty Camp is ever fabricated to host a managed
resource.

## Parse, don't validate

Every entry point here is a parse boundary that returns a derived domain type,
and nothing downstream re-checks what the boundary already established.
`parseRecipeId` returns a branded `RecipeId`; `parseSolutionRecipe` returns a
branded `SolutionRecipe` whose yards, placements, and edges are already
deduplicated, canonically ordered, and cross-referenced; `parseDeploymentRequest`
returns a request that provably names no provider. `compileRecipe` accepts those
parsed types, so "a recipe with a dangling placement" or "a request that pinned
Cloudflare" is not a case the compiler has to handle — it is a value that cannot
reach it.

The same rule holds on the way out. `buildDeploymentOffer` returns an offer that
has already passed `assertOfferIsSecretFree`, and `acceptOffer` returns an
acceptance whose digest was computed over the canonical bytes rather than
asserted about them.

## Event architecture

This package is pure and emits no events of its own: `compileRecipe`,
`buildDeploymentOffer`, and `acceptOffer` are functions of their arguments, and
a recipe is data. What it produces is the input the surrounding event-driven
control plane acts on.

A `DeploymentOffer` and its `DeploymentOfferAcceptance` are what turn a human
consent into a deploy **command**. The Conductor carries the accepted offer and
consent digests into `BrokerRequest.guest`, and the signed `ResolutionReceipt`
pins them back ([ADR-0151](../../docs/design/adr/07-portability-extensibility.md#adr-0151)).
From there the claim coordinator **actor** in `@hobo/claims` takes over: it
accepts commands like `BeginClaimItem` and `VerifyOwnership` and emits the
`claim.*` **events** (`ClaimItemStarted`, `OwnershipVerified`,
`GuestLeaseExpired`, …) that the host appends to the durable **event store**.
The claim-bundle **projection** folds that stream into the **materialized view**
of "what is still unclaimed and when does it expire"; periodic **snapshots**
back the **read store** the CLI and site query for current deployment status.

The digests this package computes are what make that trail joinable. A
`topologyDigest`, `resolutionDigest`, and `offerDigest` recorded in an event can
be re-derived years later from the same recipe, catalog, and request, because
the compiler reads no clock and no ambient state.

## Contracts

- `data-models/recipes.proto` / `.cue` — the recipe, resolved topology, offer,
  and acceptance records plus the invariants (digest formats, a claim action
  count that requires a deadline, a provider count that has to fold from the
  claim items, a multi-resource bundle that cannot call itself
  `single-resource`, a resource-only Yard that cannot carry Camps).
- `contracts/pacts/recipe-compiler.pact.json` — the conductor to compiler
  boundary, including the refusals: sponsor budget exceeded, undisclosed
  downgrade, and an acceptance invalidated by a changed catalog digest.
  `test/contract.test.ts` verifies this package as the provider by running the
  real compiler against every recorded interaction.
