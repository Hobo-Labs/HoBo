---
type: Reference
title: "Alchemy parity delivery state"
description: "SDLC state for full Alchemy parity: measured P0-P3, Cloudflare first to live, stacked PRs."
tags: [hobo, plans, sdlc, alchemy, parity, providers]
---

# Initiative: Alchemy parity

**Phase:** dispatched (SDLC 4; council-authorized 2026-11-08, local-first)
**Slug:** `alchemy-parity`
**Baseline capture:** `docs/competitors/alchemy.md` researched 2026-08-19
**Research refresh:** 2026-11-08, council workflow (5 researchers + adversarial
critic + synthesis); full evidence in `research.md` in this folder.

## Goal

HoBo supports every hosting provider and pattern family Alchemy ships or is
about to ship in `v2.0.0-beta.86`, at an honestly measured parity level, without
copying the parts HoBo ADRs forbid (Effect public API, provider-specific Bindle
types, plaintext secrets, schemaless boundaries, real-cloud PR-default tests).

## Parity definition (measurable; council-adopted)

| Level | Meaning | Claimable? |
|---|---|---|
| P0 | Catalog/slot/profile row exists. Deploy may fail closed. | **No.** Label design-only. |
| P1 | Fake-transport resolver + `@hobo/conformance` provider-lifecycle 6 cases (create/update/replace/delete-idempotent/adopt/crash-resume) + PACT at boundary. | Yes, as "simulated". |
| P2 | Cred-gated live reconcile, same 6 cases on a real account + deterministic-name recovery + no-plaintext conformance (ADR-0027) + impedance in PortabilityReport (ADR-0144) + zero-orphan cleanup sweep. | **Only level counted as live parity.** |
| P3 | Timed first-day script executed end to end (install → new → dev watch → up real URL → logs → test → down), minutes recorded vs Alchemy getting-started. Unexecuted = not parity. | Yes, per pattern. |

Claim format always shows the denominator, e.g.
`Cloudflare P2: bucket/kv/queue/api (4/6 profiles), DX P3: 6/8 steps`.

**Target (full parity attempt, user-selected scope):** every provider/pattern
family in `plan.md` reaches **P1**; Cloudflare reaches **P2** first and becomes
the getting-started default; the developer loop reaches **P3**. Other clouds
advance to P2 in tranche order in `plan.md`, never by relabelling P0/P1.

## Decisions

Confirmed by user (2026-11-08):

- Scope: **full parity attempt** (not P0-only, not research-only).
- Council mechanism: **SDLC skill loop** (brainstorm → plan → issues →
  subagents → stacked PRs → bottom-up closeout; designer council on
  design-relevant layers per OptimizeXP).
- Delivery: **plan doc, then stacked PRs** (`gh stack`).

Decided by the 7-harness council under the user's "don't bother me, defer
to council; local first, cloud as fallback" directive — full record in
`council-decision.md` (6/7 seats in, codex abstained on auth 401):

- Parity definition: **L1 simulated for every family + L2 local-live +
  L3 local-DX** (`council-decision.md`); cloud P2/P3 are fallback claims.
- Getting-started default: **localhost Yard**. First fallback cloud:
  Cloudflare, only after L2/L3 green.
- npm: scoped `@hobo/hobo` + `@hobo/bindles` approved.
- `iac-alchemy`: deferred spike (layer 12), kill criteria retained.
  `Alchemy.remote()` analog: out of the primary spine.
- ADR-0158/0160/0161 cuts: funded (majority 4/6), in the local-epic layer.

## Brainstorm kill-log (SDLC 1, council adversarial pass)

Survived:

- Copy seams, not fleet shape: distribution, one live default lane, dev watch,
  test harness, PR previews — plus P1 breadth for every family (this plan).
- `iac-alchemy` as a time-boxed, hard-pinned spike behind the IaC port
  (ADR-0006/0069), Effect strictly adapter-internal.

Killed (do not resurrect without a new ADR):

- Effect-TS on any public surface — ADR-0136 forbids it; effects stay
  declarative `EffectSpec`/`ResilienceProfile` contract data.
- Provider-specific resource types in Bindles (`Cloudflare.R2.Bucket` style) —
  ADR-0024/0144; `assertNoBindleProviderSelection` stands. Provider choice
  stays Camp/Yard, scored in the PortabilityReport.
- Native distilled-SDK breadth race per cloud (~200 AWS / ~110 CF / ~200 GCP
  source areas in Alchemy) — duplicates Pulumi/TF ecosystems; HoBo breadth is
  profiles × resolvers behind ports, depth first on one cloud.
- Real-cloud no-mocks as the PR-default test model — repo testing policy is
  mocked PACT boundaries; live lanes are cred-gated, opt-in, nightly.
- `profiles.json` plaintext tokens, `.alchemy` snapshot state as truth,
  Doppler/Infisical/dotenv as the secret default — ADR-0027/0113 secretless
  refs-only ladder + ADR-0135 event-sourced state stand.
- Schemaless RPC and stage `if`-branching — PACT/protobuf/CUE at boundaries,
  Matching/`match.Decided` (ADR-0033) over environment branching.
- Row-parity ("catalog slots == parity") — HoBo already has AWS 19 / GCP 14 /
  Azure 16 productIds while composed deploy fails closed (no
  ResourceDefinitions; `packages/cloud-providers/src/index.ts`). Rows are P0.

## Confirmed Alchemy facts (2026-11-08, second-route verified)

- Latest release `v2.0.0-beta.85` (2026-11-02); npm `latest=2.0.0-beta.85`,
  `next` stale at beta.72; peer `effect@^4.1.0`. Status moved alpha → beta.
- Upcoming "many more hosting providers and patterns" is **true in substance**
  for the next beta (main is 106 commits ahead of beta.85; beta.86 post in
  draft PR alchemy-run/alchemy#3169): sandbox providers merged to main
  (Modal, E2B, Daytona, Archil, Boat), Rivet, Effect Cluster, unified Sandbox
  handle, Domain host-as-Layer. It is **false** if read as Vercel/Netlify/
  Azure/Render in that release (Vercel/Azure = open draft PRs, Netlify =
  issue-only, Render = no evidence). No beta.86/GA date or milestone exists.
- Shipped since the 2026-08-19 baseline: GCP, Fly, Hetzner, Railway,
  Kubernetes, Prisma, Turso, ACME, Stripe v2; `@alchemy.run/domain`
  (app-level event-sourced DDD/CQRS + MCP/AI tools — not a control-plane audit
  log); Effect Workflows; per-cloud state defaults (DynamoDB/GCS/CF-DO);
  `drift`, programmatic Alchemist API, Provider Contributions.
- Sandbox/Rivet/Effect-Cluster packages exist on main but returned npm 404 at
  beta.85 — treat as "merged, publishing state unresolved", not shipped.

## Draft-cascade footprint

- Technical proofs: provider-lifecycle conformance live-lane spec (T2),
  npm-distribution proof (T6). Via the `draft` skill; no ad-hoc files.
- Experience proofs: `dx` first-day script (T9), `api` test-harness surface
  (T11). `ux`/`cx`/`ax` only if a layer touches those surfaces.
- Epic proof: getting-started real lane (T9) aggregates T3/T4/T6/T7/T8.
- Project rollup: none (no fake MVP).

## Planned stack (bottom → top)

Recorded before dispatch, per `references/stacked-prs.md`. One issue per layer
where possible; task IDs (T1…) are defined in `plan.md`, contracts in
`issues.md`.

Primary (local, zero cloud deps) — per `council-decision.md`:

1. `sdlc/alchemy-parity-01-taxonomy` — T1 taxonomy with L-levels + T2 simulated contract.
2. `sdlc/alchemy-parity-02-local-yard` — localhost ResourceDefinitions; composed deploy stops failing closed.
3. `sdlc/alchemy-parity-03-bindings-runtime` — T5 typed `ctx.bindings` clients.
4. `sdlc/alchemy-parity-04-npm-distribution` — T6 packed `@hobo/hobo`/`@hobo/bindles`.
5. `sdlc/alchemy-parity-05-local-dx` — T7 dev watch + T8 local logs.
6. `sdlc/alchemy-parity-06-local-testing` — `@hobo/testing` in-process lane.
7. `sdlc/alchemy-parity-07-breadth-p1` — T14–T19 every remaining family to L1.
8. `sdlc/alchemy-parity-08-local-epic` — T9 as L3 timed local script + T10 cut closure.

Fallback (after L2/L3 green; cred-gated; never the getting-started default):

9. `sdlc/alchemy-parity-09-cloudflare-fallback` — T3/T4 Cloudflare P2 + auth profile.
10. `sdlc/alchemy-parity-10-cloud-ci-fallback` — T11 ephemeral-Camp + T12 PR previews.
11. `sdlc/alchemy-parity-11-cloud-p2-fallback` — T20 P2 waves per cloud.
12. `sdlc/alchemy-parity-12-iac-alchemy-spike` — T13 deferred spike (may end in a documented kill).

## Open gates

- [x] Dispatch: user delegated all gates to the 7-harness council
      (2026-11-08); council authorized local-first dispatch.
- [x] npm name: scoped `@hobo/hobo` approved by council (6/6).
- [ ] Fallback-only, at layer 09: cred-gated Cloudflare account + cost cap +
      orphan-sweep owner. Not an entry gate for primary layers.
- [ ] Codex council seat: auth 401 at decision time; retry seat at next
      council round.

## Designer council

```yaml
designerConsensus:
  required: true # layers 03/04 touch CLI/DX surfaces; classify per layer at closeout
  reviewId: null
  cycle: null
  result: null
  consensusEntryId: null
  proposalDigest: null
  reviewedHeadSha: null
  assertedAt: null
```
