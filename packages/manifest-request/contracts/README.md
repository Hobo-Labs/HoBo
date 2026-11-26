# contracts

`pacts/selection-candidate-catalog.pact.json` is the PACT for the boundary this
package's shape crosses, and `test/pact.test.ts` executes every interaction in
it against the real parse boundary.

## Why there is a contract here

A candidate row is not an internal type. A catalog publishes rows and the
Planner consumes them, and
[`packages/cloud/contracts/pacts/resource-definition-catalog.pact.json`](../../cloud/contracts/pacts/resource-definition-catalog.pact.json)
already pins the *response* side of that exchange — `catalogHash`,
`candidates`, `winner` — naming candidates only by id. What a row actually
contains is the part this package owns, and until it was written down the
answer lived in six provider packages that each built one by hand.

An earlier revision of this file argued that no PACT belonged here, on the
grounds that today's catalog is in-process. That was wrong twice over: the
digest folded into the signed resolution receipt is taken over these rows, so
the encoding is already a cross-package contract whether or not it travels over
HTTP; and `pnpm run architecture:guard` requires executable PACT evidence
(`*.pact.json` with `consumer`, `provider`, `interactions`) rather than prose,
which a README explaining an absence can never satisfy.

## The six interactions

Two acceptances, transcribed from real definitions rather than invented:

1. `neon.claimable-postgres/v1` (`@hobo/provider-neon`) — the widest row in the
   repository: five runtime models, sixteen structured capabilities, two
   binding profiles and two migration profiles, all authored unsorted. It is
   the only interaction that exercises canonicalisation against a row a
   provider actually wrote, and the contract publishes the canonical bytes.
2. `cloudflare.temporary-hyperdrive/v1` (`@hobo/provider-cloudflare`) — a
   connectivity-only row that implements **no** capability profile. It is
   pinned because a schema that required at least one claim would look
   reasonable and would refuse a real, deliberate catalog row.

Four refusals, each pinning a decision the package README argues for:

3. A `null` evidence expiry. Absence means "no live evidence" and fails the
   evidence gate closed; `null` is a second spelling of it, and admitting both
   would let a producer choose which one the gate sees.
4. A row carrying a field this schema does not model. Truncating it silently is
   how a selection-relevant fact stops being covered by any digest — the exact
   failure this package documents in `@hobo/cloud`.
5. Two claims for the same profile. Selection reads the list by position, so
   the choice between two claims for one profile would rest on list order with
   nothing to appeal to.
6. An index-shaped structured-capability key. JavaScript hoists integer-like
   keys to the front of an object, so one would move ahead of the sorted keys
   in the canonical JSON and break byte-identity between two catalogs holding
   the same facts.

## It executes

`test/pact.test.ts` drives every interaction through `parseSelectionCandidate`,
asserting the exact canonical bytes for each acceptance and the exact `code`,
`path` and `message` for each refusal. It lives under `test/` rather than
`contracts/consumer/` so the package's single `test` script runs it: a contract
that is not on the default lane is a contract that stops being run.
