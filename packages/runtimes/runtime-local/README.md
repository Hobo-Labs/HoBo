# @hobo/runtime-local

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

Loading an already loaded or currently loading ID fails with
`component_already_loaded`; tear down the existing instance before replacing
it. The host captures requested leases before instantiation and rejects an
engine result whose ID differs from the requested ID. An instantiation error
releases the loading claim so the caller can retry.

The component-load model checks 78 bounded states. The projection hides 68
internal steps that do not change a displayed state.

```mermaid
stateDiagram-v2
  s0: Component absent
  s1: Component loading
  s2: Load refused or failed
  s3: Component loaded
  s4: Component torn down
  [*] --> s0
  s0 --> s1: request load
  s1 --> s2: instantiation fails or finish instantiation
  s1 --> s3: finish instantiation
  s2 --> s1: retry load
  s3 --> s4: tear down component
```

The engine and event sink remain trusted. If the event sink throws, the host
cannot determine whether it recorded the event. The host refuses subsequent
effectful operations with `event_sink_uncertain`; reconcile the sink and rebuild
the host before continuing. The sink must be synchronous: returning a promise
or thenable is also treated as uncertain, and any write already started can
still finish. Calls already in flight can still finish. The sink cannot reenter
effectful host methods during an event callback. Teardown refuses
with `component_busy` while linked or HTTP calls are active; retry it after they
settle.

The event-sink model checks 66 bounded states; its projection hides 56
same-label steps.

```mermaid
stateDiagram-v2
  s0: Host ready
  s1: Event being recorded
  s2: Host awaiting reconciliation
  s3: Event recorded
  [*] --> s0
  s0 --> s1: record event
  s1 --> s2: sink returns an async result or sink fails
  s1 --> s3: sink confirms
```

The call-fence model checks 18 bounded states and hides 12 same-label steps.

```mermaid
stateDiagram-v2
  s0: Component ready
  s1: Component torn down
  s2: Component call in progress
  s3: Calls settled
  [*] --> s0
  s0 --> s1: tear down component
  s0 --> s2: start call
  s2 --> s3: call settles
  s3 --> s1: tear down component
  s3 --> s2: start call
```

## Tests

```bash
pnpm --filter @hobo/runtime-local test
```

## Architecture evidence

See [ARCHITECTURE.md](./ARCHITECTURE.md) for protobuf/CUE contracts, PACT boundary,
parse-don't-validate parsers, and event-sourced state naming.

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
