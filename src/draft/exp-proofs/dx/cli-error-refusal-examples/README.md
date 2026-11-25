# CLI Error Refusal Examples

HOBO-558 records customer-safe CLI, JSON, and MCP refusal examples for the resource lifecycle
vibe slice.

## What This Proves

- Examples cover missing dependency, auth failure, policy denial, contract incompatibility,
  stale projection, unknown evidence, non-reactive sink, partial or unavailable provider
  capability, destructive migration blocked, and support bundle handoff.
- Each example pins human terminal copy, JSON output, MCP tool result shape, exit code, proof mode,
  fixture id, accessibility notes, and customer-safe wording.
- Fixture ids are accepted HOBO-572 `dx.lifecycle.*` fixture facts, not local
  one-off refusal ids; JSON and MCP metadata also carry the HOBO-572 fixture
  proof mode.
- Non-live examples fail closed and never claim live success from simulated transcripts or
  reference fixtures.
- Scope guards reject production handler implementation, live auth/provider checks, support ticket
  automation, and dashboard copy before CLI/API/SDK envelopes are accepted.

## Boundary

This package is a reference example catalog, not a runtime handler. It uses parse, don't validate:
untrusted catalog records cross one parser boundary and become derived parsed types before any
downstream proof can consume them.

The catalog consumes the accepted
`dx-resource-lifecycle-fixture-corpus` proof so every refusal example references
redacted, tenant-safe HOBO-572 fixture facts such as `dx.lifecycle.policy-denial.gatekeeper-decision.v1`
or `dx.lifecycle.stale-projection.projection-snapshot.v1`.

The command family is the CLI/API/MCP refusal-example read model. Later actors can emit
`cliErrorRefusalExample.Recorded` events into an event-store; projections and materialized views can
publish current example snapshots; snapshots are persisted in a read store for docs, SDK, CLI, and
MCP consumers. No production command handler, event-store, projection runtime, or read-store
implementation is included here.

## Required Cases

| Case | Primary operations | Proof mode |
|---|---|---|
| missing dependency | `hobo doctor` | reference fixture |
| credential/auth failure | `hobo doctor`, `hobo up` | simulated transcript |
| policy denial | `hobo plan`, `hobo up`, MCP action | reference fixture |
| contract incompatibility | `hobo plan`, MCP action | reference fixture |
| stale/lagged projection | `hobo inspect` | reference fixture |
| unknown evidence | `hobo up`, `hobo inspect`, MCP action | reference fixture |
| non-reactive sink | `hobo logs`, `hobo inspect` | simulated transcript |
| provider capability partial/none | `hobo plan`, `hobo doctor` | reference fixture |
| destructive migration blocked | `hobo plan`, `hobo up`, MCP action | reference fixture |
| support bundle handoff | `hobo doctor`, `hobo logs`, MCP action | reference fixture |

## Verification

```powershell
pnpm.cmd --prefix src\draft\exp-proofs\cli-error-refusal-examples test
```

## Architecture Evidence

- `architecture/` defines protobuf records and CUE constraints for the catalog.
- `architecture/pacts/` records the Pact-style design proof boundary.
- `ADR.md` records parse-derived types and command/event/actor/projection/read-store behavior.
