---
type: Reference
title: "Alchemy parity — council decision (local-first)"
description: "7-harness council verdicts on reordering and all open gates. Coordinator synthesis is the authority for dispatch."
tags: [hobo, plans, sdlc, alchemy, council]
---

# Council decision — 2026-11-08

User directive: "Don't bother me — defer to council of agents using muse,
kimi, grok, cursor, claude, codex, and opencode. Prioritize local first
without cloud deps. Cloud scenarios like Cloudflare are fallbacks."

## Seats

| Seat | Verdict | Notes |
|---|---|---|
| muse | in | headless `muse exec` |
| kimi | in | headless `kimi -p` (2.5.2) |
| grok | in | headless `grok --single` |
| cursor | in | `cursor-agent --trust -p` (first run refused: workspace trust) |
| claude | in | headless `claude -p` |
| codex | **abstain** | `codex exec` failed: 401 Unauthorized (no bearer). Not a dissent. |
| opencode | in | `opencode run` |

Raw verdicts: session scratch `/tmp/council-out/{muse,kimi,grok,cursor,claude,opencode}.txt`
(not committed; this file is the durable synthesis).

## Tallies (of 6 seated)

| Question | Result |
|---|---|
| Reorder local-first, cloud to fallback layers | **6/6** |
| npm scoped `@hobo/hobo` (+ `@hobo/bindles`) | **6/6** |
| `iac-alchemy` spike: defer (kill criteria retained) | **6/6** |
| `Alchemy.remote()` analog: out of primary spine | **6/6** |
| First fallback cloud: Cloudflare | **6/6** |
| ADR-0158/0160/0161 cuts: fund all three | **4/6 fund-all** (grok: relabel 0161; muse: relabel 0160/0161) — majority funds all, sequenced in local-epic layer |
| L2/L3 local parity replacing CF-P2 as primary | **6/6** in substance (naming varies: L2/L3, LP1, Local-P2/P3) |

## Adopted definitions

- **L1 Simulated** (= P1): fake-transport resolver + 6 conformance cases
  (create/update/replace/delete-idempotent/adopt/crash-resume) + PACT.
- **L2 Local-live (primary parity):** same 6 cases against real local
  processes on the seeded localhost Yard, WAN disabled, no cloud
  accounts/keys, loopback only; deterministic names; crash-resume from the
  SQLite EventStore; `requireNoPlaintextConformance` green; impedance in
  PortabilityReport; zero orphans (processes/ports/files/containers) after
  `down`. Claim shows denominator, e.g. `Local L2: 6/6 …`.
- **L3 Local-DX:** timed offline script (install from packed artifacts →
  `new` → dev watch <1 s → local URL 200 → logs → in-process test → clean
  `down`); minutes recorded; unexecuted = not parity.
- Cloud **P2/P3** remain defined as before but are **fallback claims only**,
  reported as a secondary column.

## Adopted stack (bottom → top)

Primary (local, zero cloud deps):

1. `sdlc/alchemy-parity-01-taxonomy` — T1 + T2 simulated contract + L-levels.
2. `sdlc/alchemy-parity-02-local-yard` — localhost ResourceDefinitions,
   composed deploy stops failing closed (new; council-named first build).
3. `sdlc/alchemy-parity-03-bindings-runtime` — T5 typed `ctx.bindings` clients.
4. `sdlc/alchemy-parity-04-npm-distribution` — T6 packed `@hobo/hobo`/`@hobo/bindles`.
5. `sdlc/alchemy-parity-05-local-dx` — T7 dev watch + T8 local logs.
6. `sdlc/alchemy-parity-06-local-testing` — `@hobo/testing` in-process lane.
7. `sdlc/alchemy-parity-07-breadth-p1` — T14–T19 all families to L1.
8. `sdlc/alchemy-parity-08-local-epic` — T9 as L3 timed local script + T10 cuts.

Fallback (only after L2/L3 green; cred-gated; never the getting-started default):

9. `sdlc/alchemy-parity-09-cloudflare-fallback` — T3/T4 Cloudflare P2 + auth.
10. `sdlc/alchemy-parity-10-cloud-ci-fallback` — T11 ephemeral-Camp + T12 PR previews.
11. `sdlc/alchemy-parity-11-cloud-p2-fallback` — T20 waves (AWS → GCP → K8s →
    Azure → Vercel/Netlify → DO/Hetzner → satellites).
12. `sdlc/alchemy-parity-12-iac-alchemy-spike` — T13 deferred spike.

## Kills ratified by council

Cloudflare-first default · "only P2 counts" · real-Cloudflare-URL as primary
P3 · ephemeral-Camp/PR-previews on the spine · cred-gated account as an entry
gate · T13/T20 before L2/L3 · `remote()` anywhere near getting-started.
All ADR kills from SDLC 1 stand (Effect public API, provider Bindle types,
plaintext secrets/state, schemaless boundaries, real-cloud PR-default tests,
row-parity).

## Council use at every step (standing)

- **Decisions:** headless council round (this file). Codex seat retries when
  auth is repaired; an abstention never blocks a ≥4/6 majority.
- **Implementation:** layers assigned across harnesses where headless edit
  modes probe true; otherwise Muse subagents in isolated worktrees.
  One package per implementer; incremental commits; `.sdlc/report.json`.
- **Review:** each layer gets rubber-duck + adversarial + an independent
  reviewer from a *different* harness than its implementer, plus the
  OptimizeXP designer council on design-relevant layers (04/05/08 expected).
- **Closeout:** bottom-up per `stacked-prs.md`; billing-red CI documented,
  never blocking; designer `assert-yay` re-run on current HEAD before merge.
