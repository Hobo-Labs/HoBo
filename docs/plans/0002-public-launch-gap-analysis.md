---
type: Review Findings
title: "Public-launch gap analysis — what remains before HoBo can launch"
description: "Deep audit of engineering, validation, go-to-market, operational, and legal gaps against HoBo's own launch criteria (v1 readiness dashboard, go/no-go record, launch-blocker taxonomy), with a prioritized critical path."
tags: [hobo, plans]
---

# Public-launch gap analysis — what remains before HoBo can launch

> Audited at commit `c14955f3803e5f27d99d1f99ca8ecc8fce1d51ee` (2026-07-17). Method: two
> fresh-context exploration passes over the full repo (design suite, `packages/`, `src/draft/`,
> CI), spot-verification of every quantitative claim against the tree at the audited commit, and a
> live check of GitHub Actions run history. Scoring rubric: **the product's own launch criteria**
> ([v1 readiness dashboard](../design/v1-readiness-dashboard.md),
> [go/no-go decision record](../design/go-no-go-decision-record.md),
> [launch-blocker taxonomy](../design/launch-blocker-taxonomy.md)) — not a generic checklist.
> Severity language below reuses the taxonomy's classes: **launch blocker · high-risk non-blocker ·
> launch note · post-GA follow-up**.

## 1. Executive summary

HoBo's design is essentially finished; the product is not. The design corpus (113 capability docs,
~125 ADRs, ~486 proof records, 35 competitor captures, a full launch-operations records layer) is
internally consistent, CI-enforced, and unusually rigorous. Against that, roughly **5–10% of the
designed system exists as production code** (~26–30k LOC across 18 packages), the current code
covers approximately **stage S0 plus slivers of S1** of the seven-stage
production build backlog, and **there is no executable path to a
real cloud**: no cloud provider adapter, no IaC engine, no identity plane, no MCP server, no
registry, no deployment artifacts of any kind.

The repo's own fail-closed readiness rules say unknown blockers, missing evidence, and
never-verified records **cannot render as green** — and by those rules the readiness scorecard
below is red in every row. Three findings dominate:

1. **The product's own gates are currently failing.** The S0 stage-gate acceptance table is all
   `TODO`, the `stage-gate-s0` and `s1-stage-gate` workflows show only failing runs in recent
   history (including scheduled runs on `main`), and the main `HoBo CI Fabric` scheduled runs on
   `main` have failed since 2026-06-29. "Green on `main` means S0 is done"
   ([build-s0-stage-gate-acceptance](../design/build-s0-stage-gate-acceptance.md)) is unmet.
2. **"Public launch" is undefined.** The launch machinery models beta → release-candidate → GA of
   the *product*, but the repo (currently private) has no decision record for what "public" means:
   opening the source (an OSS launch is plausibly weeks away) versus operating a hosted platform
   for public users (quarters away, gated on S2–S3 at minimum). Every downstream gap ranking
   depends on this decision, and no doc owns it.
3. **The launch-operations layer is contracts without evidence.** Support, SLA, legal, billing
   policy, compliance packs, readiness dashboard, and go/no-go records all exist as M0 *contracts*
   that explicitly defer the real artifacts (legal text, staffed support, populated dashboards,
   signed checklists). Not one has a populated instance.

**Distance to launch, in the backlog's own units:** of the 87 production-build issues
(HOBO-578…665) plus 25 gap-remediation issues (HOBO-666…690), the built surface corresponds to
S0's 12 issues (gate still red) and roughly a third of S1's. A hosted public beta requires at
minimum green S0–S1, S2 (first real cloud), and the S3 identity/MCP slice — on the order of
**~45–50 issues of real implementation work** — plus the dogfood (HOBO-476) and beta-pilot
(HOBO-477) operational handoffs and the three legal launch blockers already named in
[legal-privacy-terms-readiness](../design/legal-privacy-terms-readiness.md). An OSS/source-public
launch requires none of that but does require a green main, a truth-in-advertising pass over
public claims, and the launch-definition decision itself.

## 2. Method and rubric

The audit scores the repo against the launch criteria it defines for itself:

| Rubric source | Role in this audit |
|---|---|
| [v1-readiness-dashboard.md](../design/v1-readiness-dashboard.md) | Master scorecard fields (cutline, blockers, milestone health, evidence links, accepted risks, owners, last-verified) and the fail-closed rules. |
| [go-no-go-decision-record.md](../design/go-no-go-decision-record.md) | Beta/RC/GA decision template; checked for populated instances (none exist). |
| [launch-blocker-taxonomy.md](../design/launch-blocker-taxonomy.md) | Severity vocabulary used throughout this report. |
| `production-build-backlog` (a plan, not kept in the repository) | S0–S6 stage scope quantifying the engineering gap. |
| [build-s0-stage-gate-acceptance.md](../design/build-s0-stage-gate-acceptance.md) | S0 acceptance record — gate table currently all `TODO`. |
| `proof-hardening-backfill` (a plan, not kept in the repository) | Validation-debt baseline (647 grandfathered proofs). |
| [pre-launch-outcome-contract.md](../design/pre-launch-outcome-contract.md), [launch-e2e-persona-matrix.md](../design/launch-e2e-persona-matrix.md), [launch-demo-golden-path.md](../design/launch-demo-golden-path.md), [launch-messaging-claims.md](../design/launch-messaging-claims.md), [legal-privacy-terms-readiness.md](../design/legal-privacy-terms-readiness.md), [billing-launch-policy.md](../design/billing-launch-policy.md), [support-sla-channels.md](../design/support-sla-channels.md) | Per-dimension "contract exists, evidence doesn't" checks. |
| [Archived requirements suite](../archive/requirements/index.md) | Ratification status (v0.1, "Draft for review"). |
| [ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064) | The deliberate monetization scope cut — cited so business gaps aren't misread as oversights. |
| [Competitor gap analysis](../competitors/gap-analysis.md) | Competitive posture check. |

Spot-verified facts at the audited commit: 18 packages under `packages/` (15 top-level +
`providers/provider-agentv`, `providers/provider-ax`, `runtimes/runtime-local`);
`packages/iac/*` and `packages/build/*` declared in `pnpm-workspace.yaml` but the directories do
not exist; zero Dockerfiles, `.tf` files, or Helm charts anywhere in the tree; 647 entries in
`src/draft/_grandfathered.json`; exactly one hardened proof
(`src/draft/technical-proofs/cache-port-catalog-contract`, the only real `proof.json` and
notebook outside templates); two real `.feature` suites; six workflows in `.github/workflows/`;
MIT `LICENSE`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md` all present. GitHub Actions
history checked live on 2026-07-17 (details in §4.2).

## 3. Readiness scorecard

Scored per the dashboard contract's own fields and fail-closed rules ("missing evidence, unknown
blockers, absent owners, and never-verified records… are not green, even when no explicit failure
is known").

| Dashboard field | Status | Evidence |
|---|---|---|
| **Cutline** | 🔴 | A cutline *contract* exists as a draft proof (`src/draft/technical-proofs/v1-cutline-contract`), but there is no accepted cutline instance, and the requirements suite that defines release criteria is [archived at v0.1, unratified](../archive/requirements/index.md). Per the contract, "missing cutline is red; release cannot claim a shared v1 boundary." |
| **Blockers** | 🔴 | The taxonomy exists; no live blocker register does. Meanwhile de-facto blockers are unrecorded: failing `stage-gate-s0`/`s1-stage-gate`/`hobo-ci` runs (§4.2). "Unknown blockers are red and treated as not ready." |
| **Milestone health** | 🔴 | Linear holds 87 + 25 open production-build issues; built code ≈ S0 + partial S1; the S0 gate issue (S0-12) itself is not green. |
| **Evidence links** | 🔴 | The S0 acceptance [gate table](../design/build-s0-stage-gate-acceptance.md) is all `TODO` in both CI-run columns. Design-side evidence is strong; production-side evidence is absent at exactly the gate that matters. |
| **Accepted risks** | ⚪→🔴 | No exception records exist. Neutral by the contract ("no accepted risks is… not proof that blockers are closed"), but red in effect because known risks (failing gates, single-owner roles) are neither accepted nor mitigated on record. |
| **Owners** | 🔴 | Every launch-operations doc names owner *roles* (release, security, legal/privacy, support, vendor, governance owners). No humans are bound to them; observably this is a single-maintainer repo, so every role resolves to one person — an unrecorded bus-factor risk. "Unowned evidence or blockers are red." |
| **Last verified** | 🔴 | Latest scheduled `HoBo CI Fabric` runs on `main` (2026-07-06, 2026-07-13) failed; last observed success on `main` was 2026-06-29. Stage-gate workflows: no successful run in recent history (30 most recent per workflow inspected). "Never verified is red." |

## 4. Gap dimensions

### 4.1 Product / engineering — the S0–S6 unbuilt surface

**Launch blocker (for any launch involving a running product).**

What exists is real and well-gated: `@hobo/core` (events, capabilities, ports), `@hobo/cli`,
`@hobo/conformance`, `runtime-local` (SQLite event store, wasmtime host, actor leases, replay),
`@hobo/runtime`, `@hobo/wit`, `@hobo/bindles`, and the `examples/hello-bindle` fixture that runs
offline in simulate mode. That is the S0 toolchain plus part of S1's local runtime — roughly
26–30k LOC.

What does not exist, keyed to the backlog stages:

| Stage | Promise | Status at audit |
|---|---|---|
| S0 Toolchain & contracts | Signed hello-bindle through CI; conformance self-test green | **Built but gate red** — acceptance table all `TODO`; workflow failing (§4.2). |
| S1 Local SDK & runtime | hello-bindle fully offline; replay==live; runtime-port conformance | **Partial** — runtime-local + bindles + CLI verbs exist; `@hobo/data`/`@hobo/events` (CQRS packages), replay==live corpus (S1-16), and the S1 gate are not done (s1-stage-gate failing incl. on `main`). |
| S2 First real cloud | Deploy to one real provider through a governed Yard | **Not started** — no `packages/providers/provider-<cloud>` (only the agentv/ax AI-eval adapters), no `packages/iac/*` (directory absent), `packages/yards` is a ~72-LOC stub, `packages/camps` skeleton. Cloudflare provider exists only as a draft-proof shell (`src/draft/projects/s2-08-provider-cloudflare`). |
| S3 Agent-native core | Keyless agent deploys via MCP; identity plane | **Not started** — no `packages/identity`, no `packages/mcp`, no registry. The headline differentiator (agents as first-class principals) has zero production code. |
| S4 Multi-cloud | One unedited Bindle on ≥2 clouds; cross-cloud mTLS | **Not started** — no `packages/junctions`, no second provider, no mesh. |
| S5 Forge | `hobo forge <url>` yields a certified provider | **Not started** — training-pipeline is a skeleton; generation pipeline is proof-only. |
| S6 Operate at v1 | HA/DR, FinOps plane, dashboard, governance planes | **Not started** — no `packages/cloud`, no FinOps plane, no dashboard UI. |

Also absent entirely: `packages/data`, `packages/events`, `packages/contracts`, `packages/evals`,
`packages/training`, `packages/registry`, `packages/build/build-wasm` — all named in the
architecture's canonical package list. And there are **no deployment artifacts at all**: no
Dockerfiles, no Terraform/Helm/K8s manifests, no deploy scripts. The core product promise —
deploying an app onto a real cloud — cannot currently be demonstrated end-to-end outside
simulate mode.

**Consequence for launch claims:** the [vision's](../design/vision.md) differentiators
(multi-cloud portability, agent principals, AI-generated certified providers, event-sourced
audit) are all design-proven but production-unproven. Per the
[claims register discipline](../design/launch-messaging-claims.md), none of them can appear in
public launch copy today except as roadmap.

### 4.2 Validation — the evidence layer is thin exactly where it must be thick

**Launch blocker.**

- **Failing gates, live.** Checked 2026-07-17 via the GitHub API: `stage-gate-s0.yml` — 30 most
  recent runs all `failure` (all on a PR branch; no `main` runs in that window); `s1-stage-gate.yml`
  — 13 recent `main` runs (push + schedule) all `failure`; `hobo-ci.yml` on `main` — scheduled runs
  of 2026-07-06 and 2026-07-13 both `failure`, last `main` success 2026-06-29. Diagnosis from the
  job records (confirmed on this analysis PR's own runs): every job "completes" as `failure` within
  ~3 seconds with `runner_id: 0`, an empty runner name, and no downloadable logs — **jobs are never
  assigned a runner**. That signature points at an account-level GitHub Actions fault (spending
  limit / billing / runner provisioning), not at the workflows or the code; the same gates pass
  locally. Regardless of cause, the repo's fail-closed philosophy is contradicted by a red `main`
  with no recorded blocker, and no CI evidence can be produced until runner assignment is restored.
- **S0 acceptance record unfilled.** All ten gate rows in
  [build-s0-stage-gate-acceptance](../design/build-s0-stage-gate-acceptance.md) read `TODO` for
  both Ubuntu and Windows legs.
- **Proof-hardening debt.** 647 draft-proof packages are grandfathered
  (`src/draft/_grandfathered.json`); exactly **one** meets the hardened artifact standard. The
  backfill plan (waves W1–W6) exists but has not visibly burned
  down. Advisory-only warnings mean the design-proof evidence base is largely self-attested.
- **Requirements unratified.** The BRD/PRD/TRD suite is
  [archived](../archive/requirements/index.md) at v0.1 "Draft for review" with a sign-off table
  that has never been signed. The backlog inherits its release criteria from a document nobody
  ratified.
- **No populated launch records.** Zero go/no-go decision records, zero readiness-dashboard
  instances, zero accepted-risk register entries. The launch machinery has never been exercised
  even once (e.g., a practice "beta: no-go" record would validate the workflow cheaply).

### 4.3 Go-to-market / business

**Launch blocker for a hosted/commercial launch; launch note for an OSS launch.**

[ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064) deliberately excludes billing/monetization from the
*platform*, and the [billing-launch-policy](../design/billing-launch-policy.md) /
[usage-metering](../design/usage-metering.md) docs are business-layer operating contracts. This
report does not treat that scope cut as an oversight. But a *public* launch still requires
business decisions no document currently owns:

- **No launch definition.** Nothing distinguishes "make the repo public" from "operate a hosted
  public beta" from "GA." These have disjoint gap sets and different legal exposure. This is the
  single cheapest, highest-leverage open item in the repo.
- **No pricing decision.** Even "free during beta" or "OSS, no hosted offering yet" is a decision
  with entitlement, support-boundary, and messaging consequences
  ([entitlements-plan-limits](../design/entitlements-plan-limits.md) presumes plans exist).
- **No launch site, no positioning narrative, no financial model.** The
  [messaging claims register](../design/launch-messaging-claims.md) and
  [demo golden path](../design/launch-demo-golden-path.md) are contracts for vetting claims and
  demos that have not been produced.
- **Competitive window.** The [competitor suite](../competitors/index.md) is thorough and its gap
  backlog is closed *at the design level* — but every claimed differentiator is unshipped while
  the named head-on rival (Lakebed) and the mainstream PaaS cohort ship weekly. Design-level
  parity decays; the capture set will need a refresh pass at launch time.

### 4.4 Operational

**Launch blocker for a hosted launch.**

There is nothing to operate and nobody on record to operate it:

- No hosted control plane exists or can be deployed (no deploy path, §4.1).
- [Support SLAs/channels](../design/support-sla-channels.md),
  [escalation](../design/launch-support-escalation.md),
  [status page / incident comms](../design/public-status-page-incident-communication.md),
  [backup/restore](../design/backup-restore.md), and
  [chaos/load test plans](../design/performance-load-tests.md) are all M0 contracts with no
  staffed channel, no status page, no tested restore, no load-test run.
- The two operational proving grounds the GA gate depends on — the **Dogfood Yard** (HOBO-476)
  and **Beta Pilot** (HOBO-477) — are open handoffs;
  [go-no-go-decision-record](../design/go-no-go-decision-record.md) explicitly holds public GA
  claims while they are open. Dogfooding is impossible until S2 exists (nothing to host a Yard on).
- Observability/FinOps planes (S6) are design-only.

### 4.5 Legal / compliance

**Launch blocker (named as such by the repo's own checklist).**

[legal-privacy-terms-readiness](../design/legal-privacy-terms-readiness.md) already classifies
its own open unknowns, and three are launch blockers in its words: **final legal review of terms,
privacy notice, and customer-facing legal copy** (required before "public launch or paid GA");
**confirmed v1 subprocessor/provider list**; **evidence review for public security claims**. The
M0 record explicitly does *not* draft the actual terms, privacy policy, or DPA — none exist.
Additional observations:

- No legal entity/ownership posture is recorded anywhere (copyright is a personal name in
  `LICENSE`); acceptable for OSS, unresolved for a hosted service taking user data.
- [Compliance evidence pack](../design/compliance-evidence-pack.md),
  [customer assurance packet](../design/customer-assurance-evidence-packet.md), and
  [SBOM/vulnerability notices](../design/sbom-vulnerability-notice-evidence.md) are contracts;
  no evidence has been generated. SOC2 is correctly classified post-v1.
- OSS-launch hygiene is largely **done**: MIT `LICENSE`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`,
  `SECURITY.md` all present; gitleaks secret-scan lane in CI. Residual OSS items: a pre-publication
  secret/history scan of the full git history, and a truth-in-advertising pass so the README/design
  claims can't be read as shipped-product claims (README's "not shipped" framing is honest today —
  keep it that way at flip-the-switch time).

### 4.6 Holes in the rubric itself

The launch criteria are unusually good, but they have gaps a go/no-go reviewer should know about:

1. **No "repo goes public" gate.** The beta/RC/GA gates model product releases; making the source
   public is a distinct, earlier event with its own (small) checklist that no document owns.
2. **The dashboard and record are unowned and uninstantiated.** A contract that "fails closed"
   only works if someone is bound to populate it; no owner is named for the dashboard instance.
3. **Role-based ownership assumes an organization.** Six-plus owner roles across the launch docs
   currently resolve to one person. The taxonomy has no single-maintainer degradation mode
   (e.g., which roles may be self-approved, which require external counsel).
4. **The "One v1" philosophy conflicts with launch speed and hides the interim cutline.**
   [ADR-0063](../design/adr/07-portability-extensibility.md#adr-0064) makes everything v1 with MoSCoW as build-order
   only. That deliberately avoids an MVP debate, but it means no artifact defines a *public beta
   surface* smaller than S6-complete. The backlog's stage gates are the de-facto cutline; making
   that explicit (e.g., "public beta = S0–S3 green + dogfood") would let the go/no-go machinery
   engage years earlier than a literal reading allows.
5. **Red `main` without a blocker record shows the fail-closed loop isn't wired to reality yet** —
   gate failures do not currently generate blocker entries anywhere the dashboard would read.

## 5. Prioritized critical path

Ordered; items unlock the ones after them. Severity labels per the
[taxonomy](../design/launch-blocker-taxonomy.md).

**Phase 0 — restore trust in the gates (days–weeks, blocker):**
1. Restore GitHub Actions runner assignment (check the account's Actions billing/spending limit —
   §4.2: jobs fail in seconds with no runner allocated), then re-run and fix any genuine
   `hobo-ci.yml` / `stage-gate-s0` / `s1-stage-gate` failures; get `main` green.
2. Fill the [S0 acceptance table](../design/build-s0-stage-gate-acceptance.md) from the first
   green run; close S0-12. Wire "gate failed on main" → a recorded blocker so the fail-closed
   loop is real.

**Phase 1 — decide what "public launch" means (days, blocker, zero engineering):**
3. Write a launch-definition decision record (an ADR or a first
   [go/no-go record](../design/go-no-go-decision-record.md) instance): OSS-source launch vs hosted
   public beta vs both, in what order, and the public-beta cutline in stage terms (§4.6.4).
   Bind named owners to the dashboard, legal, support, and release roles — with a recorded
   single-maintainer degradation policy where one person holds multiple roles.

**Phase 2A — if OSS launch first (weeks, mostly hygiene):**
4. Full git-history secret scan; truth-in-advertising pass over README/design claims against the
   [claims register](../design/launch-messaging-claims.md); pin down the support boundary for
   outside contributors ("design-phase repo, no product support"). Populate a first
   readiness-dashboard instance and a beta-gate go/no-go record for the repo-public event.

**Phase 2B — hosted public beta path (quarters, blocker-chain):**
5. Finish S1 (CQRS packages, replay==live corpus, S1 gate green).
6. S2: first real provider (Cloudflare per the draft project), first IaC adapter, real Yard/Camp
   packages — the first moment the core promise is demonstrable.
7. S3 identity/MCP slice (the differentiator) + Dogfood Yard (HOBO-476): run HoBo's own surface on
   HoBo. Start the beta pilot (HOBO-477) with the support channel from
   [support-sla-channels](../design/support-sla-channels.md) actually staffed.
8. Legal minimum for public users: final terms + privacy notice (external counsel), confirmed
   subprocessor list, security-claims evidence review — the three named blockers in
   [legal-privacy-terms-readiness](../design/legal-privacy-terms-readiness.md).
9. Ratify the requirements suite (or formally re-scope it) so release criteria trace to a signed
   document; populate the dashboard; hold the beta go/no-go.

**Parallel, non-blocking (high-risk non-blocker / pre-GA):** proof-hardening waves W1–W6
(burn down `_grandfathered.json`), competitor-capture refresh near launch, performance/chaos/
backup-restore evidence, compliance evidence pack — all pre-GA rather than pre-beta.

## 6. Risk register (top risks, taxonomy classes)

| # | Risk | Class | Why / evidence |
|---|---|---|---|
| 1 | Product thesis unproven end-to-end: no real-cloud deploy exists; portability/agent/Forge claims are design-only | Launch blocker | §4.1; simulate-mode-only `examples/hello-bindle`. |
| 2 | Own stage gates red and unrecorded (S0 table `TODO`, workflows failing, `main` CI red since 2026-06-29) | Launch blocker | §4.2. |
| 3 | Legal artifacts absent (terms, privacy notice, subprocessor list, claims review) | Launch blocker (hosted/public) | Named as blockers by [the repo's own checklist](../design/legal-privacy-terms-readiness.md). |
| 4 | No launch definition or public-beta cutline; "One v1" philosophy leaves no defensible interim launch surface | Launch blocker (decision, not code) | §4.3, §4.6.4. |
| 5 | Single-maintainer bus factor: all owner roles resolve to one person; no degradation policy | High-risk non-blocker | §3 Owners row, §4.6.3. Needs recorded acceptance + mitigation. |
| 6 | Validation debt: 646/647 proofs unhardened; requirements unratified — evidence base is self-attested | High-risk non-blocker (pre-GA blocker) | §4.2; proof-hardening-backfill. |
| 7 | Competitive decay: differentiators unshipped while Lakebed + PaaS cohort ship; captures age | High-risk non-blocker | §4.3; [competitors/gap-analysis](../competitors/gap-analysis.md). |
| 8 | Operational cold start: no dogfood yard, no staffed support, untested restore — first public incident would be handled ad hoc | High-risk non-blocker (pre-beta blocker for hosted) | §4.4. |
| 9 | TypeScript-only SDK at launch (reference implementation per ADR-0069) | Launch note | Known limitation; needs customer-visible wording. |
| 10 | Monetization/billing absent by design (ADR-0064); SOC2, localization deferred | Post-GA follow-up | Deliberate; keep visibly chosen in launch notes. |

## 7. Appendix — evidence index

| Claim | Evidence at audited commit |
|---|---|
| 18 production packages; `iac`/`build` dirs absent | `ls packages/` (15 top-level + 2 providers + 1 runtime); `pnpm-workspace.yaml` declares `packages/iac/*`, `packages/build/*`; directories do not exist. |
| ~26–30k LOC production TS; maturity per package | Exploration pass over `packages/*/src`; `packages/yards/src` ≈ 72 LOC. |
| No deployment artifacts | Zero Dockerfiles, `.tf`, `Chart.yaml`, deploy scripts in tree (find at audited commit; CI uses stock `node:24-bookworm` only for the offline dev-loop gate). |
| 647 grandfathered proofs, 1 hardened | `src/draft/_grandfathered.json` (`packages`: 647); only non-template `proof.json`/notebook: `src/draft/technical-proofs/cache-port-catalog-contract`; 2 non-template `.feature` files. |
| S0 gate table all TODO | [build-s0-stage-gate-acceptance.md](../design/build-s0-stage-gate-acceptance.md) gate table. |
| Workflows failing | GitHub Actions API, 2026-07-17: `stage-gate-s0.yml` 30 recent runs all failure; `s1-stage-gate.yml` 13 recent `main` runs all failure; `hobo-ci.yml` `main` scheduled runs failed 2026-07-06 and 2026-07-13, last success 2026-06-29. |
| Requirements archived, unratified | [docs/archive/requirements/index.md](../archive/requirements/index.md); requirements.md v0.1 "Draft for review", unsigned sign-off table. |
| Launch machinery uninstantiated | No populated instances of the [dashboard](../design/v1-readiness-dashboard.md), [go/no-go record](../design/go-no-go-decision-record.md), or accepted-risk register anywhere in the tree. |
| Legal blockers self-declared | [legal-privacy-terms-readiness.md](../design/legal-privacy-terms-readiness.md) "Open Unknowns" table. |
| OSS hygiene present | `LICENSE` (MIT), `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`; gitleaks lane in `.github/workflows/hobo-ci.yml`. |
| Backlog scale | `production-build-backlog` (a plan, not kept in the repository): 7 stage projects, 27 milestones, 87 issues (HOBO-578…665) + 25 gap issues (HOBO-666…690). |
