# Intent-alignment gap review — Nomad × Aspire × Nitric × FinOps × agent-native

> Long-running review log for the HoBo design suite. Original owner intent: **"HashiCorp Nomad +
> .NET Aspire + Nitric with some FinOps and agent-native experiences."** Audited against commit
> `6fdbe67` on branch `claude/project-scope-gaps-review-pv38y3`.
>
> **Status key:** 🔎 candidate · ✅ confirmed · 🧯 remediation documented · ✔ remediated ·
> ❎ rejected (non-issue) · 📘 deliberate-and-documented (accepted decision, not drift).
>
> **Standing decisions (from the repo owner, 2026-07-01):**
> 1. The wasm-host pivot away from Nomad (self-hosted wasmCloud, wasm-in-container floor) is
>    **accepted** — findings check that the Nomad-concept → HoBo-design mapping is explicit and
>    complete; they do not re-litigate the decision.
> 2. This document is the long-running register; review iterations **append** to it. IDs are
>    stable and never renumbered; rejected candidates move to Verified non-issues, never deleted.
> 3. Remediations are **documented, not applied** in the review pass that confirms them.

## Intent & pillars

| Pillar | Original intent | Where it should live |
|---|---|---|
| **P1 Nomad** | Heterogeneous workload orchestration/scheduling (containers/VMs/raw-exec), bin-packing placement, federation | `docs/design/control-plane.md`, `docs/design/platform-engineering.md`, `docs/design/adr/01-architecture-core.md`, `docs/competitors/nomad.md` |
| **P2 Aspire** | Local-dev orchestration, app composition/wiring, dev dashboard, polyglot DX | `docs/design/developer-experience.md`, `docs/design/sdk-api.md`, `docs/design/authoring-resources-wiring.md`, `docs/competitors/aspire.md` |
| **P3 Nitric** | Cloud-agnostic Infrastructure-from-Code, portable resource ports, least-privilege `.allow()` | `docs/design/authoring-resources-wiring.md`, `docs/design/wasm-runtime-wit.md`, `docs/competitors/nitric.md` |
| **P4 FinOps** | Cost as a first-class input: estimates, budgets, showback, cost-aware placement | `docs/design/reliability-observability-cost.md`, `docs/design/finops-budget-routing-control-plane.md`, ADR-0039/0071 |
| **P5 Agent-native** | Agents as first-class principals and operators: identity, MCP, Crew, generation | `docs/design/ai-native-agent-auth.md`, `docs/design/operators-sre.md`, `docs/design/generated-stack.md`, ADR-0054+ |

Promoted into the design suite (REM for cand-03): [`docs/design/vision.md` — Intent lineage (five pillars)](docs/design/vision.md#intent-lineage-five-pillars) and [`docs/design/traceability.md` — Intent Pillar Coverage](docs/design/traceability.md#intent-pillar-coverage).

Cross-cutting lenses: **L-DRIFT** (scope drift vs ADR-0063/0064 and the archived requirements) ·
**L-CONS** (internal consistency and intent→design traceability).

## Verdict summary

**Iteration 5 (2026-08-04, unaudited-surface adversarial sweep — CLOSED):** three independent finder passes (ADRs 0125–0148 + the renumbered Yard-UI ADR · lineage + 11 captures · the shipped implementation wave) examined 60+ candidates and confirmed **40 findings** (1 HIGH · 27 MED · 12 LOW): 14 DRIFT (reference rot — dominated by the ADR-0149 renumber fallout and lineage/catalog omissions), 9 GAP (design claims ahead of mechanism: WireGuard floor, provider terms coverage, resourcedef/messaging event families, rect-prop art ban), and 17 IMPL (code-honesty: dispatcher budget fail-open edges, trails compensation escape paths, stations optional preconditions/dead budget signal, verify-command residency wiring, guard blind spots). **23 were remediated same-pass** (every DRIFT, the docs-side GAP fixes, and the residency-wiring IMPL — `hobo verify` now runs the ADR-0146 dimension from environment-supplied tenant constraints through the @hobo/policy layer); the remaining 17 carry documented remediations in their rows. Register total is now **80 confirmed findings**; zero unremediated-undocumented. Prior-iteration findings untouched.

**Iteration 4 (2026-07-03, post-hardening delta sweep):** an independent adversarial sweep over the 2026-07-03 design-hardening surface (18 new competitor captures + ADRs 0118–0124 + the cache-port catalog change) confirmed **2 new findings** — GAP-029 (MED) and GAP-030 (LOW), both L-CONS and both residual edges of the one new primitive (the `cache` port) — **remediated same-pass** (REM-039/040); 9 candidates refuted. Register total is now **40 confirmed findings** (2 HIGH · 25 MED · 13 LOW), **all ✔ on main; zero at 🧯**.

**Register reconciliation (2026-07-03):** the final two documented-not-applied findings were verified applied on main and flipped 🧯 → ✔ — **GAP-026** (the `Aspire.Hosting.Testing` row is ◐ at `aspire.md:471` with a whole-graph-harness iteration hook; no ✅ without a harness spec) and **DRIFT-009** (the `UI-layer generation…out…ADR-0064` mis-citation returns zero hits in `docs/design/`, pinned by proof [HOBO-704 proof](https://linear.app/quickdeploy-ai/document/hobo-704-adr-0064-ui-generation-citation-remediation-archived-cfc726defefa)). **All 38 then-confirmed findings were ✔ on main at that date (superseded by the Iteration-4 total of 40 above); zero remain at 🧯.** Linear delivery closure (HOBO-704/705) is tracked independently.

**FINAL (review closed 2026-07-02, iteration 3 closure sweep, base `caae932d`):** The intent-alignment review is **closed**. Iterations 1–2 confirmed **38 findings** (2 HIGH · 24 MED · 12 LOW), each with a documented remediation; iteration 3 fresh-eyes closure sweep confirmed **zero new findings** — stop rule met. Remediation execution (REM-001..038, HOBO-666..705) is tracked in Linear independently.

**After iteration 2 (2026-07-02, commit `ec5e9f70`):** **38 confirmed findings** (2 HIGH · 24 MED · 12 LOW) — iteration 1's 26 on main plus **12 new** (1 HIGH · 10 MED · 1 LOW); evidence audit flipped **2** additional remediations on main since iteration 1 (**DRIFT-001** ✔ ADR-0106, **DRIFT-003** ✔ ADR-0110, **GAP-002** ✔ HOBO-670). **Stop rule: open** — iteration 3+ required.

**After iteration 1 (2026-07-01, commit `59e387ae`):** 25 confirmed findings (1 HIGH · 15 MED · 9 LOW), every one with a documented remediation below; 5 candidates refuted by skeptic majority and 22 rejected by their own lens (see Verified non-issues).

- **P1 Nomad/orchestration** — GAP-001 (in-Camp scheduling) is **✔ remediated** via ADR-0108 ([HOBO-669](https://linear.app/quickdeploy-ai/issue/HOBO-669)); GAP-003 (nomad.md tracker overclaims) is **✔ remediated** via HOBO-671.
- **P2 Aspire/local DX** — GAP-004 (`hobo dev` for non-TS/OCI workloads) is **✔ remediated** via ADR-0109 ([HOBO-672](https://linear.app/quickdeploy-ai/issue/HOBO-672)); Aspire-grade local dashboard depth and external/adopted-resource semantics remain under-specified (two MED gaps).
- **P3 Nitric/IfC** — strongest pillar; `hobo:data` (**✔ remediated** via ADR-0112 [HOBO-675](https://linear.app/quickdeploy-ai/issue/HOBO-675)) and `hobo:secrets` (**✔ remediated** via ADR-0113 [HOBO-676](https://linear.app/quickdeploy-ai/issue/HOBO-676)) now have canonical WIT definitions. Route-level API security still has no authoring surface (one MED gap + a stale tracker mapping).
- **P4 FinOps** — the FinX advisory surface (forecasts, anomaly signals, commitments, optimization) is promised but nowhere specified, no Crew operator owns it, and the normatively-adopted OpenCost/FOCUS standards have no research notes (two MED + one LOW).
- **P5 Agent-native** — held up best: only one LOW confirmed (Capability-Manifest prose is an unsanitized agent-facing injection surface); autonomy-algorithm, MCP-parity, and error-UX candidates were refuted with covering evidence.
- **L-DRIFT** — a consistent *deliberate-undocumented* cluster: marketplace payout-readiness brushed the ADR-0064-removed rev-share scope until **✔ remediated** via ADR-0110 ([HOBO-668](https://linear.app/quickdeploy-ai/issue/HOBO-668)); the ~90-doc phased release program contradicted ADR-0063's "no version ladder" until **✔ remediated** via ADR-0116 ([HOBO-680](https://linear.app/quickdeploy-ai/issue/HOBO-680)). DRIFT-001 (Nomad lineage) is **✔ remediated** on main via ADR-0106 ([HOBO-666](https://linear.app/quickdeploy-ai/issue/HOBO-666)); DRIFT-002 (hosted-business boundary) is **✔ remediated** via ADR-0107 ([HOBO-667](https://linear.app/quickdeploy-ai/issue/HOBO-667)).
- **L-CONS** — GAP-002 (five-pillar intent framing in design suite) is **✔ remediated** via HOBO-670; Lakebed competitor gap, archived-requirements link rot, and glossary FinOps vocabulary remain open.

## Iteration log

### Iteration 0 — 2026-07-01 — scaffold seed (`8a5e2c5`)

- **Lenses:** none (register bootstrap only)
- **New findings:** none
- **Confirmed / rejected:** none
- **Stop rule:** open — minimum two review iterations remain before closure

### Iteration 1 — 2026-07-01 — 7-lens adversarial review (`59e387ae`)

Two parallel runs of the same 7-lens design executed this iteration. **Run A** (recorded in commit
`d7bbc39c`) was interrupted by a usage limit during skeptic verification: it confirmed the three
drift findings (now DRIFT-001..003) and left all gap candidates unadjudicated. **Run B** completed
the full pipeline and supersedes run A's provisional rows; run A's pre-rejection list is preserved
in the history of commit `d7bbc39c`.

- **Lenses:** A1 P1-Nomad · A2 P2-Aspire · A3 P3-Nitric · A4 P4-FinOps · A5 P5-agent-native · A6 L-DRIFT · A7 L-CONS (7 parallel finders → merge/dedup → 3 diverse skeptics per candidate → remediation drafting; 123 agents in run B)
- **Raw → merged → verdicts (run B):** 54 raw findings → 30 candidates (22 more pre-rejected by their own lens) → **25 confirmed** / 5 refuted
- **New findings:** DRIFT-001, DRIFT-002, DRIFT-003, DRIFT-004, DRIFT-005, DRIFT-006, DRIFT-007, DRIFT-008, GAP-001, GAP-002, GAP-003, GAP-004, GAP-005, GAP-006, GAP-007, GAP-008, GAP-009, GAP-010, GAP-011, GAP-012, GAP-013, GAP-014, GAP-015, GAP-016, GAP-017, GAP-018
- **Rejected:** NI-001…NI-027
- **Stop rule:** open — iteration 2 (completeness critic + informed re-sweep + evidence audit) required before closure. The iteration loop is itself documented as executable Linear work: [HOBO-691](https://linear.app/quickdeploy-ai/issue/HOBO-691) (iteration 2) → [HOBO-692](https://linear.app/quickdeploy-ai/issue/HOBO-692) (closure sweeps until dry)

### Iteration 2 — 2026-07-02 — completeness critic + informed re-sweep + evidence audit (`ec5e9f70`)

- **Lenses:** B1 completeness critic (pillar intersections + unaudited doc families) · B2 informed re-sweep (ADR-0064/0063 re-entry pattern + competitor tracker parity) · B3 evidence auditor (re-open all 25 iteration-1 evidence paths)
- **Evidence audit:** 26 iteration-1 register rows re-checked — **DRIFT-001**, **DRIFT-003**, **GAP-002** now **✔** on main; **23** stay **🧯**; **0** refuted (**❎**)
- **Raw → merged → verdicts:** 22 new candidates → **12 confirmed** / 10 refuted or downgraded to NI-028…NI-036
- **New findings:** DRIFT-009, DRIFT-010, GAP-019, GAP-020, GAP-021, GAP-022, GAP-023, GAP-024, GAP-025, GAP-026, GAP-027, GAP-028 (GAP-018 confirmed in iteration 1 on main; not re-counted)
- **Rejected:** NI-028…NI-036 (see Verified non-issues)
- **Stop rule:** open — iteration 3+ required (12 new findings)

### Iteration 3 — 2026-07-02 — closure fresh-eyes sweep ([HOBO-692](https://linear.app/quickdeploy-ai/issue/HOBO-692), base `caae932d`)

- **Lenses:** condensed fresh-eyes pass — P1 Nomad/orchestration · P2 Aspire/local-DX · P3 Nitric/IfC · P4 FinOps · P5 agent-native · L-DRIFT scope · L-CONS traceability (primary sources read before register diff; adversarial refute-if-uncertain on every candidate)
- **Raw → verdicts:** 7 lens sweeps → 8 borderline candidates generated → **0 confirmed new** / 8 refuted (covering text, deliberate-documented deferral, or duplicate of existing GAP/DRIFT/NI rows)
- **New findings:** none
- **Candidates examined & refuted (not promoted):**
  - P2 `Aspire.Hosting.Testing` tracker ✅ vs mock-first `hobo sandbox`/`hobo test` (ADR-0076) — deliberate architecture; testing model specified in Plan 09; same hygiene class as DRIFT-006 awaiting REM-018, not a new gap
  - P3 Nitric `websites:` build/dev yaml vs `web(name)` catalog row — NI-011 closed building-block coverage; static/SSR path documented
  - P3 `addContainer` IfC collection mode — IfC-default is wasm component path; explicit `bindle()` escape hatch documented
  - P4 FinOps `ResourceIntent`/Pareto pipeline vs Matching/Dispatcher — post-core epic composes existing slices ([`traceability.md`](docs/design/traceability.md)); GAP-017 covers glossary delta
  - P5 Crew operator MCP tools (`diagnose`/`implement`/…) vs Yard MCP catalog — NI-005; Crew composes existing Yard MCP reads/actions
  - P5 `@hobo/agent-skills` extension seam — enumerated in ADR/extension seams + `architecture.md`; no separate design doc required at this depth
  - L-CONS vision.md four-operator emphasis vs six-operator Plan 40 roster — section-specific emphasis (platform ops vs generation); glossary lists full roster
  - P1 residual Nomad tracker rows — already GAP-003 / DRIFT-005 / DRIFT-001 ✔
- **Stop rule:** **met** — zero new findings; intent-alignment **review closed** (remediations remain open)

### Iteration 4 — 2026-07-03 — post-hardening delta sweep (new surface only)

- **Scope:** the 2026-07-03 design-hardening surface **only** — 18 new competitor captures, 7 new ADRs (0118–0124), the cache-port catalog change, and the register reconciliation. Not a re-audit of the closed iteration-1–3 surface.
- **Lenses:** P1–P5 + L-DRIFT + L-CONS, refute-if-uncertain (independent adversarial verifier over the new surface).
- **Raw → verdicts:** 11 candidates examined → **2 confirmed** (1 MED · 1 LOW, both L-CONS) / 9 refuted. The 7 new ADRs' cross-anchors were individually verified to resolve **and** substantiate; the ADR index and the ADR-Pn resolution list faithfully match ADRs 0121–0124; L-DRIFT is clean (ADR-0120 keeps monetized API products out; every capture marks monetization ✗-by-design); the register reconciliation (GAP-026/DRIFT-009 → ✔) verified honest and the `check-gaps-register-lag.ts` guard parses only live table rows.
- **New findings:** GAP-029 (MED — `hobo:cache` absent from the Plan 20 canonical port catalog, same class as GAP-007/008/009), GAP-030 (LOW — `vercel.md` KV row a residual `kv`-conflation).
- **Remediation:** both **applied in the same pass** (REM-039, REM-040) — the cache port added to the Plan 20 building-block table (`wasm-runtime-wit.md`); the `vercel.md` KV row split into durable-`kv` + ephemeral-`cache`.
- **Stop rule:** met — the two findings are the residual edges of the one new primitive (the cache port), both closed; no further findings on the new surface.

### Iteration 5 — 2026-08-04 — unaudited-surface adversarial sweep

- **Scope:** the post-Iteration-4 surface only — ADRs 0125–0149, `lineage.md` + 11 captures (tailscale, cedar, temporal, argo-cd, flux-cd, service-mesh, cnab, oam, oscal, octopus-deploy, wasp), and the shipped implementation wave (dispatcher, provider-convex, trails executors, stations routing, events corpus, jurisdiction/offering ports, policy packs).
- **Protocol:** three independent read-only finders (one per surface slice), refute-if-uncertain self-verification inside each pass, coordinator verifier spot-checks on the HIGH/MED candidates (ADR-0122 vs `packages/connectivity/src/config.ts` re-read; renumber-fallout greps re-run).
- **Raw → verdicts:** 60+ candidates → **40 confirmed** / 20+ refuted with reasons (refutations include: golden-replay baseline append-only holds in git history; broker residency filter is a real hard filter; `evaluateResidency` fails closed on unmapped regions and transfer modes; convex credential gate throws before any fetch; dispatcher hysteresis short-circuits on budget violation).
- **New findings:** DRIFT-011..024, GAP-031..039, IMPL-014..030 (rows below).
- **Same-pass remediation:** 23 applied (all 14 DRIFT rows; GAP-031 docs side, GAP-033, GAP-035, GAP-036 catalog note, GAP-037 catalog row, GAP-039; IMPL-021, IMPL-022, IMPL-023 ADR-claim side, IMPL-030 stations docs side). 17 remain documented-not-applied (🧯), each with a concrete remediation in its row.
- **Stop rule:** finder passes each ended with a refuted-candidate tail and no new finding class on re-read; the surface is audited. Next register action: execute the 🧯 rows.

## Gap register

| ID | Pillar | Sev | Status | Claim | Evidence | Remediation |
|---|---|---|---|---|---|---|
| GAP-001 | P1 | HIGH | ✔ | Node-level workload scheduling inside a Camp — Nomad's core competence — has no owner in the design: nothing specifies how service-component instances are placed onto wasmCloud lattice hosts (the wadm-equivalent), who consumes the `scaling {min,max}` annotation, or any bin-packing, failure-domain spread, preemption, oversubscription, host-drain, or capacity-reservation semantics, even though the default host is self-hosted wasmCloud on bare-metal/Coolify/Docker substrates that supply no scheduler of their own. | `docs/design/adr/01-architecture-core.md#adr-0031`<br>`docs/design/control-plane.md:121`<br>`docs/design/authoring-resources-wiring.md:161` … | [REM-004](#rem-004-for-gap-001) |
| GAP-002 | L-CONS | MED | ✔ | The five-pillar intent framing (Nomad+Aspire+Nitric+FinOps+agent-native) appears nowhere in docs/design/ as an organizing principle — vision.md's borrow-list never names Nomad, the only repo echoes of the composed intent are README's GAPS.md row and GAPS.md itself (both outside the design suite), and traceability.md traces plan/ADR->Linear only, never intent->design. Partially mitigated: GAPS.md now carries the pillar mapping and README links it, but the design suite itself remains silent. | `docs/design/vision.md:68-77`<br>`docs/design/vision.md:48-64`<br>`README.md:47`<br>`GAPS.md:20-26`<br>`docs/design/traceability.md:10-27` … | [REM-005](#rem-005-for-gap-002) |
| GAP-003 | P1 | MED | ✔ remediated | The nomad.md HoBo-mapping tracker overclaimed and under-anchored: 'Constraints/affinities/spread' was marked designed-at-parity although only partial scheduler-hint coverage exists and no full Nomad-class affinity/anti-affinity/spread constraint language is committed, while the 'System jobs' and 'Raw exec / Java / QEMU' rows carried no design-doc or issue anchor. | `docs/competitors/nomad.md:190` · `docs/competitors/nomad.md:174` · `docs/competitors/nomad.md:178` · `docs/design/platform-engineering.md:50` · `docs/design/control-plane.md:227` | nomad.md statuses re-audited; affinity/spread downgraded to 🔜; workload-catalog table gained a HoBo doc column; gaps anchored to platform-engineering.md iteration-hook subsection ([HOBO-671](https://linear.app/quickdeploy-ai/issue/HOBO-671)). |
| GAP-004 | P2 | MED | ✔ | The `hobo dev` inner-loop mechanics (hot reload, codegen-in-watch, sub-minute boot) are specified only in TypeScript terms; how a non-TS wasm component (Rust/Python/Go/C#) or an OCI-container-fallback service participates in the local dev loop (watch-recompile path, state-preserving reload, per-idiom-layer codegen, whether fallback containers run locally at all) is nowhere specified, despite the Aspire parity tracker marking 'DCP -> local runtime-local host / dev loop' as designed-at-parity. | `docs/design/developer-experience.md#the-inner-loop-hobo-dev`<br>`docs/design/cli-spec.md:22`<br>`docs/design/wasm-runtime-wit.md:19` … | [REM-007](#rem-007-for-gap-004) |
| GAP-005 | P2 | MED | ✔ | Aspire's local dashboard is a core DX pillar (per-resource logs/traces/metrics/env, resource graph, OTLP sink), but HoBo's local dashboard is specified as a single 'Local emulation (Nitric-style)' table row plus a 'local inspector' code comment — and the dashboard's stated architecture (Next.js web resource in the Yard Bindle, reading via the Gateway) has no defined serving mode for `hobo dev`, which runs with no Yard/Gateway; local telemetry views during dev are unspecified. | `docs/design/developer-experience.md:22`<br>`docs/design/developer-experience.md:42`<br>`docs/design/developer-experience.md:49` … | [REM-008](#rem-008-for-gap-005) |
| GAP-006 | P2 | MED | ✔ | Local-dev behavior for non-HoBo dependencies is unspecified: an `external`/adopted resource (the promoted brownfield strangler-fig path) has no stated `hobo dev` semantics (connect to the real endpoint, mock from contract, or fail), and `addContainer(...)` workloads are specified for wiring/building but not for whether hobo dev actually runs them locally — exactly Aspire's local-orchestration strength (AddContainer/ExternalService/AddConnectionString). | `docs/design/adr/07-portability-extensibility.md#adr-0041`<br>`docs/design/developer-experience.md:158`<br>`docs/design/authoring-resources-wiring.md:146-159` … | [REM-009](#rem-009-for-gap-006) |
| GAP-007 | P3 | MED | ✔ | The catalog's `data()` resource — HoBo's replacement for Nitric's `sql`/kv-paradigm building blocks (ADR-0052) — imports a `hobo:data` WIT port that is never defined in Plan 20's self-described 'canonical port catalog'; Plan 20 instead still lists the superseded `sql` resource over `wasi:sql`(+`hobo:sql`), and ADR-level proofs use a third name (`hobo:database/postgres`), so the resource->WIT-port spine for the data block is inconsistent and undefined at its most important row. | `docs/design/authoring-resources-wiring.md:43`<br>`docs/design/authoring-resources-wiring.md:72`<br>`docs/design/authoring-resources-wiring.md:168` … | [REM-010](#rem-010-for-gap-007) |
| GAP-008 | P3 | MED | ✔ | The Nitric parity tables claim 'secret (versioned)' parity backed by `wasi:config`/`hobo:secrets`, but `hobo:secrets` was not defined in the canonical interface catalog and no secret-versioning semantics existed in the design suite. | `docs/competitors/nitric.md:311` · `docs/design/authoring-resources-wiring.md:42` · `docs/design/wasm-runtime-wit.md:151` · [ADR-0113](docs/design/adr/02-identity-security.md#adr-0113) | [REM-011](#rem-011-for-gap-008) |
| GAP-009 | P3 | MED | ✔ | The api resource's `.allow()` column says 'route-level security' (its only verb model) and nitric.md claims parity, but no design text specified the per-route security authoring surface — Nitric's oidcRule/securityRule-per-route and middleware equivalents were unspecified, and the referenced `hobo:http` extension port was undefined in the canonical interface catalog. | `docs/design/authoring-resources-wiring.md:37` · `docs/design/authoring-resources-wiring.md:65` · `docs/competitors/nitric.md:146` · [ADR-0114](docs/design/adr/02-identity-security.md#adr-0114) | [REM-012](#rem-012-for-gap-009) |
| GAP-010 | P4 | MED | ✔ | The design's own FinX surface and FinOps Framework baseline promise 'forecasts, anomaly signals, commitments, and optimization recommendations', but no design doc specified how cost anomalies/trends/forecasts are detected or computed, no cost-anomaly/forecast event family existed (event-families.md had only credit.*/meter.*/spend.*), and 'rightsizing' appeared nowhere; the only cost-reactive mechanisms were threshold breakers. | `docs/design/finops-budget-routing-control-plane.md:128` · `docs/design/finops-budget-routing-control-plane.md:51` · `docs/design/event-families.md:77` · `docs/design/reliability-observability-cost.md:238` · [ADR-0115](docs/design/adr/02-identity-security.md#adr-0115) | [REM-013](#rem-013-for-gap-010) |
| GAP-011 | P4 | MED | ✔ | The ADR-0054 Crew roster (SRE, Endpoint Monitor, GitOps, Platform Engineer, UX Designer, SWE) contains no FinOps/cost-optimization operator, and the FinX advisory outputs (forecasts, anomaly signals, commitments, optimization recommendations) plus the 'commitment optimization' advisory have no named owner — a hole at the intersection of the FinOps and agent-native pillars. | `docs/design/adr/03-data-plane.md:230`<br>`docs/design/operators-sre.md:46`<br>`docs/design/finops-budget-routing-control-plane.md:128` … | [REM-014](#rem-014-for-gap-011) |
| GAP-012 | L-CONS | MED | ✔ remediated | Vision.md declares HoBo 'competes head-on with Convex, Lakebed, and Nitric' three times, borrows from Lakebed, and design/index.md carries a whole 'Competitive frame vs Lakebed' table — but no Lakebed capture exists in docs/competitors/ (which promises 'faithful captures'), it is absent from competitors/index.md and even from its future-competitor backlog list; Lakebed appears only in passing in encore.md and gap-analysis.md. | `docs/design/vision.md:14` · `docs/design/index.md:136-144` · `docs/competitors/lakebed.md` | [REM-016](#rem-016-for-gap-012) |
| GAP-013 | P4 | LOW | ✔ remediated | FinOps has zero dedicated research notes despite normative adoption: ADR-0039 §3 models showback on OpenCost and the control-plane doc baselines FOCUS 1.4/FinOps Framework, yet docs/standards/ had no FOCUS/OpenCost note and docs/competitors/ had no FinOps-market entry. | `docs/design/adr/02-identity-security.md:282` · `docs/design/finops-budget-routing-control-plane.md:108` · `docs/standards/index.md` · `docs/competitors/index.md` | [REM-019](#rem-019-for-gap-013) |
| GAP-014 | P5 | LOW | ✔ remediated | Capability Manifest prose (signs.md / llms.txt) is designed to be read by agents at discovery time, yet the ADR-0023 §3 untrusted-material/sanitization rule is scoped only to generation-pipeline inputs and the Plan 12 threat table's injection row covers only generation-pipeline plugins — manifest prose consumed by operating/planning agents is never classified as untrusted input in the design suite (the broader prompt-injection candidate is otherwise refuted by tool contracts, the MCP hardening proof, and enforced guardrails). | `docs/design/ai-native-agent-auth.md:35`<br>`docs/design/ai-native-agent-auth.md:78`<br>`docs/design/adr/02-identity-security.md:37` … | [REM-020](#rem-020-for-gap-014) |
| GAP-016 | L-CONS | LOW | ✔ | The requirements suite and roadmap were moved under docs/archive/ without rewriting relative links: every ../design/* link in docs/archive/requirements/*.md resolves to the nonexistent docs/archive/design/, and both docs also reference design files that no longer exist under any path (adr/08-scope-and-requirements.md, forge-generated-stack.md, roadmap.md#plan-08, per-stage anchors), so intent->requirements->design tracing misroutes at every hop. | `docs/archive/requirements/index.md:20-39`<br>`docs/archive/requirements/requirements.md:25-35`<br>`docs/archive/roadmap.md:22` … | [REM-024](#rem-024-for-gap-016) |
| GAP-017 | L-CONS | LOW | ✔ | The canonical glossary — declared the single source of truth for canonical term definitions — omits the FinOps control plane's coined vocabulary (ResourceIntent, metric contract, MetricVector, ParetoFrontier, decision graph, DX/OpsX/FinX surfaces) and the ubiquitous 'Crew' alias, even though newer Meta-cloud Broker terms were added, showing the maintenance path exists but skipped the FinOps delta. | `docs/design/glossary.md:10-14`<br>`docs/design/finops-budget-routing-control-plane.md:51-83`<br>`docs/design/glossary.md:49-62`<br>`docs/design/index.md:24` | [REM-025](#rem-025-for-gap-017) |
| GAP-018 | P2 | MED | ✔ | `hobo dev` local multi-service orchestration is unspecified — lifecycle APIs exist for deploy but the inner loop never states dependency-gated startup semantics per annotation class. | `docs/design/authoring-resources-wiring.md:150-151`<br>`docs/design/developer-experience.md:135-139`<br>`docs/design/control-plane.md:57-67` … | [REM-026](#rem-026-for-gap-018) |
| GAP-019 | P3×P4 | MED | ✔ | The FinOps routing pipeline's canonical input (`ResourceIntent → DecisionGraph → ActionPlan`) is disconnected from the IfC/planning spine: control-plane Planner still terminates at manifest IR → `DeploymentPlan` with no documented bridge from resource collection / Matching / `hobo plan` into `ResourceIntent` or the FinOps DX dry-run preview surface. | `docs/design/finops-budget-routing-control-plane.md:22-36`<br>`docs/design/control-plane.md:14-28`<br>`docs/design/reliability-observability-cost.md:175-177` … | [REM-027](#rem-027-for-gap-019) |
| GAP-020 | P3×P4 | MED | ✔ | Inline FinOps budget authoring documented in Plan 21 with `costAvailabilityProfile()`, inline `budget()`/`spendCapUsd` declarations, ADR-0039 §4 alignment, and `hobo plan` Cost & budget surfacing. | `docs/design/adr/02-identity-security.md:285-295`<br>`docs/design/authoring-resources-wiring.md#finops-inline-budget--cost-availability` … | [REM-028](#rem-028-for-gap-020) |
| GAP-021 | P4×P5 | MED | ✔ | Per-token LLM inference budgets are promised in the AI governance plane (`per-token cost/safety budgets (riding the spend breaker)`) and MeteringView folds `gen.*`/`token.*`, but no design text defines a **`TokenBudget`** object, the pre-inference gate seam, which counters fold LLM input/output/total tokens (distinct from auth `token.*` credential events), or how hard denies and spend-velocity circuit-breakers apply to inference. | `docs/design/governance-planes.md:118-119`<br>`docs/design/reliability-observability-cost.md:210-216` | [REM-029](#rem-029-for-gap-021) |
| GAP-022 | P5×L-DRIFT | MED | ✔ remediated | Agent-native Crew promises lacked a known-limitations register row while launch-messaging scoped built-in operator agents to `future-roadmap`; `known-limitations-register.md` now carries a Crew/MCP write-autonomy limitation with owner, workaround, and launch-messaging guard. | `docs/design/known-limitations-register.md` · `docs/design/launch-messaging-claims.md:63` · `docs/design/operators-sre.md:46-54` | [REM-030](#rem-030-for-gap-022) ([HOBO-697](https://linear.app/quickdeploy-ai/issue/HOBO-697)) |
| GAP-023 | L-CONS | MED | ✔ remediated | `docs/patterns/` and `docs/standards/` cross-links remapped from removed `forge-generated-stack.md`/`event-model.md` paths to consolidated design targets (`generated-stack.md`, `data-plane.md#plan-11`, current ADR theme files); link-guard proof at `patterns-standards-cross-links` (3/3). | `docs/patterns/gitops-runbook-promotion.md:44`<br>`docs/patterns/runtime-code-mutation-persistence.md:37-46`<br>`docs/standards/index.md`<br>`docs/index.md:18-27` … | [REM-031](#rem-031-for-gap-023) ([HOBO-698](https://linear.app/quickdeploy-ai/issue/HOBO-698)) |
| GAP-024 | P5 | MED | ✔ | Issue-worker automation (`docs/automations/hobo-issue-worker.md`) defines claim protocol and repo guardrails but never maps them to the agent-native safety model — BR-011 / Plan 06 guardrails (`require-approval`, `spendCapUsd`, destroy protection, SafetyEnvelope) are absent, so the automation sits outside the platform's autonomous-operation contract. | `docs/automations/hobo-issue-worker.md:147-155`<br>`docs/archive/requirements/requirements.md:162`<br>`docs/design/ai-native-agent-auth.md:114-116` … | [REM-032](#rem-032-for-gap-024) |
| GAP-025 | P3 | MED | ✔ | `dapr.md` HoBo-mapping overclaims parity on **Bindings** (general input/output connectors) and **Distributed lock** at ✅ while design has no bindings category, no `hobo:lock` port, and ActorHost lease/fencing ≠ app-level distributed lock API. | `docs/competitors/dapr.md:50,54,121`<br>`docs/design/wasm-runtime-wit.md:117-179`<br>`docs/design/reliability-observability-cost.md:56-60` … | [REM-033](#rem-033-for-gap-025) |
| GAP-026 | P2 | MED | ✔ | `aspire.md` marks `Aspire.Hosting.Testing` (in-process full AppHost + DCP + real containers) as ✅ parity with "Conformance suites + E2E replay tests" — HoBo `@hobo/conformance` gates adapters/hosts/WIT, not an equivalent whole-graph local integration harness. | `docs/competitors/aspire.md:385-399,471`<br>`docs/design/generated-stack.md#plan-09`<br>`docs/design/wasm-runtime-wit.md:108` … | [REM-034](#rem-034-for-gap-026) — row now ◐ at `aspire.md:471` ("whole-graph in-process harness not yet specified") with a [whole-graph hook](docs/design/generated-stack.md#whole-graph-in-process-test-harness-iteration-hook); no ✅ without harness spec. |
| GAP-027 | P2 | MED | ✔ | `aspire.md` marks health-gated `WaitFor`/`WaitForCompletion` as ✅ vs "Saga ordering + readiness gates" but orchestrator choreography gates on `resource.Provisioned` only — health probes and run-to-completion job semantics are unspecified at the control-plane seam (corroborates GAP-018 at the tracker layer). | `docs/competitors/aspire.md:452`<br>`docs/design/control-plane.md:57-67`<br>`docs/design/authoring-resources-wiring.md:150-151` … | [REM-035](#rem-035-for-gap-027) |
| GAP-028 | L-CONS | LOW | ✔ | `docs/patterns/runtime-code-mutation-persistence.md` still frames training promotion write-back as "unanswered" although ADR-0048 + generated-stack now specify AST-aware region-scoped persistence — the pattern library lags the design suite. | `docs/patterns/runtime-code-mutation-persistence.md:37`<br>`docs/design/generated-stack.md:35`<br>`docs/design/adr/03-data-plane.md#adr-0048` … | [REM-036](#rem-036-for-gap-028) |
| GAP-029 | L-CONS | MED | ✔ | The new `hobo:cache` port (ADR-0118) was catalogued in `authoring-resources-wiring.md:39` and referenced by 11 competitor captures, but was **absent from the canonical WIT/port catalog** (Plan 20, `wasm-runtime-wit.md`) — the same class as GAP-007/008/009 (`hobo:data`/`hobo:secrets`/`hobo:http`), which all appear in that table. Found by iteration-4 adversarial sweep. | `docs/design/wasm-runtime-wit.md:139-149`<br>`docs/design/authoring-resources-wiring.md:39,60`<br>`docs/design/adr/03-data-plane.md#adr-0118` | [REM-039](#rem-039-for-gap-029) |
| GAP-030 | L-CONS | LOW | ✔ | `vercel.md` mapped "Vercel Storage — KV (Upstash Redis)" to the durable `kv` port at ✅, but Upstash Redis is an ephemeral cache (ADR-0118 names it as such) and the sibling Fly/Render/Heroku captures map it to the new `cache` port — a residual `kv`-conflation of the exact kind ADR-0118 corrected. | `docs/competitors/vercel.md:191`<br>`docs/design/adr/03-data-plane.md#adr-0118`<br>`docs/competitors/flyio.md`·`render.md`·`heroku.md` | [REM-040](#rem-040-for-gap-030) |
| GAP-031 | P1 | MED | ✔/🧯 | ADR-0122 rules WireGuard the portable mesh floor, but no WireGuard adapter exists — `@hobo/connectivity` ships tailscale/netbird only, defaults to tailscale, and `parseOverlay` silently coerces unknown providers to tailscale; three doc surfaces overclaimed Tailscale as "adopted/Tailscale-first". | `packages/connectivity/src/config.ts:38,177-179` · `docs/design/adr/07-portability-extensibility.md:451` · `docs/technologies/tailscale.md:40` | Docs downgraded to ADR-0122's actual posture same-pass (tailscale.md, lineage.md, technologies/index.md). 🧯 code: add a `wireguard` OverlayProviderKind as the default floor and make `parseOverlay` reject unknown values. |
| GAP-032 | L-CONS | MED | ✔ | `packages/code/bin/hobo-code.mjs` (84-line spawnSync dispatcher) was committed JS outside ADR-0126's only sanctioned exception path, and ADR-0139 recorded no exception for it. | `packages/code/bin/hobo-code.mjs:1-12` · `docs/design/adr/01-architecture-core.md:477-489` | The proposed remediation was to compile the bin or amend the exception. `packages/code` left `main` on 2026-11-08 and was later retired from `feature/hobo-code`; removing the affected package closes this gap without a bin conversion. |
| GAP-033 | L-CONS | MED | ✔ | ADR-0139 §5 shipped a monetization surface (sponsored wait/status, default ON) in `@hobo/code` without citing the ADR-0064/0107/0110 monetization boundary trio. | `docs/design/adr/03-data-plane.md:641` · `packages/code/src/finops.ts:11-18` | Same-pass: boundary parenthetical added to ADR-0139 §5 routing the surface through ADR-0107 lane 2 (product's own offering; app-facing removal untouched). |
| GAP-034 | P4 | MED | 🧯 | ADR-0129 §5 requires every execution-host/cloud adapter to declare a `terms` reference with `reviewedOn`, but only the three runner adapters carry one; `ProviderTerms` is a runner-local type and no gate reads `reviewedOn`. | `docs/design/adr/07-portability-extensibility.md:493` · `packages/providers/runner-github/src/manifest.ts:64-73` | Unverified; tracked in [HOBO-844](https://linear.app/quickdeploy-ai/issue/HOBO-844/reconcile-provider-terms-review-metadata). |
| GAP-035 | L-DRIFT | MED | ✔ | ADR-0143 §5 and the connectivity provider doc specified a `declareOfferings()` function no code implements — shipped adapters export profile constants. | `docs/design/adr/07-portability-extensibility.md:592` · `packages/providers/provider-aws/src/traffic-routing-offerings.ts:11` | Same-pass: both docs restated in terms of the exported `TrafficRoutingProviderProfile` constant contract. |
| GAP-036 | P5 | MED | ✔/🧯 | ADR-0144 §2's auditability rests on `resourcedef.Registered/Updated` events that nothing emits — the family existed only in the docs catalog. | `docs/design/adr/07-portability-extensibility.md:616` · zero `resourcedef` hits in packages/ | Same-pass: event-families row marked design-only with the gap named. 🧯 tracked in [HOBO-845](https://linear.app/quickdeploy-ai/issue/HOBO-845/reconcile-resource-definition-registration-event-gap). |
| GAP-037 | P5 | MED | ✔/🧯 | ADR-0138 §6 promises replayable messaging audit facts, but `messaging.*` was absent from the canonical event catalog and the 10 shipped literals violate `aggregate.PastTenseFact` naming (`messaging.topic.created`, `messaging.dead_lettered`, …). | `packages/core/src/ports/messaging.ts:102-114` · `docs/design/event-families.md:10` | Same-pass: family row added carrying the current literals + divergence note. 🧯 tracked in [HOBO-843](https://linear.app/quickdeploy-ai/issue/HOBO-843/reconcile-messaging-event-names-with-the-event-catalog). |
| GAP-039 | L-DRIFT | LOW | ✔ | ADR-0125 §1 claimed the conformance suite asserts decorator↔wrapper manifest-fact equivalence; the equivalence lives in `packages/runtime` unit tests and `@hobo/conformance` has no such suite. | `docs/design/adr/03-data-plane.md:579` · `packages/runtime/test/training.test.ts:190` | Same-pass: ADR restated as "asserted by the runtime package's tests; conformance suite registration remains open". |

## Drift register

| ID | Lens | Class | Status | Claim (intent vs actual) | Evidence | Remediation |
|---|---|---|---|---|---|---|
| DRIFT-003 | L-DRIFT | deliberate-undocumented | ✔ | Marketplace payout-readiness design (payout state machine incl. `approved-for-payout`, publisher tax-document posture, billing-reconciliation handoffs) re-enters the marketplace monetize/rev-share scope that ADR-0064 §2 removed and ADR-0062 §5 reaffirmed ('No monetization ... no commercial tiers'), converting what ADR-0063 calls a positioning anti-goal into a deferred-until-evidence launch capability with no amending decision record. | `docs/design/marketplace-payout-hooks.md:79-89`<br>`docs/design/marketplace-payout-hooks.md:51-52`<br>`docs/design/adr/07-portability-extensibility.md:294` … | [REM-003](#rem-003-for-drift-003) |
| DRIFT-001 | P1 | deliberate-undocumented | ✔ | The Nomad pillar's lineage is invisible inside the design suite: docs/design/ contains zero 'Nomad' references (ADRs included), no ADR records the Nomad evaluation or why wasmCloud/Matching/Dispatcher subsumed it, vision.md's 15-row landscape table omits Nomad although competitors/index.md labels it a direct scheduler/control-plane competitor, the nomad.md HoBo-mapping is one-way (design never links back), and Nomad-as-a-provider/host-adapter floated in nomad.md is never dispositioned. | `docs/competitors/nomad.md#primitive-mapping`<br>`docs/design/adr/01-architecture-core.md#adr-0031`<br>`docs/design/vision.md:48-64` … | [REM-001](#rem-001-for-drift-001) |
| DRIFT-002 | L-DRIFT | deliberate-undocumented | ✔ | First-party commercial-launch design (billing plans/credits/invoice lifecycle, tax/currency/receipt posture, a deterministic meter.UsageRecorded->invoice.LineItem reconciliation contract, and workspace plan tiers) now lives in docs/design/ while ADR-0064's consequence says 'no first-party commercial toolkit to maintain (commercialization is out of design scope)' — the first-party-hosted-business vs product-billing-port boundary is asserted per-doc but recorded in no ADR. | `docs/design/billing-launch-policy.md:41-61`<br>`docs/design/usage-to-invoice-reconciliation.md:50-56`<br>`docs/design/tax-currency-receipt-obligations.md:48-66` … | [REM-002](#rem-002-for-drift-002) |
| DRIFT-004 | L-DRIFT | deliberate-undocumented | ✔ remediated | ADR-0063 states there is 'no version ladder and no deferred-feature bucket in the design' and that delivery phasing is archived, yet docs/design/ now runs a full phased v1 release program (~90 Productization M0/M1 index rows, beta/RC/GA go-no-go gates, a self-described 'M0 traceability gate', known-limitations deferred/post-ga states, v1 critical-path blockers) whose M0-M4 taxonomy is defined only in the Linear backlog legend — ADR-0063 was never amended and no ADR records the productization-category/phase-gate decision or maps the archived stages 0-6 to M0-M4. | `docs/design/adr/07-portability-extensibility.md:277-282` · `docs/design/index.md:28-112` · `docs/design/go-no-go-decision-record.md:36-95` · `docs/design/traceability.md:10` · `docs/design/known-limitations-register.md:35-36` · [ADR-0116](docs/design/adr/07-portability-extensibility.md#adr-0116) | [REM-015](#rem-015-for-drift-004) |
| DRIFT-005 | P1 | silent | ✔ | platform-engineering.md still says 'multi-Yard federation (multi-region/regulatory) is out of scope (Q20)' citing a dangling anchor (generated-stack.md contains no Q20/open-questions text), contradicting ADR-0043 which fully designs multi-Yard federation (the Junction) and control-plane.md which says an air-gapped Yard 'may stand alone or join a Junction'. | `docs/design/platform-engineering.md:229`<br>`docs/design/adr/07-portability-extensibility.md#adr-0043`<br>`docs/design/control-plane.md:93` … | [REM-017](#rem-017-for-drift-005) |
| DRIFT-006 | P3 | silent | ✔ | nitric.md's HoBo-mapping layer has drifted from the current design: it maps `nitric up/down` -> `hobo deploy/destroy` and `nitric run` -> `hobo dev --containers` (the design collapsed to `hobo up/down` and defines no --containers flag), names the schedule port `hobo:schedule` vs the design's `hobo:scheduler`, and its 'Open parity items' still lists the WebSocket WIT shape and sql-migrations as open although ADR-0075 and ADR-0032/Plan 32 resolved them. | `docs/competitors/nitric.md:313`<br>`docs/competitors/nitric.md:336`<br>`docs/competitors/nitric.md:355` … | [REM-018](#rem-018-for-drift-006) |
| DRIFT-007 | L-DRIFT | deliberate-undocumented | ✔ remediated | The design-suite scope statement (index.md: 'The whole suite is one scope — every plan is in scope, bounded only by the AI-native-meta-cloud-minus-monetization line (ADR-0063/ADR-0064)') is stale: the same index now lists monetization-adjacent commercial records (billing, tax, invoicing evidence, payout hooks) and a phased launch program, so the stated bound no longer describes the suite's contents. | `docs/design/index.md:120`<br>`docs/design/index.md:53-57`<br>`docs/design/index.md:66-67` … | [REM-021](#rem-021-for-drift-007) |
| DRIFT-008 | L-CONS | silent | ✔ remediated | gap-analysis.md's traceability anchors have rotted: matrix and §C rows cite numbered open questions (Q3/Q10/Q12/Q15-Q20/Q21-Q23, '09 §15-20') linking to generated-stack.md#plan-09, but the current Plan 9 'Open design questions' list is unnumbered and contains none of those IDs, and matrix rows retain partial/missing markers for capabilities the same doc later records as closed (only §2 is explicitly labeled historical). | `docs/competitors/gap-analysis.md:31`<br>`docs/competitors/gap-analysis.md:34`<br>`docs/competitors/gap-analysis.md:72` … | [REM-022](#rem-022-for-drift-008) |
| DRIFT-009 | L-DRIFT | silent | ✔ | UI/app generation is mis-cited as OUT while ADR-0064 §1 explicitly **keeps** app generation (UX Designer, design.md, OpenUI, json-render, mcp-apps, `ui-render` port per ADR-0056): `architecture.md:171`, `stage-6-production-hardening-acceptance.md:71`, `worked-example.md:70`, and `gap-analysis.md:14,18` claimed UI-layer generation was removed under ADR-0064 — contradicting ADR-0064/0056 with no amending decision. | `docs/design/architecture.md:171`<br>`docs/design/stage-6-production-hardening-acceptance.md:71`<br>`docs/design/adr/07-portability-extensibility.md:293-300`<br>`docs/design/adr/03-data-plane.md:264-277`<br>`docs/competitors/gap-analysis.md:14,18` … | [REM-037](#rem-037-for-drift-009) — all four docs now affirm app/UI generation IN scope; `UI-layer generation…out…ADR-0064` grep returns zero hits in `docs/design/`; pinned by proof [HOBO-704 proof](https://linear.app/quickdeploy-ai/document/hobo-704-adr-0064-ui-generation-citation-remediation-archived-cfc726defefa). |
| DRIFT-010 | L-DRIFT | deliberate-undocumented | ✔ remediated | stage-6-production-hardening-acceptance.md bundles the consolidated `notify` cloud-messaging port into a single "Governance planes" lane row, contradicting ADR-0064 §3 which demotes `notify` to a catalog port and keeps only compliance/AI-safety enforcement as governance planes. | `docs/design/stage-6-production-hardening-acceptance.md:65`<br>`docs/design/stage-6-production-hardening-acceptance.md:96`<br>`docs/design/adr/07-portability-extensibility.md:295` … | [REM-038](#rem-038-for-drift-010) |
Drift classes: **deliberate-documented** (decision recorded in an ADR/plan — reported 📘, no remediation
required beyond mapping) · **deliberate-undocumented** (evidently intentional but no decision record) ·
**silent** (no evidence of a decision).
| DRIFT-012 | MED | ✔ | ADR-0148 attributed the art clauses it supersedes to ADR-0140 (launch-ship-targets — zero art content); the intended target is ADR-0147. | `docs/design/adr/07-portability-extensibility.md:671,681-682` (pre-fix) | Same-pass: every ADR-0140 citation inside ADR-0148 retargeted to ADR-0147. |
| DRIFT-013 | MED | ✔ | The JS-family exception is recorded as `examples/*/deploy/` in AGENTS.md and the ADR index, but ADR-0126 scopes it to `packages/hobo/fixtures/deploy/<provider>/` (and no examples/*/deploy exists). | `AGENTS.md:208` · `docs/design/adr/index.md:137` (pre-fix) | Same-pass: both surfaces corrected to the ADR-0126 path. |
| DRIFT-014 | MED | ✔ | ADR-0139 §6 pinned "verbs stay at 37" as the harness boundary; `CANONICAL_VERBS` has 40 (serve/replay/runbook added by later ADRs). | `docs/design/adr/03-data-plane.md:643` (pre-fix) · `packages/cli/src/shell/verbs.ts` | Same-pass: restated as the invariant ("the harness adds no canonical verb"), count delegated to the cli-docs gate. |
| DRIFT-015 | MED | ✔ | package-namespaces assigned effect-aware isolation/mocks/fault injection to `@hobo/contract-harness`, contradicting ADR-0136 §5 which deliberately keeps them in `@hobo/contracts` (cycle avoidance) — where the code actually lives. | `docs/design/package-namespaces.md:81` (pre-fix) · `packages/contracts/src/effects-harness.ts` | Same-pass: row split — PACT harness vs effects, each to its real package with the cycle rationale. |
| DRIFT-017 | LOW | ✔ | `provider.Approved` — the load-bearing approval fact ADR-0127 §4 defines and `add-command.ts` emits — was missing from the event-families `provider.*` row. | `docs/design/event-families.md:75` (pre-fix) · `packages/hobo/src/add-command.ts:74,191` | Same-pass: row extended. |
| DRIFT-018 | LOW | ✔ | ADR-0145's Context used an undefined shortcut link `[ADR-0039]` rendering as dead text. | `docs/design/adr/01-architecture-core.md:614` (pre-fix) | Same-pass: full link form. |
| DRIFT-019 | LOW | ✔ | ADR-0139 §1 said the `hobo-code` bin is a "composition-root bin from `@hobo/hobo`"; `@hobo/code` declares it. | `docs/design/adr/03-data-plane.md:633` (pre-fix) · `packages/code/package.json:7-9` | Same-pass: parenthetical corrected. |
| DRIFT-020 | MED | ✔ | lineage.md's Wasp row anchored "kits as Resource/App Packs" to ADR-0144 §5 (the SaaS thin-adapter rule) and presented the planned capability as settled; App Kits distribution is ADR-0145 §2 and wasp.md marks it 🔜. | `docs/design/lineage.md:60` (pre-fix) · `docs/competitors/wasp.md:69` | Same-pass: re-anchored to ADR-0145 §2 and marked planned. |
| DRIFT-021 | LOW | ✔ | service-mesh.md rendered the no-mesh-types-in-core citation with label "ADR-0107 region" over an `#adr-0143` anchor — wrong decision on follow. | `docs/patterns/service-mesh.md:41` (pre-fix) | Same-pass: label corrected to ADR-0143 non-goals. |
| DRIFT-022 | MED | ✔ | lineage.md's own Maintenance rule (every influence gets a row) was violated by its own wave: OSCAL (ADR-0146-pinned capture) plus CUE/OpenStack/Varlock had no influence-map rows. | `docs/design/lineage.md:95,120-121` (pre-fix) · `docs/standards/oscal.md` | Same-pass: four rows added with honest postures. |
| DRIFT-023 | LOW | ✔ | The posture legend enumerated seven postures while the tables use `informs`, `head-on`, and compound forms the legend never defined. | `docs/design/lineage.md:22-26,95-96` (pre-fix) | Same-pass: legend extended (informs, head-on, compound qualifier rule). |
| DRIFT-024 | LOW | ✔ | The Maintenance rule prescribed a borrow-heading form ("What HoBo borrows from X") that exactly one file uses and the cited exemplar itself violates. | `docs/design/lineage.md:120-123` · `docs/competitors/aspire.md:487` | Same-pass: rule softened to "clearly labelled borrow paragraph or section". |

## Remediations

### REM-001 (for DRIFT-001)

- **Finding** (cand-04, P1, LOW, votes uphold/uphold/uphold, drift-class deliberate-undocumented): The Nomad pillar's lineage is invisible inside the design suite: docs/design/ contains zero 'Nomad' references (ADRs included), no ADR records the Nomad evaluation or why wasmCloud/Matching/Dispatcher subsumed it, vision.md's 15-row landscape table omits Nomad although competitors/index.md labels it a direct scheduler/control-plane competitor, the nomad.md HoBo-mapping is one-way (design never links back), and Nomad-as-a-provider/host-adapter floated in nomad.md is never dispositioned.
- **Evidence:** `docs/competitors/nomad.md#primitive-mapping` · `docs/design/adr/01-architecture-core.md#adr-0031` · `docs/design/vision.md:48-64` · `docs/competitors/index.md:8` · `docs/design/control-plane.md:118` · `docs/competitors/gap-analysis.md:23`
- **Effort:** M · **Delivery:** ✔ [HOBO-666](https://linear.app/quickdeploy-ai/issue/HOBO-666) — ADR-0106 in `docs/design/adr/01-architecture-core.md`

Historical remediation instructions: [Linear archive](https://linear.app/quickdeploy-ai/document/rem-001-historical-remediation-plan-f6db9bbb559e).

### REM-002 (for DRIFT-002)

- **Finding** (cand-16, L-DRIFT, MED, votes uphold/uphold/uphold, drift-class deliberate-undocumented): First-party commercial-launch design (billing plans/credits/invoice lifecycle, tax/currency/receipt posture, a deterministic meter.UsageRecorded->invoice.LineItem reconciliation contract, and workspace plan tiers) now lives in docs/design/ while ADR-0064's consequence says 'no first-party commercial toolkit to maintain (commercialization is out of design scope)' — the first-party-hosted-business vs product-billing-port boundary is asserted per-doc but recorded in no ADR.
- **Evidence:** `docs/design/billing-launch-policy.md:41-61` · `docs/design/usage-to-invoice-reconciliation.md:50-56` · `docs/design/tax-currency-receipt-obligations.md:48-66` · `docs/design/entitlements-plan-limits.md:106-112` · `docs/design/adr/07-portability-extensibility.md:299` · `docs/archive/requirements/requirements.md:165`
- **Effort:** M · **Delivery:** ✔ [HOBO-667](https://linear.app/quickdeploy-ai/issue/HOBO-667) — ADR-0107 in `docs/design/adr/07-portability-extensibility.md`

Historical remediation instructions: [Linear archive](https://linear.app/quickdeploy-ai/document/rem-002-historical-remediation-plan-67afda901fd1).

### REM-003 (for DRIFT-003)

- **Finding** (cand-02, L-DRIFT, MED, votes uphold/uphold/uphold, drift-class deliberate-undocumented): Marketplace payout-readiness design (payout state machine incl. `approved-for-payout`, publisher tax-document posture, billing-reconciliation handoffs) re-enters the marketplace monetize/rev-share scope that ADR-0064 §2 removed and ADR-0062 §5 reaffirmed ('No monetization ... no commercial tiers'), converting what ADR-0063 calls a positioning anti-goal into a deferred-until-evidence launch capability with no amending decision record.
- **Evidence:** `docs/design/marketplace-payout-hooks.md:79-89` · `docs/design/marketplace-payout-hooks.md:51-52` · `docs/design/adr/07-portability-extensibility.md:294` · `docs/design/adr/07-portability-extensibility.md:170` · `docs/design/adr/07-portability-extensibility.md:282` · `docs/design/tax-currency-receipt-obligations.md:66`
- **Effort:** M · **Delivery:** ✔ [HOBO-668](https://linear.app/quickdeploy-ai/issue/HOBO-668) — ADR-0110 in `docs/design/adr/07-portability-extensibility.md`

Historical remediation instructions: [Linear archive](https://linear.app/quickdeploy-ai/document/rem-003-historical-remediation-plan-216b573ed4f5).

### REM-004 (for GAP-001)

- **Finding** (cand-01, P1, HIGH, votes uphold/uphold/uphold, drift-class silent): Node-level workload scheduling inside a Camp — Nomad's core competence — has no owner in the design: nothing specifies how service-component instances are placed onto wasmCloud lattice hosts (the wadm-equivalent), who consumes the `scaling {min,max}` annotation, or any bin-packing, failure-domain spread, preemption, oversubscription, host-drain, or capacity-reservation semantics, even though the default host is self-hosted wasmCloud on bare-metal/Coolify/Docker substrates that supply no scheduler of their own.
- **Evidence:** `docs/design/adr/01-architecture-core.md#adr-0031` · `docs/design/control-plane.md:121` · `docs/design/authoring-resources-wiring.md:161` · `docs/design/reliability-observability-cost.md:56` · `docs/design/platform-engineering.md:174` · `docs/design/wasm-runtime-wit.md:95`
- **Effort:** M · **Delivery:** [HOBO-669](https://linear.app/quickdeploy-ai/issue/HOBO-669) (Intent-Alignment Gap Remediation project)

Historical remediation instructions: [Linear archive](https://linear.app/quickdeploy-ai/document/rem-004-historical-remediation-plan-80be309717d4).

### REM-005 (for GAP-002)

- **Finding** (cand-03, L-CONS, MED, votes uphold/uphold/uphold): The five-pillar intent framing (Nomad+Aspire+Nitric+FinOps+agent-native) appears nowhere in docs/design/ as an organizing principle — vision.md's borrow-list never names Nomad, the only repo echoes of the composed intent are README's GAPS.md row and GAPS.md itself (both outside the design suite), and traceability.md traces plan/ADR->Linear only, never intent->design. Partially mitigated: GAPS.md now carries the pillar mapping and README links it, but the design suite itself remains silent.
- **Evidence:** `docs/design/vision.md:68-77` · `docs/design/vision.md:48-64` · `README.md:47` · `GAPS.md:20-26` · `docs/design/traceability.md:10-27`
- **Effort:** M · **Delivery:** [HOBO-670](https://linear.app/quickdeploy-ai/issue/HOBO-670) (Intent-Alignment Gap Remediation project)

Historical remediation instructions: [Linear archive](https://linear.app/quickdeploy-ai/document/rem-005-historical-remediation-plan-6af621b4552f).

### REM-006 (for GAP-003)

- **Finding** (cand-05, P1, MED, votes uphold/uphold/uphold): The nomad.md HoBo-mapping tracker overclaimed and under-anchored: 'Constraints/affinities/spread' was marked designed-at-parity although only partial scheduler-hint coverage exists and no full Nomad-class affinity/anti-affinity/spread constraint language is committed, while the 'System jobs' and 'Raw exec / Java / QEMU' rows carried no design-doc or issue anchor.
- **Evidence:** `docs/competitors/nomad.md:190` · `docs/competitors/nomad.md:174` · `docs/competitors/nomad.md:178` · `docs/design/platform-engineering.md:50` · `docs/design/control-plane.md:227`
- **Effort:** M · **Delivery:** ✔ [HOBO-671](https://linear.app/quickdeploy-ai/issue/HOBO-671) — nomad.md tracker re-audited; `platform-engineering.md#node-placement-and-system-workloads-iteration-hooks` added.

Historical remediation instructions: [Linear archive](https://linear.app/quickdeploy-ai/document/rem-006-historical-remediation-plan-a4ebcf3bdc0e).

### REM-007 (for GAP-004)

- **Finding** (cand-06, P2, MED, votes uphold/uphold/uphold): The `hobo dev` inner-loop mechanics (hot reload, codegen-in-watch, sub-minute boot) are specified only in TypeScript terms; how a non-TS wasm component (Rust/Python/Go/C#) or an OCI-container-fallback service participates in the local dev loop (watch-recompile path, state-preserving reload, per-idiom-layer codegen, whether fallback containers run locally at all) is nowhere specified, despite the Aspire parity tracker marking 'DCP -> local runtime-local host / dev loop' as designed-at-parity.
- **Evidence:** `docs/design/developer-experience.md#the-inner-loop-hobo-dev` · `docs/design/cli-spec.md:22` · `docs/design/wasm-runtime-wit.md:19` · [HOBO-122 proof](https://linear.app/quickdeploy-ai/document/hobo-122-dev-loop-proof-archived-d4ba66511f44) · `docs/competitors/aspire.md:465` · `docs/design/sdk-api.md:292`
- **Effort:** M · **Delivery:** ✔ [HOBO-672](https://linear.app/quickdeploy-ai/issue/HOBO-672) — ADR-0109 in `docs/design/adr/07-portability-extensibility.md`

Historical remediation instructions: [Linear archive](https://linear.app/quickdeploy-ai/document/rem-007-historical-remediation-plan-8df987f8b2f9).

### REM-008 (for GAP-005)

- **Finding** (cand-07, P2, MED, votes uphold/uphold/uphold): Aspire's local dashboard is a core DX pillar (per-resource logs/traces/metrics/env, resource graph, OTLP sink), but HoBo's local dashboard is specified as a single 'Local emulation (Nitric-style)' table row plus a 'local inspector' code comment — and the dashboard's stated architecture (Next.js web resource in the Yard Bindle, reading via the Gateway) has no defined serving mode for `hobo dev`, which runs with no Yard/Gateway; local telemetry views during dev are unspecified.
- **Evidence:** `docs/design/developer-experience.md:22` · `docs/design/developer-experience.md:42` · `docs/design/developer-experience.md:49` · `docs/design/walkthrough.md:138` · `docs/design/deployment-dashboard-topology-explorer.md#scope-out-and-non-goals` · `docs/competitors/aspire.md:360-381`
- **Effort:** M · **Delivery:** [HOBO-673](https://linear.app/quickdeploy-ai/issue/HOBO-673) (Intent-Alignment Gap Remediation project)

Historical remediation instructions: [Linear archive](https://linear.app/quickdeploy-ai/document/rem-008-historical-remediation-plan-d493c0e7b5bf).

### REM-009 (for GAP-006)

- **Finding** (cand-08, P2, MED, votes uphold/uphold/uphold): Local-dev behavior for non-HoBo dependencies is unspecified: an `external`/adopted resource (the promoted brownfield strangler-fig path) has no stated `hobo dev` semantics (connect to the real endpoint, mock from contract, or fail), and `addContainer(...)` workloads are specified for wiring/building but not for whether hobo dev actually runs them locally — exactly Aspire's local-orchestration strength (AddContainer/ExternalService/AddConnectionString).
- **Evidence:** `docs/design/adr/07-portability-extensibility.md#adr-0041` · `docs/design/developer-experience.md:158` · `docs/design/authoring-resources-wiring.md:146-159` · `docs/design/adr/07-portability-extensibility.md:195` · `docs/competitors/aspire.md:84-93`
- **Effort:** M · **Delivery:** [HOBO-674](https://linear.app/quickdeploy-ai/issue/HOBO-674) (Intent-Alignment Gap Remediation project)

Historical remediation instructions: [Linear archive](https://linear.app/quickdeploy-ai/document/rem-009-historical-remediation-plan-3b3b1a8fbbc3).

### REM-010 (for GAP-007)

- **Finding** (cand-09, P3, MED, votes uphold/uphold/uphold): The catalog's `data()` resource — HoBo's replacement for Nitric's `sql`/kv-paradigm building blocks (ADR-0052) — imports a `hobo:data` WIT port that is never defined in Plan 20's self-described 'canonical port catalog'; Plan 20 instead still lists the superseded `sql` resource over `wasi:sql`(+`hobo:sql`), and ADR-level proofs use a third name (`hobo:database/postgres`), so the resource->WIT-port spine for the data block is inconsistent and undefined at its most important row.
- **Evidence:** `docs/design/authoring-resources-wiring.md:43` · `docs/design/authoring-resources-wiring.md:72` · `docs/design/authoring-resources-wiring.md:168` · `docs/design/wasm-runtime-wit.md:128` · `docs/design/wasm-runtime-wit.md:150` · `docs/design/adr/03-data-plane.md:461`
- **Effort:** M · **Delivery:** [HOBO-675](https://linear.app/quickdeploy-ai/issue/HOBO-675) (Intent-Alignment Gap Remediation project)

Historical remediation instructions: [Linear archive](https://linear.app/quickdeploy-ai/document/rem-010-historical-remediation-plan-b49c7117775b).

### REM-011 (for GAP-008)

- **Finding** (cand-10, P3, MED, votes uphold/uphold/uphold): The Nitric parity tables claim 'secret (versioned)' parity backed by `wasi:config`/`hobo:secrets`, but `hobo:secrets` is not defined in the canonical interface catalog and no secret-versioning semantics (Nitric's put->version, access latest/specific version) exist anywhere in the design suite — the secret resource has only `put`/`access` verbs with no version model.
- **Evidence:** `docs/competitors/nitric.md:311` · `docs/design/authoring-resources-wiring.md:42` · `docs/design/authoring-resources-wiring.md:225` · `docs/design/wasm-runtime-wit.md:151`
- **Effort:** M · **Delivery:** ✔ [HOBO-676](https://linear.app/quickdeploy-ai/issue/HOBO-676) — ADR-0113 in `docs/design/adr/02-identity-security.md`; `hobo:secrets` canonical definition in `docs/design/wasm-runtime-wit.md`

Historical remediation instructions: [Linear archive](https://linear.app/quickdeploy-ai/document/rem-011-historical-remediation-plan-278ceb261295).

### REM-012 (for GAP-009)

- **Finding** (cand-11, P3, MED, votes uphold/uphold/uphold): The api resource's `.allow()` column says 'route-level security' (its only verb model) and nitric.md claims parity, but no design text specifies the per-route security authoring surface — Nitric's oidcRule/securityRule-per-route and middleware equivalents are unspecified, and the referenced `hobo:http` extension port is likewise undefined in the canonical interface catalog.
- **Evidence:** `docs/design/authoring-resources-wiring.md:37` · `docs/design/authoring-resources-wiring.md:65` · `docs/competitors/nitric.md:146` · `docs/competitors/nitric.md:306`
- **Effort:** M · **Delivery:** [HOBO-677](https://linear.app/quickdeploy-ai/issue/HOBO-677) (Intent-Alignment Gap Remediation project)

Historical remediation instructions: [Linear archive](https://linear.app/quickdeploy-ai/document/rem-012-historical-remediation-plan-171248ddb0ea).

### REM-013 (for GAP-010)

- **Finding** (cand-12, P4, MED, votes uphold/uphold/uphold): The design's own FinX surface and FinOps Framework baseline promise 'forecasts, anomaly signals, commitments, and optimization recommendations', but no design doc specifies how cost anomalies/trends/forecasts are detected or computed, no cost-anomaly/forecast event family exists (event-families.md has only credit.*/meter.*/spend.*), and 'rightsizing' appears nowhere in the repo; the only cost-reactive mechanisms are threshold breakers.
- **Evidence:** `docs/design/finops-budget-routing-control-plane.md:128` · `docs/design/finops-budget-routing-control-plane.md:51` · `docs/design/event-families.md:77` · `docs/design/reliability-observability-cost.md:238` · `docs/design/operators-sre.md:121`
- **Effort:** M · **Delivery:** [HOBO-678](https://linear.app/quickdeploy-ai/issue/HOBO-678) (Intent-Alignment Gap Remediation project)

Historical remediation instructions: [Linear archive](https://linear.app/quickdeploy-ai/document/rem-013-historical-remediation-plan-a194a57d5a95).

### REM-014 (for GAP-011)

- **Finding** (cand-13, P4, MED, votes uphold/uphold/uphold): The ADR-0054 Crew roster (SRE, Endpoint Monitor, GitOps, Platform Engineer, UX Designer, SWE) contains no FinOps/cost-optimization operator, and the FinX advisory outputs (forecasts, anomaly signals, commitments, optimization recommendations) plus the 'commitment optimization' advisory have no named owner — a hole at the intersection of the FinOps and agent-native pillars.
- **Evidence:** `docs/design/adr/03-data-plane.md:230` · `docs/design/operators-sre.md:46` · `docs/design/finops-budget-routing-control-plane.md:128` · `docs/design/reliability-observability-cost.md:240` · `docs/design/usage-metering.md:35`
- **Effort:** M · **Delivery:** [HOBO-679](https://linear.app/quickdeploy-ai/issue/HOBO-679) (Intent-Alignment Gap Remediation project)

Historical remediation instructions: [Linear archive](https://linear.app/quickdeploy-ai/document/rem-014-historical-remediation-plan-63cc2b695381).

### REM-015 (for DRIFT-004)

- **Finding** (cand-17, L-DRIFT, MED, votes uphold/uphold/uphold, drift-class deliberate-undocumented): ADR-0063 states there is 'no version ladder and no deferred-feature bucket in the design' and that delivery phasing is archived, yet docs/design/ now runs a full phased v1 release program (~90 Productization M0/M1 index rows, beta/RC/GA go-no-go gates, a self-described 'M0 traceability gate', known-limitations deferred/post-ga states, v1 critical-path blockers) whose M0-M4 taxonomy is defined only in the Linear backlog legend — ADR-0063 was never amended and no ADR records the productization-category/phase-gate decision or maps the archived stages 0-6 to M0-M4.
- **Evidence:** `docs/design/adr/07-portability-extensibility.md:277-282` · `docs/design/index.md:28-112` · `docs/design/go-no-go-decision-record.md:36-95` · `docs/design/traceability.md:10` · `docs/design/known-limitations-register.md:35-36`
- **Effort:** M · **Delivery:** [HOBO-680](https://linear.app/quickdeploy-ai/issue/HOBO-680) (Intent-Alignment Gap Remediation project)

Historical remediation instructions: [Linear archive](https://linear.app/quickdeploy-ai/document/rem-015-historical-remediation-plan-40c8177565e0).

### REM-016 (for GAP-012)

- **Finding** (cand-18, L-CONS, MED, votes uphold/uphold/uphold): Vision.md declares HoBo 'competes head-on with Convex, Lakebed, and Nitric' three times, borrows from Lakebed, and design/index.md carries a whole 'Competitive frame vs Lakebed' table — but no Lakebed capture exists in docs/competitors/ (which promises 'faithful captures'), it is absent from competitors/index.md and even from its future-competitor backlog list; Lakebed appears only in passing in encore.md and gap-analysis.md.
- **Evidence:** `docs/design/vision.md:14` · `docs/design/vision.md:43` · `docs/design/index.md:136-144` · `docs/competitors/index.md:5-23` · `docs/competitors/gap-analysis.md:10`
- **Effort:** M · **Delivery:** [HOBO-681](https://linear.app/quickdeploy-ai/issue/HOBO-681) (Intent-Alignment Gap Remediation project)

Historical remediation instructions: [Linear archive](https://linear.app/quickdeploy-ai/document/rem-016-historical-remediation-plan-e2ddd9b6211b).

### REM-017 (for DRIFT-005)

- **Finding** (cand-19, P1, LOW, votes uphold/uphold/uphold, drift-class silent): platform-engineering.md still says 'multi-Yard federation (multi-region/regulatory) is out of scope (Q20)' citing a dangling anchor (generated-stack.md contains no Q20/open-questions text), contradicting ADR-0043 which fully designs multi-Yard federation (the Junction) and control-plane.md which says an air-gapped Yard 'may stand alone or join a Junction'.
- **Evidence:** `docs/design/platform-engineering.md:229` · `docs/design/adr/07-portability-extensibility.md#adr-0043` · `docs/design/control-plane.md:93` · `docs/design/data-plane.md:601`
- **Effort:** S · **Delivery:** ✔ [HOBO-682](https://linear.app/quickdeploy-ai/issue/HOBO-682) — Q20 federation-out-of-scope claims repointed to ADR-0043 Junction

Historical remediation instructions: [Linear archive](https://linear.app/quickdeploy-ai/document/rem-017-historical-remediation-plan-503fdc73c6f9).

### REM-018 (for DRIFT-006)

- **Finding** (cand-20, P3, LOW, votes uphold/uphold/uphold, drift-class silent): nitric.md's HoBo-mapping layer has drifted from the current design: it maps `nitric up/down` -> `hobo deploy/destroy` and `nitric run` -> `hobo dev --containers` (the design collapsed to `hobo up/down` and defines no --containers flag), names the schedule port `hobo:schedule` vs the design's `hobo:scheduler`, and its 'Open parity items' still lists the WebSocket WIT shape and sql-migrations as open although ADR-0075 and ADR-0032/Plan 32 resolved them.
- **Evidence:** `docs/competitors/nitric.md:313` · `docs/competitors/nitric.md:336` · `docs/competitors/nitric.md:355` · `docs/design/developer-experience.md:71` · `docs/design/wasm-runtime-wit.md:201` · `docs/design/authoring-resources-wiring.md:127`
- **Effort:** S · **Delivery:** ✔ [HOBO-683](https://linear.app/quickdeploy-ai/issue/HOBO-683) — nitric.md HoBo-mapping reconciled

Historical remediation instructions: [Linear archive](https://linear.app/quickdeploy-ai/document/rem-018-historical-remediation-plan-b05a1ae0ece4).

### REM-019 (for GAP-013)

- **Finding** (cand-22, P4, LOW, votes uphold/uphold/uphold): FinOps has zero dedicated research notes despite normative adoption: ADR-0039 §3 models showback on OpenCost and the control-plane doc baselines FOCUS 1.4/FinOps Framework, yet docs/standards/ has a note for every other adopted standard (CloudEvents, OCSF, OpenSLO, OpenFeature...) but none for FOCUS/OpenCost, and docs/competitors/ has no FinOps-market entry (Kubecost, Infracost, Vantage, Cast.ai).
- **Evidence:** `docs/design/adr/02-identity-security.md:282` · `docs/design/finops-budget-routing-control-plane.md:108` · `docs/standards/index.md` · `docs/competitors/index.md` · `docs/competitors/antimetal.md:173`
- **Effort:** M · **Delivery:** [HOBO-684](https://linear.app/quickdeploy-ai/issue/HOBO-684) (Intent-Alignment Gap Remediation project)

Historical remediation instructions: [Linear archive](https://linear.app/quickdeploy-ai/document/rem-019-historical-remediation-plan-a71701fdf79e).

### REM-020 (for GAP-014)

- **Finding** (cand-25, P5, LOW, votes uphold/uphold/uphold): Capability Manifest prose (signs.md / llms.txt) is designed to be read by agents at discovery time, yet the ADR-0023 §3 untrusted-material/sanitization rule is scoped only to generation-pipeline inputs and the Plan 12 threat table's injection row covers only generation-pipeline plugins — manifest prose consumed by operating/planning agents is never classified as untrusted input in the design suite (the broader prompt-injection candidate is otherwise refuted by tool contracts, the MCP hardening proof, and enforced guardrails).
- **Evidence:** `docs/design/ai-native-agent-auth.md:35` · `docs/design/ai-native-agent-auth.md:78` · `docs/design/adr/02-identity-security.md:37` · `docs/design/security-networking.md:30` · `docs/design/generated-stack.md:177`
- **Effort:** M · **Delivery:** [HOBO-685](https://linear.app/quickdeploy-ai/issue/HOBO-685) (Intent-Alignment Gap Remediation project)

Historical remediation instructions: [Linear archive](https://linear.app/quickdeploy-ai/document/rem-020-historical-remediation-plan-e4f5db3cf8c4).

### REM-021 (for DRIFT-007)

- **Finding** (cand-26, L-DRIFT, LOW, votes uphold/uphold/uphold, drift-class deliberate-undocumented): The design-suite scope statement (index.md: 'The whole suite is one scope — every plan is in scope, bounded only by the AI-native-meta-cloud-minus-monetization line (ADR-0063/ADR-0064)') is stale: the same index now lists monetization-adjacent commercial records (billing, tax, invoicing evidence, payout hooks) and a phased launch program, so the stated bound no longer describes the suite's contents.
- **Evidence:** `docs/design/index.md:120` · `docs/design/index.md:53-57` · `docs/design/index.md:66-67` · `docs/design/adr/07-portability-extensibility.md:294`
- **Effort:** S · **Delivery:** [HOBO-686](https://linear.app/quickdeploy-ai/issue/HOBO-686) (Intent-Alignment Gap Remediation project)

Historical remediation instructions: [Linear archive](https://linear.app/quickdeploy-ai/document/rem-021-historical-remediation-plan-fa76a17909b4).

### REM-022 (for DRIFT-008)

- **Finding** (cand-27, L-CONS, LOW, votes uphold/uphold/refute, drift-class silent): gap-analysis.md's traceability anchors have rotted: matrix and §C rows cite numbered open questions (Q3/Q10/Q12/Q15-Q20/Q21-Q23, '09 §15-20') linking to generated-stack.md#plan-09, but the current Plan 9 'Open design questions' list is unnumbered and contains none of those IDs, and matrix rows retain partial/missing markers for capabilities the same doc later records as closed (only §2 is explicitly labeled historical).
- **Evidence:** `docs/competitors/gap-analysis.md:31` · `docs/competitors/gap-analysis.md:34` · `docs/competitors/gap-analysis.md:72` · `docs/competitors/gap-analysis.md:138` · `docs/design/generated-stack.md:352`
- **Effort:** M · **Delivery:** ✔ [HOBO-687](https://linear.app/quickdeploy-ai/issue/HOBO-687) — historical open-question ledger + link retargets

Historical remediation instructions: [Linear archive](https://linear.app/quickdeploy-ai/document/rem-022-historical-remediation-plan-c20e73800c90).

### Historical open-question ledger
(heading must be exactly this text — the repo's slugifier produces the anchor `#historical-open-question-ledger`, which every re-pointed link below targets)
- Intro paragraph (2-3 sentences): the 2026-06-22 competitor gap analysis (../competitors/gap-analysis.md) cited Plan 9's then-numbered open questions by stable IDs (Q3-Q23); the list above is the *current* unnumbered set. This ledger preserves the historical IDs as permanent citation targets. IDs are frozen — never renumber; IDs not cited by any surviving cross-reference (Q1-Q2, Q4-Q9, Q11, Q13-Q14) are deliberately not reconstructed.
- Markdown table `| ID | Question (2026-06-22 snapshot) | Status | Resolution |` with exactly these 12 rows (all link targets verified to exist as headings):
  - Q3 | Matching algorithm choice | Resolved | [ADR-0033](./adr/01-architecture-core.md#adr-0033)
  - Q10 | wasm host-of-record for prod | Resolved | [ADR-0031](./adr/01-architecture-core.md#adr-0031)
  - Q12 | Non-TS IfC parity | Still open | carried forward as the "IfC-by-default fidelity for non-TS languages" bullet above ([Plan 21](./authoring-resources-wiring.md#plan-21))
  - Q15 | App-data schema evolution & migration | Resolved | [Plan 32](./data-plane.md#plan-32) / [ADR-0032](./adr/03-data-plane.md#adr-0032)
  - Q16 | Cross-Camp stateful consistency | Resolved | [ADR-0040](./adr/01-architecture-core.md#adr-0040)
  - Q17 | Local-dev fidelity + dev dashboard | Resolved | [ADR-0042](./adr/07-portability-extensibility.md#adr-0042)
  - Q18 | Billing / quota / runaway-spend | Resolved | [ADR-0039](./adr/02-identity-security.md#adr-0039)
  - Q19 | Migration / onboarding | Resolved | [ADR-0041](./adr/07-portability-extensibility.md#adr-0041)
  - Q20 | Multi-Yard federation | Resolved (clarified: v1 single-Yard; the Junction designed) | [ADR-0043](./adr/07-portability-extensibility.md#adr-0043)
  - Q21 | Reactive / live-query model | Resolved | [Plan 32](./data-plane.md#plan-32) / [ADR-0050](./adr/03-data-plane.md#adr-0050)
  - Q22 | Vector & full-text search | Resolved | [ADR-0034](./adr/03-data-plane.md#adr-0034)
  - Q23 | Custom domains / multi-cloud ingress | Resolved | [ADR-0035](./adr/07-portability-extensibility.md#adr-0035)
  IMPORTANT: Q21 must link ADR-0050, NOT ADR-0029 — gap-analysis prose mentions "ADR-0029" but no `## ADR-0029` heading exists in any docs/design/adr/ theme file; a link to it fails the design-docs lint. Leave the plain-text "ADR-0029" mentions in gap-analysis prose untouched (historical trail, covered by the banners).

FILE 2 — AMEND C:/src/hobo/docs/competitors/gap-analysis.md
(a) §1 banner: directly under `## 1. Comparison matrix` (line 20), before the Legend line, add a blockquote mirroring §2's existing banner style: "> **Historical snapshot (2026-06-22) — markers not current.** The ◐/✗ cells record the original analysis; capabilities later closed in design are marked ✅ inline in §3/§5 and mapped in the [historical open-question ledger](../design/generated-stack.md#historical-open-question-ledger). Preserved as the reasoning trail, not as current state."
(b) §C banner + citation: change the §C heading's citation `(competitor-confirmed priorities — see [09 §15–20](../design/generated-stack.md#plan-09))` (line 72) to `(competitor-confirmed priorities — see the [historical open-question ledger](../design/generated-stack.md#historical-open-question-ledger))`, and add a one-line blockquote under it: "> **Historical snapshot** — statuses as of the original analysis; strikethrough+✅ rows were closed later. Current status per ID: the ledger."
(c) Re-point ONLY the Q-ID / question-number links whose fragment is `#plan-09` to `#historical-open-question-ledger` (path part unchanged): lines 28 [Q3], 31 [Q21], 34 [Q15], 35 [Q17], 36 [Q12], 54 [Q3], 55 [Q10], 56 [Q15], 63 [Q22], 67 [Q23], 69 [Q20], 132 [Q10], 133 [Q15], 134 [Q3], and the footer line 138 `[09](../design/generated-stack.md#plan-09)` (its sentence is about open questions #21–23). In the §C table (lines 75-81), turn each plain `#N` cell (#17, #12, #3, #10, #16, #15, #18) into `[#N](../design/generated-stack.md#historical-open-question-ledger)`. Do NOT retarget line 53's `[09](../design/generated-stack.md#plan-09)` — that one cites Plan 9's conformance gate, not a question ID.

FILE 3 — AMEND C:/src/hobo/docs/competitors/index.md (line 21)
Retarget `[open questions #21–23](../design/generated-stack.md#plan-09)` to `../design/generated-stack.md#historical-open-question-ledger` and append "(all since resolved — see the ledger)" after the link. index.md correctly has no frontmatter — do not add any.

FILE 4 — AMEND C:/src/hobo/docs/design/data-plane.md (lines 556 [Q16], 601 [Q20]) and C:/src/hobo/docs/design/platform-engineering.md (line 229 [Q20])
Same mechanical retarget: in those three `[Qn](./generated-stack.md#plan-09)` links, replace fragment `#plan-09` with `#historical-open-question-ledger`. Change nothing else on those lines.

**Acceptance**

Checklist (run from C:/src/hobo):
1. `pnpm run docs:okf` — passes (no new docs created; both amended docs/ files already carry OKF frontmatter with non-empty `type:`; competitors/index.md must remain frontmatter-free).
2. `pnpm run docs:design-lint` — passes; this is the gate that proves the new `#historical-open-question-ledger` anchor resolves (scripts/check-design-docs.ts slugifies headings via lowercase + strip non-[a-z0-9 space -] + spaces→hyphens, so the heading `### Historical open-question ledger` yields exactly that anchor) and that all 12 ledger Resolution links hit real `## ADR-XXXX` / `## Plan NN` headings.
3. `pnpm agent:check -- --staged` — passes with all edits staged.
4. Traceability gate (docs/design/ touched): `node --import tsx scripts/validate-traceability.ts` — passes. Note: there is NO package.json alias for this; agent:check auto-triggers it only for docs/design/adr/**, docs/design/traceability.md, docs/design/index.md, or docs/design/proofs/** changes (scripts/relevant-check-policy.ts line 74), so run it explicitly.
5. Rot fully purged: `pnpm run search -- -n "\[Q[0-9]+\]\([^)]*#plan-09\)" docs` returns zero matches; `pnpm run search -- -n "#plan-09" docs/competitors` returns only gap-analysis.md line 53 (the conformance-gate citation).
6. Cross-links updated (complete list): docs/competitors/gap-analysis.md (16 links + 7 §C cells + 2 banners), docs/competitors/index.md line 21, docs/design/data-plane.md lines 556/601, docs/design/platform-engineering.md line 229. No index/hub file needs a NEW link — the ledger is a subsection of an already-indexed doc (docs/design/index.md already links generated-stack.md).
7. Diff hygiene: `git diff --stat` shows exactly 4 files changed, no ADR theme files touched, no heading in generated-stack.md above the new h3 modified.

**Guardrails**

Documentation-only; no code, no requirement changes, and the Nomad→wasmCloud pivot is untouched. Do NOT create a new ADR or edit any file under docs/design/adr/ (this is traceability repair, not a decision; existing ADR IDs are never renumbered). Do NOT renumber, reorder, reword, or delete the current unnumbered "Open design questions" bullets — the ledger sits after them. Do NOT reconstruct uncited historical IDs (Q1-Q2, Q4-Q9, Q11, Q13-Q14) or invent question text beyond what gap-analysis already records. Do NOT change any ✅/➕/◐/✗ matrix markers or the historical prose in gap-analysis §§2-5 — banners and link retargets only. Do NOT link ADR-0029 anywhere (no such heading exists; docs:design-lint will fail) and do not "fix" the plain-text ADR-0029 mentions. Do NOT retarget plan-semantics links to #plan-09 (gap-analysis line 53, and all intra-generated-stack.md `[9](#plan-09)` links). Keep all links relative `.md` links per repo norms; index.md files stay frontmatter-free.

### REM-024 (for GAP-016)

- **Finding** (cand-29, L-CONS, LOW, votes uphold/uphold/uphold): The requirements suite and roadmap were moved under docs/archive/ without rewriting relative links: every ../design/* link in docs/archive/requirements/*.md resolves to the nonexistent docs/archive/design/, and both docs also reference design files that no longer exist under any path (adr/08-scope-and-requirements.md, forge-generated-stack.md, roadmap.md#plan-08, per-stage anchors), so intent->requirements->design tracing misroutes at every hop.
- **Evidence:** `docs/archive/requirements/index.md:20-39` · `docs/archive/requirements/requirements.md:25-35` · `docs/archive/roadmap.md:22` · `docs/design/adr/index.md:10-14`
- **Effort:** M · **Delivery:** ✔ [HOBO-689](https://linear.app/quickdeploy-ai/issue/HOBO-689) — archive link remap in `docs/archive/requirements/*.md` and `docs/archive/roadmap.md`

Historical remediation instructions: [Linear archive](https://linear.app/quickdeploy-ai/document/rem-024-historical-remediation-plan-72057e165f94).

### REM-025 (for GAP-017)

- **Finding** (cand-30, L-CONS, LOW, votes uphold/uphold/uphold): The canonical glossary — declared the single source of truth for canonical term definitions — omits the FinOps control plane's coined vocabulary (ResourceIntent, metric contract, MetricVector, ParetoFrontier, decision graph, DX/OpsX/FinX surfaces) and the ubiquitous 'Crew' alias, even though newer Meta-cloud Broker terms were added, showing the maintenance path exists but skipped the FinOps delta.
- **Evidence:** `docs/design/glossary.md:10-14` · `docs/design/finops-budget-routing-control-plane.md:51-83` · `docs/design/glossary.md:49-62` · `docs/design/index.md:24`
- **Effort:** S · **Delivery:** ✔ [HOBO-690](https://linear.app/quickdeploy-ai/issue/HOBO-690) — seven FinOps/Crew rows in `docs/design/glossary.md`

Historical remediation instructions: [Linear archive](https://linear.app/quickdeploy-ai/document/rem-025-historical-remediation-plan-16e40bfbcc66).

### REM-004 (for GAP-001)

- **Finding** GAP-001 [P1 · gap · HIGH · drift-class silent]: Node-level workload scheduling inside a Camp has no owner in the design.
- **Action:** ADR-0108 records the `component-host` scheduler seam (wadm default on self-hosted wasmCloud lattice; substrate-delegated elsewhere); cross-links in wasm-runtime-wit.md, control-plane.md, authoring-resources-wiring.md, reliability-observability-cost.md, platform-engineering.md; ADR-P6–P8 for deferred preemption/oversubscription/capacity-reservation.
- **Acceptance:** `docs:okf`, `agent:check -- --staged`, `validate-traceability.ts`, `lint:docs:staged`; wadm hits in wasm-runtime-wit.md, adr/01-architecture-core.md, control-plane.md; all scheduling semantics labeled designed/delegated/deferred.
- **Effort:** M
- **Delivery:** ✔ [HOBO-669](https://linear.app/quickdeploy-ai/issue/HOBO-669) — ADR-0108 in `docs/design/adr/01-architecture-core.md`

### REM-026 (for GAP-018)

- **Finding** (P2, MED): `hobo dev` local multi-service orchestration is unspecified — lifecycle APIs exist for deploy but the inner loop never states dependency-gated startup semantics per annotation class.
- **Evidence:** `docs/design/authoring-resources-wiring.md:150-151` · `docs/design/developer-experience.md:135-139` · `docs/design/control-plane.md:57-67`
- **Effort:** M · **Delivery:** ✔ [HOBO-694](https://linear.app/quickdeploy-ai/issue/HOBO-694) (Intent-Alignment Gap Remediation project)

Historical remediation instructions: [Linear archive](https://linear.app/quickdeploy-ai/document/rem-026-historical-remediation-plan-3a82cab11785).

### REM-027 (for GAP-019)

- **Finding** (iter2-B1-002, P3×P4, MED): ResourceIntent FinOps pipeline disconnected from IfC/`hobo plan` spine.
- **Evidence:** `docs/design/finops-budget-routing-control-plane.md:22-36` · `docs/design/control-plane.md:14-28`
- **Effort:** M · **Delivery:** ✔ [HOBO-696](https://linear.app/quickdeploy-ai/issue/HOBO-696) — manifest→ResourceIntent bridge in finops + control-plane docs; proof at `src/draft/technical-proofs/manifest-resource-intent-bridge-contract/`

Historical remediation instructions: [Linear archive](https://linear.app/quickdeploy-ai/document/rem-027-historical-remediation-plan-08c13d3ab25f).

### REM-028 (for GAP-020)

- **Finding** (iter2-B1-003, P3×P4, MED): `costAvailability()` orphaned in ADR-0039 only.
- **Evidence:** `docs/design/adr/02-identity-security.md:285-295` · `docs/design/reliability-observability-cost.md:175-177`
- **Effort:** M · **Delivery:** ✔ [HOBO-693](https://linear.app/quickdeploy-ai/issue/HOBO-693) — Plan 21 FinOps inline-budget section + ADR-0039 `costAvailabilityProfile` alignment + `inline-budget-authoring` proof

Historical remediation instructions: [Linear archive](https://linear.app/quickdeploy-ai/document/rem-028-historical-remediation-plan-3863eeaa8169).

### REM-029 (for GAP-021)

- **Finding** (GAP-021, P4×P5, MED): Per-token LLM inference budgets are promised in the AI governance plane but unspecified — no `TokenBudget` object, pre-inference gate seam, inference-token metering dimensions (distinct from auth `token.*`), or spend-breaker coupling.
- **Evidence:** `docs/design/governance-planes.md:118-119` · `docs/design/reliability-observability-cost.md:210-216`
- **Effort:** M · **Delivery:** ✔ [HOBO-695](https://linear.app/quickdeploy-ai/issue/HOBO-695) — `TokenBudget` object + `evaluateInferenceTokenBudget` gate seam in governance + Plan 05; glossary row; executable draft POC

Historical remediation instructions: [Linear archive](https://linear.app/quickdeploy-ai/document/rem-029-historical-remediation-plan-4e41be92e1c2).

### REM-030 (for GAP-022)

- **Finding** (iter2-B1-005, P5×L-DRIFT, MED): Crew/MCP/autonomy missing from known-limitations register while launch-messaging scopes Crew to future-roadmap.
- **Evidence:** `docs/design/launch-messaging-claims.md:63` · `docs/design/known-limitations-register.md:38-44`
- **Effort:** S · **Delivery:** [HOBO-697](https://linear.app/quickdeploy-ai/issue/HOBO-697)

Historical remediation instructions: [Linear archive](https://linear.app/quickdeploy-ai/document/rem-030-historical-remediation-plan-556d4cb427fb).

### REM-031 (for GAP-023)

- **Finding** (iter2-B1-006, L-CONS, MED): patterns/standards cross-links rot to removed design paths.
- **Evidence:** `docs/patterns/runtime-code-mutation-persistence.md:37-46` · `docs/patterns/gitops-runbook-promotion.md:44`
- **Effort:** M · **Delivery:** ✔ [HOBO-698](https://linear.app/quickdeploy-ai/issue/HOBO-698) — PR #772; link-guard proof at `src/draft/technical-proofs/patterns-standards-cross-links/`

Historical remediation instructions: [Linear archive](https://linear.app/quickdeploy-ai/document/rem-031-historical-remediation-plan-6d7d6dd2d7cd).

### REM-032 (for GAP-024)

- **Finding** (cand-31, P5, MED, votes uphold/uphold/uphold): Issue-worker automation (`docs/automations/hobo-issue-worker.md`) defines claim protocol and repo guardrails but never maps them to the agent-native safety model — BR-011 / Plan 06 guardrails (`require-approval`, `spendCapUsd`, destroy protection, SafetyEnvelope) are absent, so the automation sits outside the platform's autonomous-operation contract.
- **Evidence:** `docs/automations/hobo-issue-worker.md:147-155` · `docs/archive/requirements/requirements.md:162` · `docs/design/ai-native-agent-auth.md:114-116` · `docs/design/adr/02-identity-security.md#adr-0094`
- **Effort:** S · **Delivery:** ✔ [HOBO-702](https://linear.app/quickdeploy-ai/issue/HOBO-702) — agent-native guardrails mapping table + executable proof at `src/draft/technical-proofs/issue-worker-guardrail-mapping-contract/`

Historical remediation instructions: [Linear archive](https://linear.app/quickdeploy-ai/document/rem-032-historical-remediation-plan-cabe5cd02199).

### REM-033 (for GAP-025)

- **Finding** (iter2-B2-001, P3, MED): dapr.md Bindings + Distributed lock overclaim.
- **Evidence:** `docs/competitors/dapr.md:50,54,121`
- **Effort:** S · **Delivery:** ✔ [HOBO-699](https://linear.app/quickdeploy-ai/issue/HOBO-699) — dapr.md Bindings/Distributed lock downgraded to 🔜 with design anchors; guard at `src/draft/exp-proofs/dx/dapr-parity-anchor-audit/`

Historical remediation instructions: [Linear archive](https://linear.app/quickdeploy-ai/document/rem-033-historical-remediation-plan-99a5f2e3e552).

### REM-034 (for GAP-026)

- **Finding** (iter2-B2-002, P2, MED): aspire.md Hosting.Testing overclaim vs conformance-only harness.
- **Evidence:** `docs/competitors/aspire.md:471`
- **Effort:** S · **Delivery:** ✔ [HOBO-705](https://linear.app/quickdeploy-ai/issue/HOBO-705) — `Aspire.Hosting.Testing` row is ◐ at `aspire.md:471` with a whole-graph-harness iteration hook; acceptance (no ✅ without harness spec) satisfied.

Historical remediation instructions: [Linear archive](https://linear.app/quickdeploy-ai/document/rem-034-historical-remediation-plan-b622b62450c0).

### REM-035 (for GAP-027)

- **Finding** (iter2-B2-003, P2, MED): aspire.md WaitFor overclaim vs Provisioned-only orchestrator.
- **Evidence:** `docs/competitors/aspire.md:452` · `docs/design/control-plane.md:57-67`
- **Effort:** S · **Delivery:** ✔ [HOBO-703](https://linear.app/quickdeploy-ai/issue/HOBO-703)

Historical remediation instructions: [Linear archive](https://linear.app/quickdeploy-ai/document/rem-035-historical-remediation-plan-b3b3e024e40a).

### REM-036 (for GAP-028)

- **Finding** (iter2-B1-008, L-CONS, LOW): runtime-code-mutation pattern stale vs ADR-0048.
- **Evidence:** `docs/patterns/runtime-code-mutation-persistence.md:37` · `docs/design/generated-stack.md:35`
- **Effort:** S · **Delivery:** ✔ [HOBO-700](https://linear.app/quickdeploy-ai/issue/HOBO-700) — pattern doc cites ADR-0048, reframes write-back as decided; guard at `src/draft/technical-proofs/hobo-700-runtime-code-mutation-pattern-adr-contract/`

Historical remediation instructions: [Linear archive](https://linear.app/quickdeploy-ai/document/rem-036-historical-remediation-plan-34155401bf33).

### REM-037 (for DRIFT-009)

- **Finding** (iter2-B2-004, L-DRIFT, HIGH): UI generation mis-cited OUT contradicting ADR-0064 keep list.
- **Evidence:** `docs/design/architecture.md:171` · `docs/design/stage-6-production-hardening-acceptance.md:71` · `docs/design/adr/07-portability-extensibility.md:293-300`
- **Effort:** M · **Delivery:** ✔ [HOBO-704](https://linear.app/quickdeploy-ai/issue/HOBO-704) — all four docs affirm app/UI generation IN scope (ADR-0056/0064 keep list); `UI-layer generation…out…ADR-0064` grep clean in `docs/design/`; pinned by proof [HOBO-704 proof](https://linear.app/quickdeploy-ai/document/hobo-704-adr-0064-ui-generation-citation-remediation-archived-cfc726defefa).

Historical remediation instructions: [Linear archive](https://linear.app/quickdeploy-ai/document/rem-037-historical-remediation-plan-deb3329af507).

### REM-038 (for DRIFT-010)

- **Finding** (iter2-B2-005, L-DRIFT, MED): stage-6 bundles notify as governance plane after ADR-0064 consolidation.
- **Evidence:** `docs/design/stage-6-production-hardening-acceptance.md:65,96` · `docs/design/adr/07-portability-extensibility.md:295`
- **Effort:** S · **Delivery:** ✔ [HOBO-701](https://linear.app/quickdeploy-ai/issue/HOBO-701) — split Scope In + Evidence Required tables

Historical remediation instructions: [Linear archive](https://linear.app/quickdeploy-ai/document/rem-038-historical-remediation-plan-d1bb73ae018b).

### REM-039 (for GAP-029)

- **Finding** (iter4-001, L-CONS, MED): the `hobo:cache` port (ADR-0118) was catalogued in `authoring-resources-wiring.md` and referenced by 11 captures but was missing from the Plan 20 canonical WIT/port catalog — the same class as GAP-007/008/009.
- **Evidence:** `docs/design/wasm-runtime-wit.md:139-149` · `docs/design/authoring-resources-wiring.md:39,60` · `docs/design/adr/03-data-plane.md#adr-0118`
- **Effort:** S · **Delivery:** ✔ applied 2026-07-03 — added a `Cache (ephemeral)` row (`hobo:cache`; verbs get/set/delete/invalidate + admin flush; distinct from durable Key/value) to the Plan 20 building-block table in `wasm-runtime-wit.md`; marked the Key/value row "(durable)".

**Acceptance**

1. `wasm-runtime-wit.md` Plan 20 building-block table has a `hobo:cache` row anchored to ADR-0118.
2. `docs:design-lint` + traceability gate green.

### REM-040 (for GAP-030)

- **Finding** (iter4-002, L-CONS, LOW): `vercel.md` KV row folded Upstash Redis (an ephemeral cache) into the durable `kv` port at ✅ — a residual `kv`-conflation.
- **Evidence:** `docs/competitors/vercel.md:191` · `docs/design/adr/03-data-plane.md#adr-0118` · `docs/competitors/flyio.md`·`render.md`·`heroku.md` (sibling cache-port rows)
- **Effort:** S · **Delivery:** ✔ applied 2026-07-03 — split the `vercel.md` KV row into durable-`kv` (✅) + ephemeral-`cache` (🔜, ADR-0118), matching the Fly/Render/Heroku sibling rows; tidied the Edge Config row's stale "in progress".

**Acceptance**

1. `vercel.md` KV row references the `cache` port (ADR-0118), consistent with the sibling captures.
2. `docs:design-lint` green.

### REM-005 (for GAP-002)

- **Finding** (cand-03, L-CONS, MED): The five-pillar intent framing (Nomad+Aspire+Nitric+FinOps+agent-native) appears nowhere in docs/design/ as an organizing principle — vision.md's borrow-list never names Nomad, the only repo echoes of the composed intent are README's GAPS.md row and GAPS.md itself (both outside the design suite), and traceability.md traces plan/ADR->Linear only, never intent->design.
- **Evidence:** `docs/design/vision.md:68-77` · `docs/design/vision.md:48-64` · `README.md:47` · `GAPS.md:20-26` · `docs/design/traceability.md:10-27`
- **Effort:** M
- **Delivery:** ✔ [HOBO-670](https://linear.app/quickdeploy-ai/issue/HOBO-670) — intent lineage in `docs/design/vision.md` and intent pillar coverage in `docs/design/traceability.md`

### REM-008 (for GAP-005)

- **Action:** Add ADR-0111 for `hobo dev` local dashboard architecture; add Plan 07 § Local dashboard (`hobo dev`) answering serving mode, read path, local vs Camp-backed views, OTLP ingest/deferral, and offline behavior; close cross-links across `developer-experience.md`, `adr/07-portability-extensibility.md`, `aspire.md`, `deployment-dashboard-topology-explorer.md`, `adr/index.md`, and `traceability.md`.
- **Acceptance:** `docs:okf`, traceability gate, and staged `agent:check` pass; five local-dashboard questions answered; cross-link web closed.
- **Effort:** M
- **Delivery:** ✔ [HOBO-673](https://linear.app/quickdeploy-ai/issue/HOBO-673) — ADR-0111 + Plan 07 local dashboard section (PR #746)

### REM-009 (for GAP-006)

- **Action:** Extend ADR-0042/ADR-0041 with explicit `hobo dev` semantics for `external`/adopted resources and `addContainer` workloads; surface in Plan 7, Plan 21, traceability, and aspire.md HoBo mapping.
- **Acceptance:** `docs:okf`, `agent:check --staged`, `validate-traceability.ts`, content checks for matrix rows and `--connect` hits.
- **Effort:** M
- **Delivery:** ✔ [HOBO-674](https://linear.app/quickdeploy-ai/issue/HOBO-674) — ADR-0042 amendments in `docs/design/adr/07-portability-extensibility.md`

### REM-010 (for GAP-007)

- **Action:** Define `hobo:data` as canonical WIT port in Plan 20; demote `wasi:sql` to driver-level; retire the never-defined SQL WIT port; reconcile `hobo:database/*` as frozen proof alias (ADR-0112).
- **Acceptance:** `docs:okf`, `agent:check --staged`, grep assertions per HOBO-675.
- **Effort:** M
- **Delivery:** ✔ [HOBO-675](https://linear.app/quickdeploy-ai/issue/HOBO-675) — ADR-0112 in `docs/design/adr/03-data-plane.md`

### REM-011 (for GAP-008)

- **Finding** (cand-10, P3, MED): The Nitric parity tables claim 'secret (versioned)' parity backed by `wasi:config`/`hobo:secrets`, but `hobo:secrets` was not defined in the canonical interface catalog and no secret-versioning semantics existed in the design suite.
- **Evidence:** `docs/competitors/nitric.md:311` · `docs/design/authoring-resources-wiring.md:42` · `docs/design/wasm-runtime-wit.md:151`
- **Effort:** M
- **Delivery:** ✔ [HOBO-676](https://linear.app/quickdeploy-ai/issue/HOBO-676) — ADR-0113 in `docs/design/adr/02-identity-security.md`; `hobo:secrets` canonical definition in `docs/design/wasm-runtime-wit.md`

### REM-018 (for DRIFT-006)

- **Action:** Reconcile `docs/competitors/nitric.md` HoBo-mapping layer with current design: `nitric up/down` → `hobo up/down` (not `deploy/destroy`), `nitric run` → `hobo dev` (no `--containers` flag), `schedule` port → `hobo:scheduler`, strike WebSocket/sql-migrations open-parity items with ADR-0075/ADR-0032 links; optionally fix `hobo:schedule` in `nomad.md`.
- **Acceptance:** `docs:okf`, staged `agent:check`, `validate-traceability.ts` pass; grep assertions for removed stale strings and ADR link presence; Open parity items = 2 open + 2 resolved.
- **Effort:** S
- **Delivery:** ✔ [HOBO-683](https://linear.app/quickdeploy-ai/issue/HOBO-683) — `docs/competitors/nitric.md`, `docs/competitors/nomad.md`

### REM-012 (for GAP-009)

- **Action:** Specify route-level API security authoring in [Plan 21](./docs/design/authoring-resources-wiring.md#route-level-api-security); catalogue `hobo:http` in [Plan 20](./docs/design/wasm-runtime-wit.md#plan-20); record ADR-0114; cross-link [Plan 6 §6.7](./docs/design/ai-native-agent-auth.md#67-end-user--application-auth--same-principal-same-plane) and [nitric.md](./docs/competitors/nitric.md).
- **Acceptance:** `docs:okf`, staged `agent:check` (traceability), grep checks for `hobo:http` + `#route-level-api-security` anchor, exactly one new ADR-0114, GAPS status ✔.
- **Effort:** M
- **Delivery:** ✔ [HOBO-677](https://linear.app/quickdeploy-ai/issue/HOBO-677) — ADR-0114 in `docs/design/adr/02-identity-security.md`

### REM-013 (for GAP-010)

- **Action:** Specify the FinOps advisory plane (anomaly detection, forecasts, rightsizing/commitment recommendations) at design level with `cost.*` event family and ADR-0115; amend `event-families.md`, `adr/02-identity-security.md`, `adr/index.md`, `traceability.md`, `reliability-observability-cost.md`, `finops-budget-routing-control-plane.md`, `operators-sre.md`, and `glossary.md`.
- **Acceptance:** `docs:okf`, `docs:design-lint`, `validate-traceability.ts`, staged `agent:check` pass; `rightsizing` appears in ≥3 design docs; `cost.AnomalyDetected` catalog row in `event-families.md`; exactly one new ADR index row (ADR-0115).
- **Effort:** M
- **Delivery:** ✔ [HOBO-678](https://linear.app/quickdeploy-ai/issue/HOBO-678) — ADR-0115 FinOps advisory plane in `docs/design/adr/02-identity-security.md`

### REM-015 (for DRIFT-004)

- **Finding** (cand-17, L-DRIFT, MED, drift-class deliberate-undocumented): ADR-0063 states there is 'no version ladder and no deferred-feature bucket in the design' and that delivery phasing is archived, yet docs/design/ now runs a full phased v1 release program whose M0-M4 taxonomy was defined only in the Linear backlog legend — ADR-0063 was never amended and no ADR recorded the productization-category/phase-gate decision or mapped archived stages 0-6 to M0-M4.
- **Evidence:** `docs/design/adr/07-portability-extensibility.md:277-282` · `docs/design/index.md:28-112` · `docs/design/go-no-go-decision-record.md:36-95` · `docs/design/traceability.md:10` · `docs/design/known-limitations-register.md:35-36`
- **Effort:** M
- **Action:** Record ADR-0116 (productization M0–M4 phase gates); amend ADR-0063; update adr/index, traceability, design/index; GAPS register bookkeeping.
- **Acceptance:** `pnpm run docs:okf`, `pnpm run docs:design-lint`, `node --import tsx scripts/validate-traceability.ts`, `pnpm agent:check -- --staged` pass with all six files staged.
- **Delivery:** ✔ [HOBO-680](https://linear.app/quickdeploy-ai/issue/HOBO-680) — ADR-0116 in `docs/design/adr/07-portability-extensibility.md`

### REM-014 (for GAP-011)

- **Action:** Add FinOps operator to the Crew as ADR-0117 plus roster/ownership amendments across operators-sre.md, reliability-observability-cost.md, finops-budget-routing-control-plane.md, and glossary.md.
- **Acceptance:** `docs:okf`, `validate-traceability.ts`, and staged `agent:check` pass; FinOps named consistently as advisory-only across ADR-0054 roster, Plan 40 mermaid/table/scope/verification, FinX owner sentence, commitment-optimization owner, and glossary.
- **Effort:** M
- **Delivery:** ✔ [HOBO-679](https://linear.app/quickdeploy-ai/issue/HOBO-679) — ADR-0117 in `docs/design/adr/03-data-plane.md`

### REM-016 (for GAP-012)

- **Action:** Add `docs/competitors/lakebed.md` faithful capture; link every design-suite Lakebed characterization to it (`vision.md`, `index.md`, `gap-analysis.md`, `competitors/index.md`).
- **Acceptance:** OKF capture with `#hobo-mapping`; relative links resolve; docs gates pass; competitive claims unchanged.
- **Effort:** M
- **Delivery:** ✔ [HOBO-681](https://linear.app/quickdeploy-ai/issue/HOBO-681) — Lakebed competitor capture + cross-links

### REM-cand-26 (for DRIFT-007)

- **Action:** Restate the design-suite Scope paragraph in `docs/design/index.md` with both bounds (platform capability surface + productization/launch records); link six existing commercial-record docs; remove stale "bounded only by" wording.
- **Acceptance:** `grep -c "bounded only by" docs/design/index.md` returns 0; ADR-0063/0064 links and six commercial-doc links valid; `docs:okf`, `docs:design-lint`, `validate-traceability.ts`, and staged `agent:check` pass; no table rows or other paragraphs changed.
- **Effort:** S
- **Delivery:** ✔ [HOBO-686](https://linear.app/quickdeploy-ai/issue/HOBO-686) — dual-bound Scope paragraph in `docs/design/index.md`

### REM-019 (for GAP-013)

- **Action:** Add FOCUS/OpenCost standards research note and FinOps tooling competitor landscape; wire index/back-links from ADR-0039 and finops-budget-routing-control-plane.
- **Acceptance:** `docs:okf`, `validate-traceability.ts`, staged `agent:check`, and `lint:docs:staged` pass; `focus-opencost.md` and `finops-tooling.md` exist with OKF frontmatter; index hubs link both; GAP-013 status ✔.
- **Effort:** M
- **Delivery:** ✔ [HOBO-684](https://linear.app/quickdeploy-ai/issue/HOBO-684) — `docs/standards/focus-opencost.md`, `docs/competitors/finops-tooling.md`, index/back-link updates

### REM-020 (for GAP-014)

- **Action:** Extend ADR-0023 Decision item 3, Plan 06 §6.1/§6.4, and Plan 12 threat table to classify Registry-served Capability Manifest prose as untrusted input in any agent context and cite the HOBO-194 inert-tool-output invariant.
- **Acceptance:** ADR-0023 item 3 covers generation-pipeline inputs and manifest prose; Plan 06 trust-boundary bullet and inert-tool-output paragraph; Plan 12 new threat row; docs:okf + agent:check --staged + validate-traceability pass.
- **Effort:** M
- **Delivery:** ✔ [HOBO-685](https://linear.app/quickdeploy-ai/issue/HOBO-685) — ADR-0023 item 3 + Plan 06/Plan 12 amendments

### REM-022 (for DRIFT-008)

- **Finding** (cand-27, L-CONS, LOW, drift-class silent): gap-analysis.md's traceability anchors have rotted: matrix and §C rows cite numbered open questions (Q3/Q10/Q12/Q15-Q20/Q21-Q23) linking to generated-stack.md#plan-09, but the current Plan 9 open-questions list is unnumbered.
- **Evidence:** `docs/competitors/gap-analysis.md:31` · `docs/competitors/gap-analysis.md:72` · `docs/design/generated-stack.md:352`
- **Effort:** M
- **Action:** Add `### Historical open-question ledger` to generated-stack.md; retarget Q-ID cross-links in gap-analysis.md, competitors/index.md, data-plane.md, and platform-engineering.md.
- **Acceptance:** `docs:okf`, `docs:design-lint`, staged `agent:check`, rot grep checks pass; exactly the remediation doc files changed.
- **Delivery:** ✔ [HOBO-687](https://linear.app/quickdeploy-ai/issue/HOBO-687) — historical open-question ledger + link retargets

## Verified non-issues

| ID | Candidate | Why rejected (covering evidence) |
|---|---|---|
| NI-001 | NFR-012 (plan-time estimate within ±20%) has estimate computation designed (cost.json x usage profile + egress) but no calibration design: the reconciliation 'records the delta' with no consumer specified, there is no price-sheet staleness/refresh policy for t … | Refuted by skeptic majority (P4): The candidate misreads NFR-012: both docs/archive/requirements/requirements.md:337 and the ratified target in docs/design/adr/07-portability-extensibility.md:272 (ADR-0021) define accuracy as "within ±20% of a known fixture", and ADR-0021 line 275 explicitly records the deliberate decision that cost accuracy is an observed (not gated) dimension "measurable only once multi-region HA and the full cost model exist; unti … |
| NI-002 | Multi-agent coordination between Crew operators is reduced to a one-line scope note ('planning/negotiation rides crew.HandoffRequested') with no acceptance/decline/timeout semantics, no cross-operator conflict arbitration (e.g. SRE remediating while GitOps pro … | Refuted by skeptic majority (P5): The claim's own cited paragraph, docs/design/operators-sre.md:104, already formalizes crew.HandoffRequested beyond a transport: a typed handoff package, a policy obligation with a deadline, missing-deadline re-escalation (timeout), event-sourced apply/re-bless/abort decisions, and an explicit recorded decision that agent-to-agent delegation is "the same crew.HandoffRequested ... no separate protocol", bounded by hand … |
| NI-003 | BR-009 'Cost is a first-class input' carries an unexplained 'S->C' priority downgrade (as does FR-070) and its acceptance lands in the final build stage 6, while the owner's intent names FinOps a pillar and the design suite itself treats cost routing as load-b … | Refuted by skeptic majority (P4): The factual predicates hold (S→C at docs/archive/requirements/requirements.md:160 and :309; stage-6 acceptance at :358 and docs/archive/roadmap.md:111; ADR-0071 'load-bearing' at docs/design/adr/01-architecture-core.md:221), but the claim's core — 'no rationale for the downgrade exists anywhere' — is refuted by covering text: requirements.md:148/:35 states priorities now express build order within v1 mapped to build … |
| NI-004 | FR-013/NFR-017's named `explain-failure`/`fix --dry-run` surface was folded into 'gate results/actions exposed through SDK/dashboard/MCP surfaces' (documented in Plan 07), but no design doc specifies the machine-readable failure-result schema NFR-017 requires … | Refuted by skeptic majority (P5): The claim's core assertion — that no design doc specifies the machine-readable failure-result schema NFR-017 requires — is contradicted by existing coverage: docs/design/contracts-policy-flags.md:57-64 and :80 specify machine-readable gate blocks with root cause + suggested fixes as replayable per-gate events, and the design suite already specifies the exact shared envelope the remediation proposes via HOBO-571 (docs … |
| NI-005 | FR-020/NFR-004 promise full CLI/SDK<->MCP parity and the CLI has a canonical linted spec (cli-spec.md), but the MCP surface has no canonical tool catalog — Plan 06 §6.4 is explicitly an 'Initial tool surface' and the HOBO-173 proof names 'the base MCP tool cat … | Refuted by skeptic majority (P5): The claim that "the MCP surface has no canonical tool catalog" is contradicted by existing covering material: src/draft/technical-proofs/hobo-mcp-server-contract/src/mcp-server-contract.ts pins MCP_TOOL_SPECS (full tool list with JSON-schema inputs/outputs and read/write/destructive annotations) plus CLI_MCP_PARITY mapping all 27 cli-spec.md verbs to MCP tools, enforced by assertCliParity which fails on missing tools … |
| NI-006 | Heterogeneous workload support (containers without wasm wrapper, VMs, batch/periodic jobs) is unaddressed (A1-P1-005). | Rejected by its own lens: Covered: plain OCI containers are a first-class fallback through the identical pipeline, VMs/microVMs are Workload Profiles with Packer/Firecracker/Vagrant adapters and vm/microVm port kinds, batch is hobo:job, periodic is hobo:scheduler. Only system/per-node jobs and raw-exec remain uncovered, tracked in cand-05. `docs/design/wasm-runtime-wit.md:25` · `docs/design/platform-engineering.md:174` · `docs/design/control-plane.md:277` |
| NI-007 | Multi-Yard federation is deferred and single-region HA is under-specified (A1-P1-006). | Rejected by its own lens: ADR-0043 fully specifies the Junction (trust lifecycle, signed policy packs, peer-not-controller invariant) and Plan 5 specifies single-region HA (quorum log, leases+fencing, leader election, 99.9% target); the genuinely deferred pieces are recorded (ADR-0040 failover ceremony, ADR-P1 consensus choice) — deliberate-documented. `docs/design/adr/07-portability-extensibility.md#adr-0043` · `docs/design/reliability-observability-cost.md:63` · `docs/design/adr/01-architecture-core.md#adr-0040` |
| NI-008 | Wiring parity with Aspire is undocumented (A2-R1). | Rejected by its own lens: The mapping is explicit and complete: bind adopts WithReference semantics with lazy reference tokens, Aspire env conventions kept for the container fallback, annotations map to .with(), the manifest IR stays interop-close to aspire-manifest.json and imports Aspire manifests, and deliberate departures are stated. `docs/design/authoring-resources-wiring.md#wiring--the-manifest-ir-aspire-model` · `docs/competitors/aspire.md#primitive-mapping` |
| NI-009 | The original platform plan's open question 'Local-dev fidelity (networking tiers, auth, quotas, secrets)' is unresolved drift (A2-R2). | Rejected by its own lens: Closed by ADR-0042's simulate/mock/camp-only classification, the fidelity table in developer-experience.md, fidelity labels on the CLI dev verb, and the HOBO-122 proof asserting the labels surface. `docs/design/adr/07-portability-extensibility.md#adr-0042` · `docs/design/developer-experience.md:148-153` · [HOBO-122 proof](https://linear.app/quickdeploy-ai/document/hobo-122-dev-loop-proof-archived-d4ba66511f44) |
| NI-010 | Local-dev secret resolution is unspecified (A2-R3). | Rejected by its own lens: Fully covered: hobo dev resolves secretRef against an ordered dev-only ladder (.env.local -> OS keychain -> interactive prompt, CI-skipped), marked non-production, audited as dev, and never satisfying a production can-deploy. `docs/design/authoring-resources-wiring.md:263` · `docs/design/proofs/hobo-392-local-dev-test-authoring/index.md` |
| NI-011 | A Nitric building block (api/kv/bucket/queue/topic/secret/sql/schedule/websocket/job/website) lacks a HoBo resource or recorded rejection (A3-R1). | Rejected by its own lens: Every block has a catalog row with a WIT port, .allow() verbs, and cross-cloud equivalence, plus explicit parity tables in both the design and the competitor doc; residual per-row issues are captured in cand-09/10/11. `docs/design/authoring-resources-wiring.md:35-75` · `docs/design/wasm-runtime-wit.md:117-135` · `docs/competitors/nitric.md:302-318` |
| NI-012 | Multi-language (non-TS) IfC authoring parity vs Nitric's SDKs is missing (A3-R2). | Rejected by its own lens: The wasm/WIT spine plus non-TS SDK path is designed (hobo:sdk WIT-first contract, conformance-gated idiom layers, explicit collection facts, collection-coverage gate for non-TS guests); the remaining run-to-collect-vs-static-analysis depth choice is a recorded open design question — deliberate-documented. `docs/design/adr/01-architecture-core.md#adr-0072` · `docs/design/adr/01-architecture-core.md:259` · `docs/design/generated-stack.md:364` |
| NI-013 | No design-side commitment of the initial provider matrix (A3-R3). | Rejected by its own lens: control-plane.md commits a providers & deploy-targets matrix with a per-port equivalence table, ADR-0024 §7 names the validated seed set, and ADR-0021 gates the >=2-provider portability NFR; which pair ships first is build sequencing, explicitly deferred by ADR-0063 — deliberate-documented. `docs/design/control-plane.md:122` · `docs/design/adr/07-portability-extensibility.md:26` · `docs/design/adr/07-portability-extensibility.md:267` |
| NI-014 | Design drifted from the archived requirements' .allow() model to inferred-from-usage with .allow() as narrow-only override (A3-R4). | Rejected by its own lens: The shift is deliberate and recorded (ADR-0069 §5, Plan 21 permission model), preserves the triple-effect least-privilege guarantee the requirements actually test, and the requirements layer is archived planning material per ADR-0018. `docs/design/adr/01-architecture-core.md:100` · `docs/design/authoring-resources-wiring.md:19` · `docs/design/adr/07-portability-extensibility.md#adr-0018` |
| NI-015 | Shared/amortized cost attribution (multi-tenant Yard services, cross-boundary egress) is silently missing (A4-R1). | Rejected by its own lens: Designed and proof-backed: HOBO-325 proof shows usage-weighted tenant splits summing exactly with a system bucket and deterministic replay; egress is attributed per bind edge by connectivity tier and cross-provider link.Called egress feeds the cost model. `docs/design/proofs/hobo-325-shared-cost-attribution/index.md` · `docs/design/reliability-observability-cost.md:201` · `docs/design/adr/02-identity-security.md:282` |
| NI-016 | The Dispatcher lacks commitment/reserved-capacity awareness (A4-R2). | Rejected by its own lens: ADR-0071 folds committed credits + expiry + budget caps into effective marginal cost via CreditLedgerView, and savings-plan purchase is an explicitly documented advisory-only boundary; the residual owner question (who produces commitment recommendations) is folded into cand-12/cand-13. `docs/design/adr/01-architecture-core.md:221` · `docs/design/reliability-observability-cost.md:240` · `docs/design/finops-budget-routing-control-plane.md:131` |
| NI-017 | Egress-cost modeling in placement decisions is missing (A4-R3). | Rejected by its own lens: The Planner cost model prices egress per bind edge by connectivity tier (same_region/cross_region/internet), penalizes cross-cloud hops so it naturally colocates, and the Dispatcher's amortized switching cost includes egress — backed by the HOBO-363 executable proof. `docs/design/reliability-observability-cost.md:192` · `docs/design/reliability-observability-cost.md:203` · [HOBO-363 proof](https://linear.app/quickdeploy-ai/document/hobo-363-dispatcher-maximize-credits-proof-archived-ff8a13380e12) |
| NI-018 | The autonomy decision algorithm for agent actions is unspecified (A5-05). | Rejected by its own lens: ADR-0094 defines the SafetyEnvelope fields, four decision classes with most-restrictive-wins derivation, self-causation quarantine/cooldowns, fail-closed defaults for uncomputable blast radius, and a contractual scenario table. `docs/design/adr/02-identity-security.md#adr-0094` · `docs/design/adr/02-identity-security.md:453` · `docs/design/operators-sre.md:24` |
| NI-019 | Trace->training-data flow, privacy boundaries, and tenant opt-out are unspecified (A5-06). | Rejected by its own lens: ADR-0099 pins classify-before-persistence, redacted optimizer payloads, PII/secret sealing, fail-closed tenant isolation, and retention/sampling/opt-out inheritance; ADR-0098 pins the eval methodology; cross-tenant aggregation is a recorded in-ADR deferral — deliberate-documented. `docs/design/adr/03-data-plane.md#adr-0099` · `docs/design/adr/03-data-plane.md#adr-0098` · `docs/design/adr/03-data-plane.md:439-441` |
| NI-020 | The Capability Manifest trust model against adversarial publishers is unevaluated (A5-07). | Rejected by its own lens: Evaluated and proof-backed: unsupported capability claims refused before certification, forged conformance reports re-run in-boundary, unsigned/tampered packages refused, anti-rollback and yank lifecycles exist, equivalence-entry truthfulness conformance-gated; the residual manifest-prose injection vector is tracked as cand-25. `docs/design/proofs/hobo-221-provider-containment/index.md` · `docs/design/adr/02-identity-security.md#adr-0009` · `docs/design/adr/01-architecture-core.md#adr-0090` |
| NI-021 | Agent rate-limit/quota fairness treatment is missing (A5-08). | Rejected by its own lens: Specified at design-appropriate depth: per-principal and per-tenant limits with backpressure and typed throttle errors (ADR-0023 §2), synchronous pre-commit quota reservations bounding overshoot (ADR-0039 §2), and an authz latency NFR + bounded decision cache for high-frequency Crew principals (ADR-0074 §1). `docs/design/adr/02-identity-security.md:36` · `docs/design/adr/02-identity-security.md:281` · `docs/design/adr/02-identity-security.md:111` |
| NI-022 | The billing docs flatly contradict ADR-0064 by re-adding the removed `billing` port / product billing machinery (A6-REJ-001). | Rejected by its own lens: They are first-party launch-policy records, not product billing capability: they scope out checkout APIs, stored payment credentials, live webhooks, and all money movement, and cite ADR-0064/Plan 05/ADR-0039 as the boundaries they honor. The residual unrecorded-boundary concern is tracked as cand-16. `docs/design/billing-launch-policy.md:54-61` · `docs/design/billing-launch-policy.md:72-90` · `docs/design/usage-to-invoice-reconciliation.md:39-46` |
| NI-023 | The `notify` consolidation in ADR-0064 §3 was undone by product-notifications-lifecycle.md re-creating a standalone notification plane (A6-REJ-002). | Rejected by its own lens: The doc rides the existing consolidated port: it anchors on Plan 11 notification.* events and ADR-0059's single hobo:notify capability behind channel types, and its Scope Out rejects live providers, a notification-center product surface, and marketing systems. `docs/design/product-notifications-lifecycle.md:68-79` · `docs/design/adr/07-portability-extensibility.md:295` |
| NI-024 | entitlements-plan-limits.md reintroduces the 'subscriptions / plans-as-a-product' scope cut by ADR-0064 §2 and ADR-0079 §5 (A6-REJ-003). | Rejected by its own lens: ADR-0079 §5 cuts billing the app developer's tenants; entitlements-plan-limits governs HoBo's own workspace plan tiers (a different subject) and scopes out invoicing, checkout, payments, refunds, tax, and chargeback. The first-party residual is covered by cand-16. `docs/design/entitlements-plan-limits.md:70-82` · `docs/design/adr/02-identity-security.md:136` |
| NI-025 | marketplace-ux.md and publisher-portal.md build the commercial storefront ADR-0062 says Registry distribution is not (A6-REJ-004). | Rejected by its own lens: Browse/trust/install UX is the publish-discover-install-trust lifecycle ADR-0062 keeps, and its consequences explicitly anticipate curation and polished storefront-UX product work with no commercial tiers; the payout-adjacent slice of publisher-portal is the part that brushes removed scope and is tracked under cand-02. `docs/design/adr/07-portability-extensibility.md:163-176` · `docs/design/index.md:68-69` |
| NI-026 | UI-layer/app generation re-entered scope via the generated-stack after an ADR-0064 removal (A6-REJ-005). | Rejected by its own lens: ADR-0064 §1 explicitly KEEPS app generation (UX Designer, design.md, OpenUI, json-render, mcp-apps, ui-render); its §2 remove list is business/monetization only — app generation was never removed. `docs/design/adr/07-portability-extensibility.md:293` · `docs/design/adr/07-portability-extensibility.md:300` |
| NI-027 | The requirements suite was archived with no recorded statement of what superseded it, leaving the design suite's authority implicit (A7-CONS-08). | Rejected by its own lens: The supersession is recorded in three places: docs/design/index.md:116 states archived planning material is not part of the current design state, the archived docs' frontmatter and body state the design docs remain the source of design truth, and ADR-0063 names the archived location and rationale — deliberate-documented. `docs/design/index.md:116` · `docs/archive/requirements/requirements.md:2-5` · `docs/design/adr/07-portability-extensibility.md#adr-0063` |

## Method appendix

**Finding schema** (as returned by review lenses):
`{id, pillar, type: gap|drift, severity, claim, evidence[], counter_evidence_checked[], verdict: confirmed|rejected|refined, proposed_remediation}`

**Severity rubric:** HIGH = a pillar promise is broken or unfindable in the design suite ·
MED = present but under-specified for its stated build stage · LOW = hygiene/traceability.

**Adversarial rules:** no finding may be confirmed without checking
`docs/design/known-limitations-register.md`, the ADR-Pn open-decisions section in
`docs/design/adr/07-portability-extensibility.md`, and a grep sweep of `docs/design/` +
`docs/archive/requirements/requirements.md` for covering text. Deliberate deferrals are
classified 📘 deliberate-documented, not gaps.

**Stop rule:** minimum two iterations; the review closes when an iteration confirms zero new findings. Iterations are Linear-documented work items in the Intent-Alignment Gap Remediation project (milestone "Review iterations (engine)": [HOBO-691](https://linear.app/quickdeploy-ai/issue/HOBO-691), [HOBO-692](https://linear.app/quickdeploy-ai/issue/HOBO-692)) so any agent can run the next iteration from the issue alone.

## Implementation-gap register (2026-07-05)

> A separate lens from the (closed) intent-alignment review above: this register audits the
> **shipped `packages/` scaffold against the design suite** — what the design promises that no
> package implements, and what the promotion of draft proofs into packages has duplicated or
> dropped. IDs are `IMPL-NNN`, append-only, never renumbered. Status key matches the main
> register (🔎/✅/🧯/✔/📘/❎). Findings marked ✔ were remediated in the 2026-07-05
> trainable-code hardening pass ([ADR-0125](docs/design/adr/03-data-plane.md#adr-0125)).

| ID | Sev | Finding | Evidence | Status / remediation |
|---|---|---|---|---|
| IMPL-001 | HIGH | The entire trainable-method surface is design-only: `import { training } from "@hobo/runtime"` (promised at `docs/design/sdk-api.md` §Trainable methods) does not exist — `@hobo/runtime`'s root index exports a single constant. | `packages/runtime/src/index.ts` (one line); design at `docs/design/sdk-api.md#trainable-methods-use-training` | ✔ this pass: `training()`, `training.define()`, `stub()`, `@trainable`, `applyTrainingArtifact()` land in `@hobo/runtime` (ADR-0125) |
| IMPL-002 | HIGH | The `training-engine` WIT port (ADR-0025) has no shipped port types, WIT definition, or engine implementation; `packages/providers/*` is an empty workspace glob although `generated-stack.md` names `@hobo/provider-agent-lightning`/`@hobo/provider-trace`. | `pnpm-workspace.yaml` globs; `docs/design/generated-stack.md:115`; draft proofs only (`src/draft/technical-proofs/training-engine-port-contract`, `built-in-opto-training-engine-contract`) | ✔ this pass: port types in `@hobo/core`, `hobo:training-engine` WIT in `@hobo/wit`, ax-backed built-in engine in `@hobo/provider-ax` (first `packages/providers/*` package). Ax fully covers the TypeScript engine need; Agent Lightning is a Python/out-of-process trainer and stays a design-level optional adapter behind the same port — a 2026-07-09 TS scaffold for it was removed the next day as redundant with provider-ax (YAGNI: no TS adapter until a real out-of-process integration exists) |
| IMPL-003 | MED | Trajectory capture (OTel + OpenInference), live-eval reward attachment, and the champion/challenger promotion pipeline are design + draft-proof only (`evals-training-promotion-gates-poc`), wired into no package. | `docs/design/reliability-observability-cost.md:161-163`; `src/draft/technical-proofs/evals-training-promotion-gates-poc/` | 🧯 partially progressed 2026-07-09: the champion/challenger **promotion gate** is production now (`@hobo/training-pipeline`: three-lens `evaluatePromotionGate` over generated `PromotionDecision`, `promotionEventNames` → `training.Promoted`/`impl.Promoted`/`eval.GateFailed`). 2026-07-10 (HOBO-708): **live-eval reward attachment** is production too — `@hobo/provider-agentv` grades stored trajectories with [agentV](docs/technologies/agentv.md) (`@agentv/core` pinned; deterministic + caller-wired LLM graders, no agent re-run) into `TrajectoryReward` (`source: "live-eval"`) + per-metric `AgentVGrade`, and `aggregateEvalResults` folds graded samples into the gate's `EvalResult` (loop-tested grade → aggregate → PROMOTE/REFUSE). Remaining slice closed 2026-07-26: **trajectory capture** is production in `@hobo/training-pipeline` (`src/trajectory/`) — `createTrajectoryCapture` emits OTel-shaped, OpenInference-conformant span records (all 10 span kinds, exact semconv attribute keys, W3C traceparent propagation) through a `SpanExporterPort`, assembles them into core's generated `Trajectory` proto-JSON (`parseTrajectory` round-trip + `hashTrajectory` provenance), and `trajectoryCapturedEvent` rides `training.TrajectoryCaptured` on the existing family; integration-tested end to end (capture → agentV grade → aggregate → PROMOTE/REFUSE). ✔ resolved — the full IMPL-003 surface (capture, reward attachment, promotion pipeline) is production |
| IMPL-004 | MED | CLI verbs beyond `new`/`build` are help-text only — `stub`, `generate`, `collect`, `codegen`, `deploy` are declared in `CANONICAL_VERBS` but intentionally unimplemented; real codegen runs through a draft-proof CLI (`s0-04-protobuf-cue-codegen`), not `hobo codegen`. | `packages/cli/src/shell/verbs.ts:210`; `packages/cli/src/shell/dispatch.ts:49-52`; root `package.json` `codegen` script | 🧯 progressed 2026-07-10: `hobo codegen` is real and self-contained — the project codegen engine is promoted into `packages/cli/src/codegen/` as typed, injectable modules (`CodegenEngine` port, layout as config; ledger-frozen proof), consumed by both the verb and the `hobo build` freshness gate with no draft-proof dynamic imports (the old path could not even resolve from the compiled `dist/`). `hobo stub` is real too: codegen emits a contract-backed `training.define()` trainable stub per bindle step (`src/_generated/trainables.ts`, ADR-0125) and the verb materializes/validates them — e2e-tested (generate → stub serves → apply artifact → tuned → revert). Hardened 2026-07-10 (HOBO-706): every output path and generated-import specifier is `CodegenLayout` config (overridable defaults, layout-override test), and the codegen record types (`CodegenArtifact`/`DriftEntry`/`CodegenReport`/`TrainableStub`) are the generated `hobo.cli.v1` proto types (cli codegen opt-in via `data-models/buf.yaml`), lowered with `toJson` at the envelope boundary. Repo-level codegen was already production (`@hobo/schema-tools`). Remaining verbs closed by 2026-07-26: `hobo collect` compiles the project's own `src/bindle.ts` and `hobo generate` runs deterministic generation in the composed CLI; every canonical verb now reports "implemented in this composition". ✔ resolved |
| IMPL-005 | MED | Promoted packages drift from their draft-proof origins with no guard: `packages/runtime/src/replay/*` and `src/draft/technical-proofs/deterministic-replay-engine/src/*` are the same 10-file engine, diverged (`replayer.ts` 143 vs 136 lines); nothing detects such drift. | `diff packages/runtime/src/replay src/draft/technical-proofs/deterministic-replay-engine/src` | ✔ this pass: promotion ledger (`scripts/promotions.json`) + `scripts/check-promoted-proof-drift.mts` guard (root-test enforced); the audit showed the package copy is the hardened promotion (typing/format), so the proof is frozen at its current digests rather than back-ported; policy in `AGENTS.md` |
| IMPL-006 | MED | `packages/componentize` promotion dropped draft capability: the `hobo-componentize` proof has 8 src modules (componentize, validate, parse, oci, smoke, sources, types), the package ships 2 (componentize, index). | `src/draft/technical-proofs/hobo-componentize/src/` vs `packages/componentize/src/` | 📘 audited this pass: the package's `componentize.ts` internalized parse/validate for its S0 gate scope (ADR-0105); `oci`/`smoke`/`sources` are S1+ scope, deferred deliberately — proof stays the reference until those slices land |
| IMPL-007 | LOW | `runtime` (deterministic-replay library) vs `runtimes/runtime-local` (concrete local runtime) is an undocumented singular/plural naming collision, compounded by a third replay surface at `runtimes/runtime-local/src/replay.ts`. | `packages/runtime/`, `packages/runtimes/runtime-local/` | ✔ this pass: distinction documented in both package READMEs; replay-surface consolidation deferred (the runtime-local `replay.ts` is the eventstore's record/replay link mode, a different concern) |
| IMPL-008 | LOW | ~~`packages/iac/*` and `packages/build/*` are declared-but-empty workspace globs.~~ ✔ superseded 2026-08-03: `packages/iac/*` now holds three real adapters (`iac-pulumi`, `iac-terraform`, `iac-crossplane`) and `packages/build/*` is no longer a workspace glob. | `pnpm-workspace.yaml` | ✔ resolved by implementation; historical note retained |
| IMPL-009 | LOW | Dual CUE+proto authoring duplicates the same schema per location, and `event_envelope.{cue,proto}` is authored in both `core` and `runtime-local` `data-models/`. | `packages/core/data-models/`, `packages/runtimes/runtime-local/data-models/` | 🧯 follow-up: single-source generation (proto-first per AGENTS.md, CUE derived) is a codegen slice; not blocking. ✔ resolved 2026-07-25: `packages/core/data-models/` owns the canonical envelope schema (core proto gains the wire `meta` map its domain view already carried; core CUE gains `data`/`meta`); the runtime-local copies are header-marked mirrors kept only for the architecture guard's per-package proto+CUE requirement, differing solely in the proto package line, with the eventstore-specific defs (`#EventInput`, append/snapshot/quarantine) consolidated into `eventstore_port.cue`; divergence now fails `packages/schema-tools/test/envelope-single-source.test.ts` (drift-guarded duplication instead of silent duplication) |
| IMPL-010 | LOW | `closure-builder` is fragmented across six draft proofs overlapping shipped `@hobo/bindles`. | `src/draft/technical-proofs/closure-builder-*` | 📘 draft-proof granularity is per-slice by design (`draft` skill); consolidation happens only via promotion, tracked by the IMPL-005 ledger |
| IMPL-011 | MED | Implementation packages hand-declare TS record types alongside their `data-models/*.proto`. The 2026-07-05 review caught the training slice doing it as true duplication (fixed same pass — those records are now the generated types). A follow-up audit (2026-07-09) found the legacy core/runtime records are a *different* case: they are deliberately-richer parse-don't-validate **domain views** (generic `EventEnvelope<T>`, branded ids like `RunId`, string-union `PrincipalKind`) whose generated `*_pb.ts` is the wire form — coexistence by design, not duplication. | `packages/core/src/ports/{clock,streamer}.ts`, `packages/core/src/{envelope,manifest,ports}.ts`, `packages/core/src/capability/types.ts`, `packages/runtime/src/replay/types.ts` (marked `// domain-view:`) | ✔ resolved 2026-07-09: training slice consumes generated types; legacy domain views reclassified from `parallel-type-allowed` (debt) to `domain-view` (by-design), with the distinction codified in `technical-standards.md` and enforced by `architecture:guard` (both markers accepted, unmarked parallels rejected). No unjustified parallels remain; a true wire↔domain unification (serializing via the generated schema at the eventstore boundary) is optional future hardening, not debt |
| IMPL-012 | MED | Secretless-first config/secrets (ADR-0027) incomplete vs full ladder/mediation/can-deploy/WIT surface. | `packages/bindles` · `packages/identity` · `packages/connectivity` · `packages/contracts` · `packages/wit` · [ADR-0027](docs/design/adr/02-identity-security.md#adr-0027) | ✔ closed: ranked schema + codegen + can-deploy dimension; resolution ladder; Vault JWT/OIDC + AWS SM/Azure KV live-capable adapters + Camp factory; secretless connector plugins (postgres/tcp/mysql/redis) with isolation tiers; encrypted non-sensitive local overrides; plaintext conformance oracle; CredentialAudit folds; Gatekeeper secretless-config gate; `hobo:secrets@0.1.0` WIT + jco bindings + `asHoboSecretsStore` bridge. Preferred paths remain identity federation + `secretRef`/`fromBinding`; managed `hobo:secrets` stays residual Nitric parity only (ADR-0113) |
| IMPL-013 | MED | `agent:check` cannot see a suite it did not select. `behaviorChanged` (`scripts/relevant-check-policy.ts`) keys the cucumber gate off touched paths matching `(^\|/)features/`, so a change that breaks `features/steps/*` from **outside** `features/` skips the gate entirely. Historical example: PR #1032 moved modules the steps imported by relative path, leaving `pnpm run test:behavior` at `ERR_MODULE_NOT_FOUND` exit 1 while a staged `agent:check` reported 18 green checks; those particular steps have since been removed. The same shape applies to any per-file-selected gate whose suite reaches across package boundaries. | `scripts/relevant-check-policy.ts`; historical: `features/steps/control-yard-core-loop.steps.ts` (removed) | 🧯 follow-up: select the behavior gate from what the steps *import*, not from what the diff touched (or run it unconditionally when any `packages/*/src` path in its import graph changes). Not fixed in #1032 — a repo-wide gating change does not belong in a revert PR |
| IMPL-014 | MED | ADR-0071 §5 names stay-in-budget a hard constraint, but `budgetExceeded` is only the first sort key — when every candidate is over budget `decideDispatch` still returns ok and dispatches an over-budget provider; no test covers the all-over-budget case. | `packages/dispatcher/src/dispatcher.ts:793,828-835` | 🧯 filter budget-breaching candidates from the ranked set (or fail the decision when none fit) + negative test. |
| IMPL-015 | MED | Corrupt credit facts fail OPEN on budget: the invalid branch sets `budgetHeadroom = Number.MAX_SAFE_INTEGER`, so a non-numeric budgetCap reads as unlimited budget. | `packages/dispatcher/src/dispatcher.ts:889-903,943-958` | 🧯 invalid credit facts → zero headroom (fail closed) + test. |
| IMPL-016 | MED | The upcaster module claims an unliftable body "fails the gate — and with it can-deploy", but `runCanDeployUpcasterGate` has no caller outside `@hobo/events` and the corpus covers only the 9 `migration.*` types. | `packages/events/src/upcaster.ts:6-11,157` · `packages/contracts/src/can-deploy.ts` | 🧯 wire the gate into Gatekeeper composition as a precomputed dimension, or downgrade the docstring to the events test lane scope. |
| IMPL-017 | MED | `executeDataMigration`'s snapshot-restore compensation has escape paths: `port.verify()` runs outside the rollback try/catch (a throwing verify after the destructive contract phase leaves the store mutated, no restore, no `migration.Failed`), and `CompatGateEvidence.verifiedAt` is never read (stale evidence authorizes the drop). | `packages/trails/src/migration-executor.ts:196,221-243,41-45` | 🧯 wrap verify+compatGate in the rollback scope and require a freshness bound on gate evidence. |
| IMPL-018 | MED | `assertUpgradeScopeBoundary` is documented fail-closed but is a keyword DENYLIST over free text (unmatched = in-scope) with no production caller. | `packages/trails/src/upgrade-preflight.ts:384-411` | 🧯 allowlist of enumerated in-scope actions (deny by default) wired into the dry-run entry point, or restate as advisory classifier. |
| IMPL-019 | MED | Cutover "fail-closed preconditions" (validated change, TTL wait, live incumbent) are all inside `if (precondition)` — omitting the optional field ramps traffic with zero preconditions; no negative test. | `packages/stations/src/traffic-routing/cutover.ts:65-75,222-279` | 🧯 make the precondition required or refuse with `precondition-missing` + negative test. |
| IMPL-020 | MED | The control loop's `budget` signal is a dead discriminant: `signal.fact` is never parsed and `ledgerView` defaults empty, so the "budget signal re-dispatches to the cheaper backend" milestone passes with any signal and no budget crossing. | `packages/stations/src/traffic-routing/control-loop.ts:62-68,166-195` | 🧯 parse the budget fact into ranking inputs (or require a ledgerView) and assert no swap without a crossing. |
| IMPL-021 | MED | stations ARCHITECTURE.md claimed "Stations depend only on `@hobo/core`" while package.json/src also depend on `@hobo/connectivity` + `@hobo/dispatcher`. | `packages/stations/ARCHITECTURE.md:32-35` (pre-fix) | ✔ same-pass: layering statement corrected with the inward rationale; ADR.md dead anchor also fixed. |
| IMPL-022 | MED | The shipped CLI never ran the ADR-0146 residency dimension: `createVerifyCommand()` was registered with no deps (so `deps.residency` was always undefined) and `evaluateResidencyPolicy` had zero production consumers. | `packages/hobo/src/cli.ts:211` · `packages/hobo/src/verify-command.ts` (pre-fix) | ✔ same-pass: env-supplied tenant constraint (`HOBO_RESIDENCY_ALLOW/DENY/CLASSIFICATIONS`, `HOBO_REGION`/`--region`) is the default deps source, layered through `evaluateResidencyPolicy` (deny regulated / warn unregulated), fail-closed typed config errors; 3 new tests. |
| IMPL-023 | MED | ADR-0146 §1 claimed the region catalog covers "every region token providers publish today"; it has 17 entries and omits every Azure token and Cloudflare colo the in-repo providers declare (fail-closed, so those yards fail all residency requests). | `packages/core/src/ports/jurisdiction.ts` REGION_JURISDICTIONS · `packages/providers/provider-azure/src/yard-defaults.ts:39` | ✔ ADR claim softened to the seeded set same-pass. 🧯 extend the catalog to shipped-provider tokens + a test iterating provider manifests. |
| IMPL-024 | MED | The parallel-proto-type guard compares TS names to proto names exactly, so the wave's `*Record`/`*EventData` proto naming makes proto-shaped TS types invisible to it (CreditLedgerView, CorpusEntry, CompatGateEvidence, ControlMapping… all unmarked). | `scripts/check-architecture-guardrails.mjs:341-365` | 🧯 strip configured Record/EventData suffixes before the parallel decision. |
| IMPL-025 | MED | ADR-0071 §6 / ADR-0035 §2 make cost routing legal only for replica-safe resources with a per-route can-deploy refusal; no replica-class eligibility check exists and the control loop cost-routes any topology. | `packages/stations/src/traffic-routing/control-loop.ts:176-226` · `packages/contracts/src/can-deploy.ts` | 🧯 carry replica-class on RoutingTopology backends; refuse synthesis/can-deploy for single-writer cost routes. |
| IMPL-026 | LOW | Offering resolution: `require` returns fallback-satisfied results as resolved, remediation names the provider LACKING the feature, and stability/fidelity are parsed but never consulted. | `packages/core/src/ports/offering-resolution.ts:98-182` | 🧯 `none` under require for fallback-only/low-fidelity; remediation from providers that do offer the id. |
| IMPL-027 | LOW | Control-evidence coverage is unverifiable: refs are caller-invented strings with no binding to real streams/gates, one fact is cited under two spellings, and OCSF-export controls are `planned` though the exporter ships. | `packages/policy/src/control-evidence-pack.ts:157-215` · `packages/policy/src/seed-packs.ts:47-56` | 🧯 canonical evidence-ref registry packs must resolve against; re-audit seed statuses. |
| IMPL-028 | LOW | The dispatcher pact pins an HTTP interaction no code implements, with a request body omitting the registry/ledger the function consumes and a "budget-pressured" scenario carrying zero budget facts. | `packages/dispatcher/contracts/pacts/dispatch_decision.pact.json:10-27` | 🧯 restate as a library-call contract matching decideDispatch's real inputs with real budget facts. |
| IMPL-029 | LOW | `@hobo/dispatcher` opts out of base TS strictness (strict/noImplicitAny/noUncheckedIndexedAccess/exactOptionalPropertyTypes all false); public entry points take implicit any. | `packages/dispatcher/tsconfig.json:5-9` | 🧯 type the exported shapes and restore base strictness. |
| IMPL-030 | LOW | Package docs omit the shipped wave (stations routing loop/cutover/offering registry; trails executors; events upcaster/corpus) and the four `routing.*` loop payloads have no proto/CUE. | `packages/stations/README.md:47-61` · `packages/trails/ARCHITECTURE.md:23-31` | ✔ stations layering + ADR anchor fixed same-pass. 🧯 refresh the three package README/ARCHITECTURE sets + proto/CUE for routing.* payloads. |


## HoBo.CD closures (2026-11-12)

The delivery defects C1–C23 close with HoBo.CD, which lands `@hobo/cd` and its adapter packages
([ADR-0182](docs/design/adr/01-architecture-core.md#adr-0182),
[continuous-delivery.md](docs/design/continuous-delivery.md)). Each row names the work package
whose named tests carry the closure.

| ID | Defect | Closed by | Status |
|---|---|---|---|
| CD-C01 | Four uncoordinated delivery lanes (`up`, hosting transitions, CD plane, broker) shared no desired state | One desired-state model per Camp; `hobo up`/`down`, `hobo deploy`, broker `deliver`, pipelines and MCP all deliver through `@hobo/cd` (WP4, WP7, WP15, WP16, WP18) | ✔ |
| CD-C02 | The CD plane ran only on fixtures | The fixture-only `@hobo/cloud` CD plane is deleted; fixtures are reachable only with `--simulate`, labelled in every result (WP7, WP18) | ✔ |
| CD-C03 | Evidence failed open (`healthSamples ?? [{}, {}]`) | Deterministic verification; no data is FAIL (I5) (WP9, WP10) | ✔ |
| CD-C04 | Rollback never re-applied the prior Set | Rollback is zero exposure, then a Delta to the predecessor Set through the same gate (I7) (WP6, WP7) | ✔ |
| CD-C05 | "Gateway-weighted" changed no traffic; three ramp vocabularies | Capability lowering onto traffic rungs; one ramp engine and `CD_RAMP_DEFAULTS` (WP10, WP14) | ✔ |
| CD-C06 | Kubernetes fields in a neutral broker type | Neutral `DeliveryPolicy`; `destination_namespace` never read; `argo` mapped to a `cd-gitops` publisher (WP16; [upgrade notes](https://github.com/Hobo-Labs/HoBo/blob/3e96e0a51e5f0d286cd9639898913ae0d304c8ba/docs/design/delivery-policy-upgrade.md)) | ✔ |
| CD-C07 | No Freight/artifact contract between any build and CD | Freight, the Freight manifest and ingest (WP1, WP3) | ✔ |
| CD-C08 | Imperative `deliver(set)`; no reconciler for drift | Fenced per-Camp pull reconcilers, drift by observation (I2, I4) (WP7) | ✔ |
| CD-C09 | Promotion semantics undecided | Promote carries Freight and re-runs Matching per Camp (D2); decided in [gitops-runbook-promotion.md](docs/patterns/gitops-runbook-promotion.md) (WP6, WP21) | ✔ |
| CD-C10 | Plan 25's Relay is a reverse tunnel | Agent-mode reconcilers read an outbound-only delivery feed (WP11; Plan 25 rewritten) | ✔ |
| CD-C11 | No multi-node fenced store | `@hobo/storage-postgres` passes the EventStore suite (WP17) | ✔ |
| CD-C12 | Six hosting providers had no resolver; the long tail could never be covered in-tree | In-tree resolvers added; out-of-tree `hobo:resolver` WASM components (I14) (WP8, WP13, WP14) | ✔ |
| CD-C13 | No delivery authorization, metrics or visibility | `CdAction` authorization, OTel CI/CD telemetry, DORA, service read API (WP12, WP19) | ✔ |
| CD-C14 | No artifact store or retention | Content-addressed artifact store and retention (WP1, WP3) | ✔ |
| CD-C15 | Ingress push-only and tied to HoBo CI | Pull Freight sources; OIDC trusted publishing; in-toto/SLSA; CDEvents nudges (I15) (WP1, WP2) | ✔ |
| CD-C16 | No lineage | Pipeline graph with qualification, soak and expiring approvals (I16) (WP5, WP6) | ✔ |
| CD-C17 | No change windows, data-migration sequencing or config-only path | Change windows (I17), Trails sequencing, Delta intent `config` (WP5, WP6) | ✔ |
| CD-C18 | Explicit Camp lists only; no groups, concurrency, failure budget or quorum | Placement and fan-out (I18, I20) (WP22, WP23) | ✔ |
| CD-C19 | No Camp liveness, conditions, taints or failover | Camp inventory and governed failover (I21) (WP22, WP23) | ✔ |
| CD-C20 | Single-approval enrollment; agent facts could be trusted by accident | Double opt-in enrollment; claims only narrow (I19, I24) (WP11, WP22) | ✔ |
| CD-C21 | Rails activated everywhere at once | Rails delivered as Freight, INFORM before ENFORCE (I23) (WP2, WP5, WP24) | ✔ |
| CD-C22 | Policy was admission-time only | Continuous posture, compliance and OSCAL assessment results (I22) (WP24) | ✔ |
| CD-C23 | No way to use an existing Karmada/OCM estate or Kubernetes cluster inventory | `@hobo/cd-kube-fleet` as transport and inventory only (WP25) | ✔ |

Related existing rows: IMPL-004 already recorded `hobo deploy` as implemented; its delivery semantics
are now HoBo.CD's (`docs/design/cli-spec.md`). No existing GAP or DRIFT row is reopened or
rewritten by this section.
