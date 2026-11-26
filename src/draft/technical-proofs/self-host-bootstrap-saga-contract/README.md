# Self-host bootstrap saga contract

Independent POC for HOBO-359. It turns the HOBO-59/ADR-0092 bootstrap ordering
decision into an executable saga contract for `hobo yard up` while the production
control plane remains greenfield.

The contract models fake providers and fake Identity only at their boundaries:

- a runtime-local seed Yard opens the bootstrap attempt;
- the seed self-deploys the Yard Bindle through the normal plan -> reconcile path;
- the operator bootstrap credential is used once and audited as `identity.SeedTokenUsed`;
- handover retires the seed credential only after real Identity can broker a Yard token;
- the real Yard imports the seed log as immutable provenance;
- reruns are no-ops for the same attempt and blocked for a different lineage;
- air-gapped bootstrap uses signed in-boundary inputs and records zero public egress.

Run the proof:

```powershell
npm.cmd --prefix src\draft\technical-proofs\self-host-bootstrap-saga-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Self Host Bootstrap Saga Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
