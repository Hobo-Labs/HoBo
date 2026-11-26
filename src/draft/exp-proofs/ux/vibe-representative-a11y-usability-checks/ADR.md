# Vibe Representative Accessibility And Usability Checks - Architecture Evidence

This draft package carries the architecture-guard evidence for HOBO-565. It
states how representative accessibility and usability check fixtures are parsed,
how HOBO-554 and HOBO-577 constrain downstream evidence, and which audit,
product remediation, waiver, customer-data, and launch-claim work remains outside
this branch.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A Pact fixture under [`architecture/pacts/`](./architecture/pacts) records the
  package boundary.

## Parse, Don't Validate

`parseVibeRepresentativeA11yUsabilityChecks` checks the raw representative check
record at the boundary and returns `ParsedVibeRepresentativeA11yUsabilityChecks`.
Downstream proof code consumes the parsed domain type instead of repeatedly
checking raw strings for artifact names, required check ids, severity, owner
route, accepted-risk path, proof modes, source issues, and HOBO-577 quickstart
fixture ids.

## Event Architecture

This package does not implement product UI, full audit execution, or an
automated suite. It names the event model later runtime work must preserve:

- **Command** - `representativeCheck.Accept` records an accepted representative
  check fixture.
- **Event** - `representativeCheck.Accepted` appends artifact, check, severity,
  owner-route, accepted-risk path, launch readiness impact, proof mode, and
  scenario evidence.
- **Actor** - `RepresentativeA11yCheckActor` owns the parsed fixture and rejects
  full audits, product remediation, automated suite buildout, waiver approval,
  customer data, and unsupported launch claims.
- **Event store** - accepted representative check evidence is appended to the
  platform event store as design-time evidence.
- **Materialized view / projection** - `RepresentativeA11yCheckView` folds
  accepted events into the read model consumed by launch/vibe artifact work.
- **Snapshot** - the parsed HOBO-565 record is replayable from its accepted
  event and carries artifact coverage plus readiness impact.
- **Read store** - later launch-readiness work reads the snapshot, not issue body
  text or customer screenshots.

No full accessibility audit, product UI remediation, automated test-suite
buildout, launch waiver approval, customer data, or proofless launch claim is
implemented here.
