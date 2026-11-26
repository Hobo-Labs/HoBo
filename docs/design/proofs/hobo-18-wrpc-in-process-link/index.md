# HOBO-18 wRPC In-Process Link Proof

This proof backs [PLAN-20](../../wasm-runtime-wit.md#plan-20) and [ADR-0069](../../adr/01-architecture-core.md#adr-0069).

The branch adds `src/draft/technical-proofs/wrpc-in-process-link-contract`, an independent POC for the M1 wRPC membrane link slice. It proves import-to-provider-export routing through an in-process link table, default live boundary mode, typed no-route denial, and `link.Called` event evidence with a deadline field.

Acceptance evidence:

- `linked WIT import routes to a provider export through the in-process wRPC membrane`
- `unlinked imports fail with typed no-route instead of panicking`
- `a provider export cannot be reached unless the exact import is in the link table`
- `report records HOBO-18 scope and explicitly excludes later membrane semantics`

Scope boundary:

- Included: WIT-shaped encode/route/decode, link table routing, no-route error, `link.Called.deadline`.
- Excluded: NATS/JetStream, real deadline enforcement, backpressure, partial/ambiguous failure taxonomy, and wire-version negotiation. Those remain HOBO-24 through HOBO-27 style follow-on work.

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\wrpc-in-process-link-contract test
```
