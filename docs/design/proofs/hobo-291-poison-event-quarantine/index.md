# HOBO-291 Poison Event Quarantine Proof

Issue: HOBO-291

Proof package: `src/draft/technical-proofs/poison-event-quarantine-contract`

This branch proves the runtime poison-event path described by PLAN-11 and ADR-0050:

- A deterministic fold failure emits `*.Quarantined` with the failed source `seq` and reason.
- Projection and aggregate folds both skip quarantined events deterministically on replay.
- The original event remains in the append-only log; no rewrite or deletion is used.
- `hobo doctor` receives an incident-shaped finding for each quarantine.
- Reprocessing a quarantined event after a later upcaster/fold change requires explicit policy.

Verification:

```powershell
npm.cmd --prefix src\draft\technical-proofs\poison-event-quarantine-contract test
```
