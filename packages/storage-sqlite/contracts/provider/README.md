# Provider verification — owed

`contracts/journal-boundary.pact.json` currently has consumer-side coverage only
(`contracts/consumer/journal-boundary.test.ts`). The provider-verification lane
(`test:contract:provider`) runs with `--passWithNoTests` until a real provider
suite lands here: verify `SqliteJournal` against the pact interactions
(append-with-position, `OPTIMISTIC_SEQUENCE_CONFLICT`, `STALE_FENCE`) the same
way other packages verify their pacts. Tracked as a follow-up so the empty lane
is deliberate, not forgotten.
