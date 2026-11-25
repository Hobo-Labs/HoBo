# Closure Builder Author Flow - Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the package boundary.

## Parse, Don't Validate

This package applies the **parse, don't validate** discipline: the collected closure-builder output
is parsed once into derived domain types for the author-flow corpus, then downstream SDK conformance
receives parsed generated IDs, aliases, relationship edges, and manifest snapshots instead of raw
DTOs. The CUE constraints mirror those derived types so invalid aliases, missing generated IDs, and
non-`dependsOn` relationship verbs are refused at the corpus boundary.

## Event Architecture

The accepted author-flow corpus is the read model behind this event flow:

- **Command** - `PublishClosureBuilderAuthorFlowCorpus` records the v1 closure-builder sample as the
  SDK authoring path.
- **Event** - `closureBuilder.AuthorFlowCorpusPublished` records the collected Bindle graph, typed
  alias projection, manifest lowering snapshot, and conformance corpus path.
- **Actor** - the SDK authoring contract aggregate is the actor that owns corpus publication for one
  v1 authoring path.
- **Event store** - accepted corpus events are appended to the platform event store as durable
  evidence for the SDK conformance suite.
- **Materialized view / projection** - the SDK conformance projection folds those events into the
  closure-builder author-flow corpus consumed by `@hobo/conformance/sdk`.
- **Snapshot** - the author-flow report is the snapshot of that projection for HOBO-537.
- **Read store** - docs, examples, conformance, and release-readiness gates query the read store
  rather than raw closure-builder captures.

No provider resolver, app host, runtime engine, event store, projector, or production codegen is
implemented here; this package pins the command, event, actor, projection, snapshot, and read-store
boundary for later implementation.
