# Self-Host Bootstrap Ordering Spike

This draft package makes the HOBO-59 bootstrap decision executable while the runtime remains
greenfield. The decision itself is recorded in
[ADR-0092](../../../../docs/design/adr/01-architecture-core.md#adr-0092).

The proof models the bootstrap as a bounded state machine:

- a disposable runtime-local seed Yard starts from local SQLite state;
- exactly one scoped, non-refreshable operator bootstrap credential performs the first apply;
- the seed event log is imported into the real Yard as immutable provenance, never replayed as live
  commands;
- handover only occurs after the real Identity service can broker a Yard control-plane token;
- the seed credential is revoked and the seed is discarded after handover;
- air-gapped bootstrap follows the same state machine with in-boundary trust roots and a signed
  offline bundle.

Run the proof:

```powershell
npm.cmd --prefix src\draft\technical-proofs\self-host-bootstrap-ordering-spike test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Self Host Bootstrap Ordering Spike.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
