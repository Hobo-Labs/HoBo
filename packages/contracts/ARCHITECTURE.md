# @hobo/contracts — architecture

The Contract IR, the `can-deploy` compatibility engine, and the composed
**Gatekeeper** for HoBo's contract + policy planes (S2-07). Design source:
[`docs/design/contracts-policy-flags.md`](../../docs/design/contracts-policy-flags.md)
(Plan 29).

## Conformance is not compatibility

Conformance proves one implementation satisfies its port. It cannot answer the
version-skew question — _will `api@v3` (which removed `tenantId`) still work with
`worker@v2` already running in prod?_ That is a **contract** between a producer
and its consumers, evaluated against **what is actually deployed**. This package
is that dimension.

## Three modules, one decision

- **Contract IR** ([`src/contract-ir.ts`](./src/contract-ir.ts)) — a versioned
  producer/consumer boundary contract and its compatibility rules.
  `checkCompatibility(prev, next)` returns `compatible` or `breaking` with
  machine-readable reasons; a removed field a consumer depends on is a breaking
  change, an added field is safe. Optional **EffectSpec** (Verse-inspired purity
  lattice + domain I/O effects) and **ResilienceProfile** (secondary resiliency
  metadata) fields are first-class ([ADR-0136](../../docs/design/adr/03-data-plane-effects-resiliency.md));
  effect widening is breaking when effects are declared. Lattice helpers live in
  [`src/effects.ts`](./src/effects.ts); resiliency applicator in
  [`src/resilience.ts`](./src/resilience.ts); describe/export in
  [`src/describe.ts`](./src/describe.ts).
- **can-deploy** ([`src/can-deploy.ts`](./src/can-deploy.ts)) — given the
  currently-deployed contract state and a candidate deployment plan, it builds a
  compatibility matrix and emits `compat.GatePassed` / `compat.GateFailed` with a
  precise reason an agent can self-correct against.
- **Gatekeeper** ([`src/gatekeeper.ts`](./src/gatekeeper.ts)) — sits in front of
  every deploy and composes four gates into one explainable decision: (a) the
  can-deploy contract check, (b) the `@hobo/policy` policy-pack decision, (c) an
  obligation check, (d) a cost/quota check. A breaking contract, a deny policy,
  or an exceeded quota yields `deny` with a machine-readable reason.

## Governed by default

The Gatekeeper **composes** the `@hobo/policy` engine — it imports and runs the
Policy IR (`createDecision` / `createPolicyDecidedEvent`), never reinventing it.
Every evaluation records a `policy.Decided` fact **even when it allows**, so a
permissive default pack still governs without blocking (FR-051, NFR-017). Because
each gate result is an event, "why did this deploy block?" is replayable.

## Types

Records, messages, data, and objects are defined as protobuf in
[`data-models/contracts.proto`](./data-models/contracts.proto) with a CUE
constraint per type in
[`data-models/contracts.cue`](./data-models/contracts.cue). The TypeScript
surface follows **parse, don't validate**: the exported interfaces are parsed,
derived domain types (branded hashes, unions, richer fields) whose generated
`*_pb.ts` form is the wire encoding, built only by this package's constructors.

## Boundary

`@hobo/contracts` depends inward on `@hobo/core` (port vocabulary) and
`@hobo/policy` (the policy engine it composes) — both packages, never an adapter.
It does **not** depend on `@hobo/cloud` at runtime: the `DeploymentPlan` /
`ResourcePlan` a deploy decision gates over is mirrored structurally as a minimal
local input type, so a caller in the gateway adapts a real plan to it. The
`hobo:contract-engine` and `hobo:gatekeeper` provider ports
([`src/port.ts`](./src/port.ts)) are the seams concrete engines bind behind via
Matching. The PACT evidence in [`contracts/`](./contracts) pins the Gatekeeper's
boundaries to the contract, policy, obligation, and cost/quota engines.

Although the Gatekeeper is a synchronous decision function, its inputs and
outputs are the event-sourced substrate of the deploy pipeline: a **command**
(`hobo verify`) folds the deployed-state **projection** (a **materialized view**
over the append-only **event-store**, rebuilt from **snapshots** in the **read
store**) that the Planner **actor** maintains, and every verdict is emitted as a
replayable `policy.Decided` / `compat.Gate*` / `gatekeeper.Decided` **event**.
Gatekeeper decisions also surface **effectSummaries** and optional
`gate: "effects" | "resilience"` reasons so CLI/MCP/SRE tooling can inspect
declared side effects and resiliency intent without elevating resiliency to a
primary control-plane noun.

## Effects + resiliency (ADR-0136)

| Symbol | Role |
|---|---|
| `EffectSpec` | purity + capabilities + domains on a contract |
| `effectiveEffects` | declared or conservative default for external reasoning |
| `effectUnion` / `effectSubtype` / `isEffectWideningBreaking` | lattice |
| `EffectManifest` / `toEffectManifest` | export for policy/SRE/MCP |
| `EffectTracer` | `contract.EffectDeclared` / `EffectInvoked` facts (no re-exec on replay) |
| `ResilienceProfile` | secondary strategy metadata (retry/circuitBreaker/…) |
| `applyResilienceProfile` | thin fact-emitting applicator; never retries policy.Decided/terminal |
| `describeContractEffects` | CLI/MCP human+machine describe |
