# Contracts

`pacts/resource-intent-declaration.pact.json` is the PACT for the one service
boundary this package's shape crosses.

## Why there is a contract here at all

A declaration manifest is not an internal type. It leaves the Planner's
lowering stage as a wire record and arrives at matching, which is where a
provider-shaped field or a region that lost its presence becomes a different
component's problem. `packages/cloud/contracts/pacts/capability-registry.pact.json`
and `.../resource-definition-catalog.pact.json` already describe the *response*
side of that exchange; this one describes the request body, which is the part
this package owns.

The four interactions are the ones worth pinning:

1. A lowered `hello-bindle` node crosses intact, bind edges and all — the only
   value in the repository with a non-empty `deps`, so it is the only one that
   exercises the graph half of the shape.
2. A declaration naming a provider is refused. Provider neutrality is the whole
   reason this shape exists; a contract that did not pin the refusal would let
   it decay into a warning.
3. A present-but-empty `region` is refused. See the package README: it is the
   one value the proto3 implicit-presence encoding cannot round-trip, and
   refusing it at the boundary is how it is prevented from existing.
4. A placement selector with no operand is refused. Downstream it would reject
   every candidate without explaining why, which is the worst kind of failure:
   correct-looking and silent.

## It executes

`test/pact.test.ts` loads this file and drives every interaction through the
real parse boundary, asserting the exact refusal message for each. It lives
under `test/` rather than `contracts/consumer/` so the package's single `test`
script runs it — a contract that is not on the default lane is a contract that
stops being run.
