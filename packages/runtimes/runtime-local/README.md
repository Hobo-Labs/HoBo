# @hobo/runtime-local

In-process wRPC providers receive an `AbortSignal` in their invocation context.
When a call reaches its deadline, the signal aborts with the same
`DeadlineExceededError` returned to the caller. Providers should observe the
signal to stop work promptly; a provider that ignores it retains its in-flight
slot until it settles.
Nested calls inherit the parent deadline and may request an earlier deadline;
they cannot extend it. Concurrent calls keep their deadlines isolated.

The local scheduler supports interval schedules and five- or six-field cron
expressions. Cron expressions use UTC by default; provider calls can specify an
IANA time zone. The first occurrence is strictly after registration, and
advancing virtual time emits every due occurrence. Expression schedules survive
snapshots and participate in trace replay. The provider derives a stable id from
the expression and time zone when no `scheduleId` is supplied, so registering
the same expression again returns the existing schedule. Time-zone behavior
uses the host's time-zone data.

> **Naming:** `packages/runtimes/*` are concrete **runtime backends** (this
> package: the local/sqlite substrate). The singular `packages/runtime`
> (`@hobo/runtime`) is the app-facing **SDK primitives** package — a
> different concern; see its README for the full disambiguation.

Wasmtime-based runtime-local **component host** for HoBo S1. Loads descriptor-defined
guest components, routes WIT imports through a deny-by-default **link table**, and
appends `component.*` / `link.*` events to an injected event-log sink.

## Scope

**In:** component lifecycle, in-process link table, **wRPC in-process link layer**
(encode → route → decode, wire-version negotiation, membrane PACT), **capability
enforcement at the link table** (usage-inferred grants, deny-by-default routing,
`capability.GrantDenied` events), **local binding resolution** for offline dev
(`createLocalBindingResolver`), `wasi:http/incoming-handler@0.2.0`
dispatch, trap isolation, teardown cleanup, Wasmtime engine seam (in-process stub +
CLI version gate).

**Out:** wRPC cross-process transport, fuel/epoch limits, real `.wasm` byte execution,
OCI/wasmCloud adapters, conformance suite, grant inference from manifests.

## Usage

```ts
import { createRuntimeLocalComponentHost } from "@hobo/runtime-local";

const host = createRuntimeLocalComponentHost({
  appendEvent: (event) => eventLog.append(event),
});
```

## Tests

```bash
pnpm --filter @hobo/runtime-local test
```

Promoted from `src/draft/technical-proofs/runtime-local-component-host` in S1-02
(HOBO-591). wRPC link layer promoted in S1-03 (HOBO-592 / PR #784). Capability
enforcement promoted from `src/draft/technical-proofs/capability-enforcement-contract`
in S1-04 (HOBO-593). Binding resolver adapter added in S1-15 (HOBO-605).

## Durable EventStore reopen coverage

`createRuntimeLocalEventStore` delegates ID allocation to the shared
`@hobo/storage-sqlite` journal. Reopening with its default manual clock preserves
old IDs and permits new appends; IDs are never restarted from an empty-database
assumption. `test/eventstore-reopen-ids.test.ts` exercises this against real
SQLite. The generated API integration test also closes and reopens the default
store before resuming a journaled workflow without repeating completed effects.
