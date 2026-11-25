---
type: Reference
title: "Stage 5 Forge & Extensibility Acceptance & Productionization Plan"
description: "Source issue: S5-01."
tags: [hobo, design]
---

# Stage 5 Forge & Extensibility Acceptance & Productionization Plan

Source issue: S5-01 ([HOBO-646](https://linear.app/quickdeploy-ai/issue/HOBO-646/s5-01-m0-acceptance-record-productionization-plan-for-stage-s5-forge)).

Executable proofs:

- [`generation-pipeline-training-ai-safety`](../../src/draft/epic-proofs/generation-pipeline-training-ai-safety/README.md)
- [`providers-iac-build-adapters`](../../src/draft/epic-proofs/providers-iac-build-adapters/README.md)
- [`portability-registry-distribution`](../../src/draft/epic-proofs/portability-registry-distribution/README.md)

Branch evidence:

- [`build-s5-forge-acceptance`](./proofs/build-s5-forge-acceptance/README.md)

This M0 record defines the accepted productionization scope for Stage 5 (Forge & Extensibility). It
does not build Forge runtime code, `stub()` behavior, conformance-suite expansion, eval/training
engines, Registry certification runtime, sandbox executors, or live-fix sagas.

Design sources: [roadmap Stage 5](../archive/roadmap.md), [requirements](../archive/requirements/requirements.md)
(FR-040/041/042, NFR-007, R-1), [generated stack](./generated-stack.md#plan-23), [AI generation launch
posture](./ai-generation-launch-posture.md), and ADRs [ADR-0010](./adr/03-data-plane.md#adr-0010),
[ADR-0023](./adr/02-identity-security.md#adr-0023), [ADR-0025](./adr/03-data-plane.md#adr-0025),
[ADR-0048](./adr/03-data-plane.md#adr-0048), [ADR-0062](./adr/07-portability-extensibility.md#adr-0062),
[ADR-0076](./adr/02-identity-security.md#adr-0076).

## M0 Acceptance Record

Stage 5 (Forge & Extensibility) is accepted for M1 implementation only when this record and the
promoted epic proofs agree on:

- the user/business goal and primary personas;
- the three-part stage gate restated from the roadmap and requirements;
- scope in, scope out, and non-goals;
- the production package ownership map and architectural contracts for follow-ups;
- the four decided Stage-5 hooks (D1–D4);
- the `gen.*` event vocabulary;
- promoted proof evidence; and
- the follow-up issue gate.

**S5-02 through S5-10 stay blocked until this record is merged and indexed.**

## User And Business Goal

Stage 5 breaks the human bottleneck on breadth: AI generates providers (new backends) and
implementations (components behind WIT ports), certified by conformance + trace replay and promoted
through explicit gates. The business goal is to make `hobo forge <url>` yield trustworthy, signed
providers and to let stubbed ports evolve into conformance-passing implementations without weakening
the contract-first trust boundary.

## Primary Personas

| Persona | Need |
|---|---|
| Platform engineer certifying a generated provider | Runs cold-start generation, reviews conformance + trace-replay evidence, and publishes signed providers only after sandbox validation passes. |
| ML-ops engineer promoting a trained semantic function | Captures trajectories, scores live evals, and promotes challengers through champion/challenger + shadow traffic without blocking the champion on regressions. |
| SRE repairing via gated live-fix | Retains failing traces, validates candidate fixes sandboxed, and routes prod/high-risk remediation through approval hooks with auto-rollback on regression. |
| SecOps reviewer verifying supply-chain trust | Verifies SLSA-style provenance, SBOM presence, CVSS publish gates, unsigned-plugin refusal, and install-side signature/provenance/conformance/trust verification. |

## Stage Gate (Restated)

From [roadmap Stage 5](../archive/roadmap.md) acceptance gate (verbatim):

> `hobo forge <provider-url>` yields a certified provider that passes conformance + appears (signed)
> in the Registry; a stubbed port gets an AI-generated implementation that passes conformance +
> reproduces recorded traces, promoted through a gate; a simulated SLO regression triggers a gated
> live-fix that auto-rolls-back on failure + keeps the failing trace as a test.

Mapped to requirements:

| Gate clause | Requirement | M0 decision |
|---|---|---|
| `hobo forge <provider-url>` → certified signed provider in Registry | **FR-041** — Forge generates a candidate provider from docs/OpenAPI/Terraform, sandbox-tests against conformance, signs + publishes on pass. | Cold-start generation pipeline (`scaffold → LLM-fill → sandbox validate → bounded repair → certify`) owns this path in `packages/forge/`; Registry publication is signed with provenance via `packages/registry/`. |
| Stubbed port → promoted AI implementation reproducing recorded traces | **FR-040** — `stub()` behind any WIT port records calls and returns typed responses so an app runs before impls exist. | `stub()` boundary modes in `packages/runtime/` per [ADR-0076](./adr/02-identity-security.md#adr-0076); promotion through eval + policy gates in `packages/evals/` and `packages/forge/`. |
| Gated live-fix with auto-rollback; failing trace kept as permanent regression test | **FR-042** — AI implement/evolve/live-fix, gated: low-risk auto-canary w/ auto-rollback; prod/high-risk requires approval. | Live-fix saga in `packages/forge/` + `packages/runtime/`; failing trace always retained; D1 defines low-risk-auto threshold. |

Staged acceptance ([requirements](../archive/requirements/requirements.md)):

> **Stage 5:** `hobo forge <url>` produces a certified provider passing conformance; a stubbed port
> gets an AI-generated, conformance-passing implementation promoted through the eval gate.

## Package Ownership Map

Follow-up implementation issues own these production surfaces. Nothing is built in S5-01.

| Target | Publishes | Contents | Package anatomy |
|---|---|---|---|
| `packages/forge/` | `@hobo/forge` | Generation pipeline: scaffold, LLM-fill, sandbox validate, bounded repair, certify; `hobo forge` CLI surface; live-fix saga orchestration. | `src/`, `data-models/` (protobuf-first + CUE constraints), `contracts/` (PACT at every service boundary), `wit/` for generation-pipeline and training-engine host ports. |
| `packages/evals/` | `@hobo/evals` | Rubrics, promotion thresholds, champion/challenger, shadow traffic, min-samples floor; live-eval rewards. | `src/`, `data-models/`, `contracts/`. |
| `packages/training/` | `@hobo/training` | **Internal** default `training-engine` port implementation; Agent Lightning/Trace adapters never exposed to SDK users ([ADR-0025](./adr/03-data-plane.md#adr-0025)). | `src/`, `data-models/`, `contracts/`, `wit/` for `training-engine`. |
| `packages/runtime/` | `@hobo/runtime` | `stub()` and boundary modes (`live` · `mock` · `record`/`replay` · `fork` · `shadow` · `fault`) per [ADR-0076](./adr/02-identity-security.md#adr-0076) and FR-040. | `src/`, `data-models/`, `contracts/`, `wit/` where runtime owns host seams. |
| `packages/conformance/` | `@hobo/conformance` | Per-WIT-interface suite expansion, coverage report, publish gate blocking Registry listing until every claimed interface passes. | `src/`, `data-models/`, `contracts/`, `wit/` for conformance harness ports. |
| `packages/registry/` | `@hobo/registry` | Certification records (`gen.Certified` / `gen.PluginCertified` projections), signature/provenance verification at install, listing availability without auto-selection. | `src/`, `data-models/`, `contracts/`. |

**Architectural contracts for follow-ups (non-negotiable):** PACT at every service boundary;
protobuf-first records with CUE constraints in each package's local `data-models/` folder (no
repo-wide catalog); parse-don't-validate derived types at boundaries; CQRS/event-sourced state —
actors emit append-only `gen.*` events and never mutate read models directly.

## Stage-5 Decisions (Hooks)

### D1 — Low-risk-auto threshold (FR-042)

A generated change may auto-apply (as a canary with auto-rollback) only when **all** hold:

- non-production environment;
- conformance green for the claimed port and all recorded traces replay identically;
- blast radius ≤ 1 resource (`maxBlastRadius: "1 resource"`);
- reversible via the gated deployment saga;
- within spend cap (`spendCapUsd` default 50);
- does not touch a high-trust port.

Anything else (prod / high-risk / spend / destructive) routes to a human-approval `createHook`. The
failing trace is always retained as a permanent regression test.

Sources: [generated stack live-fix](./generated-stack.md#live-fix-gated-by-default), [roadmap Stage 5
hooks](../archive/roadmap.md), FR-042.

### D2 — Forge model/eval design (FR-041)

One engine, two entry points (cold-start generation and continuous evolution) behind the
`training-engine` WIT port:

`scaffold → LLM-fill → sandbox validate` (Firecracker + wasm, **no egress**; conformance + trace
replay) `→ bounded repair` with **default repair budget of two automated attempts**, then
`gen.NeedsHuman`.

Promotion requires all four lenses — **Contract** hard-blocks, **Eval** thresholds with
champion/challenger + shadow traffic + min-samples floor (a regressing candidate stays in shadow,
never blocks the champion), **Policy** decides allowance, **Trace** records what happened. Eval
rubrics/thresholds live in `packages/evals/`.

Sources: [generated stack](./generated-stack.md#the-generation-pipeline), [ADR-0010](./adr/03-data-plane.md#adr-0010),
[ADR-0025](./adr/03-data-plane.md#adr-0025), [HOBO-211](https://linear.app/quickdeploy-ai/issue/HOBO-211/spike-generateprovider-correctness-convergence-determinism-and).

### D3 — Human-certification threshold for high-trust ports (R-1)

Prod and high-trust certifications always require human approval via `createHook`. The high-trust
port list at Stage 5:

- identity/token-brokering;
- secrets;
- policy/gatekeeper;
- spend/payment-affecting ports;
- any port whose failure breaks tenant isolation.

Production certification additionally requires full local + real Camp provider-suite coverage
([HOBO-211](https://linear.app/quickdeploy-ai/issue/HOBO-211/spike-generateprovider-correctness-convergence-determinism-and)
bar); reference certification must be tied to the actual validation report.

**R-1 (verbatim):** *"Forge yields insecure/low-quality providers"* — mitigated by *"Conformance +
sandbox-no-egress + signing/provenance + human gate for high-trust"* ([requirements](../archive/requirements/requirements.md)).

### D4 — SLSA plugin provenance chain (NFR-007, TR-112)

Every certified artifact is signed with SLSA-style provenance pinning model + frozen prompt + seed +
input digests + conformance report (artifact digest reproducible); CycloneDX SBOM attached; CI
blocks publishing on CVSS ≥ 7.0 with a documented waiver path; the Registry refuses unsigned plugins
(NFR-007: "unsigned plugin refused"); install-side verification (signature, provenance, conformance,
catalog, trust tier) fails closed; certified listings become available to Matching but are never
auto-selected.

**NFR-007 (verbatim):** *"AI-generated code is sandboxed (Firecracker + wasm capability, no egress
in conformance) and only runs if signed + conformance-passing"*; verification: *"Executor egress
test; unsigned plugin refused"* ([requirements](../archive/requirements/requirements.md)).

**TR-112:** plugins signed w/ SLSA-style provenance + conformance report; CycloneDX SBOMs; CI blocks
publishing on CVSS ≥ 7.0 ([requirements](../archive/requirements/requirements.md)).

Supply chain posture: [ADR-0023 item 7](./adr/02-identity-security.md#adr-0023) — *"all published
artifacts carry CycloneDX SBOMs; CI blocks publishing on CVSS ≥ 7.0 (with a documented waiver path);
plugins signed with SLSA-style provenance. (TR-112)"*.

## Event Vocabulary

Stage 5 uses only cataloged `gen.*` tokens ([event families](./event-families.md)). The family is
append-only per CQRS/event-sourcing rules — actors emit events; projections rebuild from the log.

| Event | Role |
|---|---|
| `gen.Requested` | Forge run requested for a target WIT port + Capability Manifest. |
| `gen.CandidateGenerated` | Scaffold + LLM-fill produced a candidate artifact. |
| `gen.Validated` / `gen.ValidationFailed` | Sandbox conformance + trace replay outcome. |
| `gen.SafetyRejected` | Post-conformance safety finding (egress, capability, dependency abuse). |
| `gen.Repaired` | Bounded repair iteration *n* with failing-assertion set. |
| `gen.NeedsHuman` | Repair budget exhausted; escalation required. |
| `gen.Certified` | Certification succeeded; extends `gen.PluginCertified` / `impl.*`. |
| `gen.PluginCertified` | Registry-ready signed provider certification projection. |

Do **not** introduce uncataloged generation event families — only `gen.*` tokens listed in
[event families](./event-families.md) are valid.

## Promoted Proof Evidence

| Epic proof | Slice evidenced | Runnable command |
|---|---|---|
| [`generation-pipeline-training-ai-safety`](../../src/draft/epic-proofs/generation-pipeline-training-ai-safety/README.md) | Cold-start provider certification; training/eval promotion; live-fix gating with failing-trace retention and human approval. | `pnpm --prefix src/draft/epic-proofs/generation-pipeline-training-ai-safety test` |
| [`providers-iac-build-adapters`](../../src/draft/epic-proofs/providers-iac-build-adapters/README.md) | Generated and distributed provider trust: no-egress generation, bounded repair, malicious-provider containment, signed Resource Packs (`generation-certification-sandbox.pact.json`). | `pnpm --prefix src/draft/epic-proofs/providers-iac-build-adapters test` |
| [`portability-registry-distribution`](../../src/draft/epic-proofs/portability-registry-distribution/README.md) | Signing/install verification: certified listings are signature, provenance, conformance, catalog, and trust verified; available to Matching without auto-selection; yank fails closed. | `pnpm --prefix src/draft/epic-proofs/portability-registry-distribution test` |

## Scope In

- Restate Stage 5 goal, three-part gate, and FR-040/041/042 mapping.
- Name primary personas and the six production package lanes with `data-models/` + `contracts/` (+ `wit/`) obligations.
- Decide hooks D1–D4 with concrete values (not open questions).
- Pin `gen.*` event vocabulary and architectural contracts for follow-ups.
- Map promoted epic proofs to acceptance bullets.
- Record follow-up gate blocking S5-02..S5-10 until this record is accepted.

## Scope Out And Non-Goals

- Do not implement `packages/*`, Forge pipeline code, `stub()` runtime, conformance expansion,
  eval/training engines, Registry certification runtime, sandbox executors, or live-fix sagas — owned
  by S5-02..S5-10.
- Do not edit promoted epic proofs under `src/draft/epic-proofs/` — cite only.
- Do not author the Stage-4 record ([S4-01](https://linear.app/quickdeploy-ai/issue/HOBO-637)) or
  Stage-6 record (S6-01).
- Do not extend public/launch generation-safety claims beyond
  [ai-generation-launch-posture.md](./ai-generation-launch-posture.md).
- Do not relax no-egress sandbox, unsigned-plugin refusal, human gate for high-trust ports, or
  CVSS ≥ 7.0 publish block — hard requirements, not tunables.

## Follow-Up Gate

Do not create or start S5-02..S5-10 until reviewers accept this M0 record and its indexed proof
README. Adjacent stage work routes to owning families: multi-cloud provider productionization remains
Stage 4; HA/FinOps/Registry distribution productionization remains Stage 6.

| Lane | Issue key | Owner package(s) | Blocked until |
|---|---|---|---|
| Conformance coverage + coverage report gate | S5-02 ([HOBO-647](https://linear.app/quickdeploy-ai/issue/HOBO-647)) | `packages/conformance/` | This record accepted |
| Forge ingestion → candidate scaffold | S5-03 ([HOBO-648](https://linear.app/quickdeploy-ai/issue/HOBO-648)) | `packages/forge/` | This record accepted |
| Forge sandbox validate + bounded repair cycle | S5-04 ([HOBO-649](https://linear.app/quickdeploy-ai/issue/HOBO-649)) | `packages/forge/` | This record accepted |
| Signing, SLSA provenance + Registry certification | S5-05 ([HOBO-650](https://linear.app/quickdeploy-ai/issue/HOBO-650)) | `packages/registry/`, `packages/forge/` | This record accepted |
| `stub()` recording typed stubs behind any WIT port | S5-06 ([HOBO-651](https://linear.app/quickdeploy-ai/issue/HOBO-651)) | `packages/runtime/` | This record accepted |
| Stub → implementation generation from traces | S5-07 ([HOBO-652](https://linear.app/quickdeploy-ai/issue/HOBO-652)) | `packages/forge/`, `packages/runtime/` | This record accepted |
| Eval rubrics, `use training` capture + promotion gates | S5-08 ([HOBO-653](https://linear.app/quickdeploy-ai/issue/HOBO-653)) | `packages/evals/`, `packages/training/` | This record accepted |
| Gated live-fix loop (risk class, auto-canary, trace-to-test) | S5-09 ([HOBO-654](https://linear.app/quickdeploy-ai/issue/HOBO-654)) | `packages/forge/`, `packages/runtime/` | This record accepted |
| Stage gate drill (`hobo forge`, stub promotion, live-fix) | S5-10 ([HOBO-655](https://linear.app/quickdeploy-ai/issue/HOBO-655)) | cross-cutting Stage-5 packages | This record accepted |
