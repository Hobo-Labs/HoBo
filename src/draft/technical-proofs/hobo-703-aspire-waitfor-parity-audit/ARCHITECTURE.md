# Aspire WaitFor Parity Audit

HOBO-703 / GAP-027 executable audit for the aspire.md `WaitFor` tracker row.

## Boundary

- **Input** — live `docs/competitors/aspire.md` and `docs/design/control-plane.md`.
- **Output** — derived audit result (`pass`, `failures`, parsed tracker row).
- **Out of scope** — orchestrator implementation, health-check runtime, Aspire DCP.

## Evidence

- Protobuf: `architecture/aspire_waitfor_parity_audit.proto`
- CUE: `architecture/aspire_waitfor_parity_audit.cue`
- PACT: `architecture/pacts/aspire_waitfor_parity_audit.pact.json`
- ADR: `ADR.md`
