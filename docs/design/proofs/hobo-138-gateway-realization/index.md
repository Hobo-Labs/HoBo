# HOBO-138 Gateway Realization Proof

This executable proof pins the M1 gateway realization skeleton from
[Plan 12](../../security-networking.md#plan-12) and
[ADR-0035](../../adr/07-portability-extensibility.md#adr-0035).

## Contract Surface

- A `gateway()` contract can be applied to a single provider realization.
- TLS termination is represented at the listener and enforced on request handling.
- Host/path routes select bound `web()` and `service()` targets.
- Weighted traffic splits route in the declared proportions and a split flip moves traffic.
- Mounted vertical UIs serve under their path and derive CORS from declared origins.
- Unhealthy backends return a failure response instead of being served as healthy.

## Proof Boundaries

This proof is a local provider realization POC. It does not implement DNS, custom-domain
validation, ACME/provider-managed certificate issuance, staged cutover, a concrete cloud gateway
adapter, or the WAF/rate-limit enforcement engines. Those remain the separate slices named in
HOBO-138 Scope (out).

## Executable Checks

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\gateway-realization-contract test
```

The checks cover TLS + host/path routing, 95/5 and flipped traffic splits, mounted vertical routing,
default-closed CORS, invalid split rejection, and unhealthy-backend rejection.
