# SDK & Authoring Epic Architecture

## Persona

Primary persona: app developer or coding agent authoring a Bindle without choosing a cloud. Secondary personas are platform engineers who approve topology defaults and SDK authors who maintain idiom-layer parity.

## BDD Scenarios

```gherkin
Feature: IfC authoring to manifest IR

  Persona: App developer

  Scenario: Declare a portable Bindle and prove it before deploy
    Given an app declares resources, handlers, config, auth, and connector dependencies through @hobo/bindles
    When collection runs with mocked SDK, auth, codegen, and local runtime boundaries
    Then HoBo emits a deterministic hobo.manifest/v1, generated type surface, and contract evidence without live cloud calls
```

```gherkin
Feature: Authoring guardrails

  Persona: App developer

  Scenario: Unsafe authoring choices are surfaced before deploy
    Given an app narrows allow below observed usage, hides a resource behind an unobserved branch, requests a wider XAA scope, or uses raw driver access
    When the reference implementation evaluates the authoring graph
    Then can-deploy evidence fails closed or records portability debt with machine-readable reasons
```

```gherkin
Feature: Alternate authoring front doors

  Persona: SDK author

  Scenario: Hobo Code and non-TypeScript idiom layers lower to the same contract
    Given Hobo Code input and an extracted non-TypeScript component surface
    When the reference implementation compares their lowering records
    Then both must target hobo:sdk calls, hobo.manifest/v1 records, and semantics-annex parity instead of adding hidden runtime behavior
```

## Vertical Slices

| Slice | POCs | Outcome |
|---|---|---|
| Authoring graph | HOBO-37, HOBO-49, HOBO-52, HOBO-62 | Resource handles, bind edges, provider options, and topology remain authoring metadata. |
| Manifest and contract gates | HOBO-38, HOBO-40, HOBO-70, HOBO-75, HOBO-399 | Manifest, config refs, least-privilege grants, coverage, and API freeze produce fail-closed evidence. |
| Identity-aware app dependencies | HOBO-43, HOBO-83, HOBO-98 | XAA and end-user auth are declared and scoped without live token brokering. |
| Generated and local proof loop | HOBO-67, HOBO-79, HOBO-88, HOBO-392, HOBO-396 | Collection, handlers, codegen, local runtime, and end-to-end IfC flow compose. |
| Alternate front doors and parity | HOBO-58, HOBO-106, HOBO-386, HOBO-389, HOBO-394, HOBO-398 | Namespace, thin lowering, upcasters, data paradigm opt-in, DSL, and non-TS parity stay bounded. |

## Service Boundaries

The reference architecture treats every external dependency as a mocked contract boundary. The app-facing slice consumes provider-like services for WIT collection, manifest registration, coverage decisions, capability contract decisions, XAA metadata, codegen storage, local runtime replay, topology lowering, DSL parsing, auth contracts, secret-source resolution, and SDK parity reports.

## Scope Control

This implementation does not copy POC internals wholesale. It preserves each POC's accepted behavior as a vertical-slice decision and leaves production package implementation, provider realization, real OAuth, and live clouds out of scope.
## Guardrail evidence

Parse, don't validate: incoming command payloads, Pact fixtures, and protobuf/CUE-backed scenario records cross a parser boundary before the epic simulation uses them. The parsed domain types are the scenario commands, boundary fixtures, and role-flow records described above; mocked providers receive only those derived domain types, not raw DTOs.

Event architecture: command handlers in the epic actors emit events into an in-memory event-store. Materialized views and projections are rebuilt from that event stream, snapshots represent the current read model, and historical snapshots are retained in a read store so CLI, MCP, operator, and simulation reads never infer state from mutable provider internals.
