# SRE MTTD/MTTR Postmortem Contract POC

Independent POC for HOBO-305.

This package proves the Operators/SRE process-SLO contract:

- `sre.mttd` and `sre.mttr` are declared as OpenSLO-compatible duration SLOs.
- MTTR overrun emits `incident.SLABreached`, burns error budget, and produces an
  auditable `can-deploy` denial for risky deploys.
- resolved incidents produce `incident.PostmortemFiled` from replay only.
- identical replay logs produce byte-identical postmortems and content hashes.
- failed remediation creates a permanent replay regression test and candidate
  runbook/SRE-prompt updates marked for gated eval promotion.

Scope boundary:

- no eval/training promotion engine is implemented; candidate updates are emitted
  only as gated artifacts.
- no status-page publishing is implemented.
- no live incident service is implemented; the proof consumes event streams from
  the existing incident and gated-remediation contracts.

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\sre-mttd-mttr-postmortem-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Sre Mttd Mttr Postmortem Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
