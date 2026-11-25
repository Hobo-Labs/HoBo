# AvailabilityView contract POC

Independent proof for HOBO-300.

This package defines the architecture-derived availability projection as a pure
function over a dependency-graph snapshot, declared provider/resource SLAs, and
an optional observed availability value. The result is a replayable
`AvailabilityView` with a design-time estimate, an observed value shown beside
it, and warn-only `can-deploy` feedback when the estimate misses
`availabilitySlo`.

## Contract boundaries

- In scope: serial dependency composition, redundant-set composition,
  network-hop availability, unrated provider defaults, estimate-vs-observed
  gap surfacing, and warn-only `availabilitySlo` floor feedback.
- Consumed but not owned: the HOBO-111 SLO-as-code contract and ADR-0040
  topology declarations.
- Out of scope: observed SLO computation, deploy-freeze enforcement,
  cost-availability degradation, dashboard rendering, and runtime projection
  storage.

## Proof

```powershell
npm.cmd --prefix src\draft\technical-proofs\availability-view-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Availability View Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
