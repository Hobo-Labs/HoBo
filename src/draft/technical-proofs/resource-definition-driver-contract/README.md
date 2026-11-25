# HOBO-45 Resource Definition + Driver Contract POC

This draft pins the M0 Resource Definition and Driver seam:

- `defineResource()` normalizes provider, driver, match criteria, `.with` options, mapping, priority,
  and co-provisioned graph metadata.
- `createResourceCatalog().register(...)` accepts one definition or a provider's shipped default
  definitions, exposes definitions by resource type, and emits a stable content hash.
- `Driver` is the minimal `provision` / `destroy` / optional `refresh` interface named by a
  Resource Definition.
- Ambiguous definitions are surfaced in the catalog snapshot for Matching to resolve by
  priority/objective/tiebreak, instead of silently disappearing.
- The `echo` driver is explicitly read-only for externally managed resources.

## TS factory ↔ YAML-form equivalence

`defineResource()` is the author-facing factory; an equivalent declarative YAML resource definition
normalizes to the exact same `ResourceDefinition`. The two forms are interchangeable — the YAML form
is sugar over the same default-definition shape, carrying the identical
`type` / `engine` / `class` (→ `className`) / `paradigm` / `provider` / `driver` / `with` / `match` /
`priority` / `mapping` / `coProvisioned` fields.

TypeScript:

```ts
defineResource({
  type: "projection-sink",
  paradigm: "relational",
  provider: "aws",
  driver: "terraform",
  with: { tableName: "tickets_projection" },
  mapping: "./projections/tickets.mapping",
  priority: 10,
  match: { envType: "production", resourceId: "tickets" },
});
```

Equivalent YAML:

```yaml
apiVersion: hobo.resource-definition/v1
type: projection-sink
paradigm: relational
provider: aws
driver: terraform
with:
  tableName: tickets_projection
mapping: ./projections/tickets.mapping
priority: 10
match:
  envType: production
  resourceId: tickets
```

Both produce a `ResourceDefinition` with `apiVersion: hobo.resource-definition/v1`, a derived `id`
(when none is supplied), key-sorted `with`/`match`, and `priority` defaulting to `0` — so a catalog
built from YAML and one built from `defineResource()` calls yield the same content hash.

Scope intentionally stops before matching/scoring, provider `realize()` implementations, concrete
Terraform/Pulumi/OpenTofu/Crossplane backends, and ResourceActor reconciliation.

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\resource-definition-driver-contract test
```

Relevant design records:

- `docs/design/platform-engineering.md`: Resource Definition shape, matching dimensions, mapping
  sugar, driver taxonomy, co-provisioning
- `docs/design/control-plane.md`: Planner resolves one Resource Definition per resource and
  providers ship default definitions through equivalence + `realize()`
- `docs/design/adr/01-architecture-core.md`: ADR-0006 and ADR-0033


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Resource Definition Driver Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
