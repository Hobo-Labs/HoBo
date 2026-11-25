# S5-03 Forge Ingestion Contract POC

Independent draft POC for [HOBO-648](https://linear.app/quickdeploy-ai/issue/HOBO-648):
Forge ingestion from recorded backend fixtures (docs/OpenAPI/Terraform/Capability
Manifest) into a compiling candidate `@hobo/provider-x` scaffold behind the
generation-pipeline port with a pluggable reasoning-engine slot.

Design refs: [Plan 23](../../../../docs/design/generated-stack.md#plan-23),
generation-pipeline epic proof
[`generation-pipeline-training-ai-safety`](../../epic-proofs/generation-pipeline-training-ai-safety/).

## Contract

- `runForgeIngestion(fixtureUrl)` resolves `fixture://` or `file://` URLs,
  fetches recorded sources, parses them into generation material, sanitizes via
  the HOBO-352 material contract, builds a HOBO-307 `gen.Requested`, scaffolds
  via HOBO-320, and emits a candidate package with:
  - WIT binding skeleton (`src/wit-bindings.ts`)
  - equivalence-class mapping skeleton (`src/equivalence-mapping.ts`)
  - capability manifest draft (`capability-manifest.draft.json`)
- Every step is captured as events: `forge.*` ingestion steps plus `gen.*`
  generation-pipeline events.
- `pnpm run forge <fixture-url>` is the draft `hobo forge` CLI shim.
- Default reasoning engine is scaffold-only; callers may inject a custom engine
  without changing the event order before package emission.

## Acceptance Mapping

| Acceptance / adversarial case | Executable proof |
|---|---|
| `hobo forge <fixture-url>` on recorded fixture emits compiling candidate package | `recorded fixture ingestion emits compiling candidate package with full event stream` |
| Every generation step captured as events | event type assertion in acceptance test |
| WIT bindings + equivalence mapping + manifest draft present | `candidate package includes WIT bindings...` |
| Reasoning engine pluggable | `reasoning engine slot is pluggable...` |
| Prompt injection in OpenAPI refused before scaffold | `OpenAPI prompt injection is refused...` |

## Scope Boundaries

This POC does not implement production `packages/cli` wiring, LLM-fill,
sandbox validation, repair loops, certification, or Registry publish. Those
remain S5-04+ slices. Production promotion waits on S5-02 conformance coverage.

## Verification

```bash
pnpm --prefix src/draft/technical-proofs/s5-03-forge-ingestion-contract test
pnpm --prefix src/draft/technical-proofs/s5-03-forge-ingestion-contract run forge -- fixture://mock-postgres-backend
```

## Architecture Evidence

- `architecture/` — protobuf + CUE contract artifacts.
- `architecture/pacts/` — PACT boundary for forge ingestion.
- `ADR.md` — parse-don't-validate and event-flow evidence.
