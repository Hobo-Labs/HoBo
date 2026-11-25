# Vibe Clickable First-Run Walkthrough - Architecture Evidence

This draft package carries the architecture-guard evidence for HOBO-559. It
states how the M2 clickable walkthrough consumes HOBO-540 activation rail and
HOBO-541 workspace/project state evidence, how docs and support handoffs route
without hidden implementation, and which runtime work remains outside this
branch.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A Pact fixture under [`architecture/pacts/`](./architecture/pacts) records the
  package boundary.

## Parse, Don't Validate

`parseVibeClickableFirstRunWalkthrough` checks the raw walkthrough fixture at
the boundary and returns `ParsedVibeClickableFirstRunWalkthrough`. Downstream
proof code consumes the parsed domain type instead of passing raw strings and
rechecking issue, consumed sources, stage, handoff, proof mode, support
handoff, or stale-evidence behavior at every callsite.

## Event Architecture

This package does not implement onboarding runtime. It names the event model
that later runtime work must preserve:

- **Command** - `clickableFirstRunWalkthrough.Accept` records an accepted
  snapshop first-run walkthrough fixture.
- **Event** - `clickableFirstRunWalkthrough.Accepted` appends consumed HOBO-540
  and HOBO-541 evidence, scenario path, handoff route, support handoff, proof
  mode, accessibility, and stale-evidence refusal state.
- **Actor** - `ClickableFirstRunWalkthroughActor` owns the parsed fixture and
  rejects production UI, auth/account/billing, live provider, customer-data, or
  launch-claim creep.
- **Event store** - accepted walkthrough evidence is appended to the platform
  event store as design-time evidence.
- **Materialized view / projection** - `ClickableFirstRunWalkthroughView`
  folds accepted events into the read model consumed by workspace onboarding,
  docs, support, and launch slices.
- **Snapshot** - the parsed HOBO-559 record is replayable from its accepted
  event and carries step-level proof-mode and handoff labels.
- **Read store** - later prototype work reads the snapshot, not issue-body text
  or live customer state.

No production onboarding UI, auth/account/billing, live provider, customer-data,
or launch claim is implemented here.