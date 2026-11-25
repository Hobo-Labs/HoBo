# Vibe Role Tutorial Outlines - Architecture Evidence

This draft package carries architecture-guard evidence for HOBO-552. It records
how six role tutorial outlines are parsed, how they reuse accepted quickstart
fixtures, how proof modes and support handoffs stay explicit, and which docs or
live-service work remains outside this branch.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A Pact fixture under [`architecture/pacts/`](./architecture/pacts) records the
  package boundary.

## Parse, Don't Validate

`parseVibeRoleTutorialOutlines` checks the raw outline fixture at the boundary
and returns `ParsedVibeRoleTutorialOutlines`. Downstream proof code consumes the
parsed domain type instead of passing raw issue text and rechecking role,
walkthrough anchor, command path, MCP tool list, fixture id, expected output,
failure branch, proof mode, accessibility note, or support handoff in every
view.

## Event Architecture

This package does not implement tutorial publishing or a docs portal. It names
the event model later runtime or docs automation must preserve:

- **Command** - `roleTutorialOutline.Accept` records an accepted outline set.
- **Event** - `roleTutorialOutline.Accepted` appends the six-role outline,
  HOBO-577 fixture refs, coverage path, proof-mode, accessibility, and support
  handoff evidence.
- **Actor** - `RoleTutorialOutlineActor` owns parsed outline acceptance and
  rejects final tutorial content, live provider execution, hosted docs
  implementation, production recordings, customer data, or proofless launch
  claim creep.
- **Event store** - accepted outline evidence is appended as design-time
  evidence.
- **Materialized view / projection** - `RoleTutorialOutlineView` folds accepted
  events into the read model consumed by later docs portal, launch demo,
  troubleshooting, support, and tutorial implementation slices.
- **Snapshot** - the parsed HOBO-552 record is replayable from the accepted
  event and carries fixture ids, proof modes, and scope-out labels.
- **Read store** - later M2/M3 tutorial implementation reads the snapshot, not
  mutable Linear text or live provider state.

No final tutorial content, live provider execution, hosted docs implementation,
production recordings, customer data, or launch claim without evidence is
implemented here.
