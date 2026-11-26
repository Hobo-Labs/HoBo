# DX Backbone Resource Lifecycle Vibe

This HOBO-566 proof pins the DX-first backbone for v1 vibe examples. It is an
experience proof, not production CLI/API/SDK implementation.

## Scope

- Defines the child slice graph from HOBO-567 through HOBO-577.
- Proves API, SDK, CLI/MCP, result-envelope, fixture, transcript, and quickstart
  responsibilities are covered by isolated `src/draft/exp-proofs/<type>/<slug>` packages.
- Enforces M1 shape/contract/fixture work before M2 transcript and quickstart work.
- Forces downstream docs, tutorial, dashboard, marketplace, support, launch, and
  accessibility artifacts to consume accepted DX source material.
- Keeps `live`, `simulated`, `reference fixture`, and `scope-out` as the closed
  proof-mode vocabulary.

## Audience Model

- Persona / actor: product engineer, platform engineer, GitOps operator, SRE,
  support engineer, and agent/MCP caller evaluating the same resource lifecycle
  through API, SDK, CLI, and MCP surfaces.
- Context: they need a branch-sized reference graph before UI, docs, support,
  launch, or dashboard work turns examples into product claims.
- Goals: define resources once, see plan/apply/manage/migrate examples, compare
  API/SDK/CLI/MCP parity, and understand which examples are live, simulated,
  fixture-backed, or explicitly out of scope.
- Constraints: no production CLI/API/SDK, no live provider calls, no customer
  data, no real credentials, and no public launch claims.
- Prior knowledge: HoBo design anchors, resource lifecycle vocabulary,
  protobuf/CUE/Pact proof expectations, and terminal-first developer workflows.
- Accessibility needs: downstream quickstarts and visual artifacts must reuse
  one accepted source graph so text, transcripts, diagrams, and support paths do
  not diverge for screen-reader, keyboard-only, or low-context users.
- Risk tolerance: fail closed when an example cannot prove its source issue,
  proof mode, fixture, or accepted quickstart dependency.
- Success criteria: every child slice has a package/proof-note target, every M2
  transcript waits on M1 shape/fixture evidence, and every downstream consumer
  is blocked from inventing behavior before HOBO-577 quickstart evidence.

## Friction Inventory

| Friction | Measurable standard | Evidence owner |
| --- | --- | --- |
| API, SDK, CLI, and MCP examples drift into separate stories. | Child slices cover every resource lifecycle surface and use one HOBO-566 graph. | HOBO-567 through HOBO-572 |
| Transcript work starts before shape and fixture contracts exist. | M2 slices depend on all M1 foundation issues before prototype readiness. | HOBO-573 through HOBO-577 |
| Visual, launch, support, or dashboard artifacts invent behavior. | Downstream gates require HOBO-577 plus scenario, envelope, and fixture evidence. | HOBO-577 |
| Examples blur live, simulated, fixture, and non-scope claims. | Proof modes are closed over `live`, `simulated`, `reference fixture`, and `scope-out`. | HOBO-571 |
| Scope creep turns a vibe proof into production implementation. | Scope-out requests classify to non-HOBO owners and fail closed in tests. | HOBO-566 |

## Non-Scope

No production CLI parser, REST endpoint, SDK package, live provider call, real
credential, customer data, final product copy, public launch claim, or UI-first
dashboard behavior is implemented here.

## Proof Command

```powershell
npm.cmd --prefix src\draft\exp-proofs\dx-backbone-resource-lifecycle-vibe test
```

## Mocked Boundaries

- Linear child issue state is represented by a deterministic local record.
- Production CLI/API/SDK/runtime/provider surfaces are not invoked.
- Downstream artifact consumers are modeled as gates that must consume HOBO-577
  quickstart evidence rather than inventing behavior.

## Contract Evidence

- `architecture/dx_backbone_resource_lifecycle.proto`
- `architecture/dx_backbone_resource_lifecycle.cue`
- `architecture/pacts/dx-backbone-resource-lifecycle.pact.json`
