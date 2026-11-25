# HOBO-389 Data Paradigm Authoring Proof

This executable proof backs [PLAN-02](../../sdk-api.md#plan-02),
[PLAN-21](../../authoring-resources-wiring.md#plan-21),
[PLAN-32](../../data-plane.md#plan-32), [ADR-0034](../../adr/03-data-plane.md#adr-0034),
[ADR-0052](../../adr/03-data-plane.md#adr-0052), and
[ADR-0081](../../adr/03-data-plane.md#adr-0081).

The proof lives in
[`../../../src/draft/technical-proofs/data-paradigm-authoring-contract`](../../../../src/draft/technical-proofs/data-paradigm-authoring-contract).

It verifies:

- `@hobo/sql` can be opted onto a `data("db")` handle while the manifest still
  lowers through `hobo:data`;
- the manifest entry carries `paradigm: "relational"` plus a surfaced
  specialization marker for the opt-in package;
- a single `data` resource cannot mix two paradigm packages;
- the four canonical package names map to their fixed paradigm identities;
- `.with()` native pins, Resource Definition references, and `.raw()` dialect
  reads remain available on opted-in handles and surface portability debt;
- plain `data()` emits no paradigm field, specialization block, or portability
  markers;
- cross-paradigm-only package features surface as `paradigm-mismatch` lock-in
  markers instead of being hidden;
- vector and graph packages surface their `hobo:search` extension metadata while
  the resource remains `hobo:data`;
- package imports do not bypass usage-inferred `allow` collection;
- this slice imports package descriptors and does not redeclare Data Plane
  package symbols.
