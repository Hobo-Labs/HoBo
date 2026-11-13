---
type: Reference
title: "SDLC dispatch log"
description: "Append-only outcomes for sdlc coordinator runs."
tags: [hobo, plans, sdlc]
---

## 2026-08-01 — OptimizeXP replayable evidence closeout (#1000)

- **PR:** https://github.com/Tyler-R-Kendrick/HoBo/pull/1000
- **scope:** replayable API/TUI/GUI evidence guidance, independent evidence review, verified experiment certificates, persona/scenario planning, and hobo-code empty non-TTY fail-closed entry
- **local gates:** staged `agent:check` green; @hobo/code 117 passed / 4 skipped; behavior 98 scenarios / 352 steps; `optimizexp:check` green
- **OptimizeXP:** run `20260801-hobo-code-optimizexp`; `assert-complete` and `mark-complete` green; stop `pareto-equilibrium`
- **status:** merged via squash commit `91ea7bdd1942575b372a1a740f3faf061ec54ff6`; CodeRabbit review was rate-limited because the inherited initiative diff exceeded its free file limit

# Dispatch log

Append-only outcomes for sdlc coordinator runs. Newest entries at the bottom.

---

## 2026-07-30 — sdlc-gh-stack

| Field | Value |
|---|---|
| Initiative | `docs/plans/sdlc-gh-stack/sdlc-state.md` |
| Backend | sequential-fallback (parent; skill/docs work, no implementer dispatch) |
| Issue | n/a (repo tooling / agent skill) |
| Branch | `feat/sdlc-gh-stack-skill` → `feat/sdlc-billing-merge-closeout` |
| PRs | #958 (merged); follow-up billing-merge wording PR |
| Result | **success** |
| Failure class | `billing-budget` on #958 checks only (did not block merge) |
| Notes | Installed `github/gh-stack`; expanded `sdlc` + `gh-stack` skills mirrored to all agents; bottom-up closeout + incremental checkins; clarified squash-merge still required when CI is billing-red. User confirmed agent can still squash-merge under billing failures. |

## 2026-07-31 — ax-optimizexp-land

| Field | Value |
|---|---|
| Initiative | `docs/plans/ax-optimizexp-land/sdlc-state.md` |
| Backend | sequential-fallback (parent; AX work already measured under optimizexp) |
| Issue | AX-01 land setup help + gbrain fail-closed |
| Branch | `sdlc/ax-optimizexp-land-01-setup-help-gbrain` |
| PRs | #968 (squash-merged `c37cf984`) |
| Result | **success** |
| Failure class | `billing-budget` on checks only (empty steps; spending limit annotation) |
| Notes | Local gates green (setup --help, gbrain launcher exit 1, bindings, mirrors, agent:check staged). Closeout rubber-duck + adversarial on PR comment. |


## 2026-07-31 — sdlc --finish skill

| Field | Value |
|---|---|
| Initiative | session land: `/sdlc --finish` skill flag |
| Backend | sequential-fallback (parent; skill/docs only) |
| Issue | n/a (agent tooling) |
| Branch | `feat/sdlc-finish-flag` |
| PRs | #971 |
| Result | **in progress → merge** |
| Failure class | (CI: expect billing-budget if empty steps) |
| Notes | Adds references/finish.md; dual-mirror skill; AGENTS/CLAUDE/docs pointers. |


## 2026-07-31 — ax doctor + cli-help rewire

| Field | Value |
|---|---|
| Initiative | optimizexp AX continue (doctor agent-tooling + cli-help rewire) |
| Backend | sequential-fallback (`/sdlc finish`) |
| Issue | n/a |
| Branch | `feat/ax-doctor-cli-wire` |
| PRs | #972 |
| Result | **merge** |
| Failure class | (expect billing-budget if empty-step CI) |
| Notes | doctor AUTH/MCP/setup; rewire cli-help-and-doctor off eval:agent:live; plateau runs ax-doctor + ax-cli-wire |


## 2026-07-31 — ax docs sections + WorkOS AUTH + exp-nav

| Field | Value |
|---|---|
| Initiative | optimizexp AX docs + AUTH attribution + exp-nav |
| Backend | sequential-fallback (`/sdlc finish`) |
| Branch | `feat/ax-docs-exp-nav-auth` |
| PRs | #973 |
| Result | **merge** |
| Failure class | (billing-budget if empty-step CI) |
| Notes | AX section map; WorkOS auth.md; rewire draft-exp-nav; discovery live demotion |


## 2026-07-31 — optimizexp all-exp + infinite passes

| Field | Value |
|---|---|
| Initiative | bare `/optimizexp` all-exp land via `/sdlc finish` |
| Backend | sequential-fallback (parent) |
| Branch | `feat/optimizexp-all-exp-finish` |
| PRs | [#974](https://github.com/Tyler-R-Kendrick/HoBo/pull/974) (squash-merged `10c57458`) |
| Result | **success** |
| Failure class | `billing-budget` on checks only (empty steps; jobs did not start) |
| Notes | Default `--passes` infinite; design-system → design:lint; demote gate:s1/docs:design-lint; run `20260731-all-exp` irreducible residual multi-gate agent:check F=1 L. Local agent:check staged + mirrors green. |


## 2026-07-31 — optimizexp Pareto delight + survey + persona v2

| Field | Value |
|---|---|
| Initiative | optimizexp equilibrium / delight / survey session land (`/sdlc finish`) |
| Backend | sequential-fallback (parent) |
| Branch | `feat/optimizexp-equilibrium-delight` |
| PRs | [#976](https://github.com/Tyler-R-Kendrick/HoBo/pull/976) (squash-merged `19a91d22`) |
| Result | **success** |
| Failure class | `billing-budget` (empty-step CI; no code execution) |
| Notes | Dual regime until pareto-equilibrium; cognitive thresholds; persona schema v2; survey.mts + backlog; local gates green. |


## 2026-07-31 — optimizexp all-eq delight (doctor + personas v2)

| Field | Value |
|---|---|
| Initiative | bare `/optimizexp` all-eq land via `/sdlc finish` |
| Backend | sequential-fallback (parent) |
| Branch | `feat/optimizexp-all-eq-delight` |
| PRs | [#978](https://github.com/Tyler-R-Kendrick/HoBo/pull/978) (squash-merged `a2c875c2`) |
| Result | **success** |
| Failure class | `billing-budget` (empty-step CI) |
| Notes | Doctor gbrain zero-key remediation; product-* schema v2; run 20260731-all-eq pareto-equilibrium. Local agent:check staged green. |


## 2026-07-31 — yard-first provider docs + devenv/Nix note

| Field | Value |
|---|---|
| Initiative | Yard-owned provider selection + optional Nix / devenv-first DevX (`/sdlc finish`) |
| Backend | sequential-fallback (parent; design suite docs) |
| Branch | `docs/yard-first-provider-devenv` |
| PRs | [#980](https://github.com/Tyler-R-Kendrick/HoBo/pull/980) (squash-merged `0c57c62b`) |
| Result | **success** |
| Failure class | `billing-budget` / checks still queued at merge (finish exception) |
| Notes | Design suite Camp→Yard-first language; `docs/design/devx-devenv-nix.md`; index + ADR-0006 links; camps package docs. Local `agent:check -- --staged` green. |


## 2026-07-31 — yard-first skeptic gaps + Nix posture expand

| Field | Value |
|---|---|
| Initiative | Yard-first + Nix/devenv goal — adversarial verification gap close |
| Backend | sequential-fallback (parent; design suite) |
| Branch | `docs/yard-first-skeptic-gaps` |
| PRs | [#982](https://github.com/Tyler-R-Kendrick/HoBo/pull/982) (squash-merged `1f0f8575`) |
| Result | **success** |
| Failure class | `billing-budget` / checks may still be queued at merge |
| Notes | ADR-0031 + platform-engineering + worked-example; expanded `devx-devenv-nix.md` (risks, hobo-code auto-detect, NixOS/Station, dendritic); camps residual documented; SCRATCH verification captures; camps tests 7/7; agent:check staged green. |


## 2026-07-31 — yard-first sdk-api/control-plane/wasm skeptic close

| Field | Value |
|---|---|
| Initiative | Yard-first + Nix goal — skeptic re-verify gaps on Plan-02 / Planner / wasm host |
| Backend | sequential-fallback (parent) |
| Branch | `docs/yard-first-sdk-api-fix` |
| PRs | [#984](https://github.com/Tyler-R-Kendrick/HoBo/pull/984) (squash-merged `446d4280`) |
| Result | **success** |
| Failure class | billing-budget / local main worktree cannot checkout |
| Notes | sdk-api resourceMappings + reject labels; control-plane Planner rewrite; wasm-runtime-wit Yard-owned infra; walkthrough bindings removed. provider-ownership-rg unlabeled hits empty. camps 7/7; agent:check staged green. |


## 2026-07-31 — yard-first inventory sweep (Camp-owns-provider)

| Field | Value |
|---|---|
| Initiative | Yard-first AC1 / provider-ownership gate — broad inventory one-pass |
| Backend | sequential-fallback (parent) |
| Branch | `docs/yard-first-inventory-sweep` |
| PRs | [#986](https://github.com/Tyler-R-Kendrick/HoBo/pull/986) (squash-merged `6a85628a`) |
| Result | **success** |
| Failure class | billing-budget / main worktree checkout local only |
| Notes | REWRITE=0 under broad patterns; sdk-api Runtime vs Providers; control-plane authoring provider; ADR-0090; secrets authoring + ADR-0027. SCRATCH inventory + rg. agent:check staged green. |


## 2026-07-31 — optimizexp hobo-code hermetic + stop-gate

| Field | Value |
|---|---|
| Initiative | Session land: optimizexp dual-regime closeout + hobo-code hermetic/durable for advanced-nix-devenv-developer |
| Backend | sequential-fallback (parent) |
| Branch | `feat/optimizexp-hobo-code-hermetic` |
| PRs | [#988](https://github.com/Tyler-R-Kendrick/HoBo/pull/988) (squash-merged `5f9c3199`) |
| Result | **success** |
| Failure class | `billing-budget` (S0 stage gate linux/windows empty steps ~3s; no runner work) |
| Notes | hobo-code `env` + hermetic-env + durable chrome; project persona/feature; assert-complete/mark-complete stop gate + tests; package 80/80; stop-gate 6/6; optimizexp run pareto-equilibrium. Turbo graph cycle pre-existing on main for `turbo --filter packages/code` (pnpm filter vitest green). |


## 2026-07-31 — hobo-code optimizexp surfaces session land

- Branch: `feat/hobo-code-optimizexp-surfaces`
- Work: persona + product surfaces for hobo-code optimizexp (agent, config, edit, harness, cost, guides, …)
- Finish: `/sdlc finish` — single PR squash-merge
- Package tests: @hobo/code vitest 104 passed
- Note: root turbo workspace cycle (@hobo/contracts↔core↔contract-harness) pre-existing; package filter tests green

## 2026-07-31 — hobo-code optimizexp surfaces MERGED

- PR: https://github.com/Tyler-R-Kendrick/HoBo/pull/990
- Merge: `5e88a064`
- CI: billing-red empty-step failures; package tests green locally

## 2026-07-31 — hobo-code-tui-optimizexp-finish (#992)

- **PR:** https://github.com/Tyler-R-Kendrick/HoBo/pull/992
- **merge:** `fb761534054510d2e6366b4f58a11b4cad5648fb` (squash)
- **scope:** TUI craft product + optimizexp doctor/explore + personas + scaffolds
- **CI:** billing-budget empty-step failures only; local vitest 107 green
- **protocol:** `/sdlc finish`

## 2026-07-31 — hobo-code InteractiveShell (#994–#995)

- **#994** fix stale dist launcher — merge `704a5063`
- **#995** InteractiveShell replaces stock Pi default TTY — merge `8d9a7b89`
- **CI:** billing-budget empty-step failures documented; product tests green locally
- **protocol:** `/sdlc finish`
- **residual:** streaming engine, mouse/tasks, warning budget, nix panes, optimizexp interactive hard-gate

## 2026-07-31 — optimizexp hobo-code shell polish (#997)

- **PR:** https://github.com/Tyler-R-Kendrick/HoBo/pull/997
- **merge:** `b2fe524fdc1504847094d3decbb9959ef9ae25b9` (squash)
- **optimizexp run:** `20260731-code-shell-optimizexp` stopReason pareto-equilibrium
- **CI:** billing-budget empty-step; local vitest green
- **protocol:** `/sdlc finish`

## 2026-08-01 — optimizexp CLI-experience overhaul + boyscout sweep (#999)

- **PR:** https://github.com/Tyler-R-Kendrick/HoBo/pull/999
- **scope:** optimizexp falsifiable scoring + v2 personas + product-CLI features + drift gate; 10 CLI UX defects; ULID/fence/conformance/runtime-wasm real bugs; turbo dep cycle; architecture-guard debt on main; swe-shared buf codegen; example API drift
- **review:** independent reviewer approve-with-comments, no blockers
- **CI:** billing-budget empty-step failures (conformance, rehearsal, agent-e2e, S0 ×2, offline-hello-bindle, adversarial, replay-equals-live) — same red set as #965/#997/#968; PR impact gate ran real steps; cold-runner timeouts fixed (de6d4c0a, 00a860f2); DCO satisfied via squash-commit sign-off
- **local:** check:all exit 0 (test:unit 4585, behavior 98), turbo 769/769, contracts 604+200
- **protocol:** `/sdlc finish`
- **residual:** storage-sqlite provider-verification lane (tracked in packages/storage-sqlite/contracts/provider/README.md); globalSetup wasmtime warmup scope; backlog-malformed warn; user asked to disable CI workflows to save runner minutes

## 2026-08-01 — sdlc finish (identity OpenBao + integrity membrane)
- PR: https://github.com/Tyler-R-Kendrick/HoBo/pull/1003
- Merge: `769b68a6` (squash)
- Branch: `feat/identity-openbao-secrets`
- Outcome: merged; CodeRabbit rate-limit only (not code CI red)

## 2026-08-01 — OptimizeXP bare UX/DX/AX resume (#1005)

- **PR:** https://github.com/Tyler-R-Kendrick/HoBo/pull/1005
- **branch:** `feat/optimizexp-bare-resume`
- **run:** `20260801-ux-dx-ax-bare-resume`; Pareto equilibrium; harm `5/3 → 1/1`
- **local:** staged and PR-base `agent:check` passed 12 relevant gates
- **status:** closeout in progress

## 2026-08-01 — OptimizeXP bare UX/DX/AX resume merged (#1005)

- **merge:** `9d728e752cec0239c69aa195f70ddaa2ec6da1ed` (squash)
- **result:** success; independent review blocker fixed by committing and hash-verifying `primary.cast`
- **checks:** 12 local PR-base gates green; GitHub clean/mergeable; no review threads
- **failure class:** `billing-budget` for CodeRabbit line-review quota only; its status context passed

## 2026-08-03 — Try HoBo browser WIT examples (#1008)

- **PR:** https://github.com/Tyler-R-Kendrick/HoBo/pull/1008
- **merge:** `af7fa3911b522f6d313b849acae8d1468111f800` (squash)
- **result:** success; independent review findings fixed and focused re-review clean
- **checks:** 18 impact-selected staged and PR-base gates; typed WIT component,
  protobuf/CUE/generated drift gate, 139-page build, and served Playwright journey
- **failure class:** CodeRabbit free-plan review quota only; no implementation check failed
- **protocol:** `/sdlc --finish`

## 2026-08-03 — TrafficRouting production offerings + adapters (#1011)

- **PR:** https://github.com/Tyler-R-Kendrick/HoBo/pull/1011
- **branch:** `feat/traffic-routing-vercel-lakebed-prod`
- **merge:** `8f951254ba71c2253c68f8a3f915e7ea53d99301` (squash)
- **result:** success
- **scope:** production Vercel/Lakebed adapters (no stubs); offerings + prefer/require fallback ladder; Cloudflare create lifecycle + observeHealth; Funnel multi-backend; Station applyRoutingObservations; provider trafficRouting profiles (lakebed/cf/aws/gcp/azure)
- **checks:** local `agent:check --base=origin/main` 10/10 green (core/connectivity/stations + provider packages); CodeRabbit SUCCESS (rate-limited review only); no PR comment threads
- **failure class:** none for code CI; CodeRabbit free-plan rate limit only
- **protocol:** `/sdlc --finish`

## 2026-08-03 — Vision-gap closure: dispatcher→signals→loop→saga→staging→offerings→data dual

- **branch:** `feat/vision-gap-closure`
- **scope:** all seven phases of the vision-gap roadmap now implemented:
  1-2 `@hobo/dispatcher` promotion + broker `budget.ThresholdCrossed`/`Recovered`
  signal plane; 3-4 stations closed control loop + progressive cutover with the
  `domain-cutover-saga-contract` proof promoted (fail-closed preconditions,
  rollback hysteresis, refusal/TtlLowered ladder; frozen in the promotions
  ledger); 5 `pnpm run staging:cutover` (simple rehearsal green with archived
  evidence under `docs/design/instances/staging-cutover/`; vercel/cloudflare
  lanes credential-gated exit 2); 6 generic per-resource-class offering
  resolution + data-store vocabulary + station offering registry; 7 trails live
  SQLite data-dual port (CDC dual-write journal, watermark replication,
  pooled→siloed tenant scoping, divergence auto-compensate)
- **behavior:** `transparent-backend-swap.feature` — "user notices nothing when
  the backend swaps under budget pressure" (live-proxy zero-failed-requests);
  behavior lane 100 scenarios green
- **tests:** dispatcher 19, broker 70, core 78, stations 45, trails 17 green;
  architecture guard + staged agent:check green per commit
- **protocol:** goal-hook continuation of the incomplete prior session

## 2026-08-04 — Upgrade & Migration Engine M1-M4 ladder

- **branch:** `feat/upgrade-migration-m1-m4`
- **scope:** the design-gated ladder delivered end to end:
  **M1** `upgrade-preflight.ts` (HOBO-499 promotion; compatibility-input matrix,
  dry-run contract + fixtures, rollback evidence, scope-boundary register);
  **M2** live expand→backfill→contract executor (`schema-apply-port.ts`,
  `migration-executor.ts`) — snapshot-before-mutation, compat-gated contract,
  snapshot-restore rollback, full `migration.*` event family;
  **M3** pooled→siloed zero-loss tenant move (`tenant-move-port.ts` + dual-port
  fence/backfill/reap) through the identity spectrum-cutover protocol —
  conformance `source quiescent seq == silo head`;
  **M4** golden-replay corpus + upcaster-totality can-deploy gate promoted to
  `@hobo/events` with the `migration.*` v1 corpus pinned append-only
- **docs:** M1-M4 evidence sections in `upgrade-migration-engine.md`; full
  `migration.*` family catalogued in `event-families.md`; known-limitations
  HOBO-430 row moved deferred → partial with explicit provider-binding caveats
- **proofs frozen:** `upgrade-rollback-dry-run-contract`,
  `event-body-upcaster-gate` (promotions ledger now 9 frozen)
- **tests:** trails 31, events 11, identity 88, behavior lane 100 scenarios —
  all green; architecture guard + staged agent:check green per commit

## 2026-08-04 — Standards alignment (ADR-0144) + thin Convex provider (#1024)

- **PR:** https://github.com/Tyler-R-Kendrick/HoBo/pull/1024 — merge `86119ffcb`
- **scope:** critique-driven delivery of the standards-alignment instruction
  (fact-check + corrections in `docs/plans/0016`): ADR-0144 external-spec
  posture + Resource Definition versioning; platform-engineering versioning
  section; convex.md impedance boundaries; new wasp.md capture;
  `@hobo/provider-convex` (honest equivalence classes, deploy-key-brokered
  manifest, convex-deploy driver programs, typed impedance, fail-closed
  cred-gated Management API); AGENTS.md bindle-first guidance;
  live-provider-matrix row
- **tests:** provider-convex 23/23; architecture guard + staged agent:check
  green per commit (ADR index + traceability gates included)
- **protocol:** goal-hook one-shot with two Explore fact-check sweeps

## 2026-08-04 — Lineage credits + Trait/Boundary + jurisdiction/compliance core (#1028)

- **PR:** https://github.com/Tyler-R-Kendrick/HoBo/pull/1028 — merge `1658bbf07`
- **scope:** three-workstream brainstorm formalization: canonical
  `docs/design/lineage.md` credits surface + nine new influence captures
  (tailscale, cedar, temporal, argo-cd, flux-cd, service-mesh pattern, cnab,
  oam, octopus-deploy); ADR-0145 first-class Trait + architecture component/
  boundary taxonomy + glossary rows; ADR-0146 typed legal geography
  (`@hobo/core` jurisdiction port, fail-closed `evaluateResidency`,
  `Tenant.residency`, Gatekeeper `residency` gate) + `@hobo/policy` residency
  pack (`eu-data-stays-in-eu` realized) + control→evidence packs with NIST
  800-53 seed + `docs/standards/oscal.md`
- **tests:** core 85 / policy 23 / contracts 36; codegen CLEAN; guard green;
  staged agent:check green per commit
- **protocol:** plan-mode brainstorm (3 Explore sweeps) → approved plan →
  single-branch delivery


## 2026-08-04 — Remediation roadmap (0017)

- **scope:** scoped solutions for the full gap inventory as
  `0017-remediation-roadmap` (a plan, not kept in the repository) — 36 items across 7 workstreams
  (correctness, ADR-0146 loop, compliance, flagship local/WASM lane, placement
  expressiveness/Radius deliverables, all ✱ aspirational packages, register
  audits), each with verified seam facts, effort class, and acceptance
  criteria; inventory→WS traceability table included
- **decisions:** roadmap-doc-only session; WASM + local/self-host are
  first-class live lanes (3P provider credentials are end-user-supplied —
  fail-closed + contract-proven request formation is the 3P completion bar);
  all ✱ packages fully scoped
- **protocol:** plan-mode (1 seam-probe Explore sweep) → approved plan →
  single docs PR

## 2026-08-04 — restore HoBo Rubberhose; pixel-RPG becomes its own project (PR #1032)

- **trigger:** owner rejection — *"You ended up redoing the website instead of
  the game… I want my website design back."*
- **branch:** `restore/rubberhose-identity` (2 commits, off `origin/main`)
- **protocol:** sequential-fallback, coordinator-implemented (a revert of a
  merged identity change is shared-file work end to end — no layer was
  separable enough to dispatch)
- **outcome:** `site/` + `packages/control-yard/` restored to HoBo Rubberhose
  with Bo; pixel-RPG preserved as `@hobo/pixel-village` owning `HoBo Pixel`;
  five generated Bo action sheets restored to `site/public/bo-actions/` as
  site-only assets with frame metadata; ADR-0149 supersedes ADR-0148's identity
  clauses while keeping its buildability rule
- **gotcha worth remembering:** `git checkout <sha> -- <path>` does **not**
  delete files absent from that commit, so the first restore left a silent mix
  of rubberhose and pixel-era files that only surfaced as type errors. Both
  directories had to be removed first and restored whole.
- **state:** `docs/plans/highball-pixel-control-plane/sdlc-state.md` § Reversed
  by the owner

## 2026-08-04 — Remediation roadmap execution (0017 → wave 1–3)

- **scope:** the 0017 roadmap executed to completion on
  `feat/remediation-wave-1` — WS-A (match.Decided convergence, ADR-0149
  renumber, OKF, gap-analysis re-score to 35 rows), WS-B (full ADR-0146
  residency loop: Gatekeeper dimension, verify --region + env tenant
  constraints through the policy layer, broker residency plane + placement
  hard filter, typed context.dataClassifications, junction fail-closed
  guard, opt-in adequacy/SCC transfer mechanisms), WS-C (OSCAL emitter,
  SOC2/GDPR seed packs, OCSF widening + JWS batch signing), WS-D (real jco
  componentize lane, scheduler port v1, BindleBuilder completion, real
  credential-gated Cloudflare cloud-native provider, RFC 8628 device-code
  login), WS-E (placement vocabulary, RealizationResult contract,
  app-graph projection + `hobo inspect graph`, staged rollouts), WS-F
  (new packages: sdk, registry, evals, training, agent-skills; opa/cedar
  extractions; opentofu documented flag; npm-publish design 0018 —
  F28/F29/F31/F32 remain full solution sketches per the recorded user
  decision), WS-G (GAPS Iteration-5: 40 confirmed findings, 23 same-pass
  remediations; known-limitations refresh)
- **findings of note:** bindles schedule() lowers via the standard
  hobo:data+paradigm pattern (roadmap D14 wording corrected); real wasm
  bytes are not byte-stable across runs (Wizer, ADR-0105) so determinism
  is asserted on inputs metadata; the shipped CLI never ran the residency
  dimension until IMPL-022's same-pass fix
- **tests:** core 106 / contracts 38 / policy 32 / broker 75 / junctions
  29 / cloud 80 / hobo 247 / identity 96 / runtime-local 70 /
  componentize 20 / runtime-cloud-native 22 / cli 83 / sdk 40 /
  registry 21 / evals 17 / training 22 / agent-skills 6 /
  provider-opa 4 / provider-cedar 4 / conformance 65 — all green;
  architecture guard green; staged agent:check green per commit
- **protocol:** parallel implementer subagents on disjoint package sets
  (edit+test only, coordinator commits), three read-only GAPS finders +
  coordinator verifier, rubber-duck + adversarial review before every
  commit batch

## 2026-08-06 — Examples Temporary Accounts + all-provider anon hosts

| Field | Value |
|---|---|
| Initiative | `docs/plans/try-hobo-browser-wit/sdlc-state.md` |
| Backend | sequential-fallback (parent) |
| Branch | `feat/examples-temporary-anon-hosts` |
| PRs | [#1048](https://github.com/Tyler-R-Kendrick/HoBo/pull/1048) merged `e2012e5dea` |
| Scope | Cloudflare Temporary Accounts stations + OpenSaaS; same-origin `/api/anon` for other yards; never blob-as-remote; live Playwright matrix |
| Gates | live `examples:regression` / `:opensaas` / `:anon` PASS; staged `agent:check` at finish |
| Status | closed — Pages deploy follow-up publishes WIT `examples/runtime` (nested gitignore fix) |



## 2026-08-10 — full-gate verification sweep after getting latest

- **scope:** `check:all` run against merged main (`601a2154b`, PRs through
  #1053) surfaced three cold-checkout breaks, all fixed: (1) the
  package-boundaries model (`packages/conformance/src/boundaries.ts`) was
  missing nine packages (dispatcher, rift, pixel-village, yard-world, sdk,
  registry, evals, training, agent-skills) so `lint:boundaries` threw before
  evaluating a single rule; four now-visible outward edges recorded as
  documented exceptions (provider-opa/cedar→contracts per 0017 F30,
  provider-convex→bindles devDep-only, adapter-openbao→identity per #1003);
  (2) the hobo-code-harness-experience draft proof still called
  `startCodeSession`/`complete` synchronously after #1027 made them async —
  proof, test, and example made async; (3) the examples-console cucumber
  scenario (#1048) required a manually started `astro dev` — the steps now
  boot and tear down the dev server themselves with a cf-temp health poll.
- **verified:** boundaries green (zero violations); behavior 108/108;
  draft artifacts, cascade, schema, standards, licenses, docs
  coverage/design/OKF all green; unit lane 737 files green (3 tsc-in-test
  proofs are 5s-timeout flaky only under full parallel load — pass in
  isolation). Stale-dist gotcha noted: a warm worktree with a pre-#1048
  `@hobo/bindles` dist 500s the examples console; rebuild fixes it.

## 2026-08-18 — AI SDK harness adapters (`/sdlc --finish`)

| Field | Value |
|---|---|
| Initiative | `docs/plans/ai-sdk-harness-adapters/sdlc-state.md` |
| Backend | sequential-fallback (parent; stack already implemented) |
| Issue | n/a (session land) |
| Branch | `sdlc/ai-sdk-harness-01-schema` → `sdlc/ai-sdk-harness-02-runtime` |
| PRs | [#1128](https://github.com/Tyler-R-Kendrick/HoBo/pull/1128) squash-merged `ef18fb270`; [#1129](https://github.com/Tyler-R-Kendrick/HoBo/pull/1129) squash-merged `b5d0840d2` |
| Result | **success** |
| Failure class | no GitHub Actions required-check green (CodeRabbit SUCCESS only); treated as `billing-budget` / missing-runners — did not block squash-merge |
| Notes | Bottom-up rubber-duck + adversarial on PR comments. Exact-six designer yay per layer (`pr-1128`, `pr-1129`; 1129 reconvened after 1128 squash). Cannot self-approve. Residuals: `generateSdkText` injection, bridge needs `@ai-sdk/sandbox-vercel`, Goose stays `cli`. |

## 2026-08-01 — designer council implementation review (#1007)

- **PR:** https://github.com/Tyler-R-Kendrick/HoBo/pull/1007
- **branch:** `feat/designer-council`
- **scope:** exact-six OptimizeXP designer personas; append-only unanimous consensus protocol; current-head SDLC merge gate; cold final-runner compatibility
- **local:** PR-base `agent:check` green; `validate:final` 743/743 files, 4,629 passed and one skipped
- **status:** independent review and current-head council consensus pending before merge
- **protocol:** `/sdlc finish`

## 2026-10-26 — HoBo.CI SDKs and allocation relay

- **Branch:** `feat/hobo-ci`; initiative `docs/plans/hobo-ci/sdlc-state.md`.
- **Scope:** four monorepo packages; Actions-first hosted relay contract, five provider bridges, portable Actions/Dagger/Cloudflare execution and shared durable allocation accounting.
- **Dispatch:** parent owns shared contract/ledger; isolated Dagger, Cloudflare, Actions/act and independent protocol reviews.
- **Validation:** SDK/contract suites; 40 actual act jobs over eight admitted routing scenarios plus a denied zero-budget scenario. Provider transports are strict local contracts; no live-provider acceptance claimed.
- **Review repairs:** stale allocation and expiry, displaced queued demand, ambiguous launches, cancellation races, snapshot overlays, cache identity, bounded artifact reads, sibling-query shutdown races and tenant-bound backend contexts.
- **Closeout:** local gates, current-head independent review and exact-six SDK/DX council precede squash merge. GitHub records the final PR/head/merge state.

## 2026-10-26 — HoBo.CI delivery closed

- **PR:** [#1594](https://github.com/Tyler-R-Kendrick/HoBo/pull/1594), squash-merged to `main` as `a262136d98e6699f8093c45fb36e32ea0a931864`.
- **Result:** closed; all implementation and review findings repaired. No external resource or live-provider credentials used.
- **Validation:** 238 CI SDK/contract tests, 22 council protocol regressions, 19 relevant PR-base checks and 40 actual act jobs; denied account-budget case launches zero jobs.
- **Review:** independent technical review clean; exact-six SDK/DX council unanimous yay at final head `56fdbe73b6f09dc3a39b94bb5f8310cc17e4fb9b`, cycle 2. Current-head assertion passed immediately before merge; no unresolved PR threads.
- **Failure classes repaired:** tenant binding, ambiguous shutdown, pre-launch restart, documented pnpm argument forwarding and historical resolved-blocker validation. CodeRabbit automatic review was skipped; no GitHub Actions failure was waived.
- **Release limits:** provider bridges remain experimental; hosted onboarding, production deployment and vendor invoice feeds are separately documented platform/release work.

## 2026-10-26 — HoBo.CI production continuation

- **Branch:** `feat/hobo-ci-production`; prior SDK delivery #1594 is historical, not production acceptance.
- **Goal:** deployable hosted relay and testable original-job `runs-on: hobo` path, with account setup and budget routing.
- **Ownership:** parent shared schemas/account API/composition; isolated onboarding, lifecycle, deployment, host/ops, SDK client, acceptance and workflow-policy implementation/review.
- **Implemented:** durable tenant policy and setup state, repo discovery/PR install/protected pin, scoped client, public opt-in, binding revocation fencing, usage watermarks, bounded runtime/owner lock, packaged deployment, backup/restore and manual HoBo workflow.
- **Evidence:** actual connected seven-job act run and three failing controls; actual nonroot image lifecycle (including policy/CAS/tenant checks, restart/owner fencing/SIGTERM and readonly-backup restore); generated/HTTP/Pact/process tests. Final branch gate totals are recorded at completion.
- **External boundary:** runner-management API returned403; automatic approval review rejected an additional optional live GitHub permission probe citing earlier contract-only scope. No live test passed or external setup bypassed.


### 2026-10-26 — HoBo CI production acceptance and delivery

Production continuation PR #1596 covers the hosted relay, repository installer,
account client/API, deployment and Station budget bridge. Independent review
reproduced two authority-revocation races; both were repaired and 27 regressions
independently rerun. Final owning suites pass 588 tests, with 16 relevant staged
gates, seven connected act executions, three rejecting fault runs and seven actual
container lifecycle checks. Exact-six current-head review and PR-base gates are
required before squash merge. Actual GitHub/vendor execution remains unverified:
runner access was HTTP403 and automatic review rejected an extra optional probe;
no external account/repository resources were created.

## 2026-10-29 — HoBo CI local development runners (#1612)

- PR: https://github.com/Tyler-R-Kendrick/HoBo/pull/1612
- Backend: parent implementation plus independent read-only review; one coherent delivery branch.
- Scope: zero-price local provider, dedicated host label, automatic dev-container runner controller, pinned act and lifecycle/recovery contracts.
- Review: ambiguous registration, cleanup/status, repository-name grammar, test typing and long-idle watchdog findings resolved with executable regressions; independent review clean.
- Validation: 674 CI/Actions tests, 11 PR-base relevant checks, generated contracts/schema checks, touched script/test typecheck, 50 actual act jobs, base-image and nonroot official-runner smoke checks.
- Closeout: user authorized squash merge; developer-experience consensus and remote review/check reconciliation recorded on the PR before merge. Live GitHub assignment remains an explicit unverified boundary.

## 2026-10-29 — Cloudflare CI local execution (#1610)

- **Outcome:** squash-merged [#1610](https://github.com/Tyler-R-Kendrick/HoBo/pull/1610), `147e351edf6dd9ada52e14158f1f03e472b24acc`. Existing `@hobo/ci-cf` now includes opt-in local preparation, Wrangler/Docker execution and local R2 snapshots.
- **Review repairs:** clear inherited Git repository selectors, reject stale preparations at the same source SHA, describe committed-file inclusion accurately, and name asynchronous submission `local:trigger`.
- **Validation:** 15 staged/PR-base gates, 35 package tests and 290 root tests; clean-checkout package rerun passed 35/35. Exact-six synthetic review was unanimous yay with a current-head assertion immediately before merge.
- **PR state:** no unresolved threads or requested changes; CodeRabbit automatic review skipped by repository-star policy. No billing or code-check exception used.
- **Release boundary:** native command execution remains unverified because this host lacks the iptables socket module required by the Cloudflare proxy container. The local mode is explicitly experimental; no cloud deployment or hosted billing acceptance is claimed.

## 2026-10-29 — HoBo CI local runner end-to-end hardening

- Backend: sequential parent implementation and review; no delegation.
- Repairs: nonroot Corepack bootstrap, active-session AbortSignal drain, retained cleanup status, unreadable recovery-state reporting, and singleton-lock release before stop acknowledgment.
- Executable acceptance: two zero-budget local runs through the shipped relay and host launcher; capacity withdrawal and durable replay; three rejecting fault runs. The existing seven-provider-sequence acceptance and 50-job act corpus also passed.
- Validation: 556 Actions and 247 Vercel tests, package and touched-script/test TypeScript checks; generated embedded bootstrap refreshed from source.
- Verification boundary: GitHub integration refused creation of a disposable private acceptance repository. No unrelated repository or hosted runner was used. The full layered feature build exceeded the managed environment's disk capacity; nonroot Corepack execution passed in the base runtime. Live GitHub assignment and full feature-image validation are not claimed.

## 2026-10-29 — Local runner Pact Broker validation

- Backend: sequential parent implementation and review; no delegation.
- Replaced the local runner lane's Pact-shaped-only evidence with generated Pact consumer contracts, native provider verification and a real local PostgreSQL-backed Pact Broker.
- Coverage: 31 owned-relay interactions, 16 GitHub CLI consumer interactions, native lifecycle prerequisites, 50 act corpus jobs, two connected zero-budget local executions and three rejecting fault cases.
- Broker evidence: published source/branch versions; verified exact pair allowed; missing, failed, skewed and immutable-version mutation cases blocked. Deliberately broken verification is isolated under a negative-control version and branch.
- Validation: 573 Actions and 247 Vercel tests passed, plus touched-script/test TypeScript checks. The embedded Vercel bootstrap was regenerated after extracting the shipped JIT consumer boundary. Regression tests prove that upstream provider versions are selected independently of HoBo source versions.
- Release boundary: GitHub provider verification remains unknown in the broker. The explicit deployment command exits nonzero; the successful validation lane does not fabricate external provider approval.


## 2026-10-29 — Cloudflare CI native local production execution (#1621)

- **Outcome:** squash-merged [#1621](https://github.com/Tyler-R-Kendrick/HoBo/pull/1621), `038fd1ff5ea2aa0d87cc3dd2050f067fff62f2d8`. Parent implementation and clean-checkout review; no delegation.
- **Delivered:** managed native Worker/Workflow/Sandbox/local-R2 runs with verified terminal verdicts, frozen inputs, chunked binary artifacts, exclusive ownership, Docker-daemon-bound cleanup and conservative crash recovery.
- **Repairs:** output serialization, native journal names, case-sensitive ownership, submodules/release attributes, stale-lock races, context drift, process verification, hot reload and timestamp-driven vfs cache growth. Mandatory TPROXY interception remains enabled.
- **Proof:** complete finite production-state graph, 278 states and 3,224 transitions; independent clean checkout passed 47 tests/types/proof. All 12 staged and PR-base checks passed.
- **Native acceptance:** offline dependency install/restore; committed-source isolation; edits/deletions; shared-package rebuild without reload; 120 KB stdout and separate stderr; one MiB binary artifact and SHA; failure short-circuit, deadline, cancellation, forced crash with no repeated side effect, concurrent admission refusal, changed Docker context, overflow failure and confirmed cleanup. The complete suite passed again after rebase; six preparations reused one archive/image.
- **Review/merge:** exact-six unanimous current-head design consensus, final assertion immediately before merge; no unresolved review threads or requested changes. CodeRabbit auto-review skipped its repository-star policy; no CI/billing exception used.
- **Boundary:** production local execution is supported on Linux/WSL with a local Unix Docker engine. The formal proof covers controller safety under typed event assumptions; native execution supplies real integration evidence, not a proof of third-party internals or hosted billing. No Cloudflare account/resources were created.
