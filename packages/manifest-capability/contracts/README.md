# PACT inventory — `@hobo/manifest-capability`

This package owns a **data shape**, not an endpoint. It therefore publishes no
PACT of its own: the contracts that carry `CapabilityRequirement` across a
process boundary belong to the services that expose those endpoints, and a
second copy here would be a copy to drift.

What it does own is the **inventory** — `pact-inventory.json` — naming every
committed PACT interaction whose request body carries this shape:

| PACT | Interaction | Consumer → Provider |
|---|---|---|
| `packages/capability-profiles/contracts/pacts/catalog-selection.pact.json` | `POST /capabilities/select` | `hobo-planner` → `hobo-capability-catalog` |
| `packages/data-postgres/contracts/pacts/postgres-conformance.pact.json` | `POST /matching/resolve` | `hobo-capability-matching` → `hobo-postgres-product` |

The inventory is **not prose**. `test/round-trip.test.ts` reads it, harvests the
request body of every interaction it names, projects that body onto
`CapabilityRequirementInput`, and drives the result through the wire codec —
asserting byte-identity. Adding a file to the inventory adds cases; removing one
that still carries the shape fails the harvest assertion, which pins the exact
list.

## Why the bodies are *projected* rather than replayed whole

Both request bodies are **selection requests**, not requirements. They carry the
requirement inline next to fields that belong to the call:
`restrictToDefinitions` in the catalog PACT, `candidateProfiles` in the Postgres
one. Those are not part of this shape, and a round trip that pretended otherwise
would either fail for the wrong reason or force the schema to grow a field it
should not have. The projection keeps exactly the keys of
`CapabilityRequirementInput` and is asserted to be non-empty, so a body that
turned out to carry no requirement at all fails rather than silently
contributing a vacuous case.
