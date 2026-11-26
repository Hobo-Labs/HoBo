# Vibe Accessibility Usability Checklist - Architecture Evidence

This draft package carries the architecture-guard evidence for HOBO-554. It
states how the checklist fixture is parsed, how downstream vibe surfaces inherit
the launch baseline, how accepted HOBO-577 quickstart fixture ids constrain
downstream evidence, and which audit, UI, waiver, and customer-data work remains
outside this branch.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A Pact fixture under [`architecture/pacts/`](./architecture/pacts) records the
  package boundary.

## Parse, Don't Validate

`parseVibeAccessibilityChecklist` checks the raw checklist fixture at the
boundary and returns `ParsedVibeAccessibilityChecklist`. Downstream proof code
consumes the parsed domain type instead of repeatedly checking raw strings for
surface names, required check ids, proof modes, launch severity, accepted-risk
routes, owner routes, support handoff evidence, and HOBO-577 quickstart fixture
refs.

## Event Architecture

This package does not implement product UI or an audit runner. It names the
event model that later runtime work must preserve:

- **Command** - `accessibilityChecklist.Accept` records an accepted checklist
  fixture.
- **Event** - `accessibilityChecklist.Accepted` appends surface, check,
  severity, owner-route, proof-mode, and scenario evidence.
- **Actor** - `AccessibilityChecklistActor` owns the parsed fixture and rejects
  product UI, full-audit, automated-suite, waiver, customer-data, or launch-claim
  creep.
- **Event store** - accepted checklist evidence is appended to the platform
  event store as design-time evidence.
- **Materialized view / projection** - `AccessibilityChecklistView` folds
  accepted events into the read model consumed by downstream vibe artifacts.
- **Snapshot** - the parsed HOBO-554 record is replayable from its accepted
  event and carries surface-to-owner routing plus proof-mode labels.
- **Read store** - later artifact work reads the snapshot, not issue-body text
  or customer screenshots.

No product UI implementation, full accessibility audit execution, automated
test-suite buildout, launch waiver approval, customer data, or launch claim is
implemented here.
