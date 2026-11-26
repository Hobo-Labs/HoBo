Consumer/provider pacts for the boundaries `@hobo/yards` sits on live under `pacts/`,
and every pact file is listed in [`pact-inventory.md`](pact-inventory.md).

- `yard-camp-scope` — `@hobo/yards` → `@hobo/camps`: a Yard only attaches Camps whose
  provider agrees with its own.
- `yard-binding-rows` — `@hobo/cloud` → `@hobo/yards`: the planning shape the selection
  path reads binding rows from, including the refusals (`YARD_BINDING_EMPTY_CONSTRAINT`,
  `YARD_BINDING_DUPLICATE`) that keep rows a canonical set rather than an ordered list.

Both are documentation-grade: this package is pure and exposes no process boundary of
its own, so there is no provider process to verify against. The behaviour the pacts
describe is asserted by the package's unit tests.
