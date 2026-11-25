---
type: Reference
title: "Fuzzing and property oracles"
description: "OSS-Fuzz-style CI discipline for HoBo: fast-check control-plane properties, narrow Jazzer.js harnesses, Schemathesis on PRs, RESTler and Toxiproxy nightly against simulators only."
tags: [hobo, design, fuzzing]
---

# Fuzzing and property oracles

HoBo already has unit, schema, contract, behavior, browser, component, visual,
architecture, and deployment lanes. Those catch many regressions. They do not
make **lifecycle, authority, and canonicalization** bugs visible.

The high-risk defects are not ordinary parser crashes:

- a retry that mints an extra resource
- an update that widens tenancy or access
- a provider state the normalization layer mishandles
- a partial apply plus rollback that leaks resources
- two equivalent manifests producing different canonical plans
- reordered events folding to a different desired state
- a malformed capability or provider document crossing a camp, yard, tenant, or cloud boundary
- a destroy/recreate sequence that violates ownership

`@hobo/fuzz` is the home for those oracles. It targets **provider simulators
and in-memory adapters**. It does not call Azure, AWS, GCP, or paid SaaS.

## Tool split

| Tool | Role | When it runs |
|---|---|---|
| [fast-check](https://fast-check.dev/) | Primary framework. TypeScript properties, shrinking, model-based commands, deterministic async scheduling. | Package `test` / root `pnpm run test:property`. Bounded `numRuns` so default `agent:check` stays fast. |
| [Jazzer.js](https://github.com/CodeIntelligenceTesting/jazzer.js) | Coverage-guided in-process fuzzer for **untrusted serialized input only**. | PR smoke calls the harness functions. A long campaign is nightly / `npx jazzer`. |
| [Schemathesis](https://schemathesis.readthedocs.io/) | Schema-valid and invalid HTTP requests, shrinking, stateful sequences, response conformance. | PR optional: skip if the binary is missing. Point at an ephemeral `@hobo/control-api` (`GET /v1/openapi.json`) or the fixture spec in `@hobo/fuzz`. |
| [RESTler](https://github.com/microsoft/restler-fuzzer) | Infers operation dependencies and explores create → update → attach → delete. | Nightly, docker-gated, against an ephemeral control plane. |
| [Toxiproxy](https://github.com/Shopify/toxiproxy) + [Testcontainers](https://node.testcontainers.org/) | Latency, resets, timeouts, cuts, bandwidth; disposable registries/databases/queues. | Nightly, docker-gated. `HOBO_FUZZ_DOCKER=0` disables. |

Harnesses assert more than “does not crash”: bounded buffer size, deterministic
canonicalization, round-trip / replay preservation, fail-closed rejects, and
no prototype pollution or unexpected property injection.

## Reference model

`ControlModel` in `@hobo/fuzz` executes:

create bindle · add capability · resolve provider · plan · apply · retry apply ·
interrupt apply · reconcile · migrate provider · change tenant · rotate secret
reference · rollback · destroy · replay history

and checks:

- `apply(apply(x)) == apply(x)`
- `replay(history(x)) == state(x)`
- `destroy(create(x))` leaves no owned resources
- `retry(failedApply(x))` never duplicates resources
- `attenuate(capability)` never increases authority
- equivalent manifests produce equivalent normalized plans
- tenant A operations never mutate tenant B state
- rollback restores that tenant's snapshot slice and never a newer tenant state
- interrupt after destroy does not revive a resource
- apply after destroy recreates; it does not leave a destroyed hole
- HTTP create/destroy of another tenant's bindle is conflict/forbidden, not 200

`changeTenant` is fail-closed in the reference model. Idempotency keys, bindle
ids, and capability ids are tenant-scoped so a shared name cannot overwrite
another tenant.

## Jazzer targets

Use Jazzer only where the input is untrusted or richly serialized:

- Bindle manifests
- CUE / JSON / YAML / HCL adapters
- provider capability documents
- OCI annotations and metadata
- schema migration and version negotiation
- provider-response normalization
- generated-code import/export paths
- CLI argument parsers
- policy documents
- webhook and event envelopes

Phase 1 ships Bindle, event-envelope, and policy harnesses. Trainable
code uses the same oracles via `fuzzTrainable` — the silver eval suite
(`hobo.evals.trainable-silver/v1`) scores those verdicts next to the gold
exact-match suite. The evals sidecar promotion gate folds **every** gold and
silver report, so a silver miss cannot hide behind a green gold score.
A `/run` with gold seeds but no actuals and no invoker is a silver miss,
not a vacuous pass. Circular, bigint, `NaN`, `Date`, and `Map` values must
not crash gold `canonicalJson` or the silver harness — they serialize with
cycle marks / `1n` / `NaN` and fail closed on mismatch. Corpus-only
evidence (`silverEvidenceFromCorpus`) cannot claim `seedHolds`. Live
`.js` / `.mjs` / `.cjs` exports load as invokers, including a compiled
sibling next to a TypeScript `"use training"` region. A live invoker fills
unposted gold actuals so exact-match is real. Identity/echo trainables
fail silver fail-closed because they replay polluted probes. Thenable
(async) trainables need a sync wrapper. TypeScript-only regions still need
posted actuals or an in-process invokers map.
Later packages import the same `fuzz*` entrypoints rather than growing a
second fuzzer stack.

## API and fault fuzzing

Schemathesis on a PR talks to **localhost** (or skips). RESTler nightly starts
an ephemeral HoBo control plane and explores sequences. Toxiproxy sits in
front of simulators, registries, databases, and queues — never a live cloud
credential.

Related resilience scope (steady-state hypotheses, blast radius) stays in
[`chaos-resilience-tests.md`](./chaos-resilience-tests.md). This document is
the property/fuzz **discipline** and CI map.

## Lanes

- `pnpm run test:property` — fast-check oracles in `@hobo/fuzz`
- `pnpm run test:fuzz` — Jazzer-shaped serialized-input smoke
- `pnpm run test:fuzz:nightly` — docker-gated plan (skip when Docker is absent)
- Default `agent:check` runs package Vitest when `@hobo/fuzz` changes, and
  `test:property` when Bindle manifest or control-api sources change without
  the fuzz package. It never starts RESTler, Toxiproxy, or live clouds.

See [`packages/fuzz/README.md`](../../packages/fuzz/README.md) and
[`packages/fuzz/ARCHITECTURE.md`](../../packages/fuzz/ARCHITECTURE.md).
