# Vibe Docs Portal IA States - Architecture Evidence

This draft package carries the architecture-guard evidence for HOBO-551. It
states how Docs Portal IA records are parsed, how search metadata stays tied to
source records and owners, how stale/unknown evidence downgrades customer-facing
status, and which runtime work remains outside this branch.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A Pact fixture under [`architecture/pacts/`](./architecture/pacts) records the
  package boundary.

## Parse, Don't Validate

`parseVibeDocsPortalIaStates` checks the raw IA fixture at the boundary and
returns `ParsedVibeDocsPortalIaStates`. Downstream proof code consumes the
parsed domain type rather than passing raw strings and rechecking content area,
audience, source record, owner, freshness signal, proof mode, limitation state,
support/release owner, and safe scenario behavior in each view.

## Event Architecture

This package does not implement a docs portal runtime. It names the event model
that later runtime work must preserve:

- **Command** - `docsPortalIa.Accept` records an accepted IA/search-metadata
  fixture.
- **Event** - `docsPortalIa.Accepted` appends content inventory, audience path,
  search metadata, stale-state, proof-mode, and accessibility evidence.
- **Actor** - `DocsPortalIaActor` owns the parsed fixture and rejects portal UI,
  CMS/publishing, search, analytics, support-tooling, security-intake, or
  launch-claim creep.
- **Event store** - accepted IA evidence is appended to the platform event store
  as design-time evidence.
- **Materialized view / projection** - `DocsPortalIaView` folds accepted events
  into the read model consumed by later docs, launch, support, and marketplace
  slices.
- **Snapshot** - the parsed HOBO-551 record is replayable from its accepted
  event and carries freshness and limitation labels.
- **Read store** - later M2 prototype work reads the snapshot, not issue-body
  text, live analytics, CMS state, or a hosted search index.

No docs portal UI, CMS, authoring or publishing pipeline, search indexing
service, analytics, hosting, final customer-facing copy, security intake,
support queue, production UI, or unsupported launch claim is implemented here.
