# Event Body Upcaster Gate POC

Independent proof for HOBO-57. It pins the Plan 11 / ADR-0051 event-body
evolution gate:

- Versioned `EventEnvelope.type` body schemas (`ticket.Opened@v1..v3`).
- Pure forward-only upcasters chained `vN -> vN+1`.
- Golden replay corpus entries with real encoded bytes and SHA-256 digests.
- `can-deploy` gate checks for corpus coverage, append-only corpus retention,
  total upcaster chains, pure upcasters, and replay to the current version.

The fixture deliberately models event-log evolution only. PACT wiring,
projection-sink migrations, app database expand/backfill/contract phases, and
poison-event quarantine remain separate slices.

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\event-body-upcaster-gate test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Event Body Upcaster Gate.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
