# @hobo/adapter-drizzle PACT inventory

This package is pure: it holds no connection, opens no socket, and shells out to
nothing. Its one boundary is the `SchemaDiffEngine` port in `@hobo/core`, which
a migration consumer (`@hobo/trails`) drives. The pact documents that boundary
in HTTP shape — the shape the contract harness speaks — including the two
refusals, because a fail-closed answer is part of the contract and not an
incident.

| Boundary | Consumer | Provider | Protocol | Pact file/test | Provider verification | Mock used | Status |
|----------|----------|----------|----------|----------------|----------------------|-----------|--------|
| Schema-diff engine (ingest / diff / emit SQL) | @hobo/trails | @hobo/adapter-drizzle | in-process HTTP-shaped | `pacts/schema-diff-engine.pact.json` | not executed — pure package, behavior covered by `test/engine.test.ts` and `test/ingest.test.ts` | none | documented |
