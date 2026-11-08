---
type: Reference
title: "Alchemy parity — staged one-shot issue contracts"
description: "Linear staging (no Linear MCP in this session): one issue per stack layer, import runbook included. Coordinator creates Linear issues from this file at dispatch."
tags: [hobo, plans, sdlc, alchemy, backlog]
---

# Alchemy parity — issues (staged)

**Council amendment (2026-11-08):** contracts below predate the local-first
reorder in `council-decision.md`. Mapping: I1→layer 01 (conformance suite is
the existing `@hobo/conformance` provider-lifecycle; cred-gated live-lane spec
and draft proof move to fallback/L02), **new L02 local-yard contracts come from
the owner-map dispatch briefs**, I3 splits into layers 03/04/05, I4→layer 08
(local L3 script), I5→layers 06 (local testing) + 10 (cloud CI fallback),
I6→layer 07, I2→layer 09 fallback, I7→layer 12, I8→layer 11. Council file
wins on any conflict.

Staged per `sdlc/references/linear-planning.md` fallback: Linear MCP is not
available in this session, so the coordinator imports these at dispatch time.

**Import runbook:** initiative "Alchemy parity" → one project per stack layer
→ one issue per contract below (labels `slice`; I7 also `spike`). Create in
order I1→I8 so `blockedBy` targets exist. Paste this file's sections as issue
bodies verbatim; link the stack branch named in each contract.

**Shared guardrails (apply to every issue, not repeated per issue):**

- TS-only new files; protobuf-first + generated types + local CUE;
  parse-don't-validate; PACT per boundary; CQRS/event-store/actor flows.
- No Effect-TS public dependency (ADR-0136); no provider selection in
  Bindles (ADR-0024/0144); secrets refs-only (ADR-0027/0113).
- No live cloud calls in PR-default lanes; live = cred-gated opt-in only.
- Incremental commits: red → green → `pnpm agent:check -- --staged` → commit.
  Multiple commits per layer expected; never bypass hooks.
- Never edit coordinator files (`docs/plans/alchemy-parity/**`, `GAPS.md`,
  traceability, registries, `docs/plans/dispatch-log.md`). Report deltas in
  `.sdlc/report.json` (gates run, cascadeDeltas, requirement discoveries).
- Docs freshness in the same change. CI billing-red does not block merge
  (recurring failure class in `docs/plans/dispatch-log.md`); real red does.

---

## I1 — Layer 01 taxonomy + conformance spec (T1, T2)

**Branch:** `sdlc/alchemy-parity-01-taxonomy` · **Blocked by:** none

**Why:** Every later parity claim needs a machine-checked level (P0–P3 in
`sdlc-state.md`) and one conformance contract. Today the competitor table
overclaims and resolver counts disagree between docs.

**Context (load-bearing quotes):** "no namespace registered
ResourceDefinitions, deploy fails closed" (`packages/cloud-providers/src/index.ts`
honest-scope header); ADR-0157–0161 cuts are enumerated in `research.md` §3.

**Scope in:** `packages/cloud-providers/**`, `packages/conformance/**`,
`docs/design/live-provider-matrix.md`, `docs/competitors/alchemy.md`
(+ generated `docs/competitors/matrix.md` via the fix script), one technical
proof via the `draft` skill for the live-lane spec.
**Scope out:** any resolver behavior change (I2/I6 own those).

**Steps:** 1) Add failing tests: parity-level enum on each provider export;
matrix denominator assertion; live-lane spec refuses to run without explicit
cred+cost-cap env. 2) Implement taxonomy + recount resolver constants by
importing them in tests (resolve DO/Hetzner/K8s/Hostinger doc conflicts from
code, then fix prose). 3) Refresh `alchemy.md` to beta.85 + beta.86-merged
facts from `research.md`, keeping researched-date + contract frontmatter.
4) Draft-skill technical proof for the T2 live-lane conformance spec.

**Acceptance:** `pnpm --filter @hobo/cloud-providers test` green;
`pnpm --filter @hobo/conformance test` green; `pnpm run draft:artifacts`
green for the new proof; `pnpm agent:check -- --staged` green per commit.
**Verifiable output:** parity table rendered from code in test output +
refreshed competitor capture. **Draft artifacts:** `proof.json`, executed
`examples/`, bench (technical-proof standard).

## I2 — Layer 02 Cloudflare P2 + auth profile (T3, T4)

**Branch:** `sdlc/alchemy-parity-02-cloudflare-p2` · **Blocked by:** I1
**Pre-gate:** user names cred-gated Cloudflare account + cost cap (state file).

**Why:** First live parity + getting-started default. Cloudflare has the
deepest HoBo resolvers (6/6) but composed deploy fails closed.

**Scope in:** `packages/providers/provider-cloudflare/**`,
ResourceDefinition registration path it needs, `packages/identity/**` (auth
profile), CLI login wiring for the profile. **Out:** other clouds (I6/I8).

**Steps:** 1) Failing conformance: six lifecycle cases against fake transport
with new definitions. 2) Register definitions; deterministic physical names;
read-based recovery + adopt. 3) OAuth/profile flow, secretRef-only storage.
4) Cred-gated live run + orphan sweep; record results in proof notes.

**Acceptance:** six cases pass fake + live (live output attached to PR);
`requireNoPlaintextConformance` green; zero orphans after destroy;
claim written exactly as `Cloudflare P2: 6/6 profiles`.
**Verifiable output:** live run transcript + sweep report in PR body
(`sdlc-report` fence). **Draft artifacts:** cascade update to any referencing
epic proof (`draft:cascade` green).

## I3 — Layer 03 bindings + DX (T5–T8)

**Branch:** `sdlc/alchemy-parity-03-bindings-dx` · **Blocked by:** I1 (T8 also I2)
**Design-relevant:** read `packages/code/DESIGN.md`/`site/DESIGN.md` as
applicable before CLI/site edits; `pnpm run design:lint` before done.

**Why:** Distribution + dev loop is the measured DX root cause
(`research.md` §5), ahead of any API-shape change.

**Scope in:** `packages/runtimes/runtime-local/**` (typed clients),
publish metadata for `@hobo/hobo`+`@hobo/bindles` (coordinator approves any
`package.json` publish-field edit in-thread), `packages/cli/**` dev-watch +
logs, getting-started docs. **Out:** framework adapters (I6/T18).

**Steps:** 1) Failing tests: activation returns typed client (not string);
clean-dir scaffold smoke; watch fires rebuild; logs filters. 2) Implement
T5→T6→T7→T8 in that order, commit per unit. 3) Impeccable critique/audit on
touched visual surfaces.

**Acceptance:** clean-dir smoke <1 min recorded; watch-reload bench <1 s;
`pnpm --filter @hobo/cli test` + runtime-local tests green; MCP parity test
green. **Draft artifacts:** technical proof (npm distribution) with executed
examples + notebook + bench.

## I4 — Layer 04 epic + cut closure (T9, T10)

**Branch:** `sdlc/alchemy-parity-04-epic-patterns` · **Blocked by:** I2, I3

**Why:** P3 proof + removal of three "implemented*" asterisks (split WIT,
drizzle emission, Better Auth runtime).

**Scope in:** epic proof via `draft` skill, `packages/wit/**`,
`packages/adapters/adapter-drizzle/**`, `packages/adapters/adapter-better-auth/**`.
**Out:** CI previews (I5).

**Steps:** 1) Cucumber features for the first-day script (failing). 2) Close
T10 cuts or return a relabel delta to the coordinator with evidence — no
silent partial. 3) Execute the timed script against the I2 lane; record the
step table vs Alchemy getting-started.

**Acceptance:** `pnpm run test:behavior` green for the epic features;
`codegen:check` green after WIT change; minutes recorded in proof README.
**Draft artifacts:** epic `proof.json`, executable `features/`, executed
examples/notebook; `dx` exp-proof assets.

## I5 — Layer 05 CI/testing patterns (T11, T12)

**Branch:** `sdlc/alchemy-parity-05-ci-testing` · **Blocked by:** I2, I4

**Why:** Test.make-class harness + PR previews are Alchemy's strongest
pattern lead after local dev.

**Scope in:** `packages/testing/**`, CI/preview recipe surfaces in
`packages/hobo/**`/`packages/ci*/**` named by search at implementation time.
**Out:** live GitHub writes in tests (PACT-mocked boundary only).

**Steps:** 1) Failing lane tests replacing `HARNESS_LANE_UNIMPLEMENTED`
expectations. 2) Ephemeral-Camp provisioning, cred-gated, fidelity-labelled.
3) Preview lifecycle (create → comment → destroy-on-close) against mocked GH.
4) Broker-minted CI credential resources, refs-only.

**Acceptance:** `@hobo/testing` suites green incl. fidelity assertions;
`pnpm run test:behavior` green; no default lane touches network.
**Draft artifacts:** `api` exp-proof for the harness surface.

## I6 — Layer 06 breadth to P1 (T14–T19)

**Branch:** `sdlc/alchemy-parity-06-breadth-p1` · **Blocked by:** I1
(may run parallel to I3–I5; one implementer per package, coordinator splits
into sub-issues I6a–I6f = T14…T19 at dispatch if packages collide)

**Why:** User scope is full parity: every Alchemy family at least P1
simulated conformance, honestly labelled, before tranche-2 live waves.

**Scope in:** new `packages/providers/provider-{fly,render,planetscale}/**`,
Railway promotion, unresolved productIds in existing provider packages,
sandbox profile + realizations, workflow/Actions/DO profiles, framework
detectors, observability/AI-profile wiring — each confined to its package.
**Out:** live accounts (I8); new Bindle kinds without an ADR gate.

**Steps per family:** 1) Failing six-case conformance + PACT. 2) Slots/
profiles + fake-transport resolver + impedance note. 3) T1 taxonomy row to P1.

**Acceptance:** per-family package tests + conformance green; taxonomy test
shows P1 with denominator; zero claims above P1.
**Draft artifacts:** technical proof per new atomic concept (sandbox profile,
workflow profile) via the `draft` skill.

## I7 — Layer 07 `iac-alchemy` spike (T13) — label `spike`

**Branch:** `sdlc/alchemy-parity-07-spike` · **Blocked by:** I2 + explicit
user spike approval at dispatch gate. **Time-box:** 2 weeks.

**Why:** Test whether Alchemy-the-engine beats finishing native lanes, under
HoBo's rules — or kill it with evidence. A documented kill is a success.

**Scope in:** new `packages/iac/iac-alchemy/**` only. **Out:** any public
surface change; Effect types outside the adapter package.

**Steps:** 1) Pin `alchemy@2.0.0-beta.85` + `effect@4.1` (lockfile change is
coordinator-approved for this issue). 2) Cloudflare bucket+api live reconcile
through the IaC port; state through HoBo EventStore. 3) No-plaintext +
boundary PACT. 4) Verdict memo vs kill criteria in `plan.md` T13.

**Acceptance:** verdict memo + either green adapter tests or a kill record;
spike branch is deleted or promoted only by coordinator decision.

## I8 — Tranche 2 P2 waves (T20) — placeholder, split at dispatch

One issue per cloud wave (AWS → GCP → Kubernetes → Azure → Vercel/Netlify
permanent → DO/Hetzner → satellites), each a copy of the I2 contract shape
for its cloud: definitions, deterministic names, six cases live, secretless
auth, orphan sweep, denominator claim. Entry gate per wave: T1 row at P1,
named account/cost owner, coordinator-created stack layer on top of I6.
