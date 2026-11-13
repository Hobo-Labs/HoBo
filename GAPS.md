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

**Register reconciliation (2026-07-03):** the final two documented-not-applied findings were verified applied on main and flipped 🧯 → ✔ — **GAP-026** (the `Aspire.Hosting.Testing` row is ◐ at `aspire.md:471` with a whole-graph-harness iteration hook; no ✅ without a harness spec) and **DRIFT-009** (the `UI-layer generation…out…ADR-0064` mis-citation returns zero hits in `docs/design/`, pinned by proof `hobo-704-adr-0064-ui-generation-citation`). **All 38 then-confirmed findings were ✔ on main at that date (superseded by the Iteration-4 total of 40 above); zero remain at 🧯.** Linear delivery closure (HOBO-704/705) is tracked independently.

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
| GAP-032 | L-CONS | MED | 🧯 | `packages/code/bin/hobo-code.mjs` (84-line spawnSync dispatcher) is committed JS outside ADR-0126's only sanctioned exception path, and ADR-0139 records no exception for it. | `packages/code/bin/hobo-code.mjs:1-12` · `docs/design/adr/01-architecture-core.md:477-489` | Convert the bin to a compiled `dist` entry (or amend ADR-0126 with a "package bin shim" exception class cited from ADR-0139). 2026-11-08: `packages/code` left `main` for the `feature/hobo-code` branch, so this remediation is open there, not on `main`. |
| GAP-033 | L-CONS | MED | ✔ | ADR-0139 §5 shipped a monetization surface (sponsored wait/status, default ON) in `@hobo/code` without citing the ADR-0064/0107/0110 monetization boundary trio. | `docs/design/adr/03-data-plane.md:641` · `packages/code/src/finops.ts:11-18` | Same-pass: boundary parenthetical added to ADR-0139 §5 routing the surface through ADR-0107 lane 2 (product's own offering; app-facing removal untouched). |
| GAP-034 | P4 | MED | 🧯 | ADR-0129 §5 requires every execution-host/cloud adapter to declare a `terms` reference with `reviewedOn`, but only the three runner adapters carry one; `ProviderTerms` is a runner-local type and no gate reads `reviewedOn`. | `docs/design/adr/07-portability-extensibility.md:493` · `packages/providers/runner-github/src/manifest.ts:64-73` | Lift `ProviderTerms` into the core Capability Manifest, populate cloud providers, add a `reviewedOn` staleness check to the standards gate. |
| GAP-035 | L-DRIFT | MED | ✔ | ADR-0143 §5 and the connectivity provider doc specified a `declareOfferings()` function no code implements — shipped adapters export profile constants. | `docs/design/adr/07-portability-extensibility.md:592` · `packages/providers/provider-aws/src/traffic-routing-offerings.ts:11` | Same-pass: both docs restated in terms of the exported `TrafficRoutingProviderProfile` constant contract. |
| GAP-036 | P5 | MED | ✔/🧯 | ADR-0144 §2's auditability rests on `resourcedef.Registered/Updated` events that nothing emits — the family existed only in the docs catalog. | `docs/design/adr/07-portability-extensibility.md:616` · zero `resourcedef` hits in packages/ | Same-pass: event-families row marked design-only with the gap named. 🧯 emit the facts from the registry/catalog write path (`@hobo/registry` ingest is the natural emitter). |
| GAP-037 | P5 | MED | ✔/🧯 | ADR-0138 §6 promises replayable messaging audit facts, but `messaging.*` was absent from the canonical event catalog and the 10 shipped literals violate `aggregate.PastTenseFact` naming (`messaging.topic.created`, `messaging.dead_lettered`, …). | `packages/core/src/ports/messaging.ts:102-114` · `docs/design/event-families.md:10` | Same-pass: family row added carrying the current literals + divergence note. 🧯 rename the literals to past-tense facts in core + provider-kafka (breaking, needs an upcaster). |
| GAP-038 | L-CONS | MED | 🧯 | ADR-0148 §2 prohibits building props from `rect`/`line` primitives in the presenter, yet the Phaser presenter still composes locomotive/waybills/health-bars/cost-booth from ~13 `rect()` pushes with zero sprite items and no gate enforces the rule. | `docs/design/adr/07-portability-extensibility.md:679` · `packages/control-yard/src/phaser/yard-presenter.ts:996-1005,915,920,597-603` | Port the remaining props to vendored tile/sprite items and add a design-lint rule forbidding rect/line render items for prop ids. |
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
| DRIFT-009 | L-DRIFT | silent | ✔ | UI/app generation is mis-cited as OUT while ADR-0064 §1 explicitly **keeps** app generation (UX Designer, design.md, OpenUI, json-render, mcp-apps, `ui-render` port per ADR-0056): `architecture.md:171`, `stage-6-production-hardening-acceptance.md:71`, `worked-example.md:70`, and `gap-analysis.md:14,18` claimed UI-layer generation was removed under ADR-0064 — contradicting ADR-0064/0056 with no amending decision. | `docs/design/architecture.md:171`<br>`docs/design/stage-6-production-hardening-acceptance.md:71`<br>`docs/design/adr/07-portability-extensibility.md:293-300`<br>`docs/design/adr/03-data-plane.md:264-277`<br>`docs/competitors/gap-analysis.md:14,18` … | [REM-037](#rem-037-for-drift-009) — all four docs now affirm app/UI generation IN scope; `UI-layer generation…out…ADR-0064` grep returns zero hits in `docs/design/`; pinned by proof `hobo-704-adr-0064-ui-generation-citation`. |
| DRIFT-010 | L-DRIFT | deliberate-undocumented | ✔ remediated | stage-6-production-hardening-acceptance.md bundles the consolidated `notify` cloud-messaging port into a single "Governance planes" lane row, contradicting ADR-0064 §3 which demotes `notify` to a catalog port and keeps only compliance/AI-safety enforcement as governance planes. | `docs/design/stage-6-production-hardening-acceptance.md:65`<br>`docs/design/stage-6-production-hardening-acceptance.md:96`<br>`docs/design/adr/07-portability-extensibility.md:295` … | [REM-038](#rem-038-for-drift-010) |
Drift classes: **deliberate-documented** (decision recorded in an ADR/plan — reported 📘, no remediation
required beyond mapping) · **deliberate-undocumented** (evidently intentional but no decision record) ·
**silent** (no evidence of a decision).
| DRIFT-011 | HIGH | ✔ | The 2026-08-04 ADR-0135→0150 renumber (originally targeted 0149; shifted to 0150 when main independently minted ADR-0149 for the Rubberhose identity) left the Yard-UI supersession chain pointing at the SQLite EventStore ADR: ADR-0147/0148 bodies cited "ADR-0135" five times, plus stale Yard-UI-sense references in cli-spec, package-namespaces, four package ADR/AGENTS files, and three source comments. | `docs/design/adr/07-portability-extensibility.md:653-681` (pre-fix) · `docs/design/cli-spec.md:55` · `packages/control-yard/ADR.md:4` | Same-pass sweep: all Yard-UI-sense citations now read ADR-0150; SQLite-sense ADR-0135 references verified untouched. |
| DRIFT-012 | MED | ✔ | ADR-0148 attributed the art clauses it supersedes to ADR-0140 (launch-ship-targets — zero art content); the intended target is ADR-0147. | `docs/design/adr/07-portability-extensibility.md:671,681-682` (pre-fix) | Same-pass: every ADR-0140 citation inside ADR-0148 retargeted to ADR-0147. |
| DRIFT-013 | MED | ✔ | The JS-family exception is recorded as `examples/*/deploy/` in AGENTS.md and the ADR index, but ADR-0126 scopes it to `packages/hobo/fixtures/deploy/<provider>/` (and no examples/*/deploy exists). | `AGENTS.md:208` · `docs/design/adr/index.md:137` (pre-fix) | Same-pass: both surfaces corrected to the ADR-0126 path. |
| DRIFT-014 | MED | ✔ | ADR-0139 §6 pinned "verbs stay at 37" as the harness boundary; `CANONICAL_VERBS` has 40 (serve/replay/runbook added by later ADRs). | `docs/design/adr/03-data-plane.md:643` (pre-fix) · `packages/cli/src/shell/verbs.ts` | Same-pass: restated as the invariant ("the harness adds no canonical verb"), count delegated to the cli-docs gate. |
| DRIFT-015 | MED | ✔ | package-namespaces assigned effect-aware isolation/mocks/fault injection to `@hobo/contract-harness`, contradicting ADR-0136 §5 which deliberately keeps them in `@hobo/contracts` (cycle avoidance) — where the code actually lives. | `docs/design/package-namespaces.md:81` (pre-fix) · `packages/contracts/src/effects-harness.ts` | Same-pass: row split — PACT harness vs effects, each to its real package with the cycle rationale. |
| DRIFT-016 | MED | ✔ | The retired Bo art bible (ADR-0148 §3) still bound agents and policy: control-yard AGENTS.md said "Bo art bible locked" and asset-sourcing-policy cited the deleted `site/public/parallax/README.md` as normative. | `packages/control-yard/AGENTS.md:3` · `docs/design/asset-sourcing-policy.md:54-56` (pre-fix) | Same-pass: both rewritten to the sourced-pixel-art DESIGN.md contract (ADR-0148). |
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

**Action**

Remediation for cand-04 (P1 drift, deliberate-undocumented): record the Nomad evaluation/displacement as an ADR and make the Nomad lineage visible (two-way links) inside the design suite. Documentation-only; the Nomad→wasmCloud pivot is affirmed, never reversed. Amend 7 existing files; create NO new files (so no new OKF frontmatter is needed anywhere).

1. C:/src/hobo/docs/design/adr/01-architecture-core.md — ADD a new ADR section (this is the correct theme file: architecture/runtime/matching). Append it as the last `## ADR-NNNN` section of the file. Use the NEXT FREE GLOBAL ADR ID: take the highest `| NNNN |` row in docs/design/adr/index.md and add 1 (0105 at drafting time — re-verify before writing; NEVER renumber existing ADRs). House style: `## ADR-NNNN`, then a bold one-line decision, numbered points, then `### Consequences` with (+)/(−) bullets. Outline:
   - `## ADR-NNNN` — bold decision line: "Nomad evaluated and displaced: self-hosted wasmCloud + Matching + Dispatcher subsume the scheduler pillar; Nomad is accepted-future as a deploy-target/host adapter, rejected as the foundation."
   - Point 1 — The evaluation: Nomad (+ Nomad Pack) was assessed as a direct scheduler/runtime/control-plane competitor and candidate substrate; full capture + parity tracker in [`../../competitors/nomad.md#primitive-mapping`](../../competitors/nomad.md#primitive-mapping).
   - Point 2 — Why displaced: the pillar is subsumed by self-hosted wasmCloud as host of record ([ADR-0031](#adr-0031)), deterministic Matching for placement ([ADR-0033](#adr-0033)), and the Dispatcher for execution-host routing ([ADR-0071](#adr-0071)); one sentence each on what replaces jobspec/placement/allocation (cite the nomad.md Core-model mapping rows: jobspec→Manifest IR, allocation→match.Decided, drivers→component-host/OCI adapters).
   - Point 3 — Disposition of Nomad-as-provider (closes the floated-but-undispositioned question in nomad.md#positioning): **accepted-future** as a Camp deploy-target/host adapter (component-host-in-container scheduled by Nomad, or an OCI driver adapter, generatable by the generation pipeline like any adapter); **rejected** as HoBo's scheduler foundation or a core dependency. Not in the seed provider set.
   - `### Consequences` — (+) lineage auditable, one-way mapping becomes two-way, brownfield Nomad shops have a stated path; (−) one more adapter surface if/when accepted-future is exercised.

2. C:/src/hobo/docs/design/adr/index.md (NO frontmatter — it has none; keep it that way) — add one row to the `## Index` table: `| NNNN | Nomad evaluated & displaced: wasmCloud + Matching + Dispatcher subsume the scheduler pillar; Nomad = accepted-future deploy-target adapter | [architecture-core](01-architecture-core.md#adr-NNNN) |`.

3. C:/src/hobo/docs/design/traceability.md — add one ADR coverage row next to the ADR-0031/0033 rows, matching the existing format: `| ADR-NNNN | [architecture-core](./adr/01-architecture-core.md#adr-NNNN) | Nomad displacement is a documentation-only lineage record; coverage is the existing Matching and Dispatcher slice families that subsume the scheduler pillar. | <reuse the HOBO-N ids from the ADR-0033 row (HOBO-55, HOBO-61, HOBO-64, HOBO-78, HOBO-81, HOBO-86) plus the Linear issue ID created for this remediation> |`. Required: scripts/validate-traceability.ts fails if any ADR in adr/index.md is absent from this file.

4. C:/src/hobo/docs/design/adr/01-architecture-core.md, ADR-0031 (§ starting line ~76) — add one cross-reference sentence at the end of the ADR-0031 intro paragraph (before point 1): "Nomad was the evaluated scheduler alternative this decision displaces — see [ADR-NNNN](#adr-NNNN) and the [Nomad parity tracker](../../competitors/nomad.md#primitive-mapping)."

5. C:/src/hobo/docs/design/vision.md — two edits in Plan 17: (a) add a Nomad row to the landscape table (lines 48–64), inserted directly above the wasmCloud row, matching the 7 columns: `| **Nomad + Nomad Pack** | Workload scheduler/orchestrator | ✅ (schedule-anywhere; backing services stay environment-specific) | task drivers + custom plugins | HCL jobspecs → allocations | no | ✅ |`. (b) In "The gap:" paragraph (line ~66), extend the clause about wasm runtimes/orchestrators to also name schedulers: after "(Aspire) solve *runtime/wiring*" add "— and schedulers (Nomad) solve *placement* —"; and append a pointer sentence mirroring the Nitric one: "(Detailed Nomad capture + parity in [`docs/competitors/nomad`](../competitors/nomad.md#primitive-mapping); displacement recorded in [ADR-NNNN](./adr/01-architecture-core.md#adr-NNNN).)"

6. C:/src/hobo/docs/design/control-plane.md, §"Intended providers & deploy targets (non-limiting)" (line ~118, the "Self-host / deploy targets" bullet at line ~122) — append a disposition sentence to that bullet: "**Nomad** (existing HashiCorp-shop clusters) is **accepted-future** as a deploy-target/host adapter — a `component-host`-in-container or OCI driver scheduled by Nomad, generatable like any adapter — and **rejected** as HoBo's scheduler foundation ([ADR-NNNN](./adr/01-architecture-core.md#adr-NNNN), [Nomad parity](../competitors/nomad.md#primitive-mapping))."

7. C:/src/hobo/docs/design/index.md (index.md: MUST keep NO frontmatter) — extend the "**Competitor references** live in [`../competitors/`](../competitors/)." line (line ~118): "Displaced-alternative lineage is recorded as ADRs — e.g. the Nomad scheduler pillar ([ADR-NNNN](./adr/01-architecture-core.md#adr-NNNN), parity in [`../competitors/nomad.md`](../competitors/nomad.md#primitive-mapping))."

8. C:/src/hobo/docs/competitors/nomad.md — make the mapping two-way: in the `## HoBo mapping` intro blockquote (line 155), append: "The displacement decision — why self-hosted wasmCloud ([ADR-0031](../design/adr/01-architecture-core.md#adr-0031)) + Matching ([ADR-0033](../design/adr/01-architecture-core.md#adr-0033)) + Dispatcher ([ADR-0071](../design/adr/01-architecture-core.md#adr-0071)) subsume the scheduler pillar, and Nomad's accepted-future deploy-target disposition — is recorded in [ADR-NNNN](../design/adr/01-architecture-core.md#adr-NNNN)." Also in `## Positioning` (line 18), after "target as a provider/host adapter", add "(dispositioned accepted-future in [ADR-NNNN](../design/adr/01-architecture-core.md#adr-NNNN))". Keep the existing OKF frontmatter untouched.

9. C:/src/hobo/docs/competitors/gap-analysis.md — one-line pointer only (do NOT add a Nomad column to the comparison matrix; scope creep): in the intro blockquote (line 10), add Nomad to the competitor list: "[Nomad](nomad.md)" alongside Aspire/Nitric/Humanitec, with "(scheduler pillar displaced — [ADR-NNNN](../design/adr/01-architecture-core.md#adr-NNNN))".

Replace every "NNNN" above with the same single next-free ADR ID before committing.

**Acceptance**

All commands run from C:/src/hobo with pnpm.

1. `pnpm run docs:okf` — passes (no frontmatter added to index.md files; nomad.md/traceability.md frontmatter untouched; no new docs files created).
2. `pnpm run docs:design-lint` — passes: the new `#adr-NNNN` references are indexed (adr/index.md row present), and all new relative links/anchors resolve (../../competitors/nomad.md#primitive-mapping from adr/, ../competitors/nomad.md#primitive-mapping from design/, ../design/adr/01-architecture-core.md#adr-NNNN from competitors/).
3. `node --import tsx scripts/validate-traceability.ts` — passes: the traceability gate (this is the real script; there is no dedicated pnpm alias) finds ADR-NNNN in docs/design/traceability.md, no numbering gap is introduced (ID = max existing + 1), and the "Accepted / current" statement is intact.
4. `pnpm agent:check -- --staged` — passes with all nine edits staged (touching docs/design/adr/** and docs/design/index.md auto-triggers the traceability check via scripts/relevant-check-policy.ts, plus the staged doc linters).
5. Drift-closure spot checks: `pnpm run search -- -l "Nomad" docs/design` returns at least vision.md, control-plane.md, index.md, traceability.md, adr/01-architecture-core.md, adr/index.md (design suite is no longer zero-Nomad); `pnpm run search -- "nomad.md#hobo-mapping" docs/design` returns ≥3 hits (back-links exist); vision.md landscape table has exactly one new Nomad row (16 product rows total).
6. Cross-links updated (the hub/index set): docs/design/adr/index.md (new ADR row), docs/design/traceability.md (new ADR coverage row), docs/design/index.md (competitor-lineage back-link), docs/competitors/nomad.md (forward link to the new ADR — mapping now two-way), docs/competitors/gap-analysis.md (intro pointer). docs/competitors/index.md needs NO change (already links nomad.md).
7. Content assertions: the new ADR names Nomad as the displaced alternative, cites ADR-0031 + ADR-0033 + ADR-0071 as the subsuming decisions, and dispositions Nomad-as-provider as accepted-future (adapter) / rejected (foundation); control-plane.md §Intended providers contains the same disposition wording; nowhere does any edit weaken or reverse the wasmCloud default.

**Guardrails**

Never propose reversing or reopening the Nomad→wasmCloud pivot — the new ADR records history and disposition, not a re-evaluation. Never renumber or edit the decision content of existing ADRs (the only ADR-0031 change is one additive cross-reference sentence). Do not create any new files (no new ADR file — the ADR is a section in the existing theme file 01-architecture-core.md; if a file were ever created under docs/ it would need OKF YAML frontmatter with non-empty type:, and index.md files must never gain frontmatter). Do not add a Nomad column to the gap-analysis comparison matrix or new rows to the nomad.md mapping tables — pointer sentences only. Keep all links relative .md links with correct depth (../../competitors/ from adr/, ../competitors/ from design/, ../design/ from competitors/). Use one single next-free global ADR ID everywhere; verify it against adr/index.md at write time instead of trusting 0105. Land all nine edits in one commit so docs:design-lint (unindexed-ADR-reference check) and validate-traceability.ts never see a partial state; conventional scoped commit, e.g. `docs(adr): record Nomad evaluation, displacement, and deploy-target disposition`.

### REM-002 (for DRIFT-002)

- **Finding** (cand-16, L-DRIFT, MED, votes uphold/uphold/uphold, drift-class deliberate-undocumented): First-party commercial-launch design (billing plans/credits/invoice lifecycle, tax/currency/receipt posture, a deterministic meter.UsageRecorded->invoice.LineItem reconciliation contract, and workspace plan tiers) now lives in docs/design/ while ADR-0064's consequence says 'no first-party commercial toolkit to maintain (commercialization is out of design scope)' — the first-party-hosted-business vs product-billing-port boundary is asserted per-doc but recorded in no ADR.
- **Evidence:** `docs/design/billing-launch-policy.md:41-61` · `docs/design/usage-to-invoice-reconciliation.md:50-56` · `docs/design/tax-currency-receipt-obligations.md:48-66` · `docs/design/entitlements-plan-limits.md:106-112` · `docs/design/adr/07-portability-extensibility.md:299` · `docs/archive/requirements/requirements.md:165`
- **Effort:** M · **Delivery:** ✔ [HOBO-667](https://linear.app/quickdeploy-ai/issue/HOBO-667) — ADR-0107 in `docs/design/adr/07-portability-extensibility.md`

**Action**

Remediation for cand-16 (L-DRIFT, deliberate-undocumented): record one boundary ADR that legitimizes the first-party hosted-business commercialization records in docs/design/ while keeping ADR-0064's product-surface cut intact, then point ADR-0064, the archived requirements, and the four commercial design docs at it. All edits are documentation-only; no file is created except one new ADR *section* inside an existing theme file.

1. AMEND C:/src/hobo/docs/design/adr/07-portability-extensibility.md — add a new ADR section.
   - ID: take the next free global ADR ID (highest existing is ADR-0104; verify with `grep -o 'ADR-[0-9]\{4\}' docs/design/adr/*.md | sort -u | tail -1` and use highest+1; referred to below as ADR-0NNN). NEVER renumber existing ADRs.
   - Placement: insert the `## ADR-0NNN` section immediately after the ADR-0103 Consequences block and immediately before the `## Open / proposed decisions (ADR-Pn)` heading (line ~342). Follow house style: `## ADR-0NNN` heading, then a bold one-line title, then `### Context` / `### Decision` / `### Consequences`.
   - Section outline:
     - `## ADR-0NNN` + bold title: "Hosted-business commercialization records are design-scope productization; the product billing surface stays removed (boundary to ADR-0064)." — one-line decision statement.
     - `### Context` — ADR-0064 removed business/monetization from HoBo's product surface ("no first-party commercial toolkit to maintain"), yet first-party commercial-launch design for HoBo-the-hosted-business now lives in docs/design/ — billing plans/credits/invoice lifecycle (billing-launch-policy.md), the deterministic meter.UsageRecorded -> invoice.LineItem reconciliation contract (usage-to-invoice-reconciliation.md), tax/currency/receipt posture (tax-currency-receipt-obligations.md), and workspace plan tiers/entitlements (entitlements-plan-limits.md) — with the boundary asserted only per-doc, recorded in no ADR.
     - `### Decision` — numbered: (1) commercial-launch policies for HoBo-the-hosted-business (plans, prepaid credits, invoice lifecycle states, tax/currency/receipt posture, entitlements/plan tiers, usage-to-invoice reconciliation contracts) are IN design scope as productization records; (2) the product `billing` port, app-facing monetization (chargeback/invoicing/tax/rev-share/subscriptions for customer apps), and all money-movement machinery stay REMOVED per ADR-0064; (3) the routing test for future docs: "does this monetize the customer's app or generated stack (out per ADR-0064) or HoBo's own hosted offering (in, as a policy/productization record only — never implementation machinery)?"; (4) every hosted-business commercial doc must cite this ADR in its Authoritative Dependencies section.
     - `### Consequences` — (+) per-doc scope disclaimers now have a single citable decision; (+) ADR-0064's competitive cut (vs Convex/Lakebed/Nitric) is unchanged; (↔) the archived-requirements business-model statement is re-pointed here.

2. AMEND C:/src/hobo/docs/design/adr/07-portability-extensibility.md line 299 (ADR-0064 Consequences bullet). Current text ends "...no first-party commercial toolkit to maintain (commercialization is out of design scope)." Rewrite the parenthetical to: "(no first-party commercial toolkit in the product; commercialization of HoBo-the-hosted-business is recorded as design-scope productization policy per [ADR-0NNN](#adr-0nnn))". Do not change anything else in ADR-0064.

3. AMEND C:/src/hobo/docs/design/adr/index.md — add one row to the `## Index` table in numeric position (after the 0104 row): `| 0NNN | Hosted-business commercialization records are design-scope productization; the product billing surface stays removed | [portability-extensibility](07-portability-extensibility.md#adr-0nnn) |`. index.md must have NO YAML frontmatter (it has none today — do not add any).

4. AMEND C:/src/hobo/docs/archive/requirements/requirements.md line 165 (section "7 Business model"). Replace the sentence "Commercialization (pricing, billing, invoicing, tax) is **out of scope of these design docs** ([ADR-0064](../design/adr/08-scope-and-requirements.md#adr-0064))" with: "Commercialization of the product surface (a `billing` port, app-facing invoicing/tax/rev-share) is **out of design scope** ([ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064)); commercial-launch policies for HoBo-the-hosted-business (plans, credits, invoices, tax posture, entitlements) are design-scope productization records ([ADR-0NNN](../design/adr/07-portability-extensibility.md#adr-0nnn))". Note the existing link path `08-scope-and-requirements.md` is stale (file no longer exists) — fix it to `07-portability-extensibility.md` as shown. Touch only this paragraph; leave other stale archive links alone.

5. AMEND the four design docs so each per-doc disclaimer cites the new ADR (one bullet each, in the existing "Authoritative Dependencies" section; keep relative-link style used in each file):
   - C:/src/hobo/docs/design/billing-launch-policy.md (~line 82): extend the existing ADR-0064 bullet to also cite `[ADR-0NNN](./adr/07-portability-extensibility.md#adr-0nnn)` as the decision that makes this launch-readiness policy record design-scope.
   - C:/src/hobo/docs/design/usage-to-invoice-reconciliation.md (Authoritative Dependencies, ~lines 76-86; it currently cites only ADR-0039): add a bullet: `[ADR-0NNN](./adr/07-portability-extensibility.md#adr-0nnn)` records that this reconciliation contract is a hosted-business productization record while the product billing surface stays removed per `[ADR-0064](./adr/07-portability-extensibility.md#adr-0064)`.
   - C:/src/hobo/docs/design/tax-currency-receipt-obligations.md (~line 109): extend the existing ADR-0064 bullet to also cite ADR-0NNN.
   - C:/src/hobo/docs/design/entitlements-plan-limits.md (~line 187): extend the existing ADR-0064 bullet ("keeps business monetization outside HoBo core") to also cite ADR-0NNN for the plan-tier/entitlement productization records.

No new docs/ files are created, so no new OKF frontmatter is needed; if the implementer chooses to create any new doc instead, it must carry OKF YAML frontmatter with a non-empty `type:` field. The Nomad->wasmCloud pivot is untouched and must not be revisited.

**Acceptance**

Checklist (run from C:/src/hobo):
1. New ADR section exists in docs/design/adr/07-portability-extensibility.md with the next free global ID, placed before the "Open / proposed decisions (ADR-Pn)" heading; no existing ADR was renumbered or moved: `git diff --stat` shows only the 7 files named in the action.
2. ID uniqueness: `grep -o 'ADR-[0-9]\{4\}' docs/design/adr/*.md | sort | uniq -d` prints nothing new for the chosen ID (each ADR ID appears in exactly one theme-doc section heading plus references).
3. docs/design/adr/index.md gained exactly one table row for the new ADR and still has no YAML frontmatter (`head -1 docs/design/adr/index.md` is the `# Architecture Decision Records` heading, not `---`).
4. ADR-0064's consequence line (07-portability-extensibility.md, ~line 299) now cites the new ADR; the ADR-0064 Decision text is unchanged.
5. docs/archive/requirements/requirements.md line ~165 cites both ADR-0064 (via the corrected path ../design/adr/07-portability-extensibility.md#adr-0064) and the new ADR; no other archive lines changed.
6. Each of billing-launch-policy.md, usage-to-invoice-reconciliation.md, tax-currency-receipt-obligations.md, entitlements-plan-limits.md cites the new ADR in its Authoritative Dependencies section with a valid relative link (./adr/07-portability-extensibility.md#adr-0nnn).
7. Runnable gates (all must pass):
   - `pnpm run docs:okf`  (OKF frontmatter check — must stay green; no frontmatter was added to index.md)
   - `pnpm run docs:design-lint`  (the docs/design traceability gate: scripts/check-design-docs.ts validates relative links, anchors, and ADR references against the ADR index — this catches a missing index row or bad #adr-0nnn anchor)
   - `git add -A && pnpm agent:check -- --staged`  (staged relevant-checks runner)
Cross-links/hubs that must gain links: docs/design/adr/index.md (new Index-table row — the only hub update required; no new files means docs/design/index.md and docs/index.md need no changes).

**Guardrails**

Documentation-only: touch exactly the 7 named files; no src/, no scripts/, no package.json changes. Never renumber, retitle, or relocate existing ADRs; the new ADR is appended as a section inside docs/design/adr/07-portability-extensibility.md (the scope theme doc — do NOT create a new ADR file, and do NOT resurrect 08-scope-and-requirements.md). Determine the next free global ADR ID at implementation time from the actual files (highest existing +1; ADR-0104 was highest when this was drafted) — do not reuse or guess. index.md files must have NO frontmatter; any genuinely new docs/ file (none planned) needs OKF YAML frontmatter with non-empty type:. Keep all links relative .md links with lowercase #adr-0nnn anchors. Do not expand scope: no re-opening of ADR-0064's product-surface cut (the `billing` port and money-movement stay removed), no reversal of the Nomad->wasmCloud pivot, no edits to archive files beyond the single business-model paragraph at requirements.md:165, and no new implementation tasks or M1-M4 issues.

### REM-003 (for DRIFT-003)

- **Finding** (cand-02, L-DRIFT, MED, votes uphold/uphold/uphold, drift-class deliberate-undocumented): Marketplace payout-readiness design (payout state machine incl. `approved-for-payout`, publisher tax-document posture, billing-reconciliation handoffs) re-enters the marketplace monetize/rev-share scope that ADR-0064 §2 removed and ADR-0062 §5 reaffirmed ('No monetization ... no commercial tiers'), converting what ADR-0063 calls a positioning anti-goal into a deferred-until-evidence launch capability with no amending decision record.
- **Evidence:** `docs/design/marketplace-payout-hooks.md:79-89` · `docs/design/marketplace-payout-hooks.md:51-52` · `docs/design/adr/07-portability-extensibility.md:294` · `docs/design/adr/07-portability-extensibility.md:170` · `docs/design/adr/07-portability-extensibility.md:282` · `docs/design/tax-currency-receipt-obligations.md:66`
- **Effort:** M · **Delivery:** ✔ [HOBO-668](https://linear.app/quickdeploy-ai/issue/HOBO-668) — ADR-0110 in `docs/design/adr/07-portability-extensibility.md`

**Action**

Resolve drift cand-02 by recording the marketplace-commercialization boundary as a new ADR (option "record the boundary", NOT "strike the records" — marketplace-payout-hooks.md and tax-currency-receipt-obligations.md are load-bearing rows in docs/design/index.md lines 57/67 and feed billing/tax/support handoffs, so archiving them would orphan many cross-links; the docs already disclaim monetization, the only missing artifact is the decision record). All changes are amendments to existing files; create NO new files.

1. AMEND docs/design/adr/07-portability-extensibility.md — insert a new ADR section immediately after the ADR-0103 section (ends ~line 340) and BEFORE the "## Open / proposed decisions (ADR-Pn)" heading (line 342). Heading must be exactly "## ADR-0105" using the next free global ADR ID (0105 as of commit 59e387ae — before writing, re-verify max ID in docs/design/adr/index.md and use max+1). Title line (bold, matching house style): "Marketplace payout-readiness is a launch-gated commercial-operations record, not reinstated marketplace monetization." Section outline:
   - "### Context" — ADR-0064 §2 removed the product `billing` port and the marketplace monetize/rev-share lifecycle; ADR-0062 §5 reaffirmed "No monetization … no commercial tiers"; ADR-0063 frames monetization as a positioning anti-goal. Meanwhile productization M0 records entered docs/design/ (marketplace-payout-hooks.md payout state machine incl. `approved-for-payout`; tax-currency-receipt-obligations.md publisher tax-document posture and billing-reconciliation handoffs) with no amending decision record — the gap GAPS.md finding cand-02 confirmed.
   - "### Decision" — 4 numbered points: (1) ADR-0064's product-scope cut stands unchanged — no `billing` port, no rev-share machinery, no commercial tiers in the meta-cloud product or Registry distribution; this ADR amends nothing in that cut. (2) Name two distinct lanes: the product-capability lane (removed by ADR-0064) vs the hosted-HoBo commercial-operations lane — M0 launch-posture/acceptance records for operating hosted HoBo as a business (billing-launch-policy.md, tax-currency-receipt-obligations.md, marketplace-payout-hooks.md); lane-2 records define vocabulary, evidence fields, owner handoffs, and limitations only, and may never add ports, events, or runtime surface. (3) Marketplace publisher payout readiness is a deferred, evidence-gated launch capability in lane 2: the payout-readiness state table is scope vocabulary; `approved-for-payout` asserts evidence sufficiency, never settlement or money movement; M1-M4 execution stays blocked behind the marketplace-payout-hooks.md Follow-Up Gate plus an explicit v1-cutline decision. (4) Boundary test going forward: any record that would add a `billing` port, money movement, rev-share policy, or commercial tiers to the product surface requires amending ADR-0064 first; every lane-2 record must cite this ADR and register its customer-visible limitation in known-limitations-register.md.
   - "### Consequences" — (+) the anti-goal wording and the payout-readiness records no longer contradict; drift is closed with a decision record. (−) actually shipping payouts later still requires a real amending ADR plus legal/tax/provider evidence — this ADR does not pre-approve it.

2. AMEND docs/design/adr/07-portability-extensibility.md, ADR-0064 "### Consequences" (~line 297-300): append ONE new bullet — "(↔) Hosted-business commercial-operations records (billing launch policy, tax/currency/receipt posture, marketplace payout readiness) are governed by [ADR-0105](#adr-0105): launch-posture documentation for hosted HoBo, not a reinstated `billing` port or rev-share machinery." Do not alter ADR-0064's Context/Decision text.

3. AMEND docs/design/adr/index.md — append one row to the Index table after the 0104 row: "| 0105 | Marketplace payout-readiness is a launch-gated commercial-operations record, not reinstated monetization | [portability-extensibility](07-portability-extensibility.md#adr-0105) |". This file has no YAML frontmatter — keep it that way.

4. AMEND docs/design/traceability.md — add one row to the ADR table (same shape as the ADR-0095 row at line 353): "| ADR-0105 | [portability-extensibility](./adr/07-portability-extensibility.md#adr-0105) | Marketplace payout readiness stays a deferred commercial-operations posture, distinct from the billing/rev-share product scope ADR-0064 removed. | HOBO-420, HOBO-513 |". Required: scripts/validate-traceability.ts fails with "ADR-0105 missing from traceability report" otherwise.

5. AMEND docs/design/known-limitations-register.md — add one row to the "Initial V1 Entries" table: Limitation "Marketplace publisher payouts and revenue share are not v1 capabilities" | State `deferred` | Affected persona "Publisher owner and marketplace operator" | User-visible impact "Listings may surface payout-readiness states, but no payout execution, settlement, tax documents, or revenue share is promised in v1" | Workaround "None; payout commitments route to the Capability Review & Approval owner" | Owner "Marketplace Payout Hooks" | Follow-up "HOBO-420" | Handoffs "Release notes, docs portal, support scripts, launch messaging".

6. AMEND docs/design/marketplace-payout-hooks.md — in "## Authoritative Dependencies" (after the existing ADR-0064 bullet at lines 106-107), add: "[ADR-0105](./adr/07-portability-extensibility.md#adr-0105) records that payout readiness is a launch-gated commercial-operations posture and does not reinstate the marketplace monetize/rev-share scope removed by ADR-0064." Add one closing sentence to "## M0 Acceptance Record" citing the same link as the governing boundary decision.

7. AMEND docs/design/tax-currency-receipt-obligations.md — in "## Authoritative Dependencies" (lines 105-113), add a bullet: "[ADR-0105](./adr/07-portability-extensibility.md#adr-0105) governs the marketplace payout tax-document posture as a deferred commercial-operations limitation, not product billing scope."

8. AMEND GAPS.md — under "## Remediations" add "### REM-004" (use the next free REM-NNN; the section is empty as of 59e387ae) containing Action (one-paragraph summary of items 1-7), Acceptance criteria (the commands below), Effort M, and Delivery link (the Linear issue / PR once created). In the "## Drift register" table, set cand-02's Status to 🧯 (remediation documented) with the Remediation column pointing at REM-004; flip to ✔ only when the ADR lands.

**Acceptance**

All commands run from repo root C:/src/hobo, exit 0:
1. `pnpm run docs:okf` — OKF frontmatter check passes (no new docs created; index.md stays frontmatter-free; amended docs keep their existing non-empty `type:` frontmatter).
2. `node --import tsx scripts/validate-traceability.ts` — the traceability gate (this exact script; there is no package.json alias). It cross-checks every `| NNNN |` row in docs/design/adr/index.md against a literal `ADR-NNNN` mention in docs/design/traceability.md and validates all relative .md links in traceability.md, so steps 3+4 must land together.
3. `pnpm agent:check -- --staged` — with all edits staged; because docs/design/adr/ is touched, scripts/relevant-check-policy.ts (line 74/149) auto-includes the traceability gate in this run.
Structural checks:
4. `rg -n "adr-0105" docs/design` (substitute the actual next-free ID) shows hits in: adr/07-portability-extensibility.md (self-anchor + ADR-0064 cross-ref), adr/index.md, traceability.md, marketplace-payout-hooks.md, tax-currency-receipt-obligations.md.
5. `rg -n "^## ADR-" docs/design/adr/07-portability-extensibility.md` — exactly one new heading; all pre-existing ADR headings/IDs unchanged; new section sits before "## Open / proposed decisions (ADR-Pn)".
6. known-limitations-register.md "Initial V1 Entries" table has the new `deferred` payout row with all 8 columns filled.
7. `git diff` over ADR-0064 shows only an appended Consequences bullet — no edits to its Context/Decision.
Cross-links that must gain entries: docs/design/adr/index.md (Index table row), docs/design/traceability.md (ADR table row), GAPS.md (REM-004 entry + cand-02 drift-register status 🧯 with Remediation link). No changes needed to docs/design/index.md (both amended design docs are already listed at lines 57 and 67).

**Guardrails**

1. Never renumber, retitle, or rewrite any existing ADR; new ADRs take the next free global ID — verify max ID in docs/design/adr/index.md at write time (0105 as of commit 59e387ae) rather than trusting this text. 2. The new ADR must NOT weaken ADR-0064: it may not authorize payout execution, settlement, provider/KYC integration, a `billing` port, commercial tiers, or rev-share policy — it only names the lane split and the amend-first gate. 3. Do not strike or rewrite the payout state table or scope tables in marketplace-payout-hooks.md / tax-currency-receipt-obligations.md; this remediation takes the record-the-boundary option, not the archive option. 4. Create no new files: the ADR lives inside the existing theme file docs/design/adr/07-portability-extensibility.md (which already carries valid OKF frontmatter); if a new docs/ file were ever created instead, it would need OKF YAML frontmatter with a non-empty `type:`, and index.md files must have NO frontmatter. 5. All links are relative .md links: `#adr-0105` inside the theme file, `07-portability-extensibility.md#adr-0105` from adr/index.md, `./adr/07-portability-extensibility.md#adr-0105` from traceability.md and the two design docs. 6. Documentation-level change only — no code, no schema, no runtime surface; do not touch the Nomad→wasmCloud pivot (accepted, out of scope). 7. Land items 3 and 4 in the same commit or the traceability gate fails the build.

### REM-004 (for GAP-001)

- **Finding** (cand-01, P1, HIGH, votes uphold/uphold/uphold, drift-class silent): Node-level workload scheduling inside a Camp — Nomad's core competence — has no owner in the design: nothing specifies how service-component instances are placed onto wasmCloud lattice hosts (the wadm-equivalent), who consumes the `scaling {min,max}` annotation, or any bin-packing, failure-domain spread, preemption, oversubscription, host-drain, or capacity-reservation semantics, even though the default host is self-hosted wasmCloud on bare-metal/Coolify/Docker substrates that supply no scheduler of their own.
- **Evidence:** `docs/design/adr/01-architecture-core.md#adr-0031` · `docs/design/control-plane.md:121` · `docs/design/authoring-resources-wiring.md:161` · `docs/design/reliability-observability-cost.md:56` · `docs/design/platform-engineering.md:174` · `docs/design/wasm-runtime-wit.md:95`
- **Effort:** M · **Delivery:** [HOBO-669](https://linear.app/quickdeploy-ai/issue/HOBO-669) (Intent-Alignment Gap Remediation project)

**Action**

Documentation-only remediation for cand-01 (in-Camp node-level scheduling has no owner). Six files amended, no new files created (so no new OKF frontmatter and no docs/design/index.md change needed). The Nomad->wasmCloud pivot is accepted; this maps Nomad's scheduler competence onto the existing component-host seam.

1) C:/src/hobo/docs/design/adr/01-architecture-core.md — append ONE new ADR at the very end of the file, using the next free global ADR ID (verify against the index table in docs/design/adr/index.md; ADR-0104 was the highest at drafting time, so expect ADR-0105 — never renumber or edit existing ADRs). Follow the house format exactly (see ADR-0031 at line 76 as the template): `## ADR-NNNN` heading, one bold decision line, an intro paragraph, numbered points, then `### Consequences` with one (+) and one (−) bullet.
   - Bold decision line: "In-Camp workload scheduling: the component-host scheduler seam — wadm on the default self-hosted wasmCloud lattice, substrate-delegated elsewhere."
   - Intro paragraph: state the gap being closed — the Dispatcher (ADR-0071) decides WHICH provider/Camp hosts a resource, and actor-key placement (Plan 5) covers grains, but nothing owned which lattice host runs each service-component instance inside a Camp; this ADR names that owner per component-host adapter.
   - Point 1 — Scheduling is a named responsibility of the `component-host` port (extends ADR-0031 §1): every component-host adapter must declare its scheduler of record. Do NOT mint a new WIT interface and do NOT reuse the name `hobo:scheduler` (already the cron-trigger port, wasm-runtime-wit.md:166); the seam is internal to the adapter.
   - Point 2 — Default host (self-hosted wasmCloud): the scheduler of record is **wadm** (wasmCloud Application Deployment Manager) — the wadm-equivalent question resolves to wadm itself. HoBo renders each `component.v1` manifest-IR entry into a wadm/OAM application manifest; the `scaling {min,max}` annotation renders to a wadm spreadscaler (min/max instances), and spread/anti-affinity renders to spreadscaler spread requirements over host labels.
   - Point 3 — Per-substrate delegation: (a) k8s substrate = two-level scheduling — the k8s scheduler places wasmCloud host pods (nodes/bin-packing at pod level), wadm places components onto those hosts; (b) Coolify/Docker and bare-metal/VPS = lattice-native — wadm schedules across the statically registered host set (these substrates supply no scheduler of their own); (c) wasm-in-container zero-infra floor = no lattice — `scaling` renders to the substrate's replica primitive (k8s Deployment replicas / Coolify service scale); (d) provider-native (Cloudflare Workers) = provider scheduler owns placement; non-mappable scheduling annotations are inert and flagged by `hobo doctor` as host lock-in (same model as host-`.with()`, ADR-0031 §5).
   - Point 4 — The consumer of `scaling {min,max}` is therefore the Camp's component-host adapter (never the app, never the Yard Planner); conformance (`@hobo/conformance/component-host`, Plan 9) gains named assertions: min instances maintained, max never exceeded, and re-placement on host loss within a bounded window.
   - Point 5 — Explicit disposition of the remaining semantics, each labeled designed / delegated / deferred: bin-packing + failure-domain spread = **delegated** (wadm spreadscaler on the lattice; k8s scheduler for host pods); host drain = **designed** (cordon host, re-place components via lattice link late-binding, then remove; on k8s, compose with node drain); preemption, oversubscription, and capacity reservation = **deferred**, each recorded in the ADR-Pn open-decisions list (see file 5 below). Scheduling decisions stay deterministic + replayable per ADR-0033 (reconciliation, no on-path solver/LLM).
   - Point 6 — Boundary statement: actor-key placement (consistent-hash leases, reliability-observability-cost.md Plan 5) is a distinct, unchanged mechanism for grains; this ADR governs service-component instances only.

2) C:/src/hobo/docs/design/wasm-runtime-wit.md — insert a new h3 section titled `### In-Camp scheduling & placement ([ADR-NNNN](./adr/01-architecture-core.md#adr-nnnn))` between the existing `### Component-host portability` section (ends line 106) and `### Security substrate` (line 108). Outline (bullets under the h3, matching the doc's style):
   - **The scheduler seam** — one line: scheduling is part of the `component-host` port; each adapter names its scheduler of record (ADR-NNNN).
   - **Default: wadm on the wasmCloud lattice** — manifest IR -> wadm/OAM manifest; `scaling {min,max}` -> spreadscaler; spread -> host labels.
   - **Per-substrate delegation table** — a small markdown table with columns Substrate | Scheduler of record | How `scaling` is realized, rows: k8s (two-level), Coolify/Docker, bare-metal, wasm-in-container floor, provider-native (Cloudflare Workers).
   - **Semantics disposition** — one line per semantic (bin-packing, spread/anti-affinity, host drain, preemption, oversubscription, capacity reservation) with its designed/delegated/deferred label and the ADR-Pn pointer for deferred ones.
   - **Not actor placement** — one line distinguishing this from Plan 5 actor-key leases, with a relative link to ./reliability-observability-cost.md#plan-05.

3) Cross-link edits (one sentence each, keep relative .md links):
   - C:/src/hobo/docs/design/control-plane.md line 121 ("**Runtime hosts (`component-host`).**" bullet): append "In-Camp instance scheduling is owned per host adapter — wadm on the default lattice, substrate-delegated elsewhere ([ADR-NNNN](./adr/01-architecture-core.md#adr-nnnn))."
   - C:/src/hobo/docs/design/authoring-resources-wiring.md line 161 (annotations paragraph): after "First-party annotations (health, lifetime, replicas, scaling, residency) are typed and provider-neutral." append a sentence naming the consumer: "`scaling {min,max}` is consumed by the Camp's `component-host` scheduler ([ADR-NNNN](./adr/01-architecture-core.md#adr-nnnn))."
   - C:/src/hobo/docs/design/reliability-observability-cost.md line 61 ("**Placement:** consistent-hashing…" bullet): append "(actor-key placement only — service-component instance scheduling is the `component-host` scheduler seam, [ADR-NNNN](./adr/01-architecture-core.md#adr-nnnn))".
   - C:/src/hobo/docs/design/platform-engineering.md lines 174–177 (Workload Profile section): add a bullet noting a profile may carry scheduling constraints (spread/anti-affinity, drain policy) realized per substrate by the component-host scheduler ([ADR-NNNN](../design is wrong — use ./adr/01-architecture-core.md#adr-nnnn since platform-engineering.md sits in docs/design/)).

4) C:/src/hobo/docs/design/adr/index.md — add one row to the Index table after the 0104 row: `| NNNN | In-Camp workload scheduling: the component-host scheduler seam (wadm default; substrate-delegated) | [architecture-core](01-architecture-core.md#adr-nnnn) |`. This file must keep NO frontmatter.

5) C:/src/hobo/docs/design/adr/07-portability-extensibility.md — under `## Open / proposed decisions (ADR-Pn)` (line 342), append one line per deferred semantic using the next free ADR-Pn IDs (P5 is highest at drafting time, so expect P6–P8): preemption policy for in-Camp scheduling; oversubscription/density limits per component-host; capacity reservation semantics — each linking `[ADR-NNNN](01-architecture-core.md#adr-nnnn)` and `[Plan 20](../wasm-runtime-wit.md#plan-20)`.

6) C:/src/hobo/docs/design/traceability.md — (a) add a row after the ADR-0104 row (line 362): `| ADR-NNNN | [architecture-core](./adr/01-architecture-core.md#adr-nnnn) | In-Camp scheduling is owned by the component-host scheduler seam: wadm on the default self-hosted wasmCloud lattice, substrate-delegated on k8s/floor/provider-native; scaling annotation consumer named; preemption/oversubscription/capacity-reservation deferred to ADR-Pn. | HOBO-<this issue's ID> |` (use the Linear issue ID assigned to this remediation); (b) update "Counted ADRs: 93 numbered entries" (line 366) to 94; (c) update "Explicit numbering gaps through `ADR-0104`" (line 370) to the new max ID (gap list itself unchanged).

7) Register bookkeeping in C:/src/hobo/GAPS.md: add a `### REM-004` entry under `## Remediations` (Action = this plan, Acceptance, Effort M, Delivery link = the Linear issue / PR), and set the cand-01 Gap-register row Remediation cell to link `#rem-004` with status 🧯.

**Acceptance**

Checklist (all commands from C:/src/hobo):
1. `pnpm run docs:okf` passes (no frontmatter regressions; index.md files still have none; amended docs keep their existing `type:` frontmatter untouched).
2. `pnpm agent:check -- --staged` passes with all changed files staged — because docs/design/adr/** and docs/design/traceability.md are touched, this automatically runs the traceability gate (`scripts/relevant-check-policy.ts:74,149`).
3. Traceability gate directly (its real name — there is no package.json alias): `node --import tsx scripts/validate-traceability.ts` exits 0. This requires: the new ADR-NNNN appears in docs/design/traceability.md, and the numbering-gap statement still covers every unassigned ID.
4. `pnpm run lint:docs:staged` passes (link validity across the edited docs).
5. Cross-link audit: the new ADR anchor `#adr-nnnn` (lowercase) resolves from all five referrers — wasm-runtime-wit.md new section, control-plane.md:121, authoring-resources-wiring.md:161, reliability-observability-cost.md:61, platform-engineering.md Workload Profiles — and docs/design/adr/index.md gained exactly one new row.
6. Content assertions: `grep -ri wadm docs/design/` now returns hits in wasm-runtime-wit.md, adr/01-architecture-core.md, and control-plane.md; the string `hobo:scheduler` was NOT reused for the new seam; every one of {bin-packing, spread/anti-affinity, preemption, oversubscription, host drain, capacity reservation} appears in the new ADR with an explicit designed/delegated/deferred label; each "deferred" item has a matching new ADR-Pn line in docs/design/adr/07-portability-extensibility.md#open--proposed-decisions-adr-pn.
7. No existing ADR heading, ID, or anchor was modified (git diff shows only appends in adr/01-architecture-core.md and adr/index.md table).
8. GAPS.md: cand-01 row references REM-004; REM-004 links the Linear issue.

**Guardrails**

- Documentation only: no code, no schema, no new WIT files. Do not create any new docs/ file — all changes are amendments to the six named files.
- Never renumber, reword, or reorder existing ADRs; the new ADR is append-only at the end of docs/design/adr/01-architecture-core.md. Take the next free global ADR ID by checking the index table max at execution time (ADR-0104 at drafting time); same for ADR-Pn (P5 at drafting time).
- Do not re-litigate or reverse the Nomad->wasmCloud pivot; frame the ADR as making the Nomad-scheduler->HoBo mapping explicit on the accepted architecture.
- Naming hazard: `hobo:scheduler` is the existing cron-trigger WIT port (wasm-runtime-wit.md:166) — never use that name for the placement seam; do not mint any new `hobo:*` WIT interface in this remediation.
- Do not contradict ADR-0071 (Dispatcher owns cross-provider/cross-Camp placement) or ADR-0033 (deterministic, no on-path solver/LLM): the new ADR is strictly the intra-Camp layer and must say so.
- Do not invent new event families or conformance suite names; extend the existing `@hobo/conformance/component-host` suite and existing Plan 11 event-sourcing language only.
- Keep all links relative `.md` links with lowercase anchors (`#adr-nnnn`); docs/design/adr/index.md and any index.md must have NO YAML frontmatter; do not touch frontmatter of amended docs.

### REM-005 (for GAP-002)

- **Finding** (cand-03, L-CONS, MED, votes uphold/uphold/uphold): The five-pillar intent framing (Nomad+Aspire+Nitric+FinOps+agent-native) appears nowhere in docs/design/ as an organizing principle — vision.md's borrow-list never names Nomad, the only repo echoes of the composed intent are README's GAPS.md row and GAPS.md itself (both outside the design suite), and traceability.md traces plan/ADR->Linear only, never intent->design. Partially mitigated: GAPS.md now carries the pillar mapping and README links it, but the design suite itself remains silent.
- **Evidence:** `docs/design/vision.md:68-77` · `docs/design/vision.md:48-64` · `README.md:47` · `GAPS.md:20-26` · `docs/design/traceability.md:10-27`
- **Effort:** M · **Delivery:** [HOBO-670](https://linear.app/quickdeploy-ai/issue/HOBO-670) (Intent-Alignment Gap Remediation project)

**Action**

REM for cand-03 (pillar L-CONS, gap, MED) — promote the five-pillar intent lineage into the design suite. Amend three existing files; create NO new files and NO new ADRs.

FILE 1 — C:/src/hobo/docs/design/vision.md (amend; do not touch YAML frontmatter):
(a) In the "### What HoBo borrows (deliberately)" list (currently lines 68–77), insert a new bullet immediately after the "**From .NET Aspire:**" bullet:
- **From HashiCorp Nomad (founding pillar; runtime since pivoted):** heterogeneous workload orchestration/scheduling, bin-packing-style placement, and federation — realized in HoBo through the self-hosted wasmCloud lattice default ([ADR-0031](./adr/01-architecture-core.md#adr-0031)) and the Junction ⊃ Yard ⊃ Camp scopes; the Nomad→wasmCloud pivot is an accepted decision, with the full concept-by-concept mapping in [`docs/competitors/nomad`](../competitors/nomad.md#primitive-mapping).
(b) Insert a new h3 subsection titled exactly "### Intent lineage (five pillars)" immediately BEFORE the "### Defensible differentiators (the moat)" heading (i.e., after the adjacent-products blockquote that ends the borrows section). Outline:
  - Intro paragraph (2 sentences): quote the original composed intent verbatim — "HashiCorp Nomad + .NET Aspire + Nitric with some FinOps and agent-native experiences." — and state that this subsection is the canonical intent→design map; note the ongoing audit register lives at [`GAPS.md`](../../GAPS.md).
  - Table with columns "Pillar | Original contribution | Where it lives in the design", five rows:
    P1 Nomad | heterogeneous workload orchestration/scheduling, bin-packing placement, federation | [`control-plane.md`](./control-plane.md#plan-04), [`platform-engineering.md`](./platform-engineering.md#plan-25), [`adr/01-architecture-core.md`](./adr/01-architecture-core.md); accepted wasmCloud pivot ([ADR-0031](./adr/01-architecture-core.md#adr-0031)), mapping in [`../competitors/nomad.md`](../competitors/nomad.md#primitive-mapping)
    P2 Aspire | local-dev orchestration, app composition/wiring, dev dashboard, polyglot DX | [`developer-experience.md`](./developer-experience.md#plan-07), [`sdk-api.md`](./sdk-api.md#plan-02), [`authoring-resources-wiring.md`](./authoring-resources-wiring.md#plan-21), [`../competitors/aspire.md`](../competitors/aspire.md)
    P3 Nitric | cloud-agnostic Infrastructure-from-Code, portable resource ports, `.allow()` least privilege | [`authoring-resources-wiring.md`](./authoring-resources-wiring.md#plan-21), [`wasm-runtime-wit.md`](./wasm-runtime-wit.md#plan-20), [`../competitors/nitric.md`](../competitors/nitric.md)
    P4 FinOps | cost as a first-class input: estimates, budgets, showback, cost-aware placement | [`reliability-observability-cost.md`](./reliability-observability-cost.md#plan-05), [`finops-budget-routing-control-plane.md`](./finops-budget-routing-control-plane.md), [ADR-0071](./adr/01-architecture-core.md#adr-0071)
    P5 Agent-native | agents as first-class principals and operators: identity, MCP, Crew, generation | [`ai-native-agent-auth.md`](./ai-native-agent-auth.md#plan-06), [`operators-sre.md`](./operators-sre.md#plan-40), [`generated-stack.md`](./generated-stack.md#plan-23)
  - Closing sentence: one line stating the only accepted intent-level pivot is Nomad's scheduler/runtime role moving to wasmCloud, and that intent-pillar coverage is traced in [`traceability.md`](./traceability.md#intent-pillar-coverage).

FILE 2 — C:/src/hobo/docs/design/traceability.md (amend; ADDITIVE ONLY — delete or reword nothing; do not touch frontmatter):
Insert a new h2 section titled exactly "## Intent Pillar Coverage" immediately after the "## Coverage Rules" section and before "## Cross-Plan User Story Evidence" (currently line 32). Outline:
  - Intro line (1 sentence): pillars come from the founding intent recorded in [`vision.md`](./vision.md#intent-lineage-five-pillars); the audit register is [`GAPS.md`](../../GAPS.md).
  - Table with columns "Pillar | Design home | Plan/ADR anchors | Implementation evidence", five rows (reuse links from FILE 1's table for "Design home"): P1 Nomad → PLAN-04, PLAN-25, ADR-0031 → Control Plane: Planner, Matching & Orchestrator epic row; P2 Aspire → PLAN-07, PLAN-02, PLAN-21 → CLI, MCP & Developer Experience epic row; P3 Nitric → PLAN-21, PLAN-20, ADR-0069 → SDK & Authoring (IfC / bindles) epic row; P4 FinOps → PLAN-05, ADR-0071 → Reliability, Observability & Cost (FinOps) epic row; P5 Agent-native → PLAN-06, PLAN-40, PLAN-23 → Identity, Auth, Secrets & Cross-App Access (XAA) epic row. (These epic rows already exist in this file's Cross-Plan table — name them textually, no new links required in that column.)

FILE 3 — C:/src/hobo/GAPS.md (amend, append-only conventions):
Under "## Intent & pillars", after the existing table, add one pointer line: "Promoted into the design suite (REM for cand-03): [`docs/design/vision.md` — Intent lineage (five pillars)](docs/design/vision.md#intent-lineage-five-pillars) and [`docs/design/traceability.md` — Intent Pillar Coverage](docs/design/traceability.md#intent-pillar-coverage)." Then update the cand-03 register row/remediation status per the register's status key (🧯 → ✔ once these edits land).

No index/hub changes are required (no new files). Optionally, the vision.md row in docs/design/index.md "Covers" cell may append ", intent lineage" — cosmetic only; index.md must keep NO frontmatter either way.

**Acceptance**

Checklist (run from C:/src/hobo):
1. docs/design/vision.md contains heading "### Intent lineage (five pillars)" placed before "### Defensible differentiators (the moat)", quotes the verbatim phrase "HashiCorp Nomad + .NET Aspire + Nitric with some FinOps and agent-native experiences.", has a 5-row pillar table, and a new "From HashiCorp Nomad" bullet in the borrows list linking ../competitors/nomad.md#primitive-mapping (anchor verified to exist: "## HoBo mapping", docs/competitors/nomad.md line 153).
2. docs/design/traceability.md contains "## Intent Pillar Coverage" between "## Coverage Rules" and "## Cross-Plan User Story Evidence"; `git diff -- docs/design/traceability.md` shows only added lines (no deletions) — the validator requires all existing ADR-NNNN/PLAN-NN tokens, the "Accepted / current" string, and >=50 HOBO-N references to survive.
3. GAPS.md "Intent & pillars" section gains the pointer line to both new anchors; cand-03 status updated per the register status key.
4. Every new relative link resolves on disk: ./control-plane.md, ./platform-engineering.md, ./adr/01-architecture-core.md, ./developer-experience.md, ./sdk-api.md, ./authoring-resources-wiring.md, ./wasm-runtime-wit.md, ./reliability-observability-cost.md, ./finops-budget-routing-control-plane.md, ./ai-native-agent-auth.md, ./operators-sre.md, ./generated-stack.md, ../competitors/nomad.md, ../competitors/aspire.md, ../competitors/nitric.md, ../../GAPS.md (all confirmed present).
5. Validation commands (all must exit 0):
   - pnpm run docs:okf
   - node --import tsx scripts/validate-traceability.ts   (the real traceability gate — package.json defines no named script for it; this is the exact invocation from README's core gate list, and it link-checks traceability.md)
   - pnpm agent:check -- --staged   (with the three edited files staged)
   - Recommended extras since docs/design/ is touched: pnpm run docs:design-lint and pnpm run lint:docs:staged
6. Cross-links to update: none beyond FILE 3 (no new files, so docs/design/index.md and docs/index.md need no new rows); README.md line 47 already links GAPS.md.

**Guardrails**

1. The Nomad→wasmCloud pivot is ACCEPTED — the lineage text must present it as a settled decision (cite ADR-0031 and ../competitors/nomad.md#primitive-mapping); never propose re-adopting Nomad as scheduler/runtime or re-litigating the choice. 2. Documentation-level only: amend the three named files; create no new files, no new ADRs, never renumber existing ADRs (if a future decision record were ever needed it takes the next free global ADR ID in one of the four theme files under docs/design/adr/ — this remediation needs none). 3. traceability.md and GAPS.md edits are strictly additive (GAPS.md IDs stable, rejected candidates never deleted); do not remove or reword any existing traceability rows, ADR/PLAN tokens, or the "Accepted / current" audit sentence. 4. Do not modify the OKF YAML frontmatter of vision.md or traceability.md (both already carry non-empty type: Reference); GAPS.md and any index.md must remain frontmatter-free. 5. Use exactly the heading strings "### Intent lineage (five pillars)" and "## Intent Pillar Coverage" so the anchors #intent-lineage-five-pillars and #intent-pillar-coverage referenced from GAPS.md and vision.md resolve. 6. Keep all links relative .md links as specified; no absolute paths or bare directory links.

### REM-006 (for GAP-003)

- **Finding** (cand-05, P1, MED, votes uphold/uphold/uphold): The nomad.md HoBo-mapping tracker overclaimed and under-anchored: 'Constraints/affinities/spread' was marked designed-at-parity although only partial scheduler-hint coverage exists and no full Nomad-class affinity/anti-affinity/spread constraint language is committed, while the 'System jobs' and 'Raw exec / Java / QEMU' rows carried no design-doc or issue anchor.
- **Evidence:** `docs/competitors/nomad.md:190` · `docs/competitors/nomad.md:174` · `docs/competitors/nomad.md:178` · `docs/design/platform-engineering.md:50` · `docs/design/control-plane.md:227`
- **Effort:** M · **Delivery:** ✔ [HOBO-671](https://linear.app/quickdeploy-ai/issue/HOBO-671) — nomad.md tracker re-audited; `platform-engineering.md#node-placement-and-system-workloads-iteration-hooks` added.

**Action**

Amend 3 existing files; create no new files and no new ADR.

1. `C:/src/hobo/docs/design/platform-engineering.md` — insert ONE new h3 subsection inside the Plan 25 section, between the end of "### The selection algorithm — deterministic, on-path" (after the "AI/solvers are advisory, off the deploy path" paragraph, currently line 82) and "### Mapping is sugar over default definitions" (currently line 84). Do not alter any existing heading text (other docs link into this file by anchor). Exact heading (keep punctuation-free so the anchor is deterministic):

`### Node placement and system workloads (iteration hooks)`  → anchor `#node-placement-and-system-workloads-iteration-hooks`

Outline:
- Intro paragraph (2–3 sentences): Matching selects WHICH Resource Definition realizes a resource; it does not yet express Nomad-class node-level placement. These surfaces are explicitly NOT yet designed and are recorded here so the competitor parity tracker ([Nomad mapping](../competitors/nomad.md#primitive-mapping)) cannot silently overclaim; tracked as gap cand-05 in [`GAPS.md`](../../GAPS.md) and Linear issue HOBO-XXX (replace XXX with the ID of the issue you are executing).
- Bullet **Affinity / anti-affinity / topology spread** — soft/hard co-location and distribution across nodes/zones/Camps. Nearest existing constructs today: Planner step 4 "Region & colocation" ([Plan 4](./control-plane.md#plan-04)) and matching criteria; a first-class construct (matching-dimension extension or in-Camp scheduler hints) is planned, no committed design yet.
- Bullet **System (per-node) workloads** — Nomad system jobs run one instance per eligible node/node class; HoBo's sketch is Yard/operator/system Bindles per Camp or node class, with no design text yet.
- Bullet **Raw-exec / Java / QEMU legacy hosts** — OCI/container/VM adapters are designed as provider choices ([Plan 20](./wasm-runtime-wit.md#plan-20), [Plan 4](./control-plane.md#plan-04), BuildProvider packer/firecracker); a non-containerized raw-exec host adapter has no design coverage yet.
- Closing line: when a design pass (see gap cand-01 in the same register) lands real affinity/spread constructs, upgrade the tracker rows and replace the relevant bullet with a design/ADR anchor. *2026-08-03 note:* the offering-resolution port, `@hobo/dispatcher`, and the stations routing control loop are adjacent groundwork but are **not** an affinity/spread constraint language — the tracker rows stay 🔜.

2. `C:/src/hobo/docs/competitors/nomad.md` — three edits in the "HoBo mapping" section:
   a. Line 190 ("Operations, security, and rollout" table): change status ✅ → 🔜 and rewrite the row to:
   `| Constraints/affinities/spread | Context-matching selects Resource Definitions (designed); node-level affinity/anti-affinity/topology-spread constructs not yet designed | 🔜 | [25](../design/platform-engineering.md#plan-25), [iteration hook](../design/platform-engineering.md#node-placement-and-system-workloads-iteration-hooks) |`
   b. "Workload and resource catalog" table (lines 170–184): add a fourth column `HoBo doc` (extend header + divider row) with these exact cell values, all anchors already used elsewhere in this file except the new iteration-hook anchor:
   - Service jobs → `[20](../design/wasm-runtime-wit.md#plan-20)`
   - Batch jobs → `[21](../design/authoring-resources-wiring.md#plan-21), [02](../design/sdk-api.md#plan-02)`
   - System jobs → `[iteration hook](../design/platform-engineering.md#node-placement-and-system-workloads-iteration-hooks)` (status stays 🔜)
   - Periodic jobs → `[21](../design/authoring-resources-wiring.md#plan-21)`
   - Parameterized/dispatch jobs → `[02](../design/sdk-api.md#plan-02), [11](../design/data-plane.md#plan-11)`
   - Docker workloads → `[20](../design/wasm-runtime-wit.md#plan-20), [04](../design/control-plane.md#plan-04)`
   - Raw exec / Java / QEMU → `[04](../design/control-plane.md#plan-04), [iteration hook](../design/platform-engineering.md#node-placement-and-system-workloads-iteration-hooks)` and amend its "HoBo equivalent" cell to `Host/runtime adapters selected by Matching; OCI/VM adapters designed, raw-exec host adapter not yet designed` (status stays ↔)
   - Dynamic ports/network blocks → `[21](../design/authoring-resources-wiring.md#plan-21), [12](../design/security-networking.md#plan-12)`
   - CSI/host volumes → `[21](../design/authoring-resources-wiring.md#plan-21)`
   - Nomad Variables/templates → `[21](../design/authoring-resources-wiring.md#plan-21)`
   - Consul service discovery → `[21](../design/authoring-resources-wiring.md#plan-21)`
   - Vault secrets → `[21](../design/authoring-resources-wiring.md#plan-21)`
   - Autoscaler → `[05](../design/reliability-observability-cost.md#plan-05), [40](../design/operators-sre.md#plan-40)`
   c. Update the mapping-section legend line 155 blockquote: append one sentence — "Rows with no committed design text anchor to an explicit iteration hook, never to a bare status."

3. `C:/src/hobo/GAPS.md` — in the "Gap register" table, set the cand-05 row Status to ✔ remediated (the register maintainer seeds the row 🧯 with this entry; the executing agent flips it) and put in the Remediation column: "nomad.md statuses re-audited; affinity/spread downgraded to 🔜; workload-catalog table gained a HoBo doc column; gaps anchored to platform-engineering.md iteration-hook subsection (HOBO-XXX)."

No index/hub files need new links: no files are created (`docs/competitors/index.md` already links nomad.md and its `#hobo-mapping` anchor; the new subsection is inside an existing Plan 25 doc, so `docs/design/index.md` is unchanged). No OKF frontmatter work: both amended docs already carry non-empty `type:` frontmatter; no index.md is touched.

**Acceptance**

Checklist (run from C:/src/hobo):
1. `pnpm run docs:okf` — passes (frontmatter untouched; no new files).
2. `pnpm run lint:docs` — passes; this is the gate that validates the relative links/anchors from docs/competitors/nomad.md into docs/design/platform-engineering.md, so it proves the new `#node-placement-and-system-workloads-iteration-hooks` anchor slug is exactly right.
3. `pnpm agent:check -- --staged` — passes (routes lint:docs:staged + docs:coverage for the staged docs changes).
4. Traceability gate: there is NO package.json alias — the real command is `node --import tsx scripts/validate-traceability.ts`, wired via scripts/relevant-check-policy.ts into `pnpm agent:check` and auto-triggered only by changes under docs/design/adr/, docs/design/traceability.md, docs/design/index.md, or docs/design/proofs/. This remediation touches docs/design/platform-engineering.md (not a trigger path) and adds no ADR/plan, so run it once explicitly as a no-regression check: `node --import tsx scripts/validate-traceability.ts` — must pass unchanged.
5. Content checks: `grep -n "Constraints/affinities/spread" docs/competitors/nomad.md` shows 🔜 (no ✅ on that row); `grep -c "node-placement-and-system-workloads-iteration-hooks" docs/competitors/nomad.md` ≥ 3 (spread row + System jobs row + Raw exec row); every row of the "Workload and resource catalog" table has a non-empty fourth column; `grep -rniE "affinit|spread" docs/design/platform-engineering.md` now hits the iteration-hook subsection.
6. Cross-links to update verified: GAPS.md cand-05 row updated; docs/competitors/index.md and docs/design/index.md intentionally unchanged (confirm no dangling references via check 2).

**Guardrails**

- Do not re-litigate or reverse the Nomad→wasmCloud pivot; this fix only makes the parity tracker honest.
- Documentation-level only: create no ADR, no new plan anchor, no new file. If the separate cand-01 design pass later adds real affinity/spread constructs, THAT pass records the decision as a new ADR at the next free global ADR ID in the appropriate theme file under docs/design/adr/ — never pre-allocate an ID here, never renumber existing ADRs.
- Only downgrade or anchor statuses; never upgrade a row to ✅/➕ in this fix.
- The new subsection must read as an explicit iteration hook (not-yet-designed), not speculative design: no new backticked `family.Event` tokens (the event-family linter fails any family absent from docs/design/event-families.md), no new WIT interfaces, no new heading changes to existing sections (external docs link into platform-engineering.md by anchor, e.g. #plan-25 and #matching-specificity-scored-selection).
- Preserve exact table column counts and pipe alignment in both nomad.md tables; keep all relative links `.md`-relative (../design/... from docs/competitors, ../../GAPS.md from docs/design).
- Replace every HOBO-XXX placeholder with the real Linear issue ID of the issue being executed before committing; commit as a single conventional docs-scoped commit.

### REM-007 (for GAP-004)

- **Finding** (cand-06, P2, MED, votes uphold/uphold/uphold): The `hobo dev` inner-loop mechanics (hot reload, codegen-in-watch, sub-minute boot) are specified only in TypeScript terms; how a non-TS wasm component (Rust/Python/Go/C#) or an OCI-container-fallback service participates in the local dev loop (watch-recompile path, state-preserving reload, per-idiom-layer codegen, whether fallback containers run locally at all) is nowhere specified, despite the Aspire parity tracker marking 'DCP -> local runtime-local host / dev loop' as designed-at-parity.
- **Evidence:** `docs/design/developer-experience.md#the-inner-loop-hobo-dev` · `docs/design/cli-spec.md:22` · `docs/design/wasm-runtime-wit.md:19` · `docs/design/proofs/hobo-122-dev-loop/index.md` · `docs/competitors/aspire.md:465` · `docs/design/sdk-api.md:292`
- **Effort:** M · **Delivery:** ✔ [HOBO-672](https://linear.app/quickdeploy-ai/issue/HOBO-672) — ADR-0109 in `docs/design/adr/07-portability-extensibility.md`

**Action**

Document the polyglot dev-loop matrix for `hobo dev`. All edits are documentation-level; no new docs/ files are created (so no new OKF frontmatter is needed; do not touch existing frontmatter). "ADR-NNNN" below means the next free global ADR ID: derive it as (max 4-digit ID in the table in `docs/design/adr/index.md`) + 1 — at audit time the max was 0104, but re-derive at execution; never renumber existing ADRs.

1. AMEND `docs/design/adr/07-portability-extensibility.md` — append a new `## ADR-NNNN` section (place it after the last numbered ADR section and before the "Open / proposed decisions (ADR-Pn)" section), in the house style used by ADR-0042 (bold one-line title, then h3 Context / Decision / Consequences):
   - Title line: **Polyglot inner loop: per-toolchain watch lanes, replay-based state preservation, and OCI-fallback services under `hobo dev`.**
   - `### Context` — 4-6 sentences: Plan 07's inner loop and the HOBO-122 proof (`docs/design/proofs/hobo-122-dev-loop/index.md`) specify hot reload / codegen-in-watch / sub-minute boot in TypeScript terms only; Plan 20 declares "any language, one artifact" (Rust via cargo-component, Go via TinyGo, Python via componentize-py, C# via componentize-dotnet, and an OCI-container fallback); the Aspire tracker (`docs/competitors/aspire.md`, "DCP (local Go orchestrator)" row) marks the dev loop designed-at-parity — but no doc says how a non-TS component or a fallback container participates in the loop.
   - `### Decision` — 5 numbered points:
     1. **State preservation is runtime-side and toolchain-neutral.** `hobo dev` run state lives in the event log under `.hobo/` and is restored by replay (Plan 07 inner-loop point 2); a reload for ANY lane = swap the recompiled artifact + replay. In-memory, non-event-sourced state is never preserved for any lane (already true for TS).
     2. **Each workload lane declares a watch-recompile path and a latency class** (`fast` <2s · `medium` 2-15s · `slow` >15s), surfaced by `hobo dev` per service exactly like the ADR-0042 fidelity labels. The normative matrix lives in Plan 07 (relative link to `../developer-experience.md#plan-07`).
     3. **Codegen-in-watch is layered per idiom layer (ADR-0072):** a WIT edit regenerates bindings for every registered idiom layer (jco guest-types for TS, wit-bindgen for Rust/Go/Python/C#); TS-only inputs (Zod schemas, `.allow()`, `bind` edges) regenerate only the checked-in `_generated/` TS artifacts (ADR-0037); regeneration is debounced per lane.
     4. **OCI-fallback services DO run under `hobo dev`**, via the developer's local container runtime (Docker/Podman) through the same OCI pipeline (Plan 21), with **restart-on-change** (no hot reload, no in-memory state preservation — only event-log-backed state survives). If no container runtime is present, `hobo doctor` flags it and the service can run as a contract-backed `hobo stub` instead — an honest degraded mode, never a silent skip.
     5. **Proof-scope honesty:** only the TS lane is proof-backed (HOBO-122); every other lane is design-pinned and each matrix cell carries `proven | design-pinned`; a lane's cell may not claim `proven` without its own proof under `docs/design/proofs/`.
   - `### Consequences` — (+) the polyglot promise of Plan 20 now has a specified inner loop with honest per-lane labels, reusing replay + the ADR-0042 label pattern (net-new surface = a latency-class label + a container restart-on-change policy); (−) non-TS lanes are unproven until dedicated proof slices land, and slow lanes (NativeAOT C#, image rebuilds) make "sub-minute boot" a per-lane promise, not a universal one.

2. AMEND `docs/design/developer-experience.md` — inside `## Plan 07`, in the `#### The inner loop (`hobo dev`)` section, insert a new h5 subsection AFTER the HOBO-520 resilience paragraph (ends "...out of this slice.") and BEFORE the existing `##### Local-dev fidelity — what's real vs simulated vs Camp-only ([ADR-0042](...))` heading:
   - Heading: `##### Per-workload dev loop — TS, non-TS components, and OCI-fallback services ([ADR-NNNN](./adr/07-portability-extensibility.md#adr-nnnn))`
   - One intro paragraph: state preservation is replay-based and therefore toolchain-neutral; lanes differ only in recompile latency and which generated artifacts refresh; `hobo dev` surfaces a per-lane latency class like the fidelity labels.
   - The normative matrix, one row per lane, columns: **Workload lane | Watch → recompile path | Latency class | Run state across reload | Regenerated artifacts | Under `hobo dev`? | Status**:
     - TS/JS (`jco` + `componentize-js`): transpile + re-componentize on save | fast | preserved (replay from `.hobo/`) | `_generated/` TS clients on WIT/Zod/`.allow()`/`bind` edits | yes | **proven** ([HOBO-122 proof](./proofs/hobo-122-dev-loop/index.md))
     - Rust (`cargo-component`): debounced `cargo component build` | medium | preserved (replay) | wit-bindgen bindings on WIT edits (+ `_generated/` TS only if the WIT changed) | yes | design-pinned
     - Go (TinyGo): debounced `tinygo build` to component | medium | preserved (replay) | same as Rust | yes | design-pinned
     - Python (`componentize-py`): re-componentize on save | medium | preserved (replay) | same as Rust | yes | design-pinned
     - C#/.NET (`componentize-dotnet`, NativeAOT-LLVM): debounced rebuild | slow | preserved (replay) | same as Rust | yes | design-pinned
     - OCI-fallback container: image rebuild (or bind-mount) + restart-on-change via local Docker/Podman through the same OCI pipeline ([Plan 21](./authoring-resources-wiring.md#plan-21)) | slow | **not preserved in-memory** — only event-log-backed state | none (no idiom layer) | yes, restart-on-change; without a container runtime, `hobo doctor` flags it and the service runs as a `hobo stub` | design-pinned
   - Closing sentence: only the TS lane is proof-backed; the others are design-pinned pending their own proof slices (per ADR-NNNN point 5).

3. AMEND `docs/design/adr/index.md` — add one row at the end of the ID table: `| NNNN | Polyglot inner loop: per-toolchain watch lanes, replay-based state preservation & OCI-fallback under `hobo dev` | [portability-extensibility](07-portability-extensibility.md#adr-nnnn) |`. Do not touch any other row. (index.md has no frontmatter — keep it that way.)

4. AMEND `docs/design/traceability.md` — two edits: (a) add an `ADR-NNNN` row at the end of the `## ADR Coverage` table: source `[portability-extensibility](./adr/07-portability-extensibility.md#adr-nnnn)`, coverage assertion ~"Polyglot dev-loop lanes are pinned with replay-based state preservation, per-lane latency classes, layered codegen-in-watch, and a restart-on-change local container policy; only the TS lane is proof-backed." primary issues: HOBO-122, HOBO-156, HOBO-392; (b) in `## ADR Numbering and Status Audit`, bump the "Counted ADRs: N numbered entries" count by 1 and change "Explicit numbering gaps through `ADR-0104`" to reference ADR-NNNN. Do not alter the "Accepted / current" status-policy sentence.

5. AMEND `docs/design/wasm-runtime-wit.md` — directly after the `### Build pipeline (per language)` table (after the line "`@hobo/componentize` wraps these; output is a component pushed as an **OCI artifact**..."), add one sentence: each toolchain adapter also implements `@hobo/componentize`'s watch contract; per-lane watch-recompile latency classes and reload semantics under `hobo dev` are pinned in [ADR-NNNN](./adr/07-portability-extensibility.md#adr-nnnn) with the matrix in [Plan 07](./developer-experience.md#plan-07).

6. AMEND `docs/design/cli-spec.md` — in the Canonical CLI Verbs table, extend the `dev` row's Semantics cell (keep it a single table line): append "Every workload lane participates: wasm components in any supported language recompile in-watch and OCI-fallback services restart-on-change per the dev-loop matrix (ADR-NNNN)." Leave the Implementation-issues column unchanged.

7. AMEND `docs/competitors/aspire.md` — in the "Runtime, deploy & ops" table: (a) the "DCP (local Go orchestrator)" row (~line 465): add `[07](../design/developer-experience.md#plan-07)` to the HoBo-doc cell; keep status ✅ ONLY because every matrix cell now has specified behavior — if the executor defers any lane instead of specifying it, downgrade this row's status to 🔜; (b) the "Polyglot (Python/Node/Go/Java/Rust)" row (~line 470): add the same `[07]` link so the polyglot parity claim points at the dev-loop matrix.

**Acceptance**

Checklist (all must pass):
1. `docs/design/adr/07-portability-extensibility.md` contains a new `## ADR-NNNN` section with the 5 decisions above; NNNN = next free global ID (max ID in `docs/design/adr/index.md` + 1); no existing ADR section edited or renumbered; the anchor `#adr-nnnn` (lowercase) resolves.
2. `docs/design/developer-experience.md` Plan 07 inner-loop section has the new h5 with a 6-row matrix covering exactly the four disputed dimensions per lane: watch-recompile path + latency class, run-state preservation across reload, which generated artifacts regenerate, and whether/how OCI-fallback containers run under `hobo dev`. TS row cites the HOBO-122 proof; all non-TS rows say design-pinned; the container row states restart-on-change + no in-memory state preservation + the `hobo doctor`/`hobo stub` degraded mode.
3. Cross-links valid in both directions: developer-experience.md ↔ ADR-NNNN; wasm-runtime-wit.md → ADR-NNNN and → Plan 07; cli-spec.md `dev` row mentions ADR-NNNN; aspire.md DCP and Polyglot rows link `../design/developer-experience.md#plan-07`.
4. Hub/index files updated: `docs/design/adr/index.md` gains the ADR-NNNN row; `docs/design/traceability.md` gains the ADR-NNNN coverage row AND the bumped "Counted ADRs" count and "gaps through ADR-NNNN" line. (`docs/design/index.md` needs no change — no new doc or plan was added.)
5. Validation commands (run from repo root, all green):
   - `pnpm run docs:okf`
   - `pnpm agent:check -- --staged` (with all changed files staged; this auto-includes the design-doc lint and, because `docs/design/adr/` + `docs/design/traceability.md` are touched, the traceability gate)
   - `node --import tsx scripts/validate-traceability.ts` — the real traceability gate (there is no package.json alias for it; it is invoked via `scripts/relevant-check-policy.ts` and directly per CONTRIBUTING.md). It fails if ADR-NNNN is in `adr/index.md` but missing from `traceability.md`.
   - Optional belt-and-braces: `pnpm run docs:design-lint` (relative-link + ADR-reference validation).
6. Register bookkeeping (cross-link): in `GAPS.md`, flip the cand-06 Gap-register row to 🧯 and add the `### REM-` entry under `## Remediations` (Action = this entry, Effort = M, Delivery link = the PR that applies it).

**Guardrails**

Documentation-only: no `src/` changes, no watch tooling implemented, no new proofs written (the HOBO-122 proof's Scope Guard stays authoritative — do not edit `docs/design/proofs/hobo-122-dev-loop/index.md`). Never renumber or rewrite existing ADRs; the new ADR is appended with the next free global ID into one of the four theme files (07-portability-extensibility.md), and index.md files stay frontmatter-free. Do not re-litigate or weaken the Nomad→wasmCloud pivot or the wasm-first default — containers remain the fallback, not a peer runtime. Do not mark any non-TS lane "proven"; do not invent new CLI verbs, flags, or event families (`family.Event` strings trigger the event-family lint against docs/design/event-families.md); the only new named surface is the per-lane latency-class label and the container restart-on-change policy. Keep all links relative `.md` links with correct anchors; keep existing OKF YAML frontmatter on amended docs untouched.

### REM-008 (for GAP-005)

- **Finding** (cand-07, P2, MED, votes uphold/uphold/uphold): Aspire's local dashboard is a core DX pillar (per-resource logs/traces/metrics/env, resource graph, OTLP sink), but HoBo's local dashboard is specified as a single 'Local emulation (Nitric-style)' table row plus a 'local inspector' code comment — and the dashboard's stated architecture (Next.js web resource in the Yard Bindle, reading via the Gateway) has no defined serving mode for `hobo dev`, which runs with no Yard/Gateway; local telemetry views during dev are unspecified.
- **Evidence:** `docs/design/developer-experience.md:22` · `docs/design/developer-experience.md:42` · `docs/design/developer-experience.md:49` · `docs/design/walkthrough.md:138` · `docs/design/deployment-dashboard-topology-explorer.md#scope-out-and-non-goals` · `docs/competitors/aspire.md:360-381`
- **Effort:** M · **Delivery:** [HOBO-673](https://linear.app/quickdeploy-ai/issue/HOBO-673) (Intent-Alignment Gap Remediation project)

**Action**

REM for cand-07 — specify the `hobo dev` local dashboard (serving mode, read path, local views, local telemetry, offline). Documentation-only; 6 existing files amended, no new doc files created.

1. AMEND `docs/design/developer-experience.md` (Plan 07). Insert a new h3 section immediately after the "### Local-dashboard & link views (integrated)" table (currently ends line 52) and before "### CLI & developer experience" (line 54):

   ### Local dashboard (`hobo dev`) — one-line intro: the same dashboard app, served locally with no Yard/Gateway/auth; decision pinned in ADR-NNNN (see step 2).
   Body as five bold-led paragraphs (house style — no h4s needed):
   - **Serving mode.** During `hobo dev` the dashboard is NOT the Yard-Bindle web resource from "Tech & structure" — the same Next.js app ships as a static build bundled with the CLI and is served by `runtime-local` on `localhost:<port>` (printed by `hobo dev`). One app, two serving modes: hosted = web resource in the Yard Bindle behind the Gateway; local = CLI-bundled static assets over runtime-local. Link ADR-NNNN.
   - **Read path.** Locally the dashboard reads `runtime-local` projections directly through the same read-API shape the Gateway exposes hosted-side — no Gateway, no Yard, no auth (localhost-only), extending the existing "inspect/logs work against localhost with no auth" promise (link ../walkthrough.md is not needed; cite #the-inner-loop-hobo-dev item 3).
   - **Locally available views.** Enumerate which views render in dev: Deployments timeline (local runs), Topology/link map (from the collected manifest, Plan 21), Run inspector (`.hobo/` replay), Local emulation panel, WIT-call traces. Registry browser, Cost/FinOps, Drift, and Agent credential audit are Camp-backed and render as unavailable-with-reason using the ADR-0042 fidelity labels (`real|simulated|mocked|camp-only`) — never as silently empty panels.
   - **Local telemetry (Aspire parity).** `runtime-local` exposes a local OTLP ingest endpoint (any local process can point `OTEL_EXPORTER_OTLP_ENDPOINT` at it, matching the Aspire standalone-dashboard sink — link ../competitors/aspire.md#dashboard-dcp--observability); per-resource logs and traces render locally in the same views; metrics render with honest fidelity labels (provider latency/egress/cost stay `mocked` per [ADR-0042](./adr/07-portability-extensibility.md#adr-0042)). Dev-time first — not production monitoring (Plan 5 owns prod telemetry).
   - **Offline behavior.** Fully offline: projections rebuild from the `.hobo/` event log, no cloud reads, no phone-home (consistent with the in-boundary OTel collector posture, ADR-0036).

2. AMEND `docs/design/adr/07-portability-extensibility.md`. Add a new `## ADR-NNNN` section directly after ADR-0042 (ends line 206), where NNNN = the next free global ADR ID — highest existing is ADR-0104, so verify against `docs/design/adr/index.md` and take the next unused number; NEVER renumber existing ADRs. Title: **"Local dashboard serving mode & local telemetry for `hobo dev`."** House format:
   ### Context — 1 para: Plan 07 says the dashboard is a Next.js web resource in the Yard Bindle reading via the Gateway, but `hobo dev` runs with no Yard/Gateway; Aspire's per-resource logs/traces/metrics/resource-graph local dashboard (docs/competitors/aspire.md) is the P2 pillar reference; without a decided serving mode the local dashboard is unbuildable.
   ### Decision — 4 numbered points: (1) CLI-bundled static build of the SAME app, served by runtime-local on localhost ("Self-host = hosted UI" extends to "local = same app, different read source"); rejected alternative recorded: deploying the dashboard as a runtime-local-hosted web resource (couples the inner loop to a self-deploy). (2) Direct reads of runtime-local projections via the Gateway-shaped read API, localhost-only, no auth. (3) runtime-local embeds an OTLP ingest endpoint; logs/traces render locally, metrics carry ADR-0042 fidelity labels; deferrals (if any) must be explicit per-view labels, not omissions. (4) Fully offline; `.hobo/` is the only store.
   ### Consequences — (+) local DX parity with Aspire without a Yard; one dashboard codebase. (−) CLI binary carries the dashboard assets; the local read API must track the Gateway read-API shape (drift risk, covered by conformance tagging local per ADR-0042).

3. AMEND `docs/design/adr/index.md` — add one row to the Index table in numeric order: `| NNNN | Local dashboard serving mode & local telemetry for \`hobo dev\` | [portability-extensibility](07-portability-extensibility.md#adr-nnnn) |`. This file has NO frontmatter — do not add any.

4. AMEND `docs/design/traceability.md` — (a) add an ADR row matching house format: `| ADR-NNNN | [portability-extensibility](./adr/07-portability-extensibility.md#adr-nnnn) | Local dashboard during \`hobo dev\` is the CLI-bundled hosted app served by runtime-local, reading local projections with no Gateway/Yard/auth, with local OTLP ingest and ADR-0042 fidelity labels. | HOBO-<this remediation's Linear issue; use HOBO-410 if not yet minted> |`; (b) update the sentence "Explicit numbering gaps through `ADR-0104`" (line ~370) to reference the new highest ID (gap list unchanged if NNNN is contiguous).

5. AMEND `docs/design/deployment-dashboard-topology-explorer.md` — add a new h2 `## Gap Routing` section between "Owning Initiative Dependencies" and "Evidence Required For M1" (Scope In already claims gap routing exists but no section does). One lead-in line ("Adjacent gaps route to their owning initiative; the Owning Initiative Dependencies table names the owners.") plus a table with one row: Gap = "Local `hobo dev` dashboard: serving mode, local read path, local telemetry, offline behavior"; Routed to = `[developer-experience.md#local-dashboard-hobo-dev](./developer-experience.md#local-dashboard-hobo-dev)` and `[ADR-NNNN](./adr/07-portability-extensibility.md#adr-nnnn)`; Owner = Developer Experience / CLI / MCP; Boundary = "local dev surface is out of this M0's scope; this record only routes it".

6. AMEND `docs/competitors/aspire.md` — in "### Dashboard, DCP & observability" (line 360), extend the existing HoBo cross-reference sentence ("Note the scope gap HoBo closes…") with one clause linking the local-dev parity answer: HoBo's local `hobo dev` dashboard equivalent (serving mode, per-resource logs/traces/metrics, OTLP sink) is specified in [Plan 07 §Local dashboard](../design/developer-experience.md#local-dashboard-hobo-dev).

7. AMEND `GAPS.md` — on delivery, flip the cand-07 Gap register row 🧯 → ✔ and set the REM entry's Delivery link to the merged PR.

Anchor note: GitHub-style anchor for the new h3 "### Local dashboard (`hobo dev`)" is `#local-dashboard-hobo-dev` — verify the rendered anchor before finalizing cross-links (backticks and parens are stripped, spaces become dashes).

**Acceptance**

- [ ] New ADR uses the next free global ID (verify highest in docs/design/adr/index.md — ADR-0104 at time of writing); no existing ADR renumbered or moved; no new files under docs/design/adr/ (the four theme files + index.md only).
- [ ] Plan 07's new "Local dashboard (`hobo dev`)" section answers all five questions from the finding: serving mode, read path (no Gateway/Yard/auth), which views are local vs Camp-backed, per-resource logs/traces/metrics locally (OTLP ingest or explicit per-view deferral label), offline behavior.
- [ ] Cross-link web is closed: developer-experience.md §Local dashboard ↔ new ADR ↔ aspire.md #dashboard-dcp--observability; deployment-dashboard-topology-explorer.md §Gap Routing → developer-experience.md#local-dashboard-hobo-dev; all links relative `.md` links that resolve.
- [ ] adr/index.md gains the new row and still has NO YAML frontmatter; no new docs/ files are created (so no new OKF frontmatter needed), and no existing frontmatter `type:` fields are emptied.
- [ ] traceability.md has the new ADR row and the updated "Explicit numbering gaps through ADR-…" sentence.
- [ ] Run and pass: `pnpm run docs:okf`
- [ ] Run and pass (with all changes staged): `pnpm agent:check -- --staged` — because docs/design/adr/ and docs/design/traceability.md are touched, this fires the traceability gate `node --import tsx scripts/validate-traceability.ts` (wired via scripts/relevant-check-policy.ts line 149; there is no direct package.json alias) plus lint:docs:staged and docs:coverage. If iterating, the gate can also be run directly: `node --import tsx scripts/validate-traceability.ts`.
- [ ] GAPS.md cand-07 row status updated with the delivery link once merged.

**Guardrails**

Documentation-only — no code, no dashboard implementation, no CLI changes (cli-spec.md deliberately untouched: the dashboard is a projection surface, not a new verb; do not add one). Do not reverse or re-litigate the Nomad→wasmCloud pivot. Do not renumber or edit existing ADR sections beyond appending the new one. Keep the decision consistent with existing commitments: ADR-0042 fidelity labels (`real|simulated|mocked|camp-only`) must gate every locally-rendered metric, and the "Self-host = hosted UI" principle means ONE dashboard app, never a fork. Mirror Aspire's honesty: local telemetry is dev-time first, not production monitoring (Plan 5/Plan 49 own prod surfaces — do not expand them). The M0 record's Scope Out must stay intact — the new Gap Routing section routes the local-dashboard work outward; it must not pull implementation into HOBO-410's M0 scope. index.md files never gain frontmatter. If the next free ADR ID is not 0105 at execution time, take whatever is actually next — never guess from this entry.

### REM-009 (for GAP-006)

- **Finding** (cand-08, P2, MED, votes uphold/uphold/uphold): Local-dev behavior for non-HoBo dependencies is unspecified: an `external`/adopted resource (the promoted brownfield strangler-fig path) has no stated `hobo dev` semantics (connect to the real endpoint, mock from contract, or fail), and `addContainer(...)` workloads are specified for wiring/building but not for whether hobo dev actually runs them locally — exactly Aspire's local-orchestration strength (AddContainer/ExternalService/AddConnectionString).
- **Evidence:** `docs/design/adr/07-portability-extensibility.md#adr-0041` · `docs/design/developer-experience.md:158` · `docs/design/authoring-resources-wiring.md:146-159` · `docs/design/adr/07-portability-extensibility.md:195` · `docs/competitors/aspire.md:84-93`
- **Effort:** M · **Delivery:** [HOBO-674](https://linear.app/quickdeploy-ai/issue/HOBO-674) (Intent-Alignment Gap Remediation project)

**Action**

Amend 6 existing files (no new files, no new ADR ID — this extends ADR-0042 and ADR-0041 in place, which ADR-0042's own Consequences call "ongoing discipline"):

1. docs/design/adr/07-portability-extensibility.md — ADR-0042 section (starts line 178):
   a. Under "### Decision", append a new point 3 after point 2 (line 186): "**Non-HoBo dependencies get explicit `hobo dev` semantics — never an undefined seam.**" with two sub-bullets:
      - **`external`/adopted resources ([ADR-0041](#adr-0041))** default to **mock (honest seam)**: `hobo dev` serves the binding as a **contract-backed stub** — the same auto-served `mock` boundary mode as [Plan 23](../generated-stack.md#plan-23) stubs / [ADR-0076](02-identity-security.md#adr-0076) (generated from the resource's recorded contract/traces, no hand-written mock). Opt-in real connection via `hobo dev --connect <resource>` resolves the real endpoint using the dev-only credential sources of [Plan 21](../authoring-resources-wiring.md#plan-21) (`.env.local`/OS keychain, audited as `secret.Accessed { camp: "local", source: "dev" }`, never satisfying a production `can-deploy`); a static-key connection remains a counted zero-secret exception per ADR-0041 §2. If no contract is recorded and `--connect` is not given, `hobo dev` **fails that resource with remediation** (record a contract, pass `--connect`, or verify in a Camp) — never a silent empty stub.
      - **`addContainer(...)` workloads ([Plan 21](../authoring-resources-wiring.md#plan-21))** are **simulate (real locally)**: `hobo dev` runs the built image on the local container engine (Docker/Podman) with the **same env-injection convention as deploy** (`ConnectionStrings__<name>` / `services__<name>__<endpoint>__<i>`), honoring `waitFor`/`withHttpHealthCheck` ordering; wasm-on-OCI images run on `runtime-local`'s component host with no container engine needed. Without a container engine, the workload's fidelity **degrades to `camp-only` with an explicit label + remediation**, surfaced by `hobo dev` and `hobo verify` — never silently skipped.
   b. In "#### The fidelity matrix", insert two rows after the "Embedding / search" row (line 196), keeping the exact 3-column shape (| Prod behavior | Local fidelity | Why |):
      `| \`addContainer(...)\` workloads | **simulate** | local container engine runs the image with deploy-identical env injection ([Plan 21](../authoring-resources-wiring.md#plan-21)); degrades to labeled **camp-only** without Docker/Podman |`
      `| \`external\`/adopted resources | **mock** (honest seam) | outside the conformance boundary ([ADR-0041](#adr-0041)); contract-backed stub by default ([Plan 23](../generated-stack.md#plan-23)/[ADR-0076](02-identity-security.md#adr-0076) \`mock\` mode), \`--connect\` opt-in real, fail-with-remediation otherwise |`
   c. In ADR-0042 "### Consequences", extend the (−) bullet with: "…, container-engine detection + the `--connect` opt-in add a small CLI surface, and the `external` stub is only as faithful as the recorded contract."

2. Same file — ADR-0041 §Decision point 2 (line 131): append one sentence at the end of the paragraph: "Local dev against an `external` resource has **defined `hobo dev` semantics** — contract-backed stub by default, explicit `--connect` opt-in to the real endpoint, fail-with-remediation otherwise ([ADR-0042](#adr-0042) fidelity matrix)."

3. docs/design/developer-experience.md — "Local-dev fidelity" subsection (lines 148–152): append to the **Simulate** bullet: ", `addContainer` workloads (local container engine, deploy-identical env injection; labeled camp-only without one)"; append to the **Mock** bullet: ", `external`/adopted resources (contract-backed stub; `hobo dev --connect` opt-in real; fail-with-remediation if neither)". Also extend the Brownfield bullet in "#### Onboarding paths" (line 158) with: "— locally, `hobo dev` stubs still-`external` resources from their recorded contracts or connects via `--connect` ([ADR-0042](./adr/07-portability-extensibility.md#adr-0042))".

4. docs/design/authoring-resources-wiring.md — after the BuildProvider sentence closing the `addContainer` block (line 159), add one paragraph: "**Local dev (`hobo dev`):** an `addContainer` workload runs on the local container engine with the same env-injection convention as deploy (`ConnectionStrings__<name>` / `services__<name>__<endpoint>__<i>`); wasm-on-OCI images run on `runtime-local` with no container engine. Fidelity is labeled per the [ADR-0042](./adr/07-portability-extensibility.md#adr-0042) matrix — simulate with an engine present, labeled camp-only without one."

5. docs/design/traceability.md — line 304 (ADR-0042 row): extend the description cell with "…including `hobo dev` semantics for `external`/adopted resources (contract-backed stub / opt-in `--connect`) and `addContainer` workloads (local container engine, deploy-identical env injection)". Leave the HOBO-issue column unchanged.

6. docs/competitors/aspire.md — "### Composition & wiring" HoBo-mapping table (lines 444–456): add one row:
   `| \`AddContainer\` local run / \`ExternalServiceResource\` / \`AddConnectionString\` (BYO) | \`addContainer\` runs under \`hobo dev\` (local engine, same env convention); \`external\` resource = contract-backed stub or \`--connect\` | ✅ | [ADR-0042](../design/adr/07-portability-extensibility.md#adr-0042), [ADR-0041](../design/adr/07-portability-extensibility.md#adr-0041) |`

Section outline (all amendments to existing sections — no new docs, so no new OKF frontmatter and no index.md changes needed):
- ADR-0042 › Decision › new point 3 "Non-HoBo dependencies get explicit hobo dev semantics" — defines the dev default per kind.
- ADR-0042 › The fidelity matrix › +2 rows — external/adopted (mock) and addContainer (simulate).
- ADR-0041 › Decision §2 — one cross-link sentence to ADR-0042.
- Plan 7 › Local-dev fidelity + Onboarding paths › extended bullets — surface the new labels where developers read them.
- Plan 21 (authoring-resources-wiring) › addContainer block › new "Local dev" paragraph — states hobo dev runs containers locally.
- traceability.md › ADR-0042 row — description updated to cover the new rows.
- competitors/aspire.md › HoBo mapping › +1 parity row — closes the AddContainer/ExternalService/AddConnectionString comparison the finding cites (aspire.md:84-93).

**Acceptance**

Checklist:
1. `pnpm run docs:okf` passes (no frontmatter was added/removed; index.md files untouched).
2. `pnpm agent:check -- --staged` passes with all six files staged (routes docs lint/case/freshness lanes).
3. docs/design/ is touched, so the traceability gate must pass: `node --import tsx scripts/validate-traceability.ts` (validates every ADR ID in docs/design/adr/index.md appears in docs/design/traceability.md and numbering is contiguous — amendments add no ID, so this must stay green).
4. Optional but listed in .github/pull_request_template.md for ADR/design-term changes: `pnpm run docs:design-lint`.
5. Content checks: `rg -n "addContainer" docs/design/adr/07-portability-extensibility.md` hits the ADR-0042 matrix; `rg -n "external\`/adopted" docs/design/adr/07-portability-extensibility.md` hits both the Decision point and the matrix row; `rg -n "\-\-connect" docs/design/developer-experience.md docs/design/adr/07-portability-extensibility.md` returns ≥3 hits; the ADR-0042 fidelity matrix still renders as a 3-column table (| Prod behavior | Local fidelity | Why |).
6. Cross-link validity (relative .md links, lowercase anchors): within 07-portability-extensibility.md use `#adr-0041`/`#adr-0042`; sibling ADR file as `02-identity-security.md#adr-0076`; from adr/ up one level as `../generated-stack.md#plan-23` and `../authoring-resources-wiring.md#plan-21`; from developer-experience.md/authoring-resources-wiring.md as `./adr/07-portability-extensibility.md#adr-0042`; from docs/competitors/aspire.md as `../design/adr/07-portability-extensibility.md#adr-0042`.
Cross-links that must be updated (no index/hub files gain links since no files are created): ADR-0041 → ADR-0042 (new sentence), developer-experience.md Plan 7 → ADR-0042 (extended bullets already link the ADR in the heading — keep it), authoring-resources-wiring.md → ADR-0042 (new paragraph), traceability.md ADR-0042 row, competitors/aspire.md HoBo-mapping row → ADR-0041/ADR-0042.

**Guardrails**

- Amend in place; NEVER renumber, reorder, or delete existing ADRs. No new ADR ID is required for this remediation. If the implementer instead opts for a standalone ADR, it must take the next free global ADR ID (grep max `ADR-\d{4}` across docs/design/adr/ — currently ADR-0104 is the highest observed — and verify at drafting time), live in the 07-portability-extensibility.md theme file, and add both a docs/design/adr/index.md row and a docs/design/traceability.md row or scripts/validate-traceability.ts fails.
- Keep the ADR-0042 fidelity vocabulary fixed: `real | simulated | mocked | camp-only` labels and the simulate/mock/camp-only matrix terms — do not invent a new fidelity class.
- Secure-by-default must hold: the `external` dev default is the contract-backed stub, never an automatic real connection; do not weaken ADR-0041's honesty stance (external stays a PortabilityReport entry + counted zero-secret exception).
- Do not touch the Nomad→wasmCloud pivot, ADR-0031 host decisions, or the closed gap-analysis row #17 (it stays closed; this strengthens it).
- Documentation only — no code, no scripts, no schema changes. index.md files must not gain frontmatter; no new files means no OKF frontmatter work.
- Keep all links relative `.md` links with lowercase `#adr-00nn`/`#plan-nn` anchors; do not convert any to absolute paths or URLs.

### REM-010 (for GAP-007)

- **Finding** (cand-09, P3, MED, votes uphold/uphold/uphold): The catalog's `data()` resource — HoBo's replacement for Nitric's `sql`/kv-paradigm building blocks (ADR-0052) — imports a `hobo:data` WIT port that is never defined in Plan 20's self-described 'canonical port catalog'; Plan 20 instead still lists the superseded `sql` resource over `wasi:sql`(+`hobo:sql`), and ADR-level proofs use a third name (`hobo:database/postgres`), so the resource->WIT-port spine for the data block is inconsistent and undefined at its most important row.
- **Evidence:** `docs/design/authoring-resources-wiring.md:43` · `docs/design/authoring-resources-wiring.md:72` · `docs/design/authoring-resources-wiring.md:168` · `docs/design/wasm-runtime-wit.md:128` · `docs/design/wasm-runtime-wit.md:150` · `docs/design/adr/03-data-plane.md:461`
- **Effort:** M · **Delivery:** [HOBO-675](https://linear.app/quickdeploy-ai/issue/HOBO-675) (Intent-Alignment Gap Remediation project)

**Action**

All paths relative to repo root C:\src\hobo. No new standalone doc files are created (so no new OKF frontmatter is needed); one new ADR is appended to an existing theme file plus surgical edits to six existing docs and two index/registry docs.

STEP 0 — compute the next free ADR ID (do not guess): run `grep -rho "^## ADR-[0-9]\{4\}" docs/design/adr/*.md | sort -u | tail -5` and cross-check the numeric rows in docs/design/adr/index.md; the new ID is max+1, zero-padded to 4 digits (as of 2026-07-01 the max heading is ADR-0104, so the ID is likely 0105 — but always recompute). Below it is written ADR-XXXX; its anchor is #adr-xxxx (lowercase).

STEP 1 — CREATE the new ADR: append to the END of docs/design/adr/03-data-plane.md (after the current last section, ADR-0100 "generateProvider correctness…"). Outline:
- `## ADR-XXXX` then bold title line: "**`hobo:data` is the canonical WIT port of the `data()` resource; `wasi:sql` is driver-level; `hobo:sql` is retired; `hobo:database/*` is a frozen proof alias.**"
- `### Context` — names the three divergent spellings: Plan 21's catalog maps `data()` → `hobo:data` ([Plan 21](../authoring-resources-wiring.md#plan-21) rows + manifest-IR example), Plan 20's self-described canonical port catalog instead lists a superseded `sql` resource over `wasi:sql`(+`hobo:sql`) and never defines `hobo:data` ([Plan 20](../wasm-runtime-wit.md#plan-20)), and [ADR-0100](#adr-0100)/the HOBO-211 generation proofs target `hobo:database/postgres@0.1.0`; cites [ADR-0052](#adr-0052)'s "`data`, not `sql`" decision as the settled semantics this ADR gives one naming spine to.
- `### Decision` — numbered:
  1. `hobo:data` is the canonical app-facing WIT port the `data()` resource links against, with paradigm sub-interfaces `hobo:data/relational · hobo:data/document · hobo:data/graph · hobo:data/vector · hobo:data/key-value` (exactly the ADR-0052 paradigm taxonomy; the key-value *paradigm* sub-port is distinct from the `kv()` resource over `wasi:keyvalue`). Key functions map 1:1 to the `.allow()` verbs: `read(key/query)`, `write(record)`, `query(predicate)` (the predicate DSL shared with `hobo:projection`/`hobo:search`, [Plan 32](../data-plane.md#plan-32)), `admin(migration-plan ops)`.
  2. Port relationships stated once: `hobo:projection` stays the projection/fold port and `hobo:search` the query-extension port ([ADR-0034](#adr-0034)); `hobo:data` is the resource-level port a `data()` link resolves to, and a paradigm sub-interface is what a provider exports.
  3. There is no `sql` resource. `wasi:sql` is demoted to a driver-level reused interface that a `hobo:data/relational` provider/sink driver MAY realize its mapping over (consistent with Plan 32 §Projection events & ports).
  4. `hobo:sql` is retired as a WIT port name (it was never defined); the relational idiom layer is the `@hobo/sql` npm package ([ADR-0081](#adr-0081)), which lowers through `hobo:data` — package name unchanged.
  5. `hobo:database/postgres@0.1.0` is the frozen provider-target id used by ADR-0100 and the HOBO-211/HOBO-324 reference proofs/fixtures; it names a Postgres provider of `hobo:data/relational`. Proof code under src/draft is NOT rewritten; new docs must use `hobo:data/relational`.
  6. Plan 20's interface catalog is the single authoritative registry of port names; any resource→port row elsewhere must link a port defined there. Include a small naming-map table: resource `data()` → canonical port `hobo:data` → sub-interfaces → underlying reused WASI (`wasi:sql` for relational drivers) → legacy aliases (`sql` resource · `hobo:sql` · `hobo:database/*`).
- `### Consequences` — (+) the resource→WIT-port spine for the data block is defined at one authoritative row and all four names reconcile; (−) the frozen `hobo:database/*` alias survives in historical proofs/fixtures and must be read through the naming map.
Optionally (allowed, not required): add ONE italic naming-note line inside ADR-0100's Context — "*Naming note: `hobo:database/postgres@0.1.0` is the frozen reference-proof port id; the canonical catalog name is `hobo:data/relational` ([ADR-XXXX](#adr-xxxx)).*" Do not alter ADR-0100's Decision text.

STEP 2 — AMEND docs/design/wasm-runtime-wit.md (Plan 20), four edits:
(a) line 27 "Reused" bullet: change "`wasi:sql`," to "`wasi:sql` (driver-level under `hobo:data/relational`, [ADR-XXXX](./adr/03-data-plane.md#adr-xxxx)),".
(b) line 128 building-block table: replace the row `| SQL | \`wasi:sql\` (+ \`hobo:sql\`, [Plan 32](./data-plane.md#plan-32)) |` with `| Data (relational/document/graph/vector/kv) | \`hobo:data\` — paradigm sub-interfaces \`relational · document · graph · vector · key-value\` ([ADR-XXXX](./adr/03-data-plane.md#adr-xxxx)); relational realizable over draft \`wasi:sql\` ([Plan 32](./data-plane.md#plan-32)) |`.
(c) line 150 reused-WASI table: replace `| \`wasi:sql\` | \`sql\` | connection + query (draft; HoBo \`hobo:sql\` fills gaps) |` with `| \`wasi:sql\` | \`data\` (relational; driver-level) | draft; a \`hobo:data/relational\` provider/sink driver may realize its mapping over it — not an app-facing catalog port ([ADR-XXXX](./adr/03-data-plane.md#adr-xxxx)) |`.
(d) hobo:* interface table (lines 156–182): insert a new row after the `hobo:embed` row (line 169): `| \`hobo:data\` | canonical port of the \`data()\` resource ([Plan 21](./authoring-resources-wiring.md#plan-21)/[ADR-0052](./adr/03-data-plane.md#adr-0052)/[ADR-XXXX](./adr/03-data-plane.md#adr-xxxx)) — one abstract data dep; paradigm sub-interfaces \`relational · document · graph · vector · key-value\`, each a provider export | \`read(key/query)\`, \`write(record)\`, \`query(predicate)\` (predicate DSL shared with \`hobo:projection\`/\`hobo:search\`), \`admin\` (migration-plan ops, [Plan 32](./data-plane.md#plan-32)); relational sub-port realizable over draft \`wasi:sql\` |`.

STEP 3 — AMEND docs/design/authoring-resources-wiring.md (Plan 21): in the line-43 Data row and line-72 Nitric-parity Data row, expand "`hobo:data` (paradigm sub-ports)" to "`hobo:data` (sub-interfaces `relational · document · graph · vector · key-value`, [ADR-XXXX](./adr/03-data-plane.md#adr-xxxx))". Leave the manifest-IR example (lines 168/172) as-is — it is now defined.

STEP 4 — AMEND docs/design/data-plane.md (Plan 32): line 208 and lines 490/492 — replace each "the `sql` resource"/"relational **`sql`** resources" with "a relational `data` resource (`hobo:data/relational`, [ADR-XXXX](./adr/03-data-plane.md#adr-xxxx))" (keep surrounding sentence intact); line 466 — replace "(today on the `database` port)" with "(today on `hobo:data/relational`, the relational data sub-interface — [ADR-XXXX](./adr/03-data-plane.md#adr-xxxx))".

STEP 5 — AMEND docs/competitors/nitric.md line 312: replace `| \`sql\` | \`wasi:sql\` / \`hobo:sql\` | ✅ |` with `| \`sql\` | \`hobo:data/relational\` (realizable over draft \`wasi:sql\`) ([ADR-XXXX](../design/adr/03-data-plane.md#adr-xxxx)) | ✅ |`.

STEP 6 — AMEND enumerations: docs/design/control-plane.md line 140 — replace "`wasi:sql`" with "`hobo:data`"; docs/technologies/openstack.md line 38 — replace "`wasi:sql`" with "`hobo:data`".

STEP 7 — REGISTER the ADR: (a) docs/design/adr/index.md — add row `| XXXX | \`hobo:data\` is the canonical data() port; wasi:sql driver-level, hobo:sql retired, hobo:database/* frozen alias | [data-plane](03-data-plane.md#adr-xxxx) |` following the existing table format (this file must keep NO frontmatter); (b) docs/design/traceability.md — add an ADR row `| ADR-XXXX | [data-plane](./adr/03-data-plane.md#adr-xxxx) | Canonical data-port naming spine: hobo:data + paradigm sub-interfaces; wasi:sql demoted to driver level; hobo:sql retired; hobo:database/* frozen proof alias. | HOBO-<this remediation's Linear issue id> |` in the ADR table near ADR-0100/0104, and update the prose "Explicit numbering gaps through ADR-0104" to reference the new max ID.

Do NOT touch: any file under src/draft (all `hobo:database/postgres@0.1.0` hits there are frozen proof artifacts), docs/design/proofs/hobo-324-llm-fill/index.md, docs/design/proofs/hobo-232-relational-projection-sink/index.md (its `wasi:sql/query@0.2.0` driver-level lowering is consistent with the demotion), and ADR-0032/ADR-0052/ADR-0081 decision text.

**Acceptance**

Checklist (run from C:\src\hobo):
1. `pnpm run docs:okf` — passes; all amended docs keep their existing OKF frontmatter (`type: Reference`), docs/design/adr/index.md still has NO frontmatter.
2. `pnpm agent:check -- --staged` — passes with everything staged. Because docs/design/adr/** and docs/design/traceability.md are touched, this auto-runs the traceability gate; it can also be run directly as `node --import tsx scripts/validate-traceability.ts` (there is no dedicated package.json script for it — it is selected by scripts/relevant-check-policy.ts). It requires the new ADR id to appear in BOTH docs/design/adr/index.md (as a `| XXXX |` row) and docs/design/traceability.md.
3. Grep assertions:
   - `grep -rn "hobo:sql" docs/` → 0 hits.
   - `grep -n "| SQL |" docs/design/wasm-runtime-wit.md` → 0 hits; `grep -c "hobo:data" docs/design/wasm-runtime-wit.md` → ≥ 3 (building-block row + hobo:* catalog row + reused-wasi note).
   - `grep -rn "wasi:sql" docs/` → every remaining hit is in a driver-level context (Plan 20 demoted rows, data-plane.md sink-driver line 466, proofs/hobo-232) — none presents `wasi:sql` as an app-facing resource port.
   - `grep -rln "hobo:database" docs/` → only docs/design/adr/03-data-plane.md (ADR-0100 + the new ADR's alias map) and docs/design/proofs/hobo-324-llm-fill/index.md (frozen).
   - `git status --porcelain -- src/draft` → empty (no proof code touched).
4. Cross-link validity: the new ADR's relative links resolve (../wasm-runtime-wit.md#plan-20, ../authoring-resources-wiring.md#plan-21, ../data-plane.md#plan-32, #adr-0052, #adr-0081, #adr-0100); anchors `#adr-xxxx` used in wasm-runtime-wit.md, authoring-resources-wiring.md, data-plane.md, control-plane.md, competitors/nitric.md all point at docs/design/adr/03-data-plane.md. Cross-links that MUST gain entries: docs/design/adr/index.md (new ADR row) and docs/design/traceability.md (new ADR row + "gaps through ADR-…" max bumped). docs/design/index.md needs no change (no new plan/doc file).
5. Spine consistency spot-check: the Plan 21 catalog Data row, the Plan 20 building-block table, the Plan 20 hobo:* table, and the manifest-IR example (`"port": "hobo:data"`, `"links": [{"import": "hobo:data", ...}]`) now all name the same `hobo:data` port with the same five sub-interfaces.

**Guardrails**

Documentation-level only — no code, no WIT files, nothing under src/draft changes; `hobo:database/postgres@0.1.0` stays byte-frozen in all proofs/fixtures and in ADR-0100's Decision text (at most one italic naming-note line added to ADR-0100's Context). Never renumber or rewrite existing ADRs (ADR-0032/0052/0081/0100 decision text untouched); the new ADR takes the next free global ID computed by grep, not guessed. Do not rename the `@hobo/sql` npm package — only the never-defined `hobo:sql` WIT *port* name is retired (the package is an ADR-0081 idiom layer that lowers through `hobo:data`). Do not reverse or re-litigate the Nomad→wasmCloud pivot or ADR-0052's "`data`, not `sql`" decision — this remediation only fixes naming/definition, not semantics. Keep all links relative `.md` links; index.md files must have no frontmatter; do not add frontmatter-bearing new files (none are needed). Preserve markdown table column counts when editing rows (use `·` separators, never `|`, inside cells).

### REM-011 (for GAP-008)

- **Finding** (cand-10, P3, MED, votes uphold/uphold/uphold): The Nitric parity tables claim 'secret (versioned)' parity backed by `wasi:config`/`hobo:secrets`, but `hobo:secrets` is not defined in the canonical interface catalog and no secret-versioning semantics (Nitric's put->version, access latest/specific version) exist anywhere in the design suite — the secret resource has only `put`/`access` verbs with no version model.
- **Evidence:** `docs/competitors/nitric.md:311` · `docs/design/authoring-resources-wiring.md:42` · `docs/design/authoring-resources-wiring.md:225` · `docs/design/wasm-runtime-wit.md:151`
- **Effort:** M · **Delivery:** ✔ [HOBO-676](https://linear.app/quickdeploy-ai/issue/HOBO-676) — ADR-0113 in `docs/design/adr/02-identity-security.md`; `hobo:secrets` canonical definition in `docs/design/wasm-runtime-wit.md`

**Action**

Remediation for cand-10 — Option A of the sketch: DEFINE `hobo:secrets` as a thin versioned-secrets extension over `wasi:config/store` so the "secret (versioned)" ✅ parity rows become true. Chosen over dropping the claim because the `hobo:secrets` alias is already load-bearing in four tables (docs/competitors/nitric.md:311, docs/competitors/dapr.md:52, docs/design/authoring-resources-wiring.md:42 and :71) and Plan 21 (authoring-resources-wiring.md:225) already commits to a managed `secret()` store resource distinct from `secretRef`. All edits are docs-only; NO new doc file is created, so no new OKF frontmatter is needed.

1. C:/src/hobo/docs/design/adr/02-identity-security.md — ADD one new ADR section at the end of the file (this theme owns secrets: ADR-0023, ADR-0027, ADR-0038 live here). Use the NEXT FREE GLOBAL ADR ID: read the max ID from the table in docs/design/adr/index.md and take max+1 — do not guess and never renumber existing ADRs. Heading `## ADR-00XX` (anchor `#adr-00xx`), title "Versioned managed secrets: `hobo:secrets` as a version-model extension over `wasi:config/store`". Section outline (h3s, matching neighboring ADRs):
   - "Context" — Nitric's secret API is versioned (put returns a version; access reads latest or a pinned version); HoBo's parity tables claim `wasi:config`/`hobo:secrets` ✅ but the Plan 20 interface catalog defines no `hobo:secrets` and no version model; `wasi:config/store` is a flat latest-value read surface.
   - "Decision" — define `hobo:secrets@0.1.0` (stability tier `experimental` per ADR-0075) as the WIT port behind the `secret(name)` catalog resource: `put(name, value) -> version-id`; `access(name) -> (version-id, value)` (latest); `access-version(name, version-id) -> value` (pinned); `list-versions(name) -> list<version-id>`. `wasi:config/store` remains the read-only latest-value view for config-style consumption. `.allow()` verb set stays exactly `put`,`access` — version pinning is an argument to access, not a new verb, so IAM/link/token inference (Plan 21's three effects) is unchanged. `secret.Accessed` audit events carry the resolved version-id. Cloud equivalence: AWS Secrets Manager version stages / Azure Key Vault secret versions / GCP Secret Manager versions.
   - "Relationship to secretless-first" — `secret()`/`hobo:secrets` is the Nitric-parity managed-store surface, NOT a new default; `fromBinding`/`secretRef` and SVID-brokered tokens (ADR-0008/0023/0027) remain the default path; state this explicitly.
   - "Consequences" — honest ✅ parity; one more `hobo:*` interface to conform; version model must survive provider mapping.
   - "Alternatives considered" — (a) drop the "(versioned)" claim and alias (rejected: alias already referenced by Nitric AND Dapr parity tables; Nitric parity is a P3 pillar target); (b) fold versioning into `wasi:config` (rejected: not in the standard's shape).
2. C:/src/hobo/docs/design/adr/index.md — add one row to the `## Index` table: `| 00XX | Versioned managed secrets: hobo:secrets over wasi:config/store | [identity-security](02-identity-security.md#adr-00xx) |`. This file has no YAML frontmatter — keep it that way.
3. C:/src/hobo/docs/design/traceability.md — add a row for `ADR-00XX` in the ADR coverage table (mirror the ADR-0084 row shape at line ~342): theme link `./adr/02-identity-security.md#adr-00xx`, coverage assertion "versioned put/access/list round-trip with pinned-version reads proven against the secrets port conformance suite", issue family: the Identity, Auth, Secrets & XAA epic family (reference the Linear issue created from this remediation once it exists, plus existing HOBO coverage listed for ADR-0027). Required or `scripts/validate-traceability.ts` fails on the missing ID.
4. C:/src/hobo/docs/design/wasm-runtime-wit.md (Plan 20) —
   a. Canonical catalog table (~line 127): change `| Secrets | wasi:config/store |` to `| Secrets | wasi:config/store + hobo:secrets (versioned) ([ADR-00XX](./adr/02-identity-security.md#adr-00xx)) |`.
   b. "Reused WASI interfaces" table (~line 151): amend the `wasi:config/store` row note to "config + latest-secret access; version model added by `hobo:secrets`".
   c. "HoBo-authored interfaces (`hobo:*`)" table (~lines 155–183): add row `| hobo:secrets | versioned managed secrets (Nitric parity) over wasi:config/store ([Plan 21](./authoring-resources-wiring.md#plan-21)/[ADR-00XX](./adr/02-identity-security.md#adr-00xx)) | put(name,value) -> version-id, access(name) -> latest, access-version(name,version), list-versions(name) |`.
   d. New h3 subsection after "Preview wasi:websocket + the hobo:websocket extension" (follow that precedent, ~line 201): `### hobo:secrets — versioned secrets over wasi:config ([ADR-00XX](...))` — 1 short paragraph (why: parity + audit-by-version; experimental tier; secretless-first unchanged) + a ~15-line ```wit fenced sketch of `package hobo:secrets@0.1.0;` with the four functions and `type version-id = string`.
5. C:/src/hobo/docs/design/authoring-resources-wiring.md (Plan 21) —
   a. Catalog row line 42: port cell → `wasi:config/store` + `hobo:secrets` (versioned); verbs cell → `put`,`access` *(access = latest or pinned version)*.
   b. Nitric building-block parity table row line 71: same port/verb cell update.
   c. Under "### Configuration & secretless secrets" (after the `secretRef` bullet, ~line 225): add one paragraph "**Versioned managed secrets (`secret()` + `hobo:secrets`).**" — put yields a new version, access reads latest or a pinned version, `secret.Accessed` records the version-id, and this is the parity/managed-store surface while secretless brokering stays the default; link `[Plan 20](./wasm-runtime-wit.md#plan-20)` and the new ADR.
6. C:/src/hobo/docs/competitors/nitric.md line 311 — update the row to `| `secret` (versioned) | `wasi:config/store` + `hobo:secrets` (put -> version, access latest|pinned) | ✅ |` so the claim points at the now-defined port; the section-level link to Plan 21 at line 318 already covers the doc pointer.
7. C:/src/hobo/docs/competitors/dapr.md line 52 — extend the row's link cell to also cite `[Plan 20](../design/wasm-runtime-wit.md#plan-20)` next to the existing Plan 21 link (the port now has a canonical home).
8. C:/src/hobo/GAPS.md — per register rules (remediations documented, not applied): add/update the cand-10 row in "## Gap register" with Status 🧯 and Remediation column pointing to the new ADR anchor (`docs/design/adr/02-identity-security.md#adr-00xx`) and this file list; append the finding to the current iteration's log section.

**Acceptance**

- [ ] `hobo:secrets` has a canonical definition in docs/design/wasm-runtime-wit.md: a row in the hobo:* interfaces table, updated Secrets rows in the canonical-catalog and reused-WASI tables, and a WIT sketch subsection with put->version-id, access (latest), access-version (pinned), list-versions.
- [ ] New ADR exists in docs/design/adr/02-identity-security.md under the next free global ID (taken from the max in docs/design/adr/index.md, not guessed); no existing ADR renumbered or edited.
- [ ] docs/design/adr/index.md gains exactly one index row for the new ADR and still has NO YAML frontmatter.
- [ ] docs/design/traceability.md gains an ADR-00XX row with a testable coverage assertion (validate-traceability requires every indexed ADR present and no gaps up to the max ID).
- [ ] .allow() verbs for secret remain exactly put,access in both Plan 21 tables; version pinning documented as an access argument.
- [ ] docs/competitors/nitric.md:311 and docs/competitors/dapr.md:52 rows link to the defined port; all relative links resolve (nitric/dapr use ../design/ prefixes; design-suite files use ./ and ./adr/ prefixes).
- [ ] GAPS.md cand-10 row status is 🧯 with the remediation pointer; no rows deleted or renumbered.
- [ ] Runnable checks pass from repo root:
  - `pnpm run docs:okf`
  - `pnpm agent:check -- --staged` (with the edits staged — this also triggers the traceability gate because docs/design/adr/ is touched, per scripts/relevant-check-policy.ts)
  - `node --import tsx scripts/validate-traceability.ts` (the traceability gate directly — there is no dedicated pnpm alias; this is the real script wired into agent:check)
  - optional belt-and-braces: `pnpm run docs:design-lint`

**Guardrails**

Documentation-level only: no .wit files, no code under src/, no changes to .agents//.claude//scripts/. Do not reverse or re-litigate the Nomad->wasmCloud pivot. Never renumber existing ADRs; the new ADR takes the next free global ID read from docs/design/adr/index.md at edit time. Do not weaken secretless-first (ADR-0008/0023/0027): the ADR must explicitly frame hobo:secrets as the parity/managed-store surface, with fromBinding/secretRef brokering staying the default — do not present versioned secrets as the recommended path. Do not add verbs beyond put,access (would ripple through IAM/link/token-inference prose in Plan 21 and Plan 6). Mark hobo:secrets stability `experimental` and pin `hobo:secrets@0.1.0` per the ADR-0075 tier/versioning conventions already in Plan 20. index.md files must have no frontmatter; existing non-index files touched here already carry OKF frontmatter — do not remove or alter their `type:` fields. Keep every cross-doc link relative and verify anchors (#plan-20, #plan-21, #adr-00xx) resolve. In GAPS.md, only append/update — IDs are stable, rejected/confirmed rows are never deleted.

### REM-012 (for GAP-009)

- **Finding** (cand-11, P3, MED, votes uphold/uphold/uphold): The api resource's `.allow()` column says 'route-level security' (its only verb model) and nitric.md claims parity, but no design text specifies the per-route security authoring surface — Nitric's oidcRule/securityRule-per-route and middleware equivalents are unspecified, and the referenced `hobo:http` extension port is likewise undefined in the canonical interface catalog.
- **Evidence:** `docs/design/authoring-resources-wiring.md:37` · `docs/design/authoring-resources-wiring.md:65` · `docs/competitors/nitric.md:146` · `docs/competitors/nitric.md:306`
- **Effort:** M · **Delivery:** [HOBO-677](https://linear.app/quickdeploy-ai/issue/HOBO-677) (Intent-Alignment Gap Remediation project)

**Action**

All changes are amendments to existing docs — no new files, so no new OKF frontmatter is needed. Reuse the `auth()` port (Plan 6 §6.7) as the single auth machinery; do NOT invent a Nitric-style parallel `oidcRule` object. Resolve the `hobo:http` dangling reference by DEFINING it (the `hobo:websocket` thin-extension precedent, ADR-0075), not removing it — removal would orphan `docs/design/authoring-resources-wiring.md:37`, `:65` and `docs/competitors/nitric.md:306`.

1) `docs/design/adr/02-identity-security.md` — append a new ADR section at the END of the file, using the next free global ADR ID (0105 at time of writing; confirm by checking the highest `## ADR-NNNN` across the four theme files before assigning; NEVER renumber existing ADRs). Heading `## ADR-<next>` + bold title: "Route-level API security via the auth() port; hobo:http as the thin routing/security extension over wasi:http". Use the h3 Context/Decision/Consequences shape (match ADR-0023 in the same file):
   - ### Context — Plan 21's catalog rows (authoring-resources-wiring.md:37, :65) name "route-level security" as the api resource's only verb model and nitric.md claims parity, but no design text specifies the per-route security authoring surface (Nitric's oidcRule/securityRule-per-route and `.use()` middleware have no HoBo equivalent), and the referenced `hobo:http` port is undefined in Plan 20's canonical interface catalog. The policy plane already presumes an "auth middleware" obligation exists (contracts-policy-flags.md:137, walkthrough.md:612, glossary.md:50 "Obligation").
   - ### Decision — five numbered points: (1) an `api()` declares its security by BINDING the `auth()` port (Plan 6 §6.7), api-level default + per-route override — e.g. `api("main", { security: appAuth })`; per-route: route options `{ auth: appAuth.require({ audience, claims }) }` or explicit `{ auth: "public" }` opt-out; Nitric's `oidcRule({audiences, issuer})` maps to `auth.oidc(...)` provider declarations, `securityRule('name')`-per-route maps to the per-route binding. (2) A middleware seam — `app.use(fn)` and per-route middleware as ordinary handler composition; the policy plane's "require auth middleware" obligation (Plan 29) targets this seam. (3) Lowering: route security lands in the manifest IR as per-route entries under the api resource — sketch `"routes": [{ "method", "path", "security": { "authRef": "appAuth", "audience", "claims" } | "public" }]` — consumed by the gateway adapter (edge enforcement) and by `hobo:http` (in-component verify → `ctx.user` via `hobo:auth.verify`); deny-by-default: a route with neither a route rule nor an api-level default is `exposes: public` and the policy plane may mutate (attach auth middleware) or deny it at plan time. (4) `hobo:http` is a thin extension over `wasi:http` (same pattern as `hobo:websocket`/ADR-0075): route registration metadata, per-route security binding, middleware chain, principal binding. (5) Unlike Nitric (security rules not enforced in local dev — a documented Nitric gap), HoBo route rules ARE enforced in `hobo dev` via the ADR-0070 contract-asserted dev principal.
   - ### Consequences — (+) closes the Nitric parity gap with a strictly stronger local-dev story; one auth machinery (no duplicate oidcRule surface); route security is auditable in the manifest IR. (−) every gateway/provider adapter must honor per-route rules; `hobo:http` becomes a versioned WIT interface to maintain.

2) `docs/design/authoring-resources-wiring.md` (Plan 21) — insert a new h3 section `### Route-level API security` immediately after the "### Handlers, events & triggers (parity with Nitric \"services\")" section (i.e., between current lines 117 and 119). Outline:
   - (intro paragraph) — the api resource's verb model is route-level security, defined here; links to the new ADR and Plan 6 §6.7.
   - **Declaring security (api-level default, per-route override)** — TS code sample: `const app = api("main", { security: appAuth }); app.get("/protected", handler); app.get("/health", { auth: "public" }, handler); app.post("/admin", { auth: appAuth.require({ claims: { role: "admin" } }) }, handler);` — one sentence on the Nitric oidcRule/securityRule mapping.
   - **Middleware seam** — `app.use(fn)` / per-route middleware; note this is the "auth middleware" obligation target ([Plan 29](./contracts-policy-flags.md#plan-29)).
   - **Lowering to the manifest IR** — jsonc sketch of per-route `security` entries under the api resource (mirror the ADR sketch); note gateway + `hobo:http` enforcement points ([Plan 20](./wasm-runtime-wit.md#plan-20)).
   - **Deny-by-default and local dev** — unannotated route with no api default = `exposes: public` → policy mutate/deny at plan time; enforced in `hobo dev` (ADR-0070), unlike Nitric.
   Also amend the two catalog cells: line 37 and line 65 — change `route-level security` to `route-level security (below)` linking `#route-level-api-security`, and append the new ADR link in the line-37 row's equivalence column or the cell itself (match the style of other rows that cite ADRs).

3) `docs/design/wasm-runtime-wit.md` (Plan 20) — two edits: (a) in the "HoBo-authored interfaces (`hobo:*`)" table, insert a `hobo:http` row adjacent to `hobo:websocket` (current line 164): Purpose = "**thin extension** over `wasi:http` (new-ADR link; same pattern as `hobo:websocket`/ADR-0075) — route registration + per-route security the bare interface won't carry ([Plan 21](./authoring-resources-wiring.md#plan-21))"; Key functions = "`route(method,path,opts)` registration metadata, per-route `require-auth(auth-ref,audience,claims)`/`public`, middleware chain, `ctx.user` binding via `hobo:auth.verify`". (b) In the building-block table, amend line 121 `| APIs / HTTP | wasi:http/incoming-handler, .../outgoing-handler |` to append `(+ hobo:http)` so Plan 20's catalog matches Plan 21's rows 37/65.

4) `docs/design/ai-native-agent-auth.md` (Plan 6 §6.7) — under "**Client & server surface.**" (after the "Server:" bullet, current line 229) add one bullet: "**Route-level enforcement:** the `api()` resource binds this `auth()` port per api/route — authoring surface and manifest-IR lowering owned by [Plan 21](./authoring-resources-wiring.md#route-level-api-security) (new-ADR link); route rules are enforced in `hobo dev` via the contract-asserted dev principal ([ADR-0070](./adr/02-identity-security.md#adr-0070))." Do not restate Plan 21 content — Plan 6 owns verification/principal semantics, Plan 21 owns the authoring surface.

5) `docs/design/adr/index.md` — add one row to the Index table in numeric order: `| <next-id> | Route-level API security via the auth() port; hobo:http thin extension over wasi:http | [identity-security](02-identity-security.md#adr-<next-id>) |`. This file must remain WITHOUT frontmatter (it has none today — keep it that way).

6) `docs/design/traceability.md` — add an `ADR-<next-id>` row to the ADR table right after the ADR-0104 row (line ~362), format: `| ADR-<next-id> | [identity-security](./adr/02-identity-security.md#adr-<next-id>) | Route-level API security is covered by api/route auth-binding authoring, manifest-IR route-security lowering, hobo:http conformance, and local-dev enforcement slices. | <HOBO-N of the Linear issue this remediation becomes; interim: HOBO-34, HOBO-63 auth slice family> |`. Also update the prose at line ~370 "Explicit numbering gaps through `ADR-0104`" to name the new max ID. Keep the "Accepted / current" status statement intact (the validator greps for it).

7) `docs/competitors/nitric.md` — in the "Permissions, security, providers" mapping table (lines ~322-329): amend the "OIDC API auth" row (line 325) HoBo-doc column to also cite `[21](../design/authoring-resources-wiring.md#route-level-api-security)` and the new ADR; add one new row `| oidcRule/securityRule per route + .use() middleware | api/route security via the auth() binding + middleware seam; **enforced in local dev** (Nitric's is not) | ➕ | [21](../design/authoring-resources-wiring.md#route-level-api-security), [06](../design/ai-native-agent-auth.md#plan-06) |`. Line 306 (`api` → `hobo:http`/`wasi:http`) needs no text change — it becomes valid once Plan 20 defines the port.

8) `GAPS.md` — when the cand-11 register row exists on this branch, flip its status to 🧯 (remediation documented) and link the Linear issue; do not apply the doc edits in the same pass that records the remediation.

**Acceptance**

Checklist (run from repo root, C:/src/hobo):
1. `pnpm run docs:okf` — passes; all touched docs keep valid OKF frontmatter with non-empty `type:` (no new files, so no new frontmatter; `docs/design/adr/index.md` still has NO frontmatter).
2. Stage all touched files, then `pnpm agent:check -- --staged` — passes. Because `docs/design/adr/**` and `docs/design/traceability.md` are staged, this triggers the traceability gate.
3. Traceability gate directly (the real command — there is no dedicated package.json script; relevant-check-policy.ts invokes it): `node --import tsx scripts/validate-traceability.ts` — passes: the new ADR-<next-id> appears in both `docs/design/adr/index.md` and `docs/design/traceability.md`, no undocumented numbering gap, and the "Accepted / current" statement is intact.
4. Grep checks: `hobo:http` now resolves — `grep -n "hobo:http" docs/design/wasm-runtime-wit.md` shows the new interface-table row; both Plan 21 cells (authoring-resources-wiring.md:37, :65) link `#route-level-api-security`; the anchor `### Route-level API security` exists in authoring-resources-wiring.md; `docs/design/ai-native-agent-auth.md` §6.7 contains the "Route-level enforcement" bullet linking that anchor.
5. Exactly one new `## ADR-` heading was added (next free global ID, appended to `docs/design/adr/02-identity-security.md`); no existing ADR ID changed — verify with `git diff -U0 docs/design/adr/ | grep "^-## ADR-"` returning nothing.
6. Cross-links to update (all relative .md links, verified by step 2's staged lint lane): docs/design/adr/index.md (new row), docs/design/traceability.md (new ADR row + max-ID prose), docs/competitors/nitric.md (line-325 row + one new mapping row), docs/design/ai-native-agent-auth.md (§6.7 bullet), docs/design/wasm-runtime-wit.md (lines ~121 and ~164), docs/design/authoring-resources-wiring.md (lines 37, 65 + new section).
7. Content assertions a reviewer can check in <5 min: the new Plan 21 section answers (a) how a route declares its security requirement (api-level default + per-route override + public opt-out), (b) the middleware seam and its identity with the Plan 29 "auth middleware" obligation, (c) how it lowers to the manifest IR (per-route `security` entries) and where it is enforced (gateway + hobo:http), (d) that rules are enforced in `hobo dev` (differentiating from Nitric's documented local-enforcement gap).

**Guardrails**

Documentation-level only: no code, no .wit files, no schema/scripts changes. Never renumber or edit existing ADR IDs; the new ADR takes the next free global ID (0105 at time of writing — re-verify the highest `## ADR-NNNN` across the four theme files before assigning) and goes in `docs/design/adr/02-identity-security.md` (identity/security theme). Do not reverse or re-litigate the Nomad→wasmCloud pivot. Do not create a parallel Nitric-style `oidcRule` authoring object — route security must bind the existing `auth()` port (Plan 6 §6.7) so there is one auth machinery. Define `hobo:http` rather than removing the reference (removal orphans Plan 21 rows 37/65 and nitric.md:306); model it on the `hobo:websocket` thin-extension precedent (ADR-0075). Plan 21 owns the authoring surface + IR lowering; Plan 6 owns verification/principal semantics — cross-link, never duplicate prose. Keep all links relative `.md` links with kebab-case anchors matching actual headings. `docs/design/adr/index.md` and other index.md files must have no YAML frontmatter. Do not edit `_generated/` or archived requirements. Commit as a conventional scoped docs commit; remediation is documented on the branch, not merged/applied to close the gap in the same pass.

### REM-013 (for GAP-010)

- **Finding** (cand-12, P4, MED, votes uphold/uphold/uphold): The design's own FinX surface and FinOps Framework baseline promise 'forecasts, anomaly signals, commitments, and optimization recommendations', but no design doc specifies how cost anomalies/trends/forecasts are detected or computed, no cost-anomaly/forecast event family exists (event-families.md has only credit.*/meter.*/spend.*), and 'rightsizing' appears nowhere in the repo; the only cost-reactive mechanisms are threshold breakers.
- **Evidence:** `docs/design/finops-budget-routing-control-plane.md:128` · `docs/design/finops-budget-routing-control-plane.md:51` · `docs/design/event-families.md:77` · `docs/design/reliability-observability-cost.md:238` · `docs/design/operators-sre.md:121`
- **Effort:** M · **Delivery:** [HOBO-678](https://linear.app/quickdeploy-ai/issue/HOBO-678) (Intent-Alignment Gap Remediation project)

**Action**

Close gap cand-12 by specifying the FinOps advisory plane (anomaly detection, forecasts, rightsizing/commitment recommendations) at design level, with an owning mechanism and a `cost.*` event family. Documentation only — amend 7 existing files, create no new files. Do the steps IN THIS ORDER (the event-family catalog must gain the row before any other doc uses the names, or `docs:design-lint` fails).

STEP 0 — pick the ADR ID. Open `docs/design/adr/index.md`, find the highest numbered row (ADR-0104 at drafting time), and use the next free global ID (call it ADR-0NNN below; do NOT renumber or edit any existing ADR).

STEP 1 — `docs/design/event-families.md`: insert one table row between the `contract.*` and `credit.*` rows (alphabetical):
`| \`cost.*\` | \`cost.AnomalyDetected\`, \`cost.AnomalyResolved\`, \`cost.ForecastUpdated\`, \`cost.RecommendationIssued\` |`

STEP 2 — `docs/design/adr/02-identity-security.md` (theme file that owns ADR-0039 metering/cost and ADR-0045 SLO/alerting): append a new `## ADR-0NNN` section after `## ADR-0104` (which ends near line 609), following the house style of ADR-0104 (bold one-line title, then `### Context` / `### Decision` / `### Consequences`):
- Title line: **FinOps advisory plane: cost anomaly detection, forecasting & rightsizing as deterministic MeteringView projections emitting advisory `cost.*` facts.**
- `### Context` — The FinX surface and FinOps Framework standards baseline promise "budgets, forecasts, attribution, anomaly signals, commitments, and optimization recommendations" ([finops-budget-routing-control-plane.md](../finops-budget-routing-control-plane.md) Product Surfaces + Standards Baseline), and a `Forecast` contract shape already exists there; but no design doc specified how anomalies/forecasts are computed, no `cost.*` event family existed, "rightsizing" appeared nowhere, and the only cost-reactive mechanisms were threshold breakers/degradation tiers ([ADR-0039](#adr-0039)).
- `### Decision` — numbered: (1) a **`FinOpsAdvisoryView` projection** (data-plane projection pattern, [Plan 11](../data-plane.md#plan-11)) folds the existing `MeteringView` counters at a pinned `seq` (same pinned-snapshot replayability discipline as [ADR-0071](./01-architecture-core.md#adr-0071)) into per-dimension, per-attribution-scope (tenant→Camp→Bindle) rolling baselines and spend velocity — no new instrumentation; (2) **anomaly detection** is a deterministic rule — current-window spend deviating from the rolling baseline beyond a policy-configured band emits `cost.AnomalyDetected` (carries dimension, scope, baseline, observed value, ledger seq); recovery emits `cost.AnomalyResolved`; anomalies route through existing `alert.*`/incident paths, never auto-remediate; (3) **forecasts** extrapolate spend velocity to period end per budget scope (the `Forecast` shape from the FinOps control-plane contract) and emit `cost.ForecastUpdated`, feeding the policy plane's "do we cross tier N before period end" question; (4) **rightsizing and commitment recommendations** are advisory `cost.RecommendationIssued` facts comparing observed utilization against the provisioned Workload Profile and `cost.json` unit prices (rightsizing = smaller profile / scale-to-zero candidates; commitments = savings-plan/reserved-capacity opportunities); they are applied only through the Crew/SRE propose branch as gated Deltas/obligations ([Plan 40](../operators-sre.md#plan-40)), never auto-purchased or auto-resized; (5) the built-in deterministic detector/forecaster is the default; smarter models are an optional `finops-engine` behind a port (engines-behind-ports pattern, [ADR-0054](./03-data-plane.md#adr-0054)); the `cost.*` facts remain the contract either way; (6) enforcement stays with the existing breakers/degradation tiers ([ADR-0039](#adr-0039)) — this plane observes, predicts, and proposes only.
- `### Consequences` — (+) FinX promises now trace to a named mechanism, owner, and replayable facts; (+) reuses MeteringView, so every advisory figure traces to logged facts; (−) the built-in window-based detector will miss seasonality — sophisticated detection is deferred to the engine port; (−) one more projection and event family to maintain.

STEP 3 — `docs/design/adr/index.md`: add one row at the bottom of the Index table:
`| 0NNN | FinOps advisory plane: cost anomaly detection, forecasting & rightsizing as deterministic MeteringView projections (advisory \`cost.*\` facts, gated proposals only) | [identity-security](02-identity-security.md#adr-0nnn) |`

STEP 4 — `docs/design/traceability.md`: (a) add a row after the ADR-0104 row (~line 362): `| ADR-0NNN | [identity-security](./adr/02-identity-security.md#adr-0nnn) | Cost anomaly detection, forecasting, and rightsizing/commitment recommendations are deterministic MeteringView projections emitting advisory cost.* facts; recommendations are gated Crew proposals, never auto-applied; enforcement remains with ADR-0039 breakers/tiers. | HOBO-<id of the Linear issue created for this remediation> |`; (b) in the "ADR Numbering and Status Audit" section (~line 370), change "Explicit numbering gaps through `ADR-0104`" to name the new max ADR ID (the gap ID list itself is unchanged).

STEP 5 — `docs/design/reliability-observability-cost.md`: insert a new `####` subsection between "#### Cost-driven graceful degradation & availability" (ends line 236) and "#### Optional dimensions" (line 238), heading exactly: `#### FinOps advisory plane: anomaly detection, forecasts & rightsizing ([ADR-0NNN](./adr/02-identity-security.md#adr-0nnn))`. Content: an intro line (advisory vs enforcement split — breakers/tiers above enforce; this plane observes, predicts, proposes) plus five bullets mirroring the ADR decisions: **`FinOpsAdvisoryView` projection** (deterministic fold over `MeteringView` at pinned seq, rebuildable from zero); **Anomaly detection** (`cost.AnomalyDetected`/`cost.AnomalyResolved`, deterministic baseline-deviation rule, routes via `alert.*`/incident, never auto-remediates); **Forecasts** (`cost.ForecastUpdated`, spend-velocity extrapolation per budget scope, feeds the tier-crossing policy question above and the FinX surface); **Rightsizing & commitment recommendations** (`cost.RecommendationIssued`, utilization vs Workload Profile + `cost.json`; gated propose-only path); **Engine behind a port** (optional `finops-engine`). Then edit the "#### Optional dimensions" bullet "**Commitment optimization**" (line 240) to end with a cross-reference: "…surfaced as `cost.RecommendationIssued` facts via the FinOps advisory plane above."

STEP 6 — `docs/design/finops-budget-routing-control-plane.md`: after the FinX bullet in "## Product Surfaces" (line 131-132), add one paragraph: "The FinX forecasts, anomaly signals, and optimization recommendations are the advisory `cost.ForecastUpdated`, `cost.AnomalyDetected`, and `cost.RecommendationIssued` facts computed by the FinOps advisory plane ([Plan 5](./reliability-observability-cost.md#plan-05), [ADR-0NNN](./adr/02-identity-security.md#adr-0nnn)); FinX reads them alongside the `DecisionGraph` rather than inventing a separate computation."

STEP 7 — `docs/design/operators-sre.md`: add one row to the "Runtime failure-taxonomy → safe-fix map" table, after the "**Cost-induced degradation**" row (line 122): `| **Cost anomaly** (spend deviates from baseline) | \`cost.AnomalyDetected\` | SRE *proposes* rightsizing/commitment remediation as a gated obligation ([ADR-0NNN](./adr/02-identity-security.md#adr-0nnn)); enforcement stays with breakers/tiers ([ADR-0039](./adr/02-identity-security.md#adr-0039)) |`

STEP 8 — `docs/design/glossary.md`: add two alphabetically-placed rows to the term table: `| FinOps advisory plane | Deterministic MeteringView projections that emit advisory cost anomaly, forecast, and rightsizing/commitment recommendation facts; it proposes through gated obligations and never enforces. |` and `| Rightsizing | Advisory recommendation to shrink or scale-to-zero an over-provisioned workload, derived from observed utilization versus the provisioned Workload Profile and applied only through gated proposals. |`

**Acceptance**

Checklist (run from C:/src/hobo):
1. `pnpm run docs:okf` — passes (only existing OKF-frontmattered docs amended; no new files, no index.md frontmatter added).
2. `pnpm run docs:design-lint` — passes; this is the gate that fails if `cost.AnomalyDetected` / `cost.ForecastUpdated` / `cost.RecommendationIssued` / `cost.AnomalyResolved` are used anywhere in docs/design without the `cost.*` row in `docs/design/event-families.md`.
3. `node --import tsx scripts/validate-traceability.ts` — the real traceability gate (there is no `pnpm run traceability` script; it is wired via `scripts/relevant-check-policy.ts:149` and fires from agent:check whenever `docs/design/adr/**` or `docs/design/traceability.md` changes). Must report the new ADR count with 0 failures — it fails if ADR-0NNN is in `docs/design/adr/index.md` but missing from `docs/design/traceability.md`.
4. `git add -A` then `pnpm agent:check -- --staged` — passes (auto-includes the traceability check plus staged doc linters/link checks).
5. `rg -i "rightsizing" docs/design | wc -l` returns >= 3 (reliability-observability-cost.md, adr/02-identity-security.md, glossary.md at minimum) — closes the "rightsizing appears nowhere" claim.
6. `rg "cost\.AnomalyDetected" docs/design/event-families.md` returns exactly the new catalog row.
7. `git diff main -- docs/design/adr/index.md` shows exactly one added row and zero modified/removed existing ADR rows (no renumbering).
Cross-links that must exist and resolve (all relative): reliability-observability-cost.md -> ./adr/02-identity-security.md#adr-0nnn; finops-budget-routing-control-plane.md -> ./reliability-observability-cost.md#plan-05 and ./adr/02-identity-security.md#adr-0nnn; operators-sre.md -> ./adr/02-identity-security.md#adr-0nnn; adr/index.md row -> 02-identity-security.md#adr-0nnn; traceability.md row -> ./adr/02-identity-security.md#adr-0nnn (validate-traceability.ts checks traceability links exist on disk). Hub/index files gaining entries: docs/design/adr/index.md (new ADR row), docs/design/traceability.md (new ADR row + updated max-ID line), docs/design/event-families.md (new family row), docs/design/glossary.md (two term rows). docs/design/index.md needs NO change (no new doc created).

**Guardrails**

Documentation-level only: touch nothing outside docs/design/. Do not create new files — every change amends an existing doc, so no new OKF frontmatter is needed; never add frontmatter to any index.md. Never renumber, edit, or move existing ADR sections; ADR-0NNN is the next free global ID read from docs/design/adr/index.md at execution time (0105 if the max is still 0104) and lives only in docs/design/adr/02-identity-security.md. Do the event-families.md edit first — docs:design-lint rejects any backticked event name not in the catalog. The advisory plane is observe/predict/propose only: do not weaken or replace the existing enforcement mechanisms (spend circuit breaker, degradation tiers, ADR-0039) and do not introduce auto-purchase/auto-resize behavior anywhere. Do not add new event families beyond `cost.*`, no new Crew operator row, and no new SDK surface. The Nomad->wasmCloud pivot is accepted — do not touch runtime/host decisions. Keep all links relative .md links; do not use bare URLs to repo files. Do not edit generated files or src/; do not mark the Linear issue done — this entry only documents the remediation.

### REM-014 (for GAP-011)

- **Finding** (cand-13, P4, MED, votes uphold/uphold/uphold): The ADR-0054 Crew roster (SRE, Endpoint Monitor, GitOps, Platform Engineer, UX Designer, SWE) contains no FinOps/cost-optimization operator, and the FinX advisory outputs (forecasts, anomaly signals, commitments, optimization recommendations) plus the 'commitment optimization' advisory have no named owner — a hole at the intersection of the FinOps and agent-native pillars.
- **Evidence:** `docs/design/adr/03-data-plane.md:230` · `docs/design/operators-sre.md:46` · `docs/design/finops-budget-routing-control-plane.md:128` · `docs/design/reliability-observability-cost.md:240` · `docs/design/usage-metering.md:35`
- **Effort:** M · **Delivery:** [HOBO-679](https://linear.app/quickdeploy-ai/issue/HOBO-679) (Intent-Alignment Gap Remediation project)

**Action**

REM for cand-13 — add a **FinOps operator to the Crew** (sketch option 1) as a new ADR plus roster/ownership amendments. All paths relative to repo root C:/src/hobo.

**1. `docs/design/adr/03-data-plane.md` — new ADR section (appended at end of file, after ADR-0099).**
Heading `## ADR-<next-free>` — use the next free global ADR ID = max existing + 1. Verify with `rg -o "ADR-[0-9]{4}" docs/design/adr/ | sort -u | tail -3` before writing (ADR-0100 at drafting time; re-verify, never renumber existing ADRs). Title: **"FinOps operator (the Crew's cost specialist): advisory-only ownership of the FinX outputs and commitment optimization."** Section outline (match ADR-0054/0058 house style):
- `### Context` — HoBo has the FinOps substrate (MeteringView/showback [ADR-0039](02-identity-security.md#adr-0039), CreditLedgerView/Dispatcher [ADR-0071](01-architecture-core.md#adr-0071), spend circuit-breaker + costAvailabilityProfile [Plan 5](../reliability-observability-cost.md#plan-05), the FinX surface [FinOps Budget Routing Control Plane](../finops-budget-routing-control-plane.md)) but the ADR-0054 Crew roster names no cost operator; the FinX advisory outputs (forecasts, anomaly signals, commitments, optimization recommendations) and the "Commitment optimization" advisory have no named owner.
- `### Decision` — 4 numbered points: (1) add **FinOps** to the ADR-0054 roster on the unchanged shared model (SVID principal, per-agent policy + spend caps, engine behind a `finops-engine` port with built-in default, sandboxed under ADR-0061 governance); (2) it **owns** forecasts, anomaly signals, commitment/savings-plan recommendations, and optimization proposals — the FinX surface outputs and the reliability-observability-cost.md "Commitment optimization" advisory; (3) **advisory-only and off-path**: reads MeteringView/CreditLedgerView/DecisionGraph projections autonomously; every write is a gated Delta/PR or require-approval obligation (Plan 29); it never auto-purchases commitments and never sits on the deterministic Matching/Dispatcher path — cite [ADR-0071](01-architecture-core.md#adr-0071) point 3's off-path advisory layer and ADR-0033 determinism; (4) boundaries: SRE keeps `spend.DegradationRequired` enforcement, Endpoint Monitor keeps signal emission, Platform Engineer keeps Resource Definitions; FinOps escalates via `crew.HandoffRequested`; **no new event families** (rides `crew.*`/`spend.*`/`policy.Decided`).
- `### Consequences` — (+) every FinX advisory output has a named, audited, policy-gated owner; (−) one more trust surface in the roster; recommendation quality bounded by best-effort credit/usage reconciliation (ADR-0071 point 6).

**2. `docs/design/adr/03-data-plane.md` — amend ADR-0054 Decision point 1 roster list (~line 236, after the SWE bullet):** add bullet `- **FinOps** → cost forecasts + anomaly signals + commitment/optimization recommendations, advisory-only via gated Deltas ([ADR-<next-free>](#adr-<next-free>)).`

**3. `docs/design/operators-sre.md` (Plan 40) — four edits:**
- Mermaid CREW subgraph (~line 29–44): add node `FIN["FinOps"]` and edge `FIN -->|forecast / anomaly / commitment / optimization proposals| ADV["FinX advisory outputs -> gated Deltas (ADR-0039/0071)"]`.
- Roster table (~line 47): new row `| **FinOps** | forecasts · anomaly signals · commitment recommendations · optimization proposals (**advisory-only**) | MeteringView + showback ([ADR-0039](./adr/02-identity-security.md#adr-0039)), CreditLedgerView + off-path Dispatcher advisory ([ADR-0071](./adr/01-architecture-core.md#adr-0071)), spend breaker + costAvailabilityProfile ([Plan 5](./reliability-observability-cost.md#plan-05)), FinX surface ([FinOps control plane](./finops-budget-routing-control-plane.md)) | external cost-recommendation engine behind a port | MCP forecast/recommend-commitment/propose-optimization; opens gated Deltas/PRs; rides crew.*/spend.*/policy.Decided; AI counterpart to the human FinOps-owner persona ([usage metering](./usage-metering.md)) |`
- Scope bullet (~line 73): extend the bold roster enumeration to `**SRE · Endpoint Monitor · GitOps · Platform Engineer · SWE · UX Designer · FinOps**`.
- Verification (~line 63–70): add bullet: FinOps recommends a savings-plan purchase → `crew.ActionProposed` + gated Delta with a require-approval obligation; it is never auto-purchased; the decision is replayable via `policy.Decided`.

**4. `docs/design/reliability-observability-cost.md` — "Optional dimensions" → "Commitment optimization" bullet (~line 240):** append owner: `— owned by the **FinOps operator** ([Plan 40](./operators-sre.md#plan-40), [ADR-<next-free>](./adr/03-data-plane.md#adr-<next-free>))`.

**5. `docs/design/finops-budget-routing-control-plane.md` — "Product Surfaces" section (~line 131):** after the FinX bullet add one sentence: the FinX outputs are owned/actioned by the **FinOps Crew operator** ([Plan 40](./operators-sre.md#plan-40), [ADR-<next-free>](./adr/03-data-plane.md#adr-<next-free>)), advisory-only, writes gated.

**6. `docs/design/glossary.md` (~line 51, "Operator Agents" entry):** add FinOps to the enumerated roster.

**7. `docs/design/adr/index.md` — Index table:** add row `| <next-free> | FinOps operator (Crew cost specialist): advisory-only ownership of FinX outputs & commitment optimization | [data-plane](03-data-plane.md#adr-<next-free>) |` in numeric order. (This file has NO frontmatter — keep it that way.)

**8. `docs/design/traceability.md`:** add row for the new ADR following the ADR-0098/0099 row format (~line 356): `| ADR-<next-free> | [data-plane](./adr/03-data-plane.md#adr-<next-free>) | <one-line statement> | HOBO-<this remediation's Linear issue id> |`.

**9. `GAPS.md`:** under `## Remediations` add `### REM-014` (Action = this entry, Acceptance, Effort M, Delivery link = the PR/Linear issue) and set the cand-13 gap-register row status to 🧯 remediation documented.

No new files are created; all touched docs already carry valid OKF frontmatter (do not add frontmatter to index.md files). Do NOT edit `docs/archive/**` (FR-080/TR-160 roster enumerations there are frozen history).

**Acceptance**

- [ ] New ADR section exists in `docs/design/adr/03-data-plane.md` with Context/Decision/Consequences, uses the next free global ID (max existing + 1; verified via `rg -o "ADR-[0-9]{4}" docs/design/adr/ | sort -u | tail -3`), and no existing ADR was renumbered or moved.
- [ ] ADR-0054 roster bullet, operators-sre.md mermaid + roster table + Scope enumeration + Verification bullet, reliability-observability-cost.md commitment-optimization owner, finops-budget-routing-control-plane.md FinX owner sentence, and glossary.md roster all name **FinOps** consistently and mark it advisory-only.
- [ ] Cross-links added both directions: new ADR ↔ Plan 40 (operators-sre.md), new ADR ↔ finops-budget-routing-control-plane.md, new ADR ↔ reliability-observability-cost.md; hub files gain links: `docs/design/adr/index.md` (new table row) and `docs/design/traceability.md` (new ADR row with a HOBO- issue ref). All links are relative `.md` links that resolve.
- [ ] `pnpm run docs:okf` passes (OKF frontmatter intact; no frontmatter added to index.md files).
- [ ] `pnpm agent:check -- --staged` passes with all changed files staged (touching `docs/design/adr/` makes it run the traceability gate).
- [ ] Traceability gate passes directly: `node --import tsx scripts/validate-traceability.ts` (this is the real gate — there is no dedicated pnpm script; it requires the new ADR ID in both `docs/design/adr/index.md` and `docs/design/traceability.md`, with no undocumented numbering gap — using max+1 avoids gap documentation).
- [ ] `GAPS.md` REM-014 recorded and cand-13 register row updated to 🧯 with the delivery link.

**Guardrails**

Documentation-only — no code, no `src/` changes. The FinOps operator is strictly **advisory/off-path**: it must never be placed on the deterministic Matching/Dispatcher selection path (would violate ADR-0033/ADR-0071 determinism) and must never auto-purchase commitments (reliability-observability-cost.md already says "advisory, never auto-purchased without approval" — preserve that wording). Reuse existing event families (`crew.*`, `spend.*`, `policy.Decided`); do not invent a `finops.*` event family or touch `docs/design/event-families.md` with new families. Never renumber or relocate existing ADRs; the new ADR goes only in `docs/design/adr/03-data-plane.md`. Do not edit `docs/archive/**` (frozen requirements). Do not reverse or re-litigate the Nomad→wasmCloud pivot (untouched by this change). Keep index.md files frontmatter-free; keep every added link relative and resolving.

### REM-015 (for DRIFT-004)

- **Finding** (cand-17, L-DRIFT, MED, votes uphold/uphold/uphold, drift-class deliberate-undocumented): ADR-0063 states there is 'no version ladder and no deferred-feature bucket in the design' and that delivery phasing is archived, yet docs/design/ now runs a full phased v1 release program (~90 Productization M0/M1 index rows, beta/RC/GA go-no-go gates, a self-described 'M0 traceability gate', known-limitations deferred/post-ga states, v1 critical-path blockers) whose M0-M4 taxonomy is defined only in the Linear backlog legend — ADR-0063 was never amended and no ADR records the productization-category/phase-gate decision or maps the archived stages 0-6 to M0-M4.
- **Evidence:** `docs/design/adr/07-portability-extensibility.md:277-282` · `docs/design/index.md:28-112` · `docs/design/go-no-go-decision-record.md:36-95` · `docs/design/traceability.md:10` · `docs/design/known-limitations-register.md:35-36`
- **Effort:** M · **Delivery:** [HOBO-680](https://linear.app/quickdeploy-ai/issue/HOBO-680) (Intent-Alignment Gap Remediation project)

**Action**

Amend five existing files; create no new files (so no new OKF frontmatter is needed). All edits are documentation-level.

1. `docs/design/adr/07-portability-extensibility.md` — add ONE new ADR section using the next free global ADR ID (= highest ID in `docs/design/adr/index.md` + 1; the index currently ends at ADR-0104 — verify at edit time; never fill a documented gap ID such as 0013/0016/0017/0020/0022/0029/0030/0065–0068). Insert the section after `## ADR-0103` (ends ~line 341) and before `## Open / proposed decisions (ADR-Pn)` (~line 342). Title heading `## ADR-NNNN` followed by a bold one-line decision statement (house style), then:
   - **Bold statement:** "Productization release program: the M0–M4 phase-gate model over the single designed scope." (1 line)
   - `### Context` — ADR-0063 states there is "no version ladder and no deferred-feature bucket in the design" and that delivery phasing is archived (`07-portability-extensibility.md:277-282`), yet docs/design/ now carries a phased v1 release program: ~90 "Productization M0/M1" index rows (`docs/design/index.md:28-112`), beta/release-candidate/GA go/no-go gates with M3/M4 evidence gates (`docs/design/go-no-go-decision-record.md:36-95`), a self-described "M0 traceability gate" (`docs/design/traceability.md:10`), and `deferred`/`post-ga` known-limitation states (`docs/design/known-limitations-register.md:35-36`) — while the M0–M4 taxonomy is defined only in the Linear backlog legend. No decision record covers the category or the phase model.
   - `### Decision` — five numbered items: (1) recognize the **productization/release-program document category** in docs/design/ ("Productization M0/M1 …" rows define release-readiness scope and acceptance evidence, not new platform capabilities); (2) define the canonical **M0–M4 taxonomy inside the design**: `M0` Contracts → `M1` Skeleton → `M2` Core → `M3` Hardening → `M4` GA; (3) the **phase-gate rule**: M0 acceptance blocks all M1–M4 work (M1–M4 are blocked by the HOBO-521 M0 acceptance record); beta/RC/GA go/no-go decisions attach to M3 (release candidate, HOBO-468) and M4 (GA handoff, HOBO-475) per `go-no-go-decision-record.md`; (4) **scope ADR-0063's claim to the platform-capability surface**: the capability docs remain one undivided scope with no deferred-feature bucket; M0–M4 sequences *release-readiness evidence*, and known-limitations `deferred`/`post-ga` states are customer-communication states, not capability cuts; (5) the archived roadmap **stages 0–6** (`docs/archive/roadmap.md`) are **superseded** as phasing vocabulary — include a 3-row mapping note (stages 0–2 → M0/M1 contracts+skeleton; stages 3–5 → M2 core; stage 6 → M3/M4 hardening+GA) and state the archive is historical only.
   - `### Consequences` — one (+) bullet (the release program has a decision record; "M0" in any Productization doc now resolves to one canonical definition inside docs/design/) and one (−) bullet (two ladders coexist — capability scope stays flat while readiness evidence is phased — so future docs must say which surface they phase).

2. Same file — amend `## ADR-0063` (lines 277–282): keep the existing text intact and append one short paragraph beginning `**Amended (2026-07, ADR-NNNN):**` stating (a) the "no version ladder and no deferred-feature bucket" claim is scoped to the **platform-capability design surface**; (b) the productization/release-program docs run the M0–M4 phase-gate model recorded in [ADR-NNNN](#adr-nnnn); (c) the archived `docs/archive/roadmap.md` stages 0–6 vocabulary is superseded by M0–M4 for release phasing.

3. `docs/design/adr/index.md` — add one row at the bottom of the ID table (after the `0104` row, line ~112): `| NNNN | Productization release program: M0–M4 phase gates over the single designed scope | [portability-extensibility](07-portability-extensibility.md#adr-nnnn) |`. This file is an index.md: it has NO frontmatter — do not add any.

4. `docs/design/index.md` — two sentence-level amendments: (a) in the **Scope.** paragraph (~line 120), after "Build sequencing/phasing is deferred planning (archived).", append: "The exception is the **productization release program** — the 'Productization M0/M1' docs above — which phases *release-readiness evidence* (not capabilities) through the M0–M4 gates recorded in [ADR-NNNN](./adr/07-portability-extensibility.md#adr-nnnn)."; (b) in the **Archived planning material** paragraph (~line 116), after the roadmap mention, add: "the archived roadmap's stages 0–6 are superseded by the M0–M4 phase model ([ADR-NNNN](./adr/07-portability-extensibility.md#adr-nnnn))". index.md has no frontmatter — keep it that way.

5. `docs/design/traceability.md` — (a) add one ADR coverage row after the `ADR-0104` row (line 362), matching the existing 4-column format: `| ADR-NNNN | [portability-extensibility](./adr/07-portability-extensibility.md#adr-nnnn) | The productization document category and M0→M4 phase-gate model are a recorded design decision; M0-acceptance-blocks-M1–M4 is proven by the HOBO-521 M0 acceptance record and enforced by this traceability gate. | HOBO-521, HOBO-11 |`; (b) in the "ADR Numbering and Status Audit" section (~line 370), update "Explicit numbering gaps through `ADR-0104`" to name the new max ADR ID (the gap list itself is unchanged if the next-free ID is used).


All anchors must be lowercase `#adr-nnnn` form; all links relative `.md` links as shown.

**Acceptance**

Checklist:
1. New ADR section exists in `docs/design/adr/07-portability-extensibility.md` with the next free global ID (highest existing + 1; not a documented gap ID), placed before `## Open / proposed decisions (ADR-Pn)`, containing the bold statement, Context, a 5-item Decision (category recognition; M0–M4 definition; M0-blocks-M1–M4 gate rule; ADR-0063 claim scoped to the platform-capability surface; stages 0–6 superseded with mapping note), and Consequences.
2. ADR-0063 has an appended `**Amended (2026-07, ADR-NNNN):**` paragraph; its original text is otherwise untouched.
3. `docs/design/adr/index.md` has the new row; `docs/design/traceability.md` has the new ADR coverage row (citing HOBO-521 and HOBO-11) and its numbering-gap audit line covers the new max ID; `docs/design/index.md` Scope and Archived-planning paragraphs both link the new ADR.
4. Runnable validation (from repo root):
   - `pnpm run docs:okf` (OKF frontmatter check — must stay green; no frontmatter added to either index.md)
   - `pnpm agent:check -- --staged` (with all six files staged; this auto-runs the traceability gate because `docs/design/adr/**`, `docs/design/index.md`, and `docs/design/traceability.md` changed — see `scripts/relevant-check-policy.ts:74,149`)
   - `node --import tsx scripts/validate-traceability.ts` (the traceability gate itself — there is no package.json alias for it; it fails if the new ADR ID is missing from `docs/design/traceability.md` or the gap audit is stale)
   - `pnpm run docs:design-lint` (fails on unindexed ADR references and broken internal links/anchors)
5. Cross-links to update are exactly: `docs/design/adr/index.md` (ID table), `docs/design/traceability.md` (ADR row + gap-audit line), `docs/design/index.md` (Scope + Archived paragraphs). Verify every new relative link resolves from its containing file.
6. GAPS.md register: record this as the `### REM-NNN` entry for cand-17 with status moving to "remediation documented" (documented, not applied, per the register's standing decision 3).

**Guardrails**

Do not renumber, retitle, or rewrite any existing ADR — ADR-0063 gets only the appended amendment paragraph and its "no version ladder" sentence must stay (scope it, don't delete it). Take the next free global ADR ID (max existing + 1, read from docs/design/adr/index.md at edit time); never reuse the documented gap IDs (0013, 0016, 0017, 0020, 0022, 0029, 0030, 0065–0068). Do not revive or edit docs/archive/roadmap.md — only mark its stage vocabulary superseded from the design side. Do not touch the ~90 Productization docs themselves; the ADR records the category, it does not re-specify their content. Do not add YAML frontmatter to docs/design/index.md or docs/design/adr/index.md (index files must have none). Do not propose reversing the Nomad->wasmCloud pivot or un-archiving the requirements suite (ADR-0018 stands). Documentation-only change: no code, no scripts, no Linear mutations.

### REM-016 (for GAP-012)

- **Finding** (cand-18, L-CONS, MED, votes uphold/uphold/uphold): Vision.md declares HoBo 'competes head-on with Convex, Lakebed, and Nitric' three times, borrows from Lakebed, and design/index.md carries a whole 'Competitive frame vs Lakebed' table — but no Lakebed capture exists in docs/competitors/ (which promises 'faithful captures'), it is absent from competitors/index.md and even from its future-competitor backlog list; Lakebed appears only in passing in encore.md and gap-analysis.md.
- **Evidence:** `docs/design/vision.md:14` · `docs/design/vision.md:43` · `docs/design/index.md:136-144` · `docs/competitors/index.md:5-23` · `docs/competitors/gap-analysis.md:10`
- **Effort:** M · **Delivery:** [HOBO-681](https://linear.app/quickdeploy-ai/issue/HOBO-681) (Intent-Alignment Gap Remediation project)

**Action**

REM for cand-18 (L-CONS, MED): Ground the Lakebed competitive claims by adding the missing capture, then link every design-suite Lakebed characterization to it. Option A of the sketch (add the capture) is chosen; do NOT soften vision.md — the Lakebed characterization is load-bearing (borrows list, differentiator #6, risk mitigations, `hobo import`).

FILE 1 — CREATE `docs/competitors/lakebed.md`
Follow the standard capture layout used by `docs/competitors/shoo.md` and `docs/competitors/nitric.md`. Start with OKF YAML frontmatter (all four keys, non-empty `type`):
```yaml
---
type: Competitive Reference
title: "Lakebed — Competitor Reference"
description: "Lakebed is an agent-native closed PaaS: one full-stack TypeScript app per 'Capsule' on Lakebed's own hosted runtime, sync RPC (queries/mutations), machine-readable contracts (llms.txt), and instant zero-config onboarding."
tags: [hobo, competitors]
---
```
Section outline (h2/h3):
- `# Lakebed — Competitor Reference` — h1 title.
- Opening blockquote — provenance note (see PROVENANCE RULE below) + pointer to the `#hobo-mapping` section, matching shoo.md line 10's pattern.
- Intro paragraph + summary dimension table — category / unit of deploy / cloud model / runtime model / agents / self-host / escape hatches, seeded from the existing landscape row (`docs/design/vision.md:50`) and the competitive-frame table (`docs/design/index.md:137-144`).
- `## Positioning` — what Lakebed is (agent-native closed PaaS) and who it targets; one line on why HoBo tracks it (named head-on competitor).
- `## Feature surface`
  - `### Capsule model & deployment` — the "Capsule" unit: one full-stack TS app on their runtime (source: design/index.md frame table).
  - `### Runtime model` — synchronous RPC queries/mutations, server authority, no exposed IaC (sources: vision.md:50, index.md:141-142).
  - `### Machine-readable contracts` — `llms.txt` / agent-readable app contracts (sources: vision.md:70, ai-native-agent-auth.md:155).
  - `### Onboarding & local ergonomics` — "ruthless onboarding" / instant-deploy feel HoBo explicitly matches (sources: vision.md:70,108; developer-experience.md:138,155; sdk-api.md:292).
  - `### Auth` — basic guest/Google auth for agents/users (source: vision.md:50, index.md:143).
  - `### Escape hatches & lock-in` — endpoints/env only; no self-host; migration off = rewrite (sources: vision.md:50,89).
- `## Differentiators`
  - `### Headline differentiators` — what Lakebed does genuinely well (onboarding, agent-readability, simplicity).
  - `### Gaps / limitations (opportunities for HoBo)` — closed single runtime, no cloud-agnosticism, no durable workflows, no import path.
- `## HoBo mapping` — MUST render the `#hobo-mapping` anchor. Per-feature parity table (✅ has / ➕ adds / 🔜 planned) mapping: Capsule→Bindle (Plan 21, `../design/authoring-resources-wiring.md#plan-21`); sync RPC→actors+durable workflows+sagas (Plan 2 `../design/sdk-api.md#plan-02`, Plan 11 `../design/data-plane.md#plan-11`); llms.txt→llms.txt-for-operations + MCP (Plan 6 `../design/ai-native-agent-auth.md#plan-06`); onboarding→`hobo dev`/anonymous `npx hobo up` (Plan 7 `../design/developer-experience.md#plan-07`); closed runtime→self-hosted Yard + `hobo import` adopt-in-place (ADR-0041 `../design/adr/07-portability-extensibility.md#adr-0041`); basic auth→agents as first-class principals (Plan 6).
  - `### Where HoBo deliberately exceeds Lakebed` — the borrow-and-extend list from vision.md:70 (extend machine-readable from app to operations).
  - `### Open parity items (iteration hooks)` — anything HoBo has not yet matched (at minimum: Lakebed's single-runtime simplicity as a DX bar).
- `## Sources & provenance` — see PROVENANCE RULE.

PROVENANCE RULE (mandatory): `docs/competitors/index.md` promises "faithful captures" that link upstream sources. If you can verify against official Lakebed docs, link them and quote only factual interface surface per `docs/competitors/index.md#sources--fair-use`. If you cannot (no web access), every claim in the capture must instead cite the in-repo file:line it consolidates (listed per-section above), and the opening blockquote plus `## Sources & provenance` must carry an explicit callout: "Consolidated from the HoBo design suite's existing Lakebed characterization; primary-source verification pending — do not treat as a faithful upstream capture until verified." Do not invent any Lakebed fact not already asserted in this repo.

FILE 2 — AMEND `docs/competitors/index.md` (NO frontmatter — this index has none; keep it that way)
Add one row to the competitor table (after the **Encore** row, line 16):
`| **Lakebed** | Agent-native closed PaaS (Capsules, sync RPC, llms.txt) — _named head-on competitor_ | [`lakebed.md`](lakebed.md) | [HoBo mapping](lakebed.md#hobo-mapping) |`
If the capture is repo-consolidated (unverified), append "— _capture consolidated from design suite; verification pending_" to the "What it is" cell.

FILE 3 — AMEND `docs/design/vision.md` (link insertions only; no wording changes)
- Line 14: first "Lakebed" in "competes head-on with **Convex, Lakebed, and Nitric**" → `**[Lakebed](../competitors/lakebed.md)**`.
- Line 43: same edit for the Plan 17 head-on sentence.
- Line 79: change "Lakebed (agent-native PaaS, above)" → "Lakebed (agent-native PaaS, above; [`docs/competitors/lakebed`](../competitors/lakebed.md))" — mirroring how Convex is linked in the same sentence.
- Line 66: in "(Detailed Nitric capture + parity in ...)" optionally extend to "(Detailed Nitric and Lakebed captures + parity in [`docs/competitors/nitric`](../competitors/nitric.md) / [`docs/competitors/lakebed`](../competitors/lakebed.md).)" — optional but preferred.

FILE 4 — AMEND `docs/design/index.md`
Under `### Competitive frame vs Lakebed (what we deliberately do differently)` (line 136), add one sentence directly below the heading, before the table: `Full capture + parity tracker: [`docs/competitors/lakebed`](../competitors/lakebed.md#hobo-mapping).`

FILE 5 — AMEND `docs/competitors/gap-analysis.md`
Line 10: link the "Lakebed" mention in "the **Convex / Lakebed / Nitric** set" to `lakebed.md` (same-directory relative link), matching how Aspire/Nitric/etc. are linked in that sentence.

NO new ADR is needed — this is a documentation-consistency fix, not a decision change; do not touch `docs/design/adr/`.

CROSS-LINK BOOKKEEPING: if `GAPS.md` carries a cand-18 row in its Gap register / a `### REM-` section for cand-18 at implementation time, set its Status to remediated (✔) and add the delivery PR link per GAPS.md conventions.

**Acceptance**

1. `docs/competitors/lakebed.md` exists with OKF frontmatter (`type: Competitive Reference`, non-empty title/description, `tags: [hobo, competitors]`) and contains all outlined sections including a working `## HoBo mapping` section (anchor `#hobo-mapping`) and a `## Sources & provenance` section that either links official Lakebed sources or carries the explicit "verification pending" callout with per-claim in-repo citations.
2. `docs/competitors/index.md` table has a Lakebed row linking `lakebed.md` and `lakebed.md#hobo-mapping`; the file still has NO YAML frontmatter.
3. `docs/design/vision.md` lines ~14, ~43, ~79 link Lakebed to `../competitors/lakebed.md`; `docs/design/index.md` "Competitive frame vs Lakebed" section links the capture; `docs/competitors/gap-analysis.md` line ~10 links `lakebed.md`. All links are relative `.md` links and resolve.
4. No existing ADRs renumbered; no files under `docs/design/adr/` modified; no wording of competitive claims softened or removed; the Nomad→wasmCloud pivot untouched.
5. Runnable checks all pass (run from repo root, changes staged):
   - `pnpm run docs:okf`
   - `pnpm agent:check -- --staged`
   - `node --import tsx scripts/validate-traceability.ts` (required — `docs/design/` is touched; this is the real traceability gate per CONTRIBUTING.md / PR template; there is no package.json "traceability" script)
   - `pnpm run docs:design-lint` (broken-link/anchor gate for the new relative links in `docs/design/`)
6. GAPS.md cand-18 register row/REM entry (if present at implementation time) updated to remediated status with delivery link.

**Guardrails**

- Documentation-only: create/amend the five named files; write no code, no ADRs, no renames/renumbers of existing captures or ADRs.
- Do NOT soften, hedge, or delete the "competes head-on with Convex, Lakebed, and Nitric" claims — the chosen remediation grounds them with a capture; option B (softening) is rejected because the Lakebed characterization is load-bearing across vision.md (borrows, differentiator #6, risk mitigations) and ADR-0041.
- Do NOT fabricate Lakebed facts: every statement in lakebed.md must trace to an official Lakebed source (linked, fair-use excerpting per docs/competitors/index.md#sources--fair-use) or to a cited in-repo assertion, with the "verification pending" callout in the unverified case.
- `docs/competitors/index.md` must remain frontmatter-free; the new `lakebed.md` must have OKF frontmatter with non-empty `type:`.
- Use relative links only (`../design/...` from competitors docs; `../competitors/lakebed.md` from design docs); verify anchors (`#hobo-mapping`, `#plan-NN`, `#adr-NNNN`) exist before linking.
- Never propose or imply reversing the Nomad→wasmCloud pivot.
- Conventional scoped commit (e.g. `docs(competitors): add Lakebed capture and link design-suite claims (cand-18)`); do not commit if any acceptance check fails.

### REM-017 (for DRIFT-005)

- **Finding** (cand-19, P1, LOW, votes uphold/uphold/uphold, drift-class silent): platform-engineering.md still says 'multi-Yard federation (multi-region/regulatory) is out of scope (Q20)' citing a dangling anchor (generated-stack.md contains no Q20/open-questions text), contradicting ADR-0043 which fully designs multi-Yard federation (the Junction) and control-plane.md which says an air-gapped Yard 'may stand alone or join a Junction'.
- **Evidence:** `docs/design/platform-engineering.md:229` · `docs/design/adr/07-portability-extensibility.md#adr-0043` · `docs/design/control-plane.md:93` · `docs/design/data-plane.md:601`
- **Effort:** S · **Delivery:** ✔ [HOBO-682](https://linear.app/quickdeploy-ai/issue/HOBO-682) — Q20 federation-out-of-scope claims repointed to ADR-0043 Junction

**Action**

Amend three existing files (no new files, no new ADR — ADR-0036/ADR-0043 already state the correct design; this aligns the three downstream references to them).

1. C:/src/hobo/docs/design/platform-engineering.md, line 229 (Plan 25, "Air-gapped (zero-egress) profile" subsection, the blockquote immediately after the mermaid diagram). Replace the whole line:
OLD: `> Air-gap is a **single in-boundary Yard**; multi-Yard **federation** (multi-region/regulatory) is out of scope ([Q20](./generated-stack.md#plan-09)).`
NEW: `> Air-gap is a **single in-boundary Yard** that may **stand alone or join a Junction** ([ADR-0036](./adr/07-portability-extensibility.md#adr-0036)); multi-Yard **federation** (multi-region/regulatory/cross-cloud) is designed first-class as the **Junction** ([ADR-0043](./adr/07-portability-extensibility.md#adr-0043), [Plan 4](./control-plane.md#plan-04) §Yard scope & multi-Yard).`

2. C:/src/hobo/docs/design/data-plane.md, line 601 (Plan 32, "Embeddings — the `embed` capability" bullet list). Replace the whole line:
OLD: `- **Local / in-boundary model** — for \`hobo dev\` and **air-gapped** Camps (no egress; relates to [Q20](./generated-stack.md#plan-09) / the air-gap gap).`
NEW: `- **Local / in-boundary model** — for \`hobo dev\` and **air-gapped** Camps (no egress; the air-gapped profile, [ADR-0036](./adr/07-portability-extensibility.md#adr-0036)).`

3. C:/src/hobo/docs/competitors/gap-analysis.md, line 69 (section "B. Designed-but-shallow", bullet "G6 — Air-gapped / sovereign mode"). Replace only the final sentence of the bullet:
OLD: `The deterministic core works with no egress. Multi-Yard **federation** stays deferred ([Q20](../design/generated-stack.md#plan-09)).`
NEW: `The deterministic core works with no egress. Multi-Yard **federation** is designed as the **Junction** ([ADR-0043](../design/adr/07-portability-extensibility.md#adr-0043)); an air-gapped Yard may stand alone or join a Junction.`

Rationale to cite in the commit/issue: `docs/design/generated-stack.md` §Open design questions (line 352) contains no Q-numbered items, so `[Q20](...#plan-09)` is a dangling label; ADR-0043 (docs/design/adr/07-portability-extensibility.md, `## ADR-0043` at line 139) fully designs multi-Yard federation (the Junction), and control-plane.md:93 + ADR-0036's consequence (adr/07-portability-extensibility.md:121) already say an air-gapped Yard "may stand alone or join a Junction". Link targets used above all exist and are verified: `#adr-0036` and `#adr-0043` headings in docs/design/adr/07-portability-extensibility.md; `## Plan 04` at docs/design/control-plane.md:12. No new doc/section is created, so no section outline, no OKF frontmatter additions, and no index.md/hub link changes are required. Commit style: `docs(design): repoint stale Q20 federation-out-of-scope claims to ADR-0043 Junction`.

**Acceptance**

1. Stale label gone repo-wide: `rg -n "Q20" docs/` returns no matches (baseline before the fix: exactly 3 hits — docs/design/platform-engineering.md:229, docs/design/data-plane.md:601, docs/competitors/gap-analysis.md:69).
2. New link targets resolve: `rg -n "^## ADR-0036$|^## ADR-0043$" docs/design/adr/07-portability-extensibility.md` prints both headings, and `rg -n "^## Plan 04$" docs/design/control-plane.md` prints one.
3. `pnpm run docs:okf` passes (frontmatter untouched; platform-engineering.md keeps `type: Reference`).
4. Stage the three files (`git add docs/design/platform-engineering.md docs/design/data-plane.md docs/competitors/gap-analysis.md`), then `pnpm agent:check -- --staged` passes.
5. Traceability gate (docs/design/ touched; there is no npm alias — the real command is the script named in scripts/relevant-check-policy.ts:149): `node --import tsx scripts/validate-traceability.ts` passes.
6. Optional but cheap: `pnpm run docs:design-lint` passes for the two design docs.
7. Cross-link consistency: the edited lines' wording matches ADR-0036 consequence (docs/design/adr/07-portability-extensibility.md:121) and docs/design/control-plane.md:93 — no remaining text anywhere in docs/ claims multi-Yard federation is "out of scope" or "deferred" (`rg -in "federation.*(out of scope|deferred)" docs/` returns only historical-note hits outside these three lines, ideally none).
8. GAPS.md register: flip cand-19 status from confirmed to remediation-documented per the register's own workflow (handled by the register commit that embeds this entry, not by the doc edits themselves).

**Guardrails**

Do NOT edit any file under docs/design/adr/ — ADR-0036 and ADR-0043 are already correct and ADRs are never renumbered or reworded by this fix. Do NOT touch the sibling stale labels Q22/Q23 (docs/competitors/gap-analysis.md:63,67) or the "#16/#18/#19/#20" note at gap-analysis.md:127 — same stale-label class but out of scope for cand-19; file separately if confirmed. Do NOT add a Q20 item back into generated-stack.md §Open design questions — the fix direction is repointing references to ADR-0043, not resurrecting the dead question. Do NOT reintroduce any "federation is out of scope/deferred" phrasing anywhere. Keep relative-link conventions exactly as shown (`./adr/...` from docs/design/*, `../design/...` from docs/competitors/*). Documentation-only change; the Nomad→wasmCloud pivot is accepted and untouched. index.md files must gain no frontmatter (none are edited here).

### REM-018 (for DRIFT-006)

- **Finding** (cand-20, P3, LOW, votes uphold/uphold/uphold, drift-class silent): nitric.md's HoBo-mapping layer has drifted from the current design: it maps `nitric up/down` -> `hobo deploy/destroy` and `nitric run` -> `hobo dev --containers` (the design collapsed to `hobo up/down` and defines no --containers flag), names the schedule port `hobo:schedule` vs the design's `hobo:scheduler`, and its 'Open parity items' still lists the WebSocket WIT shape and sql-migrations as open although ADR-0075 and ADR-0032/Plan 32 resolved them.
- **Evidence:** `docs/competitors/nitric.md:313` · `docs/competitors/nitric.md:336` · `docs/competitors/nitric.md:355` · `docs/design/developer-experience.md:71` · `docs/design/wasm-runtime-wit.md:201` · `docs/design/authoring-resources-wiring.md:127`
- **Effort:** S · **Delivery:** ✔ [HOBO-683](https://linear.app/quickdeploy-ai/issue/HOBO-683) — nitric.md HoBo-mapping reconciled

**Action**

Amend ONE file (plus one optional one-line sibling fix). No new files, no new ADRs — every drifted claim already has a resolving design doc/ADR to link to.

FILE 1 (required): docs/competitors/nitric.md — refresh only the "## HoBo mapping" layer (lines 288-359). Do NOT touch anything above "## HoBo mapping" (the Nitric-offering sections are a faithful capture of Nitric and are correct).

Edit 1 — line 313, "### Resource catalog" table, `schedule` row. Replace:
`| \`schedule\` (cron/interval) | \`hobo:schedule\` (control-plane \`cron\`) | ✅ |`
with:
`| \`schedule\` (cron/interval) | \`hobo:scheduler\` (control-plane \`every(spec)\`/\`cron(expr)\`) | ✅ |`
Rationale: the design's port is `hobo:scheduler` — see docs/design/wasm-runtime-wit.md:166 and docs/design/authoring-resources-wiring.md:44.

Edit 2 — line 336, "### CLI, local dev, deployment" table, `nitric run` row. Replace:
`| \`nitric run\` (containers) | \`hobo dev --containers\` (wasm host or OCI) | ✅ | [15](../design/developer-experience.md#plan-07) |`
with:
`| \`nitric run\` (containers) | \`hobo dev\` on \`runtime-local\` (Wasmtime host); container execution is the wasm-in-container OCI floor, not a flag | ✅ | [15](../design/developer-experience.md#plan-07), [ADR-0031](../design/adr/01-architecture-core.md#adr-0031) |`
Rationale: the design defines no `--containers` flag (docs/design/developer-experience.md:71-108); ADR-0031 (docs/design/adr/01-architecture-core.md:76-89) makes wasm-in-container the zero-infra floor and Wasmtime the `hobo dev` host of record.

Edit 3 — line 337, same table, `nitric up/down/spec/build` row. Replace:
`| \`nitric up/down/spec/build\` | \`hobo deploy/destroy/plan/build\` | ✅ | [15](../design/developer-experience.md#plan-07) |`
with:
`| \`nitric up/down/spec/build\` | \`hobo up/down\` (the only lifecycle verbs — no \`deploy\`/\`destroy\`) + \`hobo collect\` (≈ \`nitric spec\`) / \`hobo plan\` (dry-run) / \`hobo build\` | ✅ | [15](../design/developer-experience.md#plan-07) |`
Rationale: the CLI collapsed to `hobo up`/`hobo down` (docs/design/developer-experience.md:71-89: "There is no separate deploy/destroy"); `hobo collect` is explicitly "à la nitric spec" (docs/design/developer-experience.md:62,95).

Edit 4 — "### Open parity items (iteration hooks)" (lines 354-359). Replace the four-bullet list so the two resolved items are struck and cross-linked, keeping the two genuinely open ones first. New section body outline:
- (h3, existing) "Open parity items (iteration hooks)" — keep heading unchanged.
  - Bullet: Bucket-event + presigned-URL semantics (`hobo:blob-events`) — keep verbatim (still open).
  - Bullet: Per-language IfC collection fidelity — keep verbatim (still open).
  - New sub-list intro line "Resolved since capture:" — one-line lead-in for struck items.
  - Bullet: `~~WebSocket port WIT shape (no standard \`wasi:websocket\` yet)~~ — resolved by [ADR-0075](../design/adr/07-portability-extensibility.md#adr-0075): vendored preview \`wasi:websocket@0.0.x-draft\` + \`hobo:websocket\` thin extension ([Plan 20](../design/wasm-runtime-wit.md#plan-20)).`
  - Bullet: `~~\`sql\` migrations workflow parity (Nitric's \`migrations/<db>/*.up.sql\`)~~ — resolved by [ADR-0032](../design/adr/03-data-plane.md#adr-0032)/[Plan 32](../design/data-plane.md#plan-32): declarative desired-schema + auto-diff (raw \`.up.sql\`-style escape hatch), gated expand/backfill/contract apply + snapshot rollback.`
Anchor targets verified to exist: `## ADR-0075` at docs/design/adr/07-portability-extensibility.md:229, `## ADR-0032` at docs/design/adr/03-data-plane.md:88, `#plan-32` anchor used throughout docs/design/data-plane.md, `#plan-20` in docs/design/wasm-runtime-wit.md, `#adr-0031` at docs/design/adr/01-architecture-core.md:76.

FILE 2 (optional, same drift class, one word): docs/competitors/nomad.md line 175 — change `hobo:schedule` to `hobo:scheduler` in the "Periodic jobs" row. (docs/competitors/dapr.md already uses the correct `hobo:scheduler`.)

Frontmatter: nitric.md already has valid OKF frontmatter (`type: Competitive Reference`) — do not change it. No new docs, so no new frontmatter and no index.md changes are needed (docs/competitors/index.md already links nitric.md).

**Acceptance**

Checklist (run from repo root C:/src/hobo):
1. `pnpm run docs:okf` — passes (frontmatter untouched, but gate must stay green).
2. `pnpm agent:check -- --staged` — passes with the nitric.md (and optional nomad.md) edits staged.
3. `node --import tsx scripts/validate-traceability.ts` — passes; this is the repo's traceability/link gate (there is NO pnpm alias for it — package.json has no traceability script; the command comes from CONTRIBUTING.md:39 and .github/pull_request_template.md:21). Required here because the edit adds four new relative links from docs/competitors/nitric.md into docs/design/adr/01-architecture-core.md, docs/design/adr/03-data-plane.md, docs/design/adr/07-portability-extensibility.md, docs/design/data-plane.md, and docs/design/wasm-runtime-wit.md.
4. Grep assertions (all must return zero matches):
   - `pnpm run search -- "hobo dev --containers" docs/competitors`
   - `pnpm run search -- "hobo deploy/destroy" docs/competitors`
   - `pnpm run search -- "hobo:schedule\b" docs/competitors/nitric.md` (and docs/competitors/nomad.md if the optional fix is applied)
5. Grep assertion (must return matches): `pnpm run search -- "adr-0075" docs/competitors/nitric.md` and `pnpm run search -- "adr-0032" docs/competitors/nitric.md` — confirms the resolved-parity links landed.
6. Manual: the "Open parity items" section still lists exactly two open bullets (blob-events, per-language IfC fidelity) and two struck/resolved bullets with ADR links; nothing above "## HoBo mapping" in nitric.md changed.
Cross-links to update: none in hub/index files — no files are created; docs/competitors/index.md already links nitric.md.

**Guardrails**

- Documentation-only; edit the HoBo-mapping layer of nitric.md, never the Nitric-offering capture above "## HoBo mapping" (it intentionally documents Nitric's own `nitric run`/containers model faithfully).
- Do not create or renumber ADRs; this remediation needs no new ADR — it only links existing ADR-0031, ADR-0032, ADR-0075.
- Do not "fix" docs/archive/requirements/requirements.md (`hobo deploy` there is an immutable archived snapshot). docs/technologies/cloud-foundry-pcf.md:28,32 has the same `hobo deploy` drift but is OUT OF SCOPE for cand-20 — leave it for a separate finding; do not expand this change beyond docs/competitors/.
- Keep the ✅/➕/🔜 legend semantics and existing table column structure; keep all links relative `.md` links (repo norm).
- Do not mark the `hobo:blob-events` or per-language-IfC bullets resolved — the finding only established WebSocket (ADR-0075) and sql-migrations (ADR-0032/Plan 32) as resolved.
- The Nomad→wasmCloud pivot is accepted; nothing here may imply revisiting it (ADR-0031's wasmCloud default is cited as-is).

### REM-019 (for GAP-013)

- **Finding** (cand-22, P4, LOW, votes uphold/uphold/uphold): FinOps has zero dedicated research notes despite normative adoption: ADR-0039 §3 models showback on OpenCost and the control-plane doc baselines FOCUS 1.4/FinOps Framework, yet docs/standards/ has a note for every other adopted standard (CloudEvents, OCSF, OpenSLO, OpenFeature...) but none for FOCUS/OpenCost, and docs/competitors/ has no FinOps-market entry (Kubecost, Infracost, Vantage, Cast.ai).
- **Evidence:** `docs/design/adr/02-identity-security.md:282` · `docs/design/finops-budget-routing-control-plane.md:108` · `docs/standards/index.md` · `docs/competitors/index.md` · `docs/competitors/antimetal.md:173`
- **Effort:** M · **Delivery:** [HOBO-684](https://linear.app/quickdeploy-ai/issue/HOBO-684) (Intent-Alignment Gap Remediation project)

**Action**

Create 2 files and amend 4 (docs-only; no new ADR — ADR-0039 already made the adoption decision, this remediation adds the missing research notes and back-links).

1) CREATE C:/src/hobo/docs/standards/focus-opencost.md — mirror docs/standards/openslo.md exactly. OKF YAML frontmatter: `type: Reference Standard`, `title: "FOCUS & OpenCost"`, non-empty `description:`, `tags: [hobo, standards]`. Then `# FOCUS & OpenCost`, a blockquote line ("**Standard** · ..." with sources focus.finops.org, finops.org/framework, opencost.io, github.com/opencost/opencost + fair-use note), and sections:
- `## What it is` — one paragraph each: FOCUS 1.4 (FinOps Foundation's open billing-data spec: a normalized column taxonomy for cost/usage across providers) and OpenCost (CNCF cost-allocation specification + implementation: how to attribute infrastructure cost to workloads); why one note covers both (the data format + the allocation method HoBo adopted together).
- `## Key features` with three h3s: `### FOCUS 1.4` (core columns: BilledCost/EffectiveCost/ListCost/ContractedCost, charge categories, SKU/pricing dimensions, provider adoption AWS/Azure/GCP/OCI, what 1.4 added); `### OpenCost allocation spec` (allocation = usage x price per resource dimension, idle-cost and shared-cost distribution rules, the API surface, relationship to Kubecost); `### FinOps Framework` (short: Inform/Optimize/Operate phases + capability vocabulary, since docs/design/finops-budget-routing-control-plane.md:109 baselines it).
- `## Relevance to HoBo` — map to: ADR-0039 §1 MeteringView dimensions (control-plane ops, compute-seconds, storage-GB, egress-GB, generation runs) vs FOCUS columns; ADR-0039 §3 showback "modeled on the OpenCost open standard" (link [ADR-0039](../design/adr/02-identity-security.md#adr-0039)); ADR-0071 CreditLedgerView "effective marginal cost" vs FOCUS EffectiveCost-vs-ListCost distinction (link [ADR-0071](../design/adr/01-architecture-core.md#adr-0071)); `FocusCostLedgerEntry` + the standards-baseline table in [finops-budget-routing-control-plane.md](../design/finops-budget-routing-control-plane.md#standards-baseline); the boundary stance parallel to CloudEvents/OCSF in [ADR-0046](../design/adr/02-identity-security.md#adr-0046) (showback figures should export FOCUS-conformant). End with a "Boundaries / caveats" paragraph: FOCUS is a billing-data format but HoBo ships no billing (ADR-0064); OpenCost is Kubernetes-centric — HoBo's wasm runtime needs its own usage→price mapping while keeping the allocation-spec shape.
- `## Sources` — bulleted external links + one "HoBo:" line of cross-links (copy the openslo.md:66-71 pattern).

2) CREATE C:/src/hobo/docs/competitors/finops-tooling.md — landscape entry mirroring docs/competitors/wasm-hosts.md / antimetal.md. Frontmatter: `type: Competitive Reference`, `title: "FinOps tooling landscape - Competitor Reference"`, non-empty `description:`, `tags: [hobo, competitors]`. Sections:
- `# FinOps tooling landscape - Competitor Reference`; blockquote with researched date + sources (kubecost.com, opencost.io, infracost.io, vantage.sh, cast.ai) + adjacency note ("adjacent; FinOps/showback benchmark — none is a meta-cloud, all overlap ADR-0039/ADR-0071/Plan 5").
- `## What it is` — a Dimension|... comparison table across the four products.
- `## Feature surface` with h3 per product: `### Kubecost / OpenCost` (K8s cost allocation, idle/shared cost, savings insights); `### Infracost` (plan-time cost estimation on Terraform PRs — pressure-tests HoBo's plan-time cost estimation in Plan 5); `### Vantage` (multi-cloud cost observability/showback SaaS, per-team attribution, anomaly alerts); `### Cast.ai` (automated optimization/rightsizing — pressure-tests cost-driven degradation tiers and the Planner "minimize cost subject to availability floor").
- `## Differentiators` and `## Gaps a competitor could exploit` — bullets.
- `## HoBo mapping` — table (Feature | HoBo equivalent / delta | Status) mapping to [ADR-0039](../design/adr/02-identity-security.md#adr-0039) metering/showback/quota/degradation, [ADR-0071](../design/adr/01-architecture-core.md#adr-0071) Dispatcher/CreditLedgerView cost routing, [Plan 5](../design/reliability-observability-cost.md#plan-05) budgets/spend-caps/estimation, and the FinX surface of [finops-budget-routing-control-plane.md](../design/finops-budget-routing-control-plane.md#product-surfaces).
- `## Verdict` — is showback+cost-routing-inside-the-control-plane a real differentiator vs these tools bolted onto any cluster.

3) AMEND C:/src/hobo/docs/standards/index.md — add one row to the Index table (after OCSF, line 17): `| **FOCUS & OpenCost** (FinOps Foundation / CNCF) | Normalized cost/usage billing-data spec + cost-allocation spec | [`focus-opencost.md`](./focus-opencost.md) |`; extend the "See also" blockquote (line 19) with a clause pointing at ADR-0039 showback and the FinOps control plane: `cost standards ground showback ([ADR-0039](../design/adr/02-identity-security.md#adr-0039)) and the [FinOps budget-routing control plane](../design/finops-budget-routing-control-plane.md#standards-baseline)`. NO frontmatter on this file.

4) AMEND C:/src/hobo/docs/competitors/index.md — add one table row after Wasm hosts (line 17): `| **FinOps tooling** | Cost allocation/estimation/optimization landscape (Kubecost/OpenCost · Infracost · Vantage · Cast.ai) — _adjacent; showback/FinOps benchmark_ | [`finops-tooling.md`](finops-tooling.md) | [HoBo mapping](finops-tooling.md#hobo-mapping) |`. NO frontmatter on this file.

5) AMEND C:/src/hobo/docs/design/adr/02-identity-security.md line 282 (ADR-0039 §3): after `**modeled on the [OpenCost](https://opencost.io) open standard** (the CNCF cost-allocation spec)` insert ` — captured with FOCUS in [`../../standards/focus-opencost.md`](../../standards/focus-opencost.md) —`. Do not change any other decision text; never renumber ADRs.

6) AMEND C:/src/hobo/docs/design/finops-budget-routing-control-plane.md — in the Standards Baseline section (line 104-109), add one sentence after the table intro or below the table: `FOCUS and OpenCost are captured as a standards research note in [`../standards/focus-opencost.md`](../standards/focus-opencost.md).`

7) OPTIONAL (include if capacity allows): add `## 3e. Survey - FinOps tooling (2026-07-01)` to C:/src/hobo/docs/competitors/gap-analysis.md — 3-6 bullets stating whether the landscape exposes new gaps or confirms ADR-0039/ADR-0071 coverage, following the 3d Antimetal re-survey pattern.

**Acceptance**

- [ ] docs/standards/focus-opencost.md exists with frontmatter `type: Reference Standard` (non-empty) and sections What it is / Key features / Relevance to HoBo / Sources, matching the openslo.md shape.
- [ ] docs/competitors/finops-tooling.md exists with frontmatter `type: Competitive Reference`, covers Kubecost/OpenCost, Infracost, Vantage, Cast.ai, and ends with a `## HoBo mapping` table whose anchor `#hobo-mapping` resolves.
- [ ] Index/hub files gained links: docs/standards/index.md table row -> ./focus-opencost.md; docs/competitors/index.md table row -> finops-tooling.md + finops-tooling.md#hobo-mapping. Neither index.md gained frontmatter.
- [ ] Back-links added: docs/design/adr/02-identity-security.md ADR-0039 §3 -> ../../standards/focus-opencost.md; docs/design/finops-budget-routing-control-plane.md Standards Baseline -> ../standards/focus-opencost.md.
- [ ] All new cross-doc links are relative .md links and resolve (spot-check: from docs/standards/ use ../design/...; from docs/competitors/ use ../design/...; from docs/design/adr/ use ../../standards/...).
- [ ] Run: `pnpm run docs:okf` — passes (frontmatter rules).
- [ ] Run: `pnpm agent:check -- --staged` (with all changed files staged) — passes; because docs/design/adr/** and docs/design/*.md are touched this automatically includes the traceability gate wired in scripts/relevant-check-policy.ts.
- [ ] Traceability gate directly (the real command; there is no package.json alias): `node --import tsx scripts/validate-traceability.ts` — passes.
- [ ] Run: `pnpm run lint:docs:staged` — passes (link/lint checks on the staged docs).

**Guardrails**

Documentation-only: create/amend the six listed files, nothing else. Do NOT create a new ADR (ADR-0039 already decided FOCUS/OpenCost adoption; this fills the missing research notes) and never renumber or rewrite existing ADR decision text beyond the single §3 cross-link insertion. Do not touch the Nomad->wasmCloud pivot or docs/competitors/nomad.md. New docs need OKF frontmatter with non-empty type:; index.md files must have NO frontmatter. Follow the fair-use conventions already in docs/standards/index.md and docs/competitors/index.md: quote only factual spec/API surface, attribute sources, keep excerpts minimal. Both new docs must state facts with source links (focus.finops.org, opencost.io, infracost.io, vantage.sh, cast.ai) — no invented pricing/feature claims. Keep every cross-doc link relative; verify anchors (#adr-0039, #adr-0071, #plan-05, #standards-baseline, #hobo-mapping) exist before linking.

### REM-020 (for GAP-014)

- **Finding** (cand-25, P5, LOW, votes uphold/uphold/uphold): Capability Manifest prose (signs.md / llms.txt) is designed to be read by agents at discovery time, yet the ADR-0023 §3 untrusted-material/sanitization rule is scoped only to generation-pipeline inputs and the Plan 12 threat table's injection row covers only generation-pipeline plugins — manifest prose consumed by operating/planning agents is never classified as untrusted input in the design suite (the broader prompt-injection candidate is otherwise refuted by tool contracts, the MCP hardening proof, and enforced guardrails).
- **Evidence:** `docs/design/ai-native-agent-auth.md:35` · `docs/design/ai-native-agent-auth.md:78` · `docs/design/adr/02-identity-security.md:37` · `docs/design/security-networking.md:30` · `docs/design/generated-stack.md:177`
- **Effort:** M · **Delivery:** [HOBO-685](https://linear.app/quickdeploy-ai/issue/HOBO-685) (Intent-Alignment Gap Remediation project)

**Action**

Amend three existing design docs (no new files, no new ADR ID — this extends an existing accepted ADR's decision text and lifts an already-proven invariant into design prose).

1. `docs/design/adr/02-identity-security.md` — ADR-0023, Decision item 3 (currently line 37: "**AI generation is hardened against prompt injection** — source docs/OpenAPI fed to generation pipeline are scanned/sanitized; the signed provenance includes a scrub report; conformance runs with **no egress** as a hard requirement. (TR-083)"). Replace that single list item with a two-part rule, keeping the "(TR-083)" citation and the item's position in the 1–9 list:
   - (a) Generation-pipeline inputs — keep the existing sentence verbatim (scanned/sanitized, scrub report in signed provenance, no-egress conformance).
   - (b) Discovery-time manifest prose — Registry-served Capability Manifest prose (`signs.md`/`llms.txt` and free-text description fields in `index.json`/`capabilities.json`/`auth.json`, [Plan 6](../ai-native-agent-auth.md#plan-06) §6.1) is **untrusted input in any agent context** (planning, operating, or generation). State explicitly: the Registry signature (ADR-0009) authenticates *who published* the manifest, not that its prose is safe to obey; agent-facing surfaces returning manifest content (e.g. `search_registry`) deliver it as **inert data** — embedded instructions can never expand an agent's authority, because tool contracts ([Plan 29](../contracts-policy-flags.md#plan-29)), the deny-by-default policy plane, and scoped tokens bound every action regardless of prose content, proven for the MCP surface by the [HOBO-194 hardening proof](../proofs/hobo-194-mcp-server-hardening/index.md).

2. `docs/design/ai-native-agent-auth.md` — two small additions to Plan 06:
   - §6.1 (Capability Manifest): add one bullet to the existing Discovery / Preference order / Thematic anchor bullet list (after "Thematic anchor", ~line 78): "**Trust boundary:** `signs.md`/`llms.txt` and manifest description fields are untrusted input wherever an agent reads them — the signature authenticates the publisher, not the safety of the prose; instructions inside a manifest never widen what an agent may do ([ADR-0023](./adr/02-identity-security.md#adr-0023) item 3, [Plan 12](./security-networking.md#plan-12) threat table)."
   - §6.4 (MCP control surface): after the paragraph "MCP auth uses the same Identity/SVID model…" (~line 155), add a short bolded invariant paragraph: "**Inert-tool-output invariant.** Every MCP tool result — including `search_registry` results carrying Capability Manifest prose — is inert data: a tool output can never schedule, authorize, or widen a follow-up tool call beyond the agent's existing grant; prompt-injected content in a result is recorded but powerless ([ADR-0023](./adr/02-identity-security.md#adr-0023) item 3; proven in [HOBO-194](./proofs/hobo-194-mcp-server-hardening/index.md))."

3. `docs/design/security-networking.md` — Plan 12 threat model table (lines 24–32): add ONE new row immediately after the existing "generation pipeline plugins (AI-generated)" row (line 30), keeping that row unchanged: `| **Capability Manifest prose** (signs.md / llms.txt / auth.json descriptions) | prompt injection at discovery time — a malicious or compromised provider manifest steering planning/operating agents | classified untrusted input in every agent context ([ADR-0023](./adr/02-identity-security.md#adr-0023) item 3); Registry signature verifies publisher, not prose; inert-tool-output invariant — a tool result cannot trigger an out-of-scope follow-up call ([Plan 6](./ai-native-agent-auth.md#plan-06) §6.4, [HOBO-194 proof](./proofs/hobo-194-mcp-server-hardening/index.md)) |`

No index/hub updates needed: no new files are created, so `docs/design/index.md`, `docs/design/adr/index.md`, and `docs/design/traceability.md` need no edits (ADR-0023 already appears in the traceability report and the ADR index; the validator only requires ID presence). All three amended files already carry valid OKF frontmatter.

**Acceptance**

- [ ] ADR-0023 Decision item 3 in `docs/design/adr/02-identity-security.md` now covers BOTH generation-pipeline inputs and Registry-served manifest prose (`signs.md`/`llms.txt`/JSON description fields) as untrusted input in any agent context, retains "(TR-083)", and links to Plan 6, Plan 29, and `../proofs/hobo-194-mcp-server-hardening/index.md`.
- [ ] `docs/design/ai-native-agent-auth.md` §6.1 has the new "Trust boundary" bullet and §6.4 has the "Inert-tool-output invariant" paragraph, each cross-linking ADR-0023 and (for §6.4) `./proofs/hobo-194-mcp-server-hardening/index.md`.
- [ ] `docs/design/security-networking.md` Plan 12 threat table has the new "Capability Manifest prose" row; the existing "generation pipeline plugins" row is unchanged.
- [ ] No files created or renamed; no ADR renumbered; no frontmatter added to any `index.md`.
- [ ] All new relative links resolve (targets exist: `docs/design/proofs/hobo-194-mcp-server-hardening/index.md`, `docs/design/adr/02-identity-security.md`, `docs/design/ai-native-agent-auth.md`, `docs/design/security-networking.md`, `docs/design/contracts-policy-flags.md`).
- [ ] Run: `pnpm run docs:okf` (passes).
- [ ] Run: `pnpm agent:check -- --staged` (passes; because `docs/design/adr/` is touched this automatically runs the traceability gate).
- [ ] Run the traceability gate directly: `node --import tsx scripts/validate-traceability.ts` (passes — package.json has no named traceability script; this is the real gate wired through `scripts/relevant-check-policy.ts` line 149).

**Guardrails**

- Amend ADR-0023 in place (extend Decision item 3); do NOT mint a new ADR ID, renumber, or reorder the existing 1–9 decision list, and do not touch any other ADR section.
- Do not restate or re-open the refuted broader prompt-injection claim: the amendment classifies manifest prose as untrusted and states the existing inert-output invariant — it must not invent new mitigation mechanisms or imply tool contracts/policy plane are insufficient.
- Keep the existing Plan 12 "generation pipeline plugins" threat row byte-identical; only add the new row.
- Do not edit `docs/design/traceability.md`, `docs/design/index.md`, or `docs/design/adr/index.md` — they are not required for this change and edits risk tripping the traceability validator's exact-string checks (e.g. "Accepted / current").
- Preserve OKF frontmatter untouched in all three amended files; never add frontmatter to any `index.md`.
- Documentation-only: no changes under `src/draft/` (the HOBO-194 proof is cited, not modified) and nothing touching the Nomad→wasmCloud pivot.
- Use exactly the relative link paths given in the action (they are correct from each file's directory: `../proofs/...` from `docs/design/adr/`, `./proofs/...` from `docs/design/`).

### REM-021 (for DRIFT-007)

- **Finding** (cand-26, L-DRIFT, LOW, votes uphold/uphold/uphold, drift-class deliberate-undocumented): The design-suite scope statement (index.md: 'The whole suite is one scope — every plan is in scope, bounded only by the AI-native-meta-cloud-minus-monetization line (ADR-0063/ADR-0064)') is stale: the same index now lists monetization-adjacent commercial records (billing, tax, invoicing evidence, payout hooks) and a phased launch program, so the stated bound no longer describes the suite's contents.
- **Evidence:** `docs/design/index.md:120` · `docs/design/index.md:53-57` · `docs/design/index.md:66-67` · `docs/design/adr/07-portability-extensibility.md:294`
- **Effort:** S · **Delivery:** [HOBO-686](https://linear.app/quickdeploy-ai/issue/HOBO-686) (Intent-Alignment Gap Remediation project)

**Action**

REM-cand-26 — Restate the design-suite Scope paragraph with both bounds (platform capability surface + productization/launch records).

AMEND (1 file): `docs/design/index.md` — replace the single **Scope.** paragraph at line 120. No new headings, no frontmatter (index.md files must have NO frontmatter; this file has none — keep it that way). Replace this exact paragraph:

"**Scope.** The whole suite is **one scope** — every plan is in scope, bounded only by the AI-native-meta-cloud-minus-monetization line ([ADR-0063](./adr/07-portability-extensibility.md#adr-0063)/[ADR-0064](./adr/07-portability-extensibility.md#adr-0064)). Build sequencing/phasing is deferred planning (archived)."

with this exact paragraph:

"**Scope.** The suite covers one designed platform surface plus its launch program, with two distinct bounds. (1) **Platform capability surface:** every numbered plan is in scope, bounded by the AI-native-meta-cloud-minus-monetization line ([ADR-0063](./adr/07-portability-extensibility.md#adr-0063)/[ADR-0064](./adr/07-portability-extensibility.md#adr-0064)) — HoBo the product ships no billing/monetization capability (no `billing` port, invoicing, tax, rev-share, or subscriptions); build sequencing/phasing of this surface is deferred planning (archived). (2) **Productization & launch records:** the \"Productization M0/M1\" rows in the index above (for example [`billing-launch-policy.md`](./billing-launch-policy.md), [`usage-metering.md`](./usage-metering.md), [`usage-to-invoice-reconciliation.md`](./usage-to-invoice-reconciliation.md), [`entitlements-plan-limits.md`](./entitlements-plan-limits.md), [`tax-currency-receipt-obligations.md`](./tax-currency-receipt-obligations.md), [`marketplace-payout-hooks.md`](./marketplace-payout-hooks.md)) describe how the hosted HoBo offering itself is launched, billed, and operated as a business — vendor operating records with their own M0/M1 phasing, not platform capabilities, so they do not move the ADR-0064 cut line."

CONDITIONAL LINK STEP: open `docs/design/adr/index.md` and search its Index table for an ADR whose title covers the productization/launch-record scope boundary (it would have been added by the remediations for findings cand-16/cand-17, in `docs/design/adr/07-portability-extensibility.md` under the next free global ADR ID). If such an ADR exists, append to the end of item (2) of the new paragraph: " Boundary decision: [ADR-NNNN](./adr/07-portability-extensibility.md#adr-nnnn)." with NNNN replaced by that real ID. If no such ADR exists, append nothing and leave the paragraph exactly as given above (no dangling link, no placeholder).

DO NOT create any new file, new ADR, or new index row. All six linked docs already exist in `docs/design/`. Register bookkeeping (done in the same change, per GAPS.md conventions): add a `### REM-cand-26` entry under `## Remediations` in `GAPS.md` recording Action/Acceptance/Effort/Delivery-link, and set cand-26's Drift-register row status to 🧯 remediation documented.

**Acceptance**

Checklist:
1. `docs/design/index.md` Scope paragraph names BOTH bounds; the phrase "bounded only by" no longer appears anywhere in the file (verify: `grep -c "bounded only by" docs/design/index.md` returns 0).
2. The paragraph keeps working relative links to `./adr/07-portability-extensibility.md#adr-0063` and `#adr-0064`, and to the six existing commercial-record docs (`billing-launch-policy.md`, `usage-metering.md`, `usage-to-invoice-reconciliation.md`, `entitlements-plan-limits.md`, `tax-currency-receipt-obligations.md`, `marketplace-payout-hooks.md`) — all six files already exist under `docs/design/`.
3. `docs/design/index.md` still has NO YAML frontmatter (first line remains `# HoBo — Design Plan Suite`), and no table rows, `#plan-NN` anchors, or other paragraphs changed.
4. No boundary-ADR link is present unless the referenced `#adr-NNNN` anchor actually exists in `docs/design/adr/07-portability-extensibility.md` and is listed in `docs/design/adr/index.md`.
5. `GAPS.md` gains the `### REM-cand-26` entry and the cand-26 drift-register row is flipped to 🧯.

Runnable validation (from repo root, after `git add docs/design/index.md GAPS.md`):
- `pnpm run docs:okf`
- `pnpm run docs:design-lint`  (catches broken internal links/anchors introduced by the paragraph rewrite)
- `node --import tsx scripts/validate-traceability.ts`  (the real traceability gate — required because `docs/design/index.md` is touched; `scripts/relevant-check-policy.ts` triggers it on exactly this path; there is no shorter pnpm alias)
- `pnpm agent:check -- --staged`

Cross-links to update: none gained elsewhere — the edit is inside the design-suite hub itself; no other index/hub file (docs/index.md, docs/design/adr/index.md, AGENTS.md, README.md) references the old scope wording, so nothing else needs a link or text change.

**Guardrails**

- Documentation-only: change one paragraph in `docs/design/index.md` plus GAPS.md bookkeeping; do not edit, renumber, or reword ADR-0063/ADR-0064 themselves — their decisions stand, only the hub's summary sentence was stale.
- Do NOT create the productization-boundary ADR here; that belongs to the cand-16/cand-17 remediations. Only link it if it already exists (verified via `docs/design/adr/index.md`), otherwise omit — never insert an `ADR-NNNN` placeholder or guess an ID.
- Do NOT add YAML frontmatter to `docs/design/index.md` (index.md files must have none).
- Do NOT delete or relocate the commercial-record docs or their index rows; the remediation legitimizes them as a named category, it does not remove them.
- Keep all links relative (`./…` / `./adr/…`); do not introduce absolute or repo-root paths inside docs/design/.
- Standing rule: the Nomad→wasmCloud pivot is accepted; nothing in this change may reopen it.
- Commit style: conventional scoped commit (e.g. `docs(design): state both scope bounds in design-suite index (cand-26)`).

### REM-022 (for DRIFT-008)

- **Finding** (cand-27, L-CONS, LOW, votes uphold/uphold/refute, drift-class silent): gap-analysis.md's traceability anchors have rotted: matrix and §C rows cite numbered open questions (Q3/Q10/Q12/Q15-Q20/Q21-Q23, '09 §15-20') linking to generated-stack.md#plan-09, but the current Plan 9 'Open design questions' list is unnumbered and contains none of those IDs, and matrix rows retain partial/missing markers for capabilities the same doc later records as closed (only §2 is explicitly labeled historical).
- **Evidence:** `docs/competitors/gap-analysis.md:31` · `docs/competitors/gap-analysis.md:34` · `docs/competitors/gap-analysis.md:72` · `docs/competitors/gap-analysis.md:138` · `docs/design/generated-stack.md:352`
- **Effort:** M · **Delivery:** ✔ [HOBO-687](https://linear.app/quickdeploy-ai/issue/HOBO-687) — historical open-question ledger + link retargets

**Action**

Remediation for cand-27 (traceability-anchor rot between gap-analysis.md and generated-stack.md's open questions). Strategy per the sketch's first option: restore the stable historical question IDs as a resolution ledger inside Plan 09, re-point every Q-ID cross-reference at it, and banner the two gap-analysis sections that still read as current state. No new ADR is needed (no architectural decision — pure traceability repair). Four files amended, zero created.

FILE 1 — AMEND C:/src/hobo/docs/design/generated-stack.md
Insert a new h3 at end of file, directly after the last bullet of "### Open design questions" (currently line 352-365; last bullet is the "Low-risk auto threshold" item):

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

**Action**

Amend exactly three archived docs (no files created, no docs/design/ changes, no new ADR needed — this is a pure link-remap; next free ADR ID is not consumed).

FILE 1 + 2 — C:/src/hobo/docs/archive/requirements/index.md and C:/src/hobo/docs/archive/requirements/requirements.md
Apply these literal find-replace passes IN THIS ORDER, across the whole file including the YAML frontmatter of requirements.md (its `description:` field contains a stale link):
1. `../design/adr/08-scope-and-requirements.md#` -> `../design/adr/07-portability-extensibility.md#`  (covers adr-0018/0019/0021/0063/0064; verified those `## ADR-00xx` headings exist in 07-portability-extensibility.md)
2. `../design/adr/04-governance-verification.md#` -> `../design/adr/02-identity-security.md#`  (covers adr-0039/0045/0046/0060/0061; requirements.md uses 0046/0061)
3. `../design/adr/06-ai-generation-operators.md#` -> `../design/adr/03-data-plane.md#`  (covers adr-0025/0056)
4. `../design/forge-generated-stack.md` -> `../design/generated-stack.md`  (anchors #plan-09 and #plan-23 exist in docs/design/generated-stack.md)
5. `../design/roadmap.md` -> `../roadmap.md`  (the roadmap itself moved to docs/archive/roadmap.md; anchors #plan-08 and #per-stage-build-detail-stages-06 exist there; requirements.md has 11 such links, index.md has 1)
6. `](../competitors/` -> `](../../competitors/`  (targets aspire/convex/humanitec/nitric/shoo/index.md all exist under docs/competitors/)
7. LAST: `](../design/` -> `](../../design/`  (generic base-path fix for every remaining design link, ~184 in requirements.md, ~14 in index.md; do NOT touch plain-text/code-span mentions of `docs/design/*` — only occurrences prefixed by `](`)
Then add one archive-note line:
- index.md: append to the top blockquote (after the `**Status:**` line, as a new `>` line): `> **Archive note:** this suite was moved under docs/archive/ and its links remapped — design paths resolve via ../../design/, the roadmap lives beside this suite at ../roadmap.md, forge-generated-stack.md is now generated-stack.md, and the former ADR theme docs 04/05/06/08 were consolidated into the four current theme docs (see ../../design/adr/index.md).`
- requirements.md: same sentence appended as a new `>` line at the end of the intro blockquote (after the current line 12). Keep the existing OKF frontmatter (type: Archived Reference) untouched apart from the pass-1/7 rewrite inside `description:`. index.md must remain frontmatter-free.

FILE 3 — C:/src/hobo/docs/archive/roadmap.md
Apply IN THIS ORDER:
1. `](./adr/08-scope-and-requirements.md#` -> `](../design/adr/07-portability-extensibility.md#`  (3 occurrences, adr-0064)
2. `](./adr/04-governance-verification.md#` -> `](../design/adr/02-identity-security.md#`  (6 occurrences: adr-0039/0045/0060/0061)
3. `](./adr/05-config-matching-environments.md#` -> `](../design/adr/01-architecture-core.md#`  (1 occurrence, adr-0040)
4. `](./forge-generated-stack.md` -> `](../design/generated-stack.md`  (13 occurrences)
5. `](./adr/` -> `](../design/adr/`  (remaining links to theme docs 01/02/03/07 — already correctly named, only the base path changes)
6. LAST: `](./` -> `](../design/`  (all remaining same-dir design links, ~130 occurrences; within-doc anchors use `](#...` and are untouched by this pattern)
Then add the archive-note line directly under the existing line 10 ("This capability doc consolidates Plan 8 ..."): `> **Archive note:** this doc was moved under docs/archive/ and its links remapped — design paths resolve via ../design/, forge-generated-stack.md is now generated-stack.md, and the former ADR theme docs 04/05/08 were consolidated into the four current theme docs (see ../design/adr/index.md).` Keep its existing OKF frontmatter untouched.

Hub/index files: NONE need new links — docs/index.md line 27 already links `./archive/` and docs/design/index.md line 116 already links `../archive/`; do not edit them. Do NOT extend scripts/check-design-docs.ts (DEFAULT_SCAN_PATHS) to docs/archive/ in this change — its event-family and SDK-disambiguation checks would false-positive on archived content; that is a separate optional follow-up finding.

**Acceptance**

All commands from repo root C:/src/hobo (use Git Bash for the node one-liner).
1. `pnpm run docs:okf` — passes: requirements.md and roadmap.md keep non-empty `type:` frontmatter; docs/archive/requirements/index.md stays frontmatter-free.
2. `git add docs/archive && pnpm agent:check -- --staged` — passes (staged relevant-checks lane).
3. Traceability gate: NOT triggered — this change touches no docs/design/ file. (If any docs/design/ file were touched, the real gate is `node --import tsx scripts/validate-traceability.ts`, which `pnpm agent:check -- --staged` auto-includes per scripts/relevant-check-policy.ts lines 74/149 — there is no package.json alias for it.)
4. Stale-pattern greps — each must produce NO output (rg exit code 1):
   - `rg '\]\(\.\./design/' docs/archive/requirements`
   - `rg '\]\(\./' docs/archive/roadmap.md`
   - `rg 'forge-generated-stack' docs/archive`
   - `rg 'adr/0[4568]-' docs/archive`
   - `rg 'design/roadmap\.md' docs/archive`
   - `rg '\]\(\.\./competitors/' docs/archive`
5. Link-target resolution (must print nothing and exit 0):
   `node -e "const fs=require('fs'),p=require('path');let bad=0;for(const f of ['docs/archive/requirements/index.md','docs/archive/requirements/requirements.md','docs/archive/roadmap.md']){const c=fs.readFileSync(f,'utf8');for(const m of c.matchAll(/\]\(([^)#\s]+\.md)/g)){const t=p.resolve(p.dirname(f),m[1]);if(!fs.existsSync(t)){bad++;console.log(f,'->',m[1]);}}}process.exit(bad?1:0)"`
6. Spot anchor checks — each must match: `rg -c '^## ADR-0063' docs/design/adr/07-portability-extensibility.md`; `rg -c '^## Plan 09' docs/design/generated-stack.md`; `rg -c '^## Plan 08' docs/archive/roadmap.md`; `rg -c '^### Per-stage build detail' docs/archive/roadmap.md`.
7. Each of the three files contains exactly one "**Archive note:**" line: `rg -c 'Archive note' docs/archive` shows 1 per file.
Cross-links to update: only the three archive files themselves; docs/index.md, docs/design/index.md, and CLAUDE.md already point at docs/archive/ correctly and must not change.

**Guardrails**

Documentation-only: touch nothing outside docs/archive/requirements/index.md, docs/archive/requirements/requirements.md, docs/archive/roadmap.md. Do not move the archived docs back under docs/design/ and do not reverse any archive/pivot decision (Nomad->wasmCloud pivot is accepted and unrelated). Do not create or renumber ADRs; do not edit docs/design/adr/* or any docs/design/ file (that would trigger the traceability gate needlessly). Do not modify scripts/check-design-docs.ts or any script. Preserve existing OKF frontmatter (`type: Archived Reference`) on requirements.md and roadmap.md; keep docs/archive/requirements/index.md free of frontmatter. Apply the find-replace passes in the exact order given (specific renames/retargets BEFORE the generic `](../design/` -> `](../../design/` and `](./` -> `](../design/` passes, otherwise the generic pass corrupts the specific targets). Preserve all `#anchor` fragments verbatim (lowercase); only file paths change except where the mapping table says the ADR theme filename changes. Do not "fix" plain-text or code-span mentions like `docs/design/0–36` — only markdown link targets starting with `](`.

### REM-025 (for GAP-017)

- **Finding** (cand-30, L-CONS, LOW, votes uphold/uphold/uphold): The canonical glossary — declared the single source of truth for canonical term definitions — omits the FinOps control plane's coined vocabulary (ResourceIntent, metric contract, MetricVector, ParetoFrontier, decision graph, DX/OpsX/FinX surfaces) and the ubiquitous 'Crew' alias, even though newer Meta-cloud Broker terms were added, showing the maintenance path exists but skipped the FinOps delta.
- **Evidence:** `docs/design/glossary.md:10-14` · `docs/design/finops-budget-routing-control-plane.md:51-83` · `docs/design/glossary.md:49-62` · `docs/design/index.md:24`
- **Effort:** S · **Delivery:** ✔ [HOBO-690](https://linear.app/quickdeploy-ai/issue/HOBO-690) — seven FinOps/Crew rows in `docs/design/glossary.md`

**Action**

Amend ONE existing file: `docs/design/glossary.md` (keep its existing OKF frontmatter untouched; do NOT create any new file, ADR, or index row — the glossary is already linked from `docs/design/index.md` line "The canonical term source is [`glossary.md`](./glossary.md)").

Insert exactly 7 new rows into the existing `| Term | Definition |` table, preserving the table's alphabetical ordering (backticked `@hobo/*`/`hobo:sdk` rows stay at the bottom). Exact rows and placement:

1. Between `| Contract Manifest | ... |` and `| Cross-App Access | ... |` insert:
`| Crew | Alias for Operator Agents — the built-in autonomous Yard services roster; see the Operator Agents row and [operators-sre.md](./operators-sre.md#plan-40). |`

2. Between `| Cross-App Access | ... |` and `| Delta | ... |` insert:
`| Decision graph | Per-decision explainability artifact (\`DecisionGraph\`) emitted by the FinOps routing control plane, recording candidates generated/rejected, constraint results, policy outcomes, metric vectors, Pareto frontier, preference result, stability decision, rationale, and audit references; DX/OpsX/FinX surfaces read this same graph ([finops-budget-routing-control-plane.md](./finops-budget-routing-control-plane.md)). |`

3. Between `| Driver | ... |` and `| Environment group | ... |` insert:
`| DX / OpsX / FinX surfaces | The three FinOps control-plane product surfaces over the same decision graph: DX (intent spec, dry-run preview, simulation, "why this placement?"), OpsX (override, freeze, rollback, migrate, incident reroute, blast-radius controls), and FinX (budgets, forecasts, attribution, anomaly signals, commitments, optimization recommendations). |`

4. Between `| Meta-cloud Broker | ... |` and `| Obligation | ... |` insert:
`| Metric contract | Governed definition (\`MetricContract\`) of a routing metric's semantics, units, source, normalization, and version under the three-tier model: Tier 0 immutable system metrics, Tier 1 derived metrics via approved transforms, Tier 2 composition-only approved user metrics. |`

5. Immediately after the new `Metric contract` row insert:
`| MetricVector | Per-candidate vector of metric-contract values (cost, reliability, latency, risk, approved custom metrics) evaluated after constraint filtering and used to build the Pareto frontier. |`

6. Between `| Operator Agents | ... |` and `| Planner | ... |` insert:
`| Pareto frontier | Non-dominated candidate set (\`ParetoFrontier\`) built across metric dimensions; preference weights select only within it — the router never uses one global weighted score, and a stability controller may still override the preferred candidate. |`

7. Between `| ResourceActor | ... |` and `| Run | ... |` insert:
`| ResourceIntent | Provider-neutral infrastructure request that enters the FinOps routing pipeline as its canonical input, before candidate generation; the router core must not see provider names, SKUs, regions, account IDs, or backend API names. |`

Do NOT edit `docs/design/finops-budget-routing-control-plane.md`, `docs/design/index.md`, or `docs/design/operators-sre.md`. Do NOT add a design-lint rule in this change; if desired, record the sketch's lint idea ("terms coined/bolded in capability docs must appear in the glossary") only as an optional follow-up note in the Linear issue body, not as code.

**Acceptance**

Checklist:
1. `docs/design/glossary.md` gains exactly 7 rows (Crew, Decision graph, DX / OpsX / FinX surfaces, Metric contract, MetricVector, Pareto frontier, ResourceIntent) at the alphabetical positions listed in the action; no existing row is removed, reworded, or reordered; frontmatter unchanged.
2. No term duplicates an existing Term-column entry (the `docs:design-lint` gate fails on `duplicate-glossary-term`).
3. Relative links used in the new rows resolve from `docs/design/`: `./operators-sre.md#plan-40` and `./finops-budget-routing-control-plane.md` (both files exist in the same directory).
4. No new files created, so no index/hub links need to change; `docs/design/index.md` already links the glossary.

Runnable validation commands (from repo root, after `pnpm run setup` if needed):
- `pnpm run docs:okf`
- `pnpm run docs:design-lint` (this is the gate that owns the glossary table: duplicate terms, broken relative links/anchors)
- `pnpm agent:check -- --staged` (stage the glossary change first with `git add docs/design/glossary.md`)
- `node --import tsx scripts/validate-traceability.ts` (traceability gate; there is no pnpm alias for it in package.json — this is the exact command CONTRIBUTING.md and the PR template use; run it because `docs/design/` is touched, expect it to pass unchanged)

**Guardrails**

Documentation-only change: touch a single existing file, no code, no new lint rules, no changes to scripts/. Never renumber or reword existing glossary rows or ADRs; only insert rows. Keep the table's one-sentence definition style and escape any literal pipe characters inside definitions. Use relative `.md` links only (same-directory `./` form). Do not touch the Nomad->wasmCloud pivot or any runtime decisions. Do not add frontmatter changes to glossary.md and do not add frontmatter to any index.md. If `docs:design-lint` flags a duplicate term, resolve by merging into the existing row rather than renaming the canonical term.

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

**Action**

Documentation + executable proof (no new ADR):

1. `docs/design/developer-experience.md` — Plan 07 inner-loop section gains `##### Local multi-service orchestration — lifecycle annotations under hobo dev` with a normative matrix naming local lifecycle behavior for each Plan 21 annotation class (`bind`, endpoints, env/args, storage, lifetime, explicit startup, `waitFor`, `waitForCompletion`, health, replicas, scaling, residency).
2. `src/draft/technical-proofs/local-dev-orchestration-contract/` — independent POC proving dependency-gated startup, health/job gates, explicit startup, parallel roots, lazy env resolution, local replica labels, reverse shutdown order, and cycle detection.
3. `docs/design/proofs/hobo-694-local-dev-orchestration/index.md` + `docs/design/traceability.md` HOBO-694 / PLAN-07 rows.

**Acceptance**

1. Plan 07 inner-loop section names local lifecycle behavior for each annotation class.
2. `pnpm run docs:design-lint` + `pnpm agent:check -- --staged` pass.

**Guardrails**

Docs-first; Nomad→wasmCloud pivot accepted — never reverse. No production `runtime-local` or CLI daemon implementation in this slice.

### REM-027 (for GAP-019)

- **Finding** (iter2-B1-002, P3×P4, MED): ResourceIntent FinOps pipeline disconnected from IfC/`hobo plan` spine.
- **Evidence:** `docs/design/finops-budget-routing-control-plane.md:22-36` · `docs/design/control-plane.md:14-28`
- **Effort:** M · **Delivery:** ✔ [HOBO-696](https://linear.app/quickdeploy-ai/issue/HOBO-696) — manifest→ResourceIntent bridge in finops + control-plane docs; proof at `src/draft/technical-proofs/manifest-resource-intent-bridge-contract/`

**Action**

Add a bridge subsection to `finops-budget-routing-control-plane.md` and `control-plane.md` Planner section: map manifest IR / Matching output / `hobo plan` preview → `ResourceIntent` construction, DecisionGraph emission, and DX dry-run surface. One sequence diagram or numbered pipeline acceptable.

**Acceptance**

1. Both docs cite the same bridge; grep `ResourceIntent` in control-plane + authoring returns hits.
2. Gates green per REM-026.

### REM-028 (for GAP-020)

- **Finding** (iter2-B1-003, P3×P4, MED): `costAvailability()` orphaned in ADR-0039 only.
- **Evidence:** `docs/design/adr/02-identity-security.md:285-295` · `docs/design/reliability-observability-cost.md:175-177`
- **Effort:** M · **Delivery:** ✔ [HOBO-693](https://linear.app/quickdeploy-ai/issue/HOBO-693) — Plan 21 FinOps inline-budget section + ADR-0039 `costAvailabilityProfile` alignment + `inline-budget-authoring` proof

**Action**

Docs-first remediation with an executable exp-proof (no new ADR — ADR-0039 already decided the profile shape).

1. `docs/design/authoring-resources-wiring.md` — add `### FinOps — inline budget & cost-availability` (anchor `#finops-inline-budget--cost-availability`) before the DNS section: scope-declaration table (`budget`, `spendCapUsd`, `costAvailabilityProfile`), inline Camp policy example, `hobo plan` Cost & budget surfacing (projected cost, headroom, tier preview, JSON envelope fields), manifest IR `policy` sketch, and link to the exp-proof.

2. `docs/design/adr/02-identity-security.md` — ADR-0039 §4: rename the example helper from `costAvailability(` to `costAvailabilityProfile(`; add one cross-link sentence pointing at Plan 21 `#finops-inline-budget--cost-availability`. Do not reword other decision bullets.

3. CREATE `src/draft/exp-proofs/dx/inline-budget-authoring/` — independent POC proving declaration normalization + plan budget surfacing (human + JSON) against mocked MeteringView/policy fixtures; link from Plan 21.

4. CREATE `docs/design/proofs/hobo-693-inline-budget-authoring/index.md` — proof record mapping acceptance bullets to test names.

**Acceptance**

1. Plan 21 documents inline `budget()`, `costAvailabilityProfile()`, and agent `spendCapUsd` declarations plus `hobo plan` Cost & budget surfacing.
2. ADR-0039 §4 example uses `costAvailabilityProfile(` and links back to Plan 21.
3. `src/draft/exp-proofs/dx/inline-budget-authoring` tests pass.
4. Gates green.

**Guardrails**

Documentation-first: do not implement policy-engine or MeteringView runtime. Do not create a new ADR or renumber existing ADRs. Keep relative `.md` links valid. The exp-proof is contract-only over mocked seams.

### REM-029 (for GAP-021)

- **Finding** (GAP-021, P4×P5, MED): Per-token LLM inference budgets are promised in the AI governance plane but unspecified — no `TokenBudget` object, pre-inference gate seam, inference-token metering dimensions (distinct from auth `token.*`), or spend-breaker coupling.
- **Evidence:** `docs/design/governance-planes.md:118-119` · `docs/design/reliability-observability-cost.md:210-216`
- **Effort:** M · **Delivery:** ✔ [HOBO-695](https://linear.app/quickdeploy-ai/issue/HOBO-695) — `TokenBudget` object + `evaluateInferenceTokenBudget` gate seam in governance + Plan 05; glossary row; executable draft POC

**Action**

1. Amend `docs/design/governance-planes.md` — insert **Per-token inference budgets** subsection (object JSON, authoring, gate seam, post-call metering, spend-breaker coupling) before "The four lenses" under AI safety & model governance; link proof index + draft POC.
2. Amend `docs/design/reliability-observability-cost.md` — extend **Budgets, caps & guardrails** with inference token budget bullet; extend **Metering** dimension list with `inference-tokens-input` / `inference-tokens-output` and OpenInference source; disambiguate from auth `token.*`.
3. Amend `docs/design/glossary.md` — insert **Token budget** row alphabetically between `The notify port` and `WIT interface`.
4. Add proof index `docs/design/proofs/hobo-695-token-budget-governance/index.md` linking acceptance to the draft POC.
5. Add draft POC `src/draft/technical-proofs/token-budget-governance-contract/` (protobuf/CUE/PACT evidence + `evaluateInferenceTokenBudget` contract tests).

Do NOT create a new ADR (extends ADR-0039/Plan 05 in place). Do NOT implement production MeteringView projection, policy engine, or model runtime.

**Acceptance**

Checklist:
1. Design docs define `TokenBudget` object fields (scope, period, input/output/total soft+hard limits) and `evaluateInferenceTokenBudget` pre-inference gate seam with seq-pinned `MeteringView`, `policy.Decided`, and `inference.BudgetGateEvaluated`.
2. Docs explicitly distinguish LLM inference tokens from auth `token.*` credential events.
3. Glossary gains exactly one **Token budget** row; no duplicate terms.
4. Draft POC tests cover soft warn, hard deny, missing metering fail-closed, and scope-evasion guard.
5. Gates green (see commands below).

Runnable validation commands (from repo root):
- `pnpm run docs:okf`
- `pnpm run docs:design-lint`
- `pnpm --prefix src/draft/technical-proofs/token-budget-governance-contract test`
- `pnpm agent:check -- --staged`
- `node --import tsx scripts/validate-traceability.ts`

**Guardrails**

Primary delivery is documentation; the draft POC is an independent contract proof only. Touch only the files listed in Action. Preserve existing OKF frontmatter. Use relative `.md` links. Do not edit `traceability.md` or `adr/index.md` unless a gate requires it.

### REM-030 (for GAP-022)

- **Finding** (iter2-B1-005, P5×L-DRIFT, MED): Crew/MCP/autonomy missing from known-limitations register while launch-messaging scopes Crew to future-roadmap.
- **Evidence:** `docs/design/launch-messaging-claims.md:63` · `docs/design/known-limitations-register.md:38-44`
- **Effort:** S · **Delivery:** [HOBO-697](https://linear.app/quickdeploy-ai/issue/HOBO-697)

**Action**

Add known-limitations rows for built-in Crew autonomy scope (owner, workaround, customer-facing wording alignment with launch-messaging-claims.md).

**Acceptance**

1. Register contains ≥1 Crew/MCP limitation row with owner + workaround.
2. `pnpm run docs:design-lint` passes.

### REM-031 (for GAP-023)

- **Finding** (iter2-B1-006, L-CONS, MED): patterns/standards cross-links rot to removed design paths.
- **Evidence:** `docs/patterns/runtime-code-mutation-persistence.md:37-46` · `docs/patterns/gitops-runbook-promotion.md:44`
- **Effort:** M · **Delivery:** ✔ [HOBO-698](https://linear.app/quickdeploy-ai/issue/HOBO-698) — PR #772; link-guard proof at `src/draft/technical-proofs/patterns-standards-cross-links/`

**Action**

Bulk-fix relative links in `docs/patterns/*.md` and audit `docs/standards/*.md`: map `forge-generated-stack.md`→`generated-stack.md`, `event-model.md`→`data-plane.md#plan-11`, `verification.md`→`generated-stack.md#plan-09`, ADR theme file renames per current `docs/design/adr/index.md`.

**Acceptance**

1. `pnpm run docs:design-lint` passes on patterns + standards paths (or documented follow-up if lint scope excludes — note in issue).
2. Zero links to nonexistent `forge-generated-stack.md` / `event-model.md` under patterns.

### REM-032 (for GAP-024)

- **Finding** (cand-31, P5, MED, votes uphold/uphold/uphold): Issue-worker automation (`docs/automations/hobo-issue-worker.md`) defines claim protocol and repo guardrails but never maps them to the agent-native safety model — BR-011 / Plan 06 guardrails (`require-approval`, `spendCapUsd`, destroy protection, SafetyEnvelope) are absent, so the automation sits outside the platform's autonomous-operation contract.
- **Evidence:** `docs/automations/hobo-issue-worker.md:147-155` · `docs/archive/requirements/requirements.md:162` · `docs/design/ai-native-agent-auth.md:114-116` · `docs/design/adr/02-identity-security.md#adr-0094`
- **Effort:** S · **Delivery:** ✔ [HOBO-702](https://linear.app/quickdeploy-ai/issue/HOBO-702) — agent-native guardrails mapping table + executable proof at `src/draft/technical-proofs/issue-worker-guardrail-mapping-contract/`

**Action**

Documentation-only for design suite: amend `docs/automations/hobo-issue-worker.md` and add an executable mapping proof under `src/draft/technical-proofs/issue-worker-guardrail-mapping-contract/`.

1. `docs/automations/hobo-issue-worker.md` — insert `## Agent-native guardrails (BR-011, Plan 06)` after **Codex automation settings** with a mapping table citing BR-011, FR-022, Plan 06, Plan 29, and ADR-0094; retag the embedded prompt `GUARDRAILS` header to reference the mapping.
2. `src/draft/technical-proofs/issue-worker-guardrail-mapping-contract/` — independent POC pinning the mapping as executable contract evidence.
3. `GAPS.md` — add GAP-024 register row and this REM-032 section.

**Acceptance**

1. `docs/automations/hobo-issue-worker.md` cites BR-011 and Plan 06 guardrails with the mapping table.
2. Draft proof tests pass and assert the automation doc cites BR-011/Plan 06 guardrails.
3. `pnpm run docs:okf` and `pnpm agent:check -- --staged` pass.

**Guardrails**

Do not touch `docs/design/` files. No new ADR. Preserve OKF frontmatter on `hobo-issue-worker.md`. Relative `.md` links only.

### REM-033 (for GAP-025)

- **Finding** (iter2-B2-001, P3, MED): dapr.md Bindings + Distributed lock overclaim.
- **Evidence:** `docs/competitors/dapr.md:50,54,121`
- **Effort:** S · **Delivery:** ✔ [HOBO-699](https://linear.app/quickdeploy-ai/issue/HOBO-699) — dapr.md Bindings/Distributed lock downgraded to 🔜 with design anchors; guard at `src/draft/exp-proofs/dx/dapr-parity-anchor-audit/`

**Action**

Downgrade/fix `dapr.md` HoBo-mapping rows: Bindings → partial (name blob-events/triggers/schedule/api adapters); Distributed lock → ◐ actor-lease only unless `hobo:lock` added. Add executable guard at `src/draft/exp-proofs/dx/dapr-parity-anchor-audit/`.

**Acceptance**

1. No ✅ on Bindings or Distributed lock without design anchor.
2. Gates green.

### REM-034 (for GAP-026)

- **Finding** (iter2-B2-002, P2, MED): aspire.md Hosting.Testing overclaim vs conformance-only harness.
- **Evidence:** `docs/competitors/aspire.md:471`
- **Effort:** S · **Delivery:** ✔ [HOBO-705](https://linear.app/quickdeploy-ai/issue/HOBO-705) — `Aspire.Hosting.Testing` row is ◐ at `aspire.md:471` with a whole-graph-harness iteration hook; acceptance (no ✅ without harness spec) satisfied.

**Action**

Change `Aspire.Hosting.Testing` row to ➕ or ◐; point to `@hobo/conformance` + epic proofs as partial; note missing DistributedApplicationTestingBuilder equivalent.

**Acceptance**

1. Row status not ✅ without whole-graph harness spec.
2. Gates green.

### REM-035 (for GAP-027)

- **Finding** (iter2-B2-003, P2, MED): aspire.md WaitFor overclaim vs Provisioned-only orchestrator.
- **Evidence:** `docs/competitors/aspire.md:452` · `docs/design/control-plane.md:57-67`
- **Effort:** S · **Delivery:** ✔ [HOBO-703](https://linear.app/quickdeploy-ai/issue/HOBO-703)

**Action**

Downgrade WaitFor/WaitForCompletion row to ◐ in `aspire.md`; align with REM-026 local/deploy semantics once documented.

**Acceptance**

1. Tracker row ◐ or notes health/readiness gap.
2. Gates green.

### REM-036 (for GAP-028)

- **Finding** (iter2-B1-008, L-CONS, LOW): runtime-code-mutation pattern stale vs ADR-0048.
- **Evidence:** `docs/patterns/runtime-code-mutation-persistence.md:37` · `docs/design/generated-stack.md:35`
- **Effort:** S · **Delivery:** ✔ [HOBO-700](https://linear.app/quickdeploy-ai/issue/HOBO-700) — pattern doc cites ADR-0048, reframes write-back as decided; guard at `src/draft/technical-proofs/hobo-700-runtime-code-mutation-pattern-adr-contract/`

**Action**

Update pattern doc intro: cite ADR-0048 answer; reframe "unanswered" as historical; fix cross-links per REM-031 mapping. Add executable guard at `src/draft/technical-proofs/hobo-700-runtime-code-mutation-pattern-adr-contract/`.

**Acceptance**

1. Pattern doc links ADR-0048; no "unanswered" without deferral pointer.
2. Gates green.

### REM-037 (for DRIFT-009)

- **Finding** (iter2-B2-004, L-DRIFT, HIGH): UI generation mis-cited OUT contradicting ADR-0064 keep list.
- **Evidence:** `docs/design/architecture.md:171` · `docs/design/stage-6-production-hardening-acceptance.md:71` · `docs/design/adr/07-portability-extensibility.md:293-300`
- **Effort:** M · **Delivery:** ✔ [HOBO-704](https://linear.app/quickdeploy-ai/issue/HOBO-704) — all four docs affirm app/UI generation IN scope (ADR-0056/0064 keep list); `UI-layer generation…out…ADR-0064` grep clean in `docs/design/`; pinned by proof `hobo-704-adr-0064-ui-generation-citation`.

**Action**

Fix mis-citations in architecture.md, stage-6 scope-out, worked-example.md, gap-analysis.md: replace "UI-layer generation out (ADR-0064)" with correct boundary — **business/monetization out; app generation IN per ADR-0064 §1 + ADR-0056**. Do not amend ADR-0064 decision text.

**Acceptance**

1. grep `UI-layer generation.*out.*ADR-0064` in docs/design returns zero false negatives.
2. All four files cite ADR-0056/0064 keep list where UI generation mentioned.
3. Gates green.

### REM-038 (for DRIFT-010)

- **Finding** (iter2-B2-005, L-DRIFT, MED): stage-6 bundles notify as governance plane after ADR-0064 consolidation.
- **Evidence:** `docs/design/stage-6-production-hardening-acceptance.md:65,96` · `docs/design/adr/07-portability-extensibility.md:295`
- **Effort:** S · **Delivery:** ✔ [HOBO-701](https://linear.app/quickdeploy-ai/issue/HOBO-701) — split Scope In + Evidence Required tables

**Action**

Amend `docs/design/stage-6-production-hardening-acceptance.md` only (plus the S6-01 proof README row count and this GAPS.md register update):

1. In **Scope In**, replace the single "Governance planes" row with two rows:
   - **`notify` port (cloud messaging)** — `packages/cloud`; cites ADR-0059 + ADR-0064 §3; explicitly states it is **not** a Plan 46 governance plane.
   - **Governance planes (Plan 46)** — `packages/cloud`, `packages/registry`, `packages/policy`; classification/residency/retention, guardrails, Registry distribution per Plan 46 ADRs — **no** `notify` mention.
2. In **Evidence Required**, mirror the same split: one row for `notify` port evidence, one for Plan 46 governance-plane evidence.
3. Update the lane count from six to seven in the Scope In intro and in `docs/design/proofs/build-s6-01-stage6-acceptance/README.md`.

**Acceptance**

1. Scope In table has distinct `notify` port and Governance planes (Plan 46) rows; neither row bundles both concerns.
2. Evidence Required table mirrors the split.
3. `pnpm run docs:okf`, `pnpm run docs:design-lint`, `pnpm agent:check -- --staged` green.

**Guardrails**

Documentation-only. Do not amend ADR-0064 decision text. Preserve relative links and OKF frontmatter.

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
| NI-009 | The original platform plan's open question 'Local-dev fidelity (networking tiers, auth, quotas, secrets)' is unresolved drift (A2-R2). | Rejected by its own lens: Closed by ADR-0042's simulate/mock/camp-only classification, the fidelity table in developer-experience.md, fidelity labels on the CLI dev verb, and the HOBO-122 proof asserting the labels surface. `docs/design/adr/07-portability-extensibility.md#adr-0042` · `docs/design/developer-experience.md:148-153` · `docs/design/proofs/hobo-122-dev-loop/index.md` |
| NI-010 | Local-dev secret resolution is unspecified (A2-R3). | Rejected by its own lens: Fully covered: hobo dev resolves secretRef against an ordered dev-only ladder (.env.local -> OS keychain -> interactive prompt, CI-skipped), marked non-production, audited as dev, and never satisfying a production can-deploy. `docs/design/authoring-resources-wiring.md:263` · `docs/design/proofs/hobo-392-local-dev-test-authoring/index.md` |
| NI-011 | A Nitric building block (api/kv/bucket/queue/topic/secret/sql/schedule/websocket/job/website) lacks a HoBo resource or recorded rejection (A3-R1). | Rejected by its own lens: Every block has a catalog row with a WIT port, .allow() verbs, and cross-cloud equivalence, plus explicit parity tables in both the design and the competitor doc; residual per-row issues are captured in cand-09/10/11. `docs/design/authoring-resources-wiring.md:35-75` · `docs/design/wasm-runtime-wit.md:117-135` · `docs/competitors/nitric.md:302-318` |
| NI-012 | Multi-language (non-TS) IfC authoring parity vs Nitric's SDKs is missing (A3-R2). | Rejected by its own lens: The wasm/WIT spine plus non-TS SDK path is designed (hobo:sdk WIT-first contract, conformance-gated idiom layers, explicit collection facts, collection-coverage gate for non-TS guests); the remaining run-to-collect-vs-static-analysis depth choice is a recorded open design question — deliberate-documented. `docs/design/adr/01-architecture-core.md#adr-0072` · `docs/design/adr/01-architecture-core.md:259` · `docs/design/generated-stack.md:364` |
| NI-013 | No design-side commitment of the initial provider matrix (A3-R3). | Rejected by its own lens: control-plane.md commits a providers & deploy-targets matrix with a per-port equivalence table, ADR-0024 §7 names the validated seed set, and ADR-0021 gates the >=2-provider portability NFR; which pair ships first is build sequencing, explicitly deferred by ADR-0063 — deliberate-documented. `docs/design/control-plane.md:122` · `docs/design/adr/07-portability-extensibility.md:26` · `docs/design/adr/07-portability-extensibility.md:267` |
| NI-014 | Design drifted from the archived requirements' .allow() model to inferred-from-usage with .allow() as narrow-only override (A3-R4). | Rejected by its own lens: The shift is deliberate and recorded (ADR-0069 §5, Plan 21 permission model), preserves the triple-effect least-privilege guarantee the requirements actually test, and the requirements layer is archived planning material per ADR-0018. `docs/design/adr/01-architecture-core.md:100` · `docs/design/authoring-resources-wiring.md:19` · `docs/design/adr/07-portability-extensibility.md#adr-0018` |
| NI-015 | Shared/amortized cost attribution (multi-tenant Yard services, cross-boundary egress) is silently missing (A4-R1). | Rejected by its own lens: Designed and proof-backed: HOBO-325 proof shows usage-weighted tenant splits summing exactly with a system bucket and deterministic replay; egress is attributed per bind edge by connectivity tier and cross-provider link.Called egress feeds the cost model. `docs/design/proofs/hobo-325-shared-cost-attribution/index.md` · `docs/design/reliability-observability-cost.md:201` · `docs/design/adr/02-identity-security.md:282` |
| NI-016 | The Dispatcher lacks commitment/reserved-capacity awareness (A4-R2). | Rejected by its own lens: ADR-0071 folds committed credits + expiry + budget caps into effective marginal cost via CreditLedgerView, and savings-plan purchase is an explicitly documented advisory-only boundary; the residual owner question (who produces commitment recommendations) is folded into cand-12/cand-13. `docs/design/adr/01-architecture-core.md:221` · `docs/design/reliability-observability-cost.md:240` · `docs/design/finops-budget-routing-control-plane.md:131` |
| NI-017 | Egress-cost modeling in placement decisions is missing (A4-R3). | Rejected by its own lens: The Planner cost model prices egress per bind edge by connectivity tier (same_region/cross_region/internet), penalizes cross-cloud hops so it naturally colocates, and the Dispatcher's amortized switching cost includes egress — backed by the HOBO-363 executable proof. `docs/design/reliability-observability-cost.md:192` · `docs/design/reliability-observability-cost.md:203` · `docs/design/proofs/hobo-363-dispatcher-maximize-credits/index.md:27` |
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
| IMPL-013 | MED | `agent:check` cannot see a suite it did not select. `behaviorChanged` (`scripts/relevant-check-policy.ts:178`) keys the cucumber gate off touched paths matching `(^\|/)features/`, so a change that breaks `features/steps/*` from **outside** `features/` skips the gate entirely. Found live: PR #1032 moved modules the steps import by relative path, leaving `pnpm run test:behavior` at `ERR_MODULE_NOT_FOUND` exit 1 while a staged `agent:check` reported 18 green checks. The same shape applies to any per-file-selected gate whose suite reaches across package boundaries. | `scripts/relevant-check-policy.ts:178`, `features/steps/control-yard-core-loop.steps.ts` | 🧯 follow-up: select the behavior gate from what the steps *import*, not from what the diff touched (or run it unconditionally when any `packages/*/src` path in its import graph changes). Not fixed in #1032 — a repo-wide gating change does not belong in a revert PR |
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


## HoBo.CD closures (2026-11-12, plan 0024)

Appended by plan 0024 WP21. The delivery defects plan 0024 §4 recorded (C1–C23) close with the
merge of `integration/hobo-cd`, which lands `@hobo/cd` and its adapter packages
([ADR-0182](docs/design/adr/01-architecture-core.md#adr-0182),
[continuous-delivery.md](docs/design/continuous-delivery.md)). Each row names the work package
whose named tests carry the closure; the coordinator's final report (plan 0024 §13) holds the
test names and gate results. A row whose owning work package does not merge stays open.

| ID | Defect | Closed by | Status |
|---|---|---|---|
| CD-C01 | Four uncoordinated delivery lanes (`up`, hosting transitions, CD plane, broker) shared no desired state | One desired-state model per Camp; `hobo up`/`down`, `hobo deploy`, broker `deliver`, pipelines and MCP all deliver through `@hobo/cd` (WP4, WP7, WP15, WP16, WP18) | ✔ with the plan 0024 merge |
| CD-C02 | The CD plane ran only on fixtures | The fixture-only `@hobo/cloud` CD plane is deleted; fixtures are reachable only with `--simulate`, labelled in every result (WP7, WP18) | ✔ with the plan 0024 merge |
| CD-C03 | Evidence failed open (`healthSamples ?? [{}, {}]`) | Deterministic verification; no data is FAIL (I5) (WP9, WP10) | ✔ with the plan 0024 merge |
| CD-C04 | Rollback never re-applied the prior Set | Rollback is zero exposure, then a Delta to the predecessor Set through the same gate (I7) (WP6, WP7) | ✔ with the plan 0024 merge |
| CD-C05 | "Gateway-weighted" changed no traffic; three ramp vocabularies | Capability lowering onto traffic rungs; one ramp engine and `CD_RAMP_DEFAULTS` (WP10, WP14) | ✔ with the plan 0024 merge |
| CD-C06 | Kubernetes fields in a neutral broker type | Neutral `DeliveryPolicy`; `destination_namespace` never read; `argo` mapped to a `cd-gitops` publisher (WP16; [upgrade notes](docs/design/delivery-policy-upgrade.md)) | ✔ with the plan 0024 merge |
| CD-C07 | No Freight/artifact contract between any build and CD | Freight, the Freight manifest and ingest (WP1, WP3) | ✔ with the plan 0024 merge |
| CD-C08 | Imperative `deliver(set)`; no reconciler for drift | Fenced per-Camp pull reconcilers, drift by observation (I2, I4) (WP7) | ✔ with the plan 0024 merge |
| CD-C09 | Promotion semantics undecided | Promote carries Freight and re-runs Matching per Camp (D2); decided in [gitops-runbook-promotion.md](docs/patterns/gitops-runbook-promotion.md) (WP6, WP21) | ✔ with the plan 0024 merge |
| CD-C10 | Plan 25's Relay is a reverse tunnel | Agent-mode reconcilers read an outbound-only delivery feed (WP11; Plan 25 rewritten) | ✔ with the plan 0024 merge |
| CD-C11 | No multi-node fenced store | `@hobo/storage-postgres` passes the EventStore suite (WP17) | ✔ with the plan 0024 merge |
| CD-C12 | Six hosting providers had no resolver; the long tail could never be covered in-tree | In-tree resolvers added; out-of-tree `hobo:resolver` WASM components (I14) (WP8, WP13, WP14) | ✔ with the plan 0024 merge |
| CD-C13 | No delivery authorization, metrics or visibility | `CdAction` authorization, OTel CI/CD telemetry, DORA, service read API (WP12, WP19) | ✔ with the plan 0024 merge |
| CD-C14 | No artifact store or retention | Content-addressed artifact store and retention (WP1, WP3) | ✔ with the plan 0024 merge |
| CD-C15 | Ingress push-only and tied to HoBo CI | Pull Freight sources; OIDC trusted publishing; in-toto/SLSA; CDEvents nudges (I15) (WP1, WP2) | ✔ with the plan 0024 merge |
| CD-C16 | No lineage | Pipeline graph with qualification, soak and expiring approvals (I16) (WP5, WP6) | ✔ with the plan 0024 merge |
| CD-C17 | No change windows, data-migration sequencing or config-only path | Change windows (I17), Trails sequencing, Delta intent `config` (WP5, WP6) | ✔ with the plan 0024 merge |
| CD-C18 | Explicit Camp lists only; no groups, concurrency, failure budget or quorum | Placement and fan-out (I18, I20) (WP22, WP23) | ✔ with the plan 0024 merge |
| CD-C19 | No Camp liveness, conditions, taints or failover | Camp inventory and governed failover (I21) (WP22, WP23) | ✔ with the plan 0024 merge |
| CD-C20 | Single-approval enrollment; agent facts could be trusted by accident | Double opt-in enrollment; claims only narrow (I19, I24) (WP11, WP22) | ✔ with the plan 0024 merge |
| CD-C21 | Rails activated everywhere at once | Rails delivered as Freight, INFORM before ENFORCE (I23) (WP2, WP5, WP24) | ✔ with the plan 0024 merge |
| CD-C22 | Policy was admission-time only | Continuous posture, compliance and OSCAL assessment results (I22) (WP24) | ✔ with the plan 0024 merge |
| CD-C23 | No way to use an existing Karmada/OCM estate or Kubernetes cluster inventory | `@hobo/cd-kube-fleet` as transport and inventory only (WP25) | ✔ with the plan 0024 merge |

Related existing rows: IMPL-004 already recorded `hobo deploy` as implemented; its delivery semantics
are now HoBo.CD's (`docs/design/cli-spec.md`). No existing GAP or DRIFT row is reopened or
rewritten by this section.
