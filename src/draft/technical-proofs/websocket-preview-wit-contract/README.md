# HOBO-33 websocket preview WIT contract

This proof vendors the preview `wasi:websocket@0.0.1-draft` contract and the stable `hobo:websocket@0.1.0` extension described by Plan 20 and ADR-0075.

It proves:

- `wasi:websocket` has typed `types`, `incoming-handler`, `outgoing`, and `websocket` world surfaces.
- `hobo:websocket` only carries HoBo-specific principal, addressing, and fan-out helpers over the preview message type.
- generated guest bindings compile for a server-side `incoming-handler` stub.
- manifest metadata records exact interface versions, stability tiers, and source digests.
- static feedback warns on preview imports, and preview version bumps fail closed unless an upcaster edge is present.

Run:

```powershell
npm.cmd install
npm.cmd test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Websocket Preview Wit Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
