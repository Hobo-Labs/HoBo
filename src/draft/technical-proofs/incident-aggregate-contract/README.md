# Incident Aggregate Contract POC

Independent proof for HOBO-258: the SRE Incident aggregate and `incident.*`
lifecycle contract.

## Contract Surface

- Incident stream id: `incident:<id>`.
- Single aggregate fold: `foldIncidentStream(events)`.
- Source-signal correlation: `deriveIncidentOpenEvents(signals, existingIncidents)`.
- Event constructor: `makeIncidentEvent(type, envelope)`.

## Proven Behaviors

- Lifecycle rejects illegal transitions.
- Multiple source signals with the same `correlationId` open one Incident.
- From-zero replay rebuilds the same timeline.
- Late duplicate signals after resolution do not reopen silently.
- An ownerless Incident cannot advance past `Triaged`.

## Run

```powershell
npm.cmd --prefix src\draft\technical-proofs\incident-aggregate-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Incident Aggregate Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
