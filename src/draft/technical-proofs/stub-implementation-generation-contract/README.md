# Stub Implementation Generation Contract

Independent POC for HOBO-652 (S5-07). It pins the Forge stub-to-implementation
generation loop: a stubbed WIT port's recorded traces, conformance suite, and
interface contract drive AI scaffold/fill, no-egress sandbox validation with
replay-as-tests, bounded repair, and gated promotion.

## Requirements Source

- [Plan 23](../../../../docs/design/generated-stack.md#plan-23): stub recordings are the specification-by-example oracle; "done" = conformance green + reproduces observed outputs.
- [Plan 9](../../../../docs/design/generated-stack.md#plan-09): per-interface `@hobo/conformance` is the hard gate.
- Promotes the stub-to-implementation slice from
  [`generation-pipeline-training-ai-safety`](../../epic-proofs/generation-pipeline-training-ai-safety/README.md).

## Contract

- `parseStubRecordings()` crosses the S5-06 stub recording boundary once into a derived type.
- `adaptStubRecordedTrace()` bridges HOBO-651 `hobo.stub.recorded-trace/v1` exports into generation input.
- `buildStubImplementationGenerationRequest()` binds authoritative WIT + conformance suite; stub material cannot override the target port.
- `runStubImplementationGeneration()` composes scaffold, LLM-fill, sandbox validation (conformance + trace replay), bounded repair, and promotion.
- Promotion requires **all** stub-recorded traces to replay and the per-interface conformance suite to pass.
- Repair is bounded; exhaustion emits exactly one `gen.NeedsHuman`.

## BDD Acceptance

```gherkin
Feature: Generate implementation from stubbed port

  Scenario: Stubbed fixture port promotes after conformance and trace replay
    Given a stubbed payments port with recorded link.Called traces
    When the Forge generates, validates, and repairs an implementation candidate
    Then the candidate passes per-interface conformance
    And reproduces every recorded trace
    And promotion emits impl.Promoted
```

## Scope Boundaries

This POC does not implement production `stub()`, a live Firecracker runner, a
real LLM, Registry publish, or S5-04 repair orchestration. It proves the
event-stream composition and replay-as-test gate that production Forge code
consumes.

## Verification

```bash
pnpm exec turbo run test --filter ./src/draft/technical-proofs/stub-implementation-generation-contract
```

## Architecture Evidence

- `architecture/` — protobuf data shapes and CUE constraints.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
