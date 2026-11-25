# HOBO-79 IfC Handler Trigger Proof

This proof package lives at `src/draft/technical-proofs/ifc-handler-trigger-contract`.

It covers the HOBO-79 acceptance surface:

- HTTP, topic, and schedule entry points lower to explicit WIT export names and manifest trigger edges.
- `topic.subscribe` accepts workflow handlers and records the durable runtime link without implementing runtime execution.
- TypeScript verifies handler `ctx.bindings` exposes only declared bound resource clients.
- Negative tests cover out-of-Bindle trigger resources, duplicate HTTP routes, workflow subscribers without durable event paths, and bucket write-event permission inference.

Scope kept out: host trigger wiring, runtime primitive implementation, and `hobo:websocket` Streamer fan-out.

## HOBO-608 promotion path

HOBO-608 extends this proof with `queue.worker`, `schedule.every`, and local `TriggerDispatcher` dispatch. Draft POC: `src/draft/technical-proofs/ifc-handler-trigger-hobo-608/`. Production promotion targets `packages/bindles/src/triggers/` and `packages/runtimes/runtime-local/src/triggers/`.
