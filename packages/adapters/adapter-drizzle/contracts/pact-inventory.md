# @hobo/adapter-drizzle PACT inventory

The migration boundary is in-process. The contract exercises Drizzle schema
conversion and SQL generation, the trails migration executor, and the
PostgreSQL schema-apply port against embedded PostgreSQL.

| Boundary | Consumer | Provider | Protocol | Contract | Verification | Status |
|----------|----------|----------|----------|----------|--------------|--------|
| Generated phased migration | @hobo/trails | @hobo/adapter-drizzle | in-process | `pacts/schema-diff-engine.pact.json` | `packages/trails/test/drizzle-migration.test.ts` | verified |
