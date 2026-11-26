# @hobo/data — contract evidence

Executable PACT boundaries for the CQRS fold kernel, lifted from the data-plane
epic proof:

- `pacts/eventstore-append-boundary.pact.json` — the aggregate appends a
  past-tense fact at the expected `seq` under optimistic concurrency.
- `pacts/projection-sink-boundary.pact.json` — a projection materializes the
  read-model row the sink upserts, at the source `seq`.

`consumer/data-boundaries.test.ts` drives the kernel against the real
`@hobo/runtime-local` event store and asserts each recorded interaction.
