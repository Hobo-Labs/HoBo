# Dispatcher Reservation Hardening Contract POC

Independent HOBO-379 hardening harness for the Dispatcher reservation seam from
[ADR-0071](../../../../docs/design/adr/01-architecture-core.md#adr-0071).

## What This Proves

- A stale-snapshot burst cannot double-spend free-tier headroom.
- Dispatch failure releases a reservation and restores the same provider/dimension headroom.
- Never-confirmed reservations expire and release.
- Confirmed reservations are recorded and stay spent through timeout cleanup.
- Late provider usage cannot confirm an already expired reservation.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\dispatcher-reservation-hardening-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Dispatcher Reservation Hardening Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
