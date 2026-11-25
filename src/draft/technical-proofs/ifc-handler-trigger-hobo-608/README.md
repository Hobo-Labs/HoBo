# HOBO-608 IfC Handler Trigger Attachment POC

Independent draft proof for [HOBO-608](https://linear.app/quickdeploy-ai/issue/HOBO-608/s1-18-ifc-handlertrigger-attachment-httptopicbucketschedulequeue).

Extends the HOBO-79 authoring contract with `queue.worker`, `schedule.every`, local `TriggerDispatcher`, and hello-bindle manifest fixture. Promotion target: `packages/bindles/src/triggers/` and `packages/runtimes/runtime-local/src/triggers/`.

## Scope

- HTTP, topic, schedule (cron + every), bucket, and queue trigger attachment lowering to manifest `triggerEdges`.
- Fail-closed guards: duplicate routes, out-of-Bindle resources, workflow without durable path.
- Permission inference including bucket write (`event:write`, `read`) and queue worker (`dequeue`).
- `TriggerDispatcher` wiring mock runtime-local ports and emitting `trigger.Fired` events.
- Deterministic `hello-bindle.manifest.json` golden fixture.

## Out of scope

- Production `@hobo/bindles` / `@hobo/runtime-local` packages (blocked on S1-13/S1-16 merge).
- `hobo dev` CLI, durable runtime execution, websocket/job triggers.

## Verify

```bash
pnpm --prefix src/draft/technical-proofs/ifc-handler-trigger-hobo-608 test
```

## Architecture evidence

- `data-models/trigger_edge.{proto,cue}` — TriggerEdge protobuf + CUE constraints.
- `architecture/pacts/bindles_collector_triggers.pact.json` — bindles→collector boundary.
- `architecture/pacts/dispatcher_ports.pact.json` — dispatcher→runtime-local ports boundary.
- `ADR.md` — parse-don't-validate and CQRS event emission.
