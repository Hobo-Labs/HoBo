# HOBO-359 self-host bootstrap saga proof

This proof backs the self-host bootstrap implementation slice in
[control-plane bootstrapping](../../control-plane.md#bootstrapping-chicken-and-egg),
[ADR-0092](../../adr/01-architecture-core.md#adr-0092), and the
[ADR-0036](../../adr/07-portability-extensibility.md#adr-0036) air-gapped boundary.

It keeps the executable contract inside the repo-standard draft path:

- [`src/draft/technical-proofs/self-host-bootstrap-saga-contract`](../../../../src/draft/technical-proofs/self-host-bootstrap-saga-contract)

## Proven boundaries

- `hobo yard up` starts a runtime-local seed, self-deploys the Yard Bindle through fake provider
  plan -> reconcile, and emits the accepted sequence including `identity.SeedTokenUsed`.
- The seed credential is retired only after real Identity can broker a Yard control-plane token.
- The real Yard imports the seed log as read-only provenance, and a replay reconstructs the
  bootstrap deployment without live command replay.
- A completed rerun for the same attempt is a no-op; a different attempt for the same target is
  blocked before provider calls.
- The seed-crash, premature-handover, expired-credential, air-gapped zero-egress, and
  double-bootstrap adversarial cases each have executable guards.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\self-host-bootstrap-saga-contract test
```
