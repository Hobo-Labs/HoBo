# Control-plane event schema contract POC

This draft pins the M0 control-plane event vocabulary for HOBO-39.

It covers:

- `deployment.*`, `match.Decided`, `set.*`, `delta.*`, `resource.*`, `exec.*`, and `dispatch.Decided` event types.
- Required envelope linkage: `correlationId` and `causationId` on every event.
- Deterministic `deployment.Planned` content addressing.
- ADR-0033 `match.Decided` fields: winner, full ranking, rejected candidates, objective, tie flag, catalog content hash, and optional per-rank region/rationale fields.
- ADR-0071 `dispatch.Decided` fields: selected runner/build-machine provider plus pinned `CreditLedgerView@seq`, reservation input, and optional per-candidate rationale.
- A JSON schema, Protobuf descriptor, Zod validator surface, generated event metadata, and a `codegen:check` drift gate.
- An explicit compatibility marker for `@hobo/core/EventEnvelope@v1` until the greenfield `@hobo/core` package exists.

This is intentionally a contract POC. It does not implement runtime ports, policy/compat events, credit-ledger folding, IaC execution, or orchestration.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Control Plane Event Schema Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
