# @hobo/stations contracts

PACT consumer evidence for the Station control-plane occupancy boundary.
The Station local store / Conductor client is the provider under test.
`test/traffic-routing-contract.test.ts` validates the Pact identity/request envelope
and executes its bodies against the in-process synthesis boundary; it does not claim
that `@hobo/stations` hosts an HTTP server.

`hosting-cutover.pact.json` describes the **library call** between the hosting
transition supervisor and Station routing cutover. `hosting-cutover-contract.test.ts`
executes the fixture against the real cutover implementation with observed-status
adapters and injected lost responses/unrealized restoration. It pins fail-closed
availability, apply-once effects, and honest recovery-pending outcomes. It does not
model an HTTP endpoint or attest a live provider.

Generated routing snapshots and scoped health observations have CUE fixture pairs
under `fixtures/routing-control/`. Vet `routing_control.cue` with
`#RoutingControlStateRecord` or `#CutoverHealthObservationRecord`: valid fixtures
must pass and invalid fixtures must fail. Protobuf JSON field names are preserved.
