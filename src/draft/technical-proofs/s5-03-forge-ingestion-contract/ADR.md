# S5-03 Forge Ingestion Contract — Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the
  package boundary.

## Parse, Don't Validate

This package applies the **parse, don't validate** discipline: untrusted fixture
bytes are parsed once at the ingestion boundary into derived domain types
(`ParsedIngestion`, `EmittedCandidatePackage`, `ForgeEvent`), and downstream
scaffold and compile steps receive those parsed derived types instead of
re-checking raw URL payloads.

## Event Architecture

Forge ingestion composes with the generation event families:

- **Command** — `runForgeIngestion(fixtureUrl)` requests ingestion for one fixture.
- **Event** — `forge.IngestionStarted`, `forge.SourceFetched`, `forge.SourcesParsed`,
  `gen.MaterialSanitized` / `gen.MaterialRefused`, `gen.Requested`,
  `gen.CandidateGenerated`, `forge.PackageEmitted`, `forge.PackageCompiled`.
- **Actor** — `agent:forge-ingestion` owns the stream for one `requestId`.
- **Event store** — accepted events append to the platform event store as the
  durable source of truth for a generation run.
- **Materialized view / projection** — tests fold the event list into a terminal
  status projection consumers query.
- **Snapshot** — the compiled candidate package ref is the snapshot of the
  ingestion projection at completion.
- **Read store** — CLI and tests query the folded event projection rather than
  re-parsing fixture bytes.

No runtime event store engine is implemented here; this package pins the command,
event, actor, and projection boundaries for the production Forge ingestion stage.

## Performance

Not applicable — deterministic fixture IO and local `tsc --noEmit` only.

## Productionization Note

When S5-02 merges, promote this seam to `packages/cli` `hobo forge` and wire the
reasoning-engine port to the production generation-pipeline adapter.
