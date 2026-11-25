# IfC Handler Trigger Contract POC

Independent proof for HOBO-79.

This package pins the authoring-side trigger attachment contract for IfC resources:

- HTTP routes lower to `wasi:http/incoming-handler`.
- `topic.subscribe`, `schedule.cron`, and `bucket.on` produce manifest trigger edges with host-trigger WIT exports.
- Workflow subscribers record a durable `hobo:runtime/workflow@0.1.0` link.
- Handler `ctx.bindings` is typed from the resource bind map.
- Duplicate routes, out-of-Bindle trigger resources, missing durable event paths, and bucket write-event permission inference are guarded by tests.

Out of scope: host trigger execution, durable runtime internals, gateway/websocket fan-out, and runtime provider wiring.

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\ifc-handler-trigger-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Ifc Handler Trigger Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.

## Testing

Run `pnpm --filter @hobo/draft-ifc-handler-trigger-contract test` (Vitest,
followed by `tsc --noEmit -p tsconfig.types.json`). The handle/context types are
generic over their bindings, so `test/type-consumer.ts` can assert that
`ctx.bindings.<alias>` resolves to the correct per-resource client type and that
misuse (`.get` on a non-API handle, missing bindings) fails at compile time.
