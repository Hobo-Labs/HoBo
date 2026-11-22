---
type: Agent Skill Reference
title: "OptimizeXP review loop"
description: "Iterative experience review that reduces harms, friction, and uncertainty until plateau."
tags: [hobo, optimizexp, review-loop, hcd]
timestamp: 2026-07-30T00:00:00Z
---

# Review loop

Goal: reach **Pareto equilibrium** — minimize harm, then maximize delight under harm non-regression and persona **cognitive thresholds**, until no admissible S/M experiment remains (`equilibrium.md`).

**Default infinite does not stop at the harm floor.** Harm floor only **switches regime** to `delight_maximize`.

```text
  Scope (passes, delight-passes, survey, harm-only flags)
  regime = harm_reduce
  loop (until pareto-equilibrium | caps | user | safety | blocked):
    measure: primary harm + positive + cognitive (persona thresholds)
    if regime == harm_reduce:
      apply S/M harm reductions until true plateau (flat + implementableHarm=0)
      → regime = delight_maximize  (unless --no-delight)
      survey + rank backlog
    if regime == delight_maximize:
      apply Pareto-admissible S/M uplifts (delight↑, harm not↑, no cognitive breach)
      if harm regressed → regime = harm_reduce
      if no admissible uplift + harm floor holds → STOP pareto-equilibrium
  summary + survey themes + backlog
```

**Flags** (`references/flags.md`): `--passes`, `--delight-passes`, `--no-delight`/`--harm-only`, `--no-survey`, `--report-only`.

## 0. Create the run

```text
runId = <YYYYMMDD>-<experiences>-<short-slug>
.optimizexp/runs/<runId>/
  scope.json
  baseline.json
  iterations/
  artifacts/
  summary.md          # written at stop
```

Host workflow (if any): load from `workflows/<host>/` after reading `references/workflow-generation.md`.

## 1. Scope

1. **Bare (no flags):** run `init.mts --mode needs-init`; if true, `init.mts` for all experiences + **all projects**, then review with **ux+dx+ax** and **all-projects**. If false, review all experiences + all-projects immediately (`references/init.md` § Auto-init).
2. Resolve **projects** (default `all-projects`) and **experiences** (default all three) (`references/flags.md`).
3. **Persona seeds** (`--persona` …): rewrite each seed → write-scope `personas/<id>.md` — global `.optimizexp/` or `<project>/.optimizexp/` when a single non-root `--project` is set (`references/personas.md`). Harness: `generate-persona.mts`. Never use the raw seed as the review system prompt.
4. **Persona selection** (single set for the whole run — review **and** feature fan-out):
   1. `--personas` if set → exactly those ids
   2. Else if any personas generated this run → exactly those ids
   3. Else → all on-disk personas intersecting experiences (fallback: all on-disk)
   4. Apply `--max-personas`
5. **Feature seeds** (`--feature` …): for each seed, create write-scope `features/<id>/` (global or project-local) with **one** `<id>-<persona>.feature` **per selected persona**, plus `steps/` bindings, Vitest stubs, and discovery-wired implementations when code exists (`references/features.md`). Tag `feature.json.projects` + `scope` from project selection. Resolve personas from **global + selected project** trees. Harness: `generate-feature.mts`. Do not delete `evidence/` on regenerate.
6. **Select features for review:** `--features` list if set; else features whose `projects` tag intersects project selection (missing tag ≈ `root`).
7. List surfaces; prefer smallest set covering critical paths within selected projects.
8. Load experience references only for selected experiences.
9. Resolve `passes` (default **infinite** until **pareto-equilibrium**). Harm floor switches to delight; `--no-delight` is the only early exit at harm floor.
10. Write `scope.json` with `passes`, `regime`, `stopPolicy: infinite-until-pareto-equilibrium`, projects, personas, features, seeds, `autoInitRan`.

## 2. Baseline

For each persona × surface cell, score harms / friction / uncertainty (`references/metrics.md`). Prefer evidence from:

- **Prior bus entries** for this run and prior runs on the same feature/persona (read via bus feedback)
- Existing docs (`AGENTS.md`, `site/src/styles/global.css`, `docs/agent-tooling.md`)
- One cheap probe command (smoke, lint --help, design:lint) rather than full suites

Write `baseline.json` and iteration `000/scores.json`.

## 2b. Bus feedback (read before every expect after iteration 0)

Agents **must read the bus** before predicting again — especially after being wrong.

```bash
node --import tsx .agents/skills/optimizexp/workflows/cross-agent/review-loop.mts \
  --mode read-bus --run <runId> --limit 20

# mismatches only (failed expectations / positive score deltas)
node --import tsx .agents/skills/optimizexp/workflows/cross-agent/review-loop.mts \
  --mode read-bus --run <runId> --mismatches-only
```

### What to load

| Source | Use |
|---|---|
| Prior **outcome** `comparison.matchedExpectation === false` | Correct next **expect** (behavior + predicted scores) |
| Prior **deltaFromExpect** with positive metrics | Do not re-predict the same optimistic scores without new evidence |
| Prior **act** `observed` scores vs **judged** | Calibrate how harsh the persona is on this surface |
| Prior **feelings** / desirability | Keep persona voice consistent; note trust drops |
| Prior **evidence** paths | Re-open what was seen; avoid re-probing blindly |
| Prior **reduction.md** | Know what already was tried |

### Correction protocol (when the agent was wrong)

1. Classify error: wrong **behavior** forecast, wrong **score** forecast, or both.
2. Write next expect with `correctedFrom: <prior-outcome-id>` and optional `lessons: ["…"]` on the expect entry.
3. **Tighten** predicted scores toward last judged scores unless a real reduction landed.
4. Change the **action** if the command/surface was wrong (update bindings via `generate-feature --mode implement` if needed).
5. Never discard the bus history — append only.

See also `references/agent-bus.md` § Reading the bus.

## 3. Expect (write-ahead) + predicted scores

1. **Read bus feedback** (required from iteration 1+; recommended at baseline).
2. Ensure a Gherkin scenario exists under `.optimizexp/features/<feature>/*.feature` (persona tags required).
3. Write a bus **expect** entry with `featureId` + `scenarioSlug` (`references/agent-bus.md`).
4. Include formal **`scores`** with `role: "predicted"` — informed by prior outcomes when present.
5. If correcting: set `correctedFrom` + `lessons`.
6. Expectations come from the **persona prompt** + **bus lessons**, not ungrounded optimism.

## 4. Act + capture evidence + observed scores

Exercise the surface **and** capture what the persona sees:

```bash
node --import tsx .agents/skills/optimizexp/harness/capture-evidence.mts --mode capture \
  --feature <id> --scenario <slug> --driver <cli|tui|web|native> \
  --command '…'   # or --url / --native-cmd
```

| Interface | Capture |
|---|---|
| cli | transcript + terminal cols×rows |
| tui | asciinema if available + transcript + size |
| web | Playwright/browser MCP video → screenshots → stitch |
| native | computer-use recorder → screenshots → stitch |

Then write a bus **act** entry (`expects` → expect id) with:

- action metadata (driver, command, exit code, timestamps)
- `evidence` path
- formal **`scores`** with `role: "observed"` from the capture (first-pass)

Rules: prefer **video**; overwrite previous `primary.*` for that scenario only; redaction on. Details: `references/evidence.md`, `references/harness.md`.

Prefer read-only / dry-run / staged gates for **probes**. **Reduce** (next step) may mutate product surfaces when not `--report-only`.

## 5. Outcome + judged scores + comparison

Write the bus **outcome** entry:

- actual Gherkin / observed result
- feelings (persona voice about the **evidence**)
- desirability
- formal **`scores`** with `role: "judged"` (authoritative for the iteration)
- **`comparison`**: `deltaFromExpect`, optional `deltaFromAct`, `matchedExpectation` (behavior **and** scores within tolerance)
- `evidence` path + `actId`

Helpers:

```bash
node --import tsx .agents/skills/optimizexp/harness/scorecard.mts --mode compare \
  --expect <expect.json> --act <act.json> --outcome <outcome.json>
```

## 6. Rescore (from judged outcomes)

Roll up **outcome** scorecards into cells (not predictions):

```bash
node --import tsx .agents/skills/optimizexp/workflows/cross-agent/review-loop.mts \
  --mode aggregate-bus --run <runId>
```

Write `iterations/<nnn>/scores.json` + `findings.md` ranked by leverage (impact on metric_max / effort). Cite score deltas from `comparison`. Scores must be re-measured: an iteration `scores.json` byte-identical or score-identical to `baseline.json` fails assert-complete (`copied_scores_without_justification`) unless it carries an explicit `justification` field.

Finding shape:

```markdown
### F-<n>: <title>
- Metrics (judged): friction=3, uncertainty=2 (Δ expect +2 friction)
- Personas: developer
- Evidence: features/…/evidence/…/primary.* , bus outcome id …
- Smallest reduction: …
- Effort: S|M|L
```

## 7. Reduce experiment (default ON) + verify + commit

Pick the **top finding** by leverage (impact on `metric_max` / effort). Then **implement it**.

### Default (apply experiment)

1. Design the **smallest safe experiment** that can lower judged friction, uncertainty, or harms on the measured surface.
2. **Apply it now** in the repo (scripts, copy, docs, harness, package entrypoints, UI, setup paths, etc.). Prefer local reversible edits. Run local install/setup when that is the honest next step for the persona **and** the workspace allows it (see § Anti-stall).
3. Write `iterations/<nnn>/reduction.md`: finding id, hypothesis, files touched, expected metric deltas, residual risk, `result: improved|no-improve|regressed`.
4. **Verify immediately in the same pass:**
   - New bus **expect** (predicted scores after the experiment; may still be imperfect).
   - **Act + capture** on the same scenario(s).
   - **Outcome** judged scores — these replace the pre-reduce cells for this iteration's final scores when better.
5. If verify scores did **not** improve: record in `reduction.md`, keep or revert based on safety, then **immediately take the next finding** in the same pass if it is independent (do not wait for the next pass to apply a known fix).
6. When on a delivery branch: incremental git commit for this checkpoint (`references/pr-delivery.md`).

### Derive → implement (non-negotiable)

| Agent state | Required action |
|---|---|
| You know the file/script/message to change | **Edit it this pass** |
| You know “user should run X” | Prefer **make X automatic**, or **run X** if safe/local, or **print X as the only exit path** — not “document for later” |
| Finding lists “Smallest reduction: …” | That reduction is the **work item**, not optional backlog |
| Prior pass left residual with clear next step | **Next pass implements it** — residual is not a trophy |

Writing a good analysis without landing the change is a **failed reduce**.

### Opt-out (`--report-only` / `--no-reduce` / `OPTIMIZEXP_REPORT_ONLY=1`)

Document the finding and a concrete fix plan in `reduction.md` only — **no code changes**. Summarize that the run was report-only.

### Hard constraints

- Never "reduce" by gaming scores without changing the experience.
- Do not invent fake evidence.
- Prefer one primary experiment per pass; **also ship** other independent **S**-effort fixes in the same pass when they do not thrash the same surface (list all in `reduction.md`).

## 7b. Anti-stall (do not stop early)

These are **invalid** stop reasons / false completion signals:

| Invalid excuse | Do this instead |
|---|---|
| “Needs `pnpm install` / node_modules” | Implement cold-path messaging **and/or** run install when allowed **and/or** offline entrypoints; then re-measure happy path |
| “Env issue / cloud agent has no deps” | Product code + harness still fixable; install if policy allows; expand offline paths |
| “I’ll leave residual for improve/sdlc” | If you already derived the fix, **you** own implementing it in this run |
| “Scores flat so plateau” while findings have S/M reductions | **Not plateau** — keep reducing |
| “Messaging fixed; friction 2 is good enough” | Keep going if happy-path still fails for the persona or uncertainty remains |
| “Report-only vibe” without `--report-only` | Apply experiments |
| “Package tests green / feature wired” | Product experiment only — continue bus + scores + regimes |
| “One evidence capture done” | Capture is act, not closeout — keep cycling |
| “should-stop exit 0 / plateau” | **cycleStop only** — enter delight (unless `--no-delight`); never claim invocation complete |
| “Todo list empty / compaction said done” | Re-run `--mode status` / `assert-complete`; resume if `status: running` |
| “Implemented the hermetic/env/product fix” | That was a reduce pass — rescore and continue |

**True external block** (allowed in `summary.md` → Blocked only): missing secrets the user did not provide, network forbidden by policy, user explicitly forbade installs/mutations, safety rule. Every blocked item needs `blockedBecause` + what would unblock it.

### Plateau definition (strict)

Numeric plateau (`metric_total` and `metric_max` not improved vs previous pass) is **necessary but not sufficient**.

Plateau **only if both**:

1. Scores did not improve vs previous pass
2. **`implementableFindingsRemaining === 0`** — no finding with Effort S/M and a concrete in-repo (or safe local setup) reduction left unapplied

When calling `should-stop`, pass implementable backlog:

```bash
node --import tsx …/review-loop.mts --mode should-stop \
  --run <id> --iteration <passIndex> --scores c.json --prev-scores p.json \
  --implementable-findings <N>   # 0 only when backlog empty
```

If N > 0, harness **must not** return plateau stop (continue).

## 8. PR checkpoint (per pass)

When the user wants PRs (or already asked for optimizexp PR delivery):

1. Prefer **stacked PR** for this iteration if `gh stack` / Graphite is available.
2. Push incremental commits.
3. Post evidence: `harness/post-pr-evidence.mts --feature <id>` (splits/compresses when oversized).

## 9. Stop conditions

### Two layers (do not conflate)

| Layer | Meaning | Harness |
|---|---|---|
| **cycleStop** | End of harm cycle (true plateau) | `should-stop` → `cycleStop: true`, `invocationStop: false` |
| **invocation complete** | Skill finished for this run | `assert-complete` exit 0 **and** `mark-complete` |

`should-stop` **`stop` is a deprecated alias of `cycleStop`**. Never treat exit 0 on should-stop as “optimizexp done.”

### Within a cycle (after each review iteration)

Stop the **cycle** when **any** is true:

1. **True plateau** (§ 7b): scores flat **and** zero implementable findings remaining  
2. User says stop  
3. **Only** true external blocks remain — list under `summary.md` → Blocked (with `blockedBecause`)  
4. Safety boundary hit  

**Forbidden stops (within a cycle):**

- Invented max review-iteration budget / “we did N review iterations so done”  
- Misusing **`--passes`** as “only N reduce steps”  
- “Good enough after N experiments” while S/M findings remain  
- Flat scores while implementable S/M findings remain  
- Product tests green / feature wired / one evidence capture  

**Do not stop** because you ran out of ideas while residual still names a file-level fix. If stuck, take the next surface/persona cell with the worst `metric_max` and reduce that.

### Across regimes (default infinite → Pareto equilibrium)

Canonical policy: **`equilibrium.md`**.

1. Record harm + delight + cognitive cells each pass.  
2. On harm true plateau → **do not invoke complete** → `regime: delight_maximize` (unless `--no-delight`).  
3. Survey + rank backlog; apply Pareto-admissible uplifts.  
4. Harm regression during delight → return to `harm_reduce`.  
5. Candidate terminal: `equilibrium` mode `stop: true` with reason `pareto-equilibrium` (etc.).  
6. **Invocation complete only when:**

```bash
node --import tsx …/review-loop.mts --mode assert-complete --run <id>   # exit 0
node --import tsx …/review-loop.mts --mode mark-complete --run <id> \
  --stop-reason pareto-equilibrium
```

`metrics-zero` and `irreducible` are **harm-floor markers**, not infinite-loop terminals. Forbidden invocation `stopReason`s: `plateau`, `metrics-zero`, `irreducible`, `tests-pass`, `wired`.

Use `--report-only` only when the user wants measure-only (still survey/score; no apply).

Update `scope.json`:

- `status`: `running` | `complete`  
- `regime`: `harm_reduce` | `delight_maximize`  
- `regimesEntered`: array (must include `delight_maximize` unless `noDelight`)  
- `stopPolicy`: `infinite-until-pareto-equilibrium` (default infinite)  
- `passesCompleted` / `cyclesCompleted` / `delightCyclesCompleted`  
- `surveyCompleted`, `equilibrium` object  
- `stopReason`: `pareto-equilibrium` | `inverted-u-peak` | `delight-ceiling` | `delight-passes-cap` | `passes-cap` | `harm-only-floor` | `blocked` | `user` | `safety`  

Write `summary.md` **before** mark-complete:

- Harm floor + final delight + cognitive breaches  
- Why equilibrium (or cap) — include `stopReason`  
- Experiments (harm + uplift) + rejected past-peak / constraint failures  
- Persona survey + top backlog  
- Segment coverage (which KYC personas judged)

### Resume after compaction / handoff

```bash
node --import tsx …/review-loop.mts --mode status --run <id>
node --import tsx …/review-loop.mts --mode assert-complete --run <id>
```

If `status: running` or `INCOMPLETE.md` exists → continue the loop. Never claim done from a prior narrative alone.

## Host workflows vs cross-agent

| Host supports workflows? | Use |
|---|---|
| Yes (Claude Code, Grok, etc.) | `workflows/<host>/review.*` generated per `workflow-generation.md` |
| No / unknown | `workflows/cross-agent/` deterministic runner template |

Both paths **must** still write the agent bus **and** feature evidence; workflows orchestrate the loop, they do not replace either.

## SDLC designer consensus

Ordinary OptimizeXP score/reduce/equilibrium review remains independent. For a
design-relevant SDLC layer, its current-head outcomes and captured acceptance
evidence feed the exact-six council described in `design-council.md`. Any nay
returns a machine-readable rework packet to implementation; evidence is
refreshed and the same six reconvene without investment recharge. OptimizeXP
run completion fails when `scope.json` marks designer consensus required and
the latest council decision is missing, nay, stale, short of six voters, or has
an unresolved blocker.

The run scope declares the authoritative review inputs explicitly:

```json
{
  "designerConsensus": {
    "required": true,
    "reviewId": "run-pr-123-a1b2c3d",
    "baseSha": "base-sha...",
    "headSha": "a1b2c3d...",
    "proposalPath": ".optimizexp/runs/run/consensus/run-pr-123-a1b2c3d/proposal-cycle-0.json"
  }
}
```

Policy-aware SDLC runs also set
`designerConsensusPolicy: "required-when-design-relevant"`.
`assert-complete` replays council history, recomputes the proposal digest from
`proposalPath`, and asserts unanimous approval for the effective `baseSha` and
`headSha`. A `required: false` policy decision needs a deterministic internal
exemption; legacy non-SDLC runs keep their existing completion contract.
