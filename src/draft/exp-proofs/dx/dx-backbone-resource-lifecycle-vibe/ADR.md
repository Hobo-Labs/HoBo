# ADR: DX-First Resource Lifecycle Backbone

## Decision

HOBO-566 treats the API/SDK/CLI/MCP resource lifecycle as the source material
for v1 vibe examples. Visual, support, docs, launch, marketplace, and
accessibility artifacts must consume the accepted DX quickstart, scenario
matrix, result envelopes, and fixture corpus instead of inventing product
behavior.

## Context

The design anchors define `hobo up`, `hobo plan`, `hobo collect`, inspect/log
projections, WIT-first SDK object graphs, DeploymentPlan/Set/Delta, Gatekeeper,
ResourceActor, and `migration.*` events. Those are enough to build branch-sized
experience proofs without shipping production surfaces.

## Alternatives Considered

- Start with dashboard or launch mockups. Rejected because visual artifacts would
  invent behavior before API, SDK, CLI, MCP, fixture, and refusal evidence exists.
- Build production CLI/API/SDK paths. Rejected because HOBO-566 is a coordination
  proof and must not cross runtime, provider, credential, or customer-data
  boundaries.
- Let each child slice choose its own proof vocabulary. Rejected because later
  docs, support, and visual work need one closed proof-mode vocabulary.

## Friction Tradeoffs

- The graph adds sequencing friction by blocking M2 transcript and quickstart
  work until M1 shape and fixture evidence exists. That is intentional because
  transcripts without accepted shapes become unreviewable product promises.
- Downstream artifacts must wait for HOBO-577 quickstart evidence. That slows
  launch/demo material, but keeps support, docs, dashboards, and accessibility
  copy aligned to the same DX source material.
- Scope-out refusals are explicit rather than permissive. This prevents a vibe
  proof from silently becoming production CLI/API/SDK, live provider, or launch
  work.

## Standards Used

- `src/draft/README.md` experience-proof requirements for audience model,
  friction inventory, mocked boundaries, ADR coverage, and deterministic tests.
- `AGENTS.md` contract-first standards for protobuf, CUE, Pact-style proof,
  parse-don't-validate boundaries, and event-architecture notes.
- Linear HOBO-566 acceptance criteria for child-slice coverage, M1/M2 ordering,
  downstream source-material gates, and proof-mode vocabulary.

## Consequences

- M1 shape and fixture slices precede M2 transcript/prototype slices.
- HOBO-577 is the canonical downstream quickstart source.
- Proof-mode labels are closed: `live`, `simulated`, `reference fixture`, and
  `scope-out`.
- Scope-out requests fail closed when they ask for production CLI/API/SDK, live
  providers, real credentials, customer data, or launch claims without evidence.

## Performance Applicability

Performance is not applicable to this coordination proof. Later transcript and
fixture packages can add deterministic timing expectations when they model CLI
or API execution.
