# HOBO-59 self-host bootstrap proof

This proof backs [ADR-0092](../../adr/01-architecture-core.md#adr-0092) and the
[control-plane bootstrapping section](../../control-plane.md#bootstrapping-chicken-and-egg).

It keeps the spike inside the repo-standard draft path:

- [`src/draft/technical-proofs/self-host-bootstrap-ordering-spike`](../../../../src/draft/technical-proofs/self-host-bootstrap-ordering-spike)

## Proven boundaries

- Bootstrap order is seed Yard -> one operator bootstrap credential -> target resource provisioning
  -> seed-log provenance import -> real Identity broker readiness -> credential revocation -> seed
  discard.
- The seed event log is imported as read-only provenance and is not replayed as live commands.
- The handover trigger requires real Identity token issuance, not only target resource creation.
- Air-gapped bootstrap uses the same state machine with signed offline inputs and zero public egress.
- Failure handling covers the HOBO-59 adversarial cases in an executable table.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\self-host-bootstrap-ordering-spike test
```
