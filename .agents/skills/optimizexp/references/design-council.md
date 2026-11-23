---
type: Agent Skill Reference
title: "OptimizeXP designer council"
description: "Exact-six, evidence-backed, unanimous design consensus bound to the reviewed proposal and Git head."
tags: [hobo, optimizexp, design-council, consensus, sdlc, agent-bus]
timestamp: 2026-08-01T00:00:00Z
---

# Designer council

The designer council is an additional SDLC design-review protocol. It does not
replace ordinary OptimizeXP persona scoring. Existing outcomes are evidence the
council reads; council debate and votes use `kind: "council"` bus entries.

## Fixed membership

The council contains exactly these six equal votes, in deterministic speaking
order:

| Priority | Persona | Lens | Experiences |
|---:|---|---|---|
| 10 | `steve-jobs` | product editor | ux, dx, ax |
| 20 | `jony-ive` | coherence engineer | ux, dx |
| 30 | `walt-disney` | experience imagineer | ux, dx, ax |
| 40 | `hayao-miyazaki` | living-world humanist | ux, dx |
| 50 | `naoto-fukasawa` | behavioral naturalist | ux, dx |
| 60 | `shigeru-miyamoto` | interaction toymaker | ux, dx |

Priority controls order only. It gives no authority or voting weight. No other
famous-designer persona may join, substitute, vote, break ties, or form a
quorum. These files are synthetic expert-review lenses grounded in public
methods, not impersonations or claims about real feelings, consciousness,
speech, identity, or private beliefs.

## Subject and proposal digest

Every review binds to `runId`, `reviewId`, reviewed surface or PR, `baseSha`,
`headSha`, and a deterministic SHA-256 proposal digest. Canonical digest input
contains:

- the reviewed PR number or surface;
- base and head SHA;
- sorted changed paths;
- normalized diff hash;
- acceptance-contract hash;
- evidence-manifest hash;
- normalized relevance and evidence signals;
- the exact ordered council IDs; and
- consensus protocol schema version.

Canonical JSON sorts object keys recursively and excludes timestamps. A new
commit, effective diff, acceptance digest, evidence digest, membership, or
protocol version makes approval stale.

## Synthetic investment

`investment` is an auditable orchestration variable, sometimes described to
humans as synthetic emotional investment. It does not indicate sentience or a
historical person's feelings.

For deterministic relevance and evidence-strength values in `[0,1]`:

```text
clamp01(x) = min(1, max(0, x))
round4(x) = round to four decimal places

initialInvestment =
  round4(clamp01(relevance * (0.65 + 0.35 * evidenceStrength)))

decayPerTurn =
  round4(clamp(0.12, 0.40, 0.34 - 0.18 * evidenceStrength))

after = round4(max(0, before - decayPerTurn))
```

Relevance is derived from inspectable path/interface categories, acceptance
tags, feature tags, evidence types, and persona relevance cues. Proposal words
are only a low-weight fallback. Evidence strength is `0` none, `.25` prose or
unverified mock, `.5` reproducible path/static artifact, `.75` executable
test/capture, and `1` multiple independent current-head evidence types mapped
to acceptance. Agent confidence never raises the score.

Every substantive `position` or `reply` consumes one decay step. A vote consumes
no extra turn unless it introduces a new argument. Investment never increases
inside a review. Rework uses
`min(previousCurrentInvestment, seed(newRelevance, newEvidenceStrength))`, so a
cycle cannot recharge personalities.

At zero, a persona may not introduce or repeat subjective preferences. It
submits, yields remaining preferences, and votes `yay` unless an unresolved
hard blocker remains. Hard blockers never decay away.

## Preference and hard blocker

A preference is doctrine-based quality advice whose rejection violates no
objective contract. A hard blocker requires evidence of at least one of:

- failed executable acceptance or current-head validation;
- accessibility, safety, security, privacy, tenancy, or data-loss risk;
- contradiction with an explicit HoBo architecture/design invariant;
- unusable or misleading behavior on the claimed path; or
- stale, missing, fabricated, or mismatched evidence.

Every blocker has an ID, claim, rule, evidence references, requested resolution,
and status. It leaves the active set only through an append-only
`blocker-resolution` entry citing changed implementation, passing evidence,
corrected artifact, policy-permitted override, or a reasoned originating-persona
withdrawal. Snapshot-only deletion is invalid. A verified cycle transition retains open
blockers and leaves older resolved records in the bus. Validation accepts their
absence from a later snapshot only after successful history replay; current-cycle
records and retained statuses must still match their resolution entries.

## Council bus

Council entries extend the append-only agent bus without changing
`expect|act|outcome|survey` scorecard rules. Common fields are:

```json
{
  "kind": "council",
  "schemaVersion": 1,
  "id": "globally-unique-id",
  "runId": "run-id",
  "reviewId": "review-id",
  "cycle": 0,
  "turn": 0,
  "stage": "position",
  "subject": { "headSha": "...", "proposalDigest": "..." },
  "createdAt": "2026-08-01T00:00:00.000Z"
}
```

Closed stage enum:

- `open`: coordinator subject, exact council, order, manifests, state path,
  protocol version, and initial investment;
- `position`: first persona review for a cycle with an investment transition;
- `reply`: non-repeating response to an existing same-review entry/argument;
- `vote`: one active final `yay|nay` per persona/cycle/subject; correction must
  explicitly supersede and reference the prior vote;
- `submitted`: zero investment, no new preference, final vote included or
  referenced;
- `consensus`: coordinator-only exact-six vote aggregation;
- `rework`: coordinator packet after any nay;
- `blocker-resolution`: append-only resolution evidence; and
- `closed`: approved, superseded, or honest blocked/user/safety termination.

Persona stages record `persona`, `respondsTo`, investment before/decay/after,
stance, arguments, blockers, preferences, evidence, and requested changes.
Every entry includes the immutable state digest needed to audit the mutable
snapshot. Entry IDs are unique; exact duplicate appends may be idempotent only
when the complete entry digest matches.

## Conversation and decision

1. Coordinator opens the current-head review and seeds all six states.
2. In order, each persona reads its file, proposal, acceptance, evidence,
   relevant OptimizeXP outcomes, and prior council entries, then appends a
   position.
3. Invested personas answer the strongest opposing argument with new evidence,
   concession, refinement, or contradiction. Duplicate claims are rejected or
   must explicitly reference the earlier claim.
4. Preferences monotonically yield at zero; blockers require explicit
   resolution. Each persona casts exactly one active binary vote.
5. Coordinator decides only after all six votes exist. Any nay or open blocker
   produces `result: "nay"` and a machine-readable rework packet. Six yays and
   no blockers produce `result: "yay"`.
6. Rework refreshes implementation, acceptance evidence, effective diff, and
   subject; carries investment without recharge; and reconvenes the same six in
   the next cycle. The opening must link the single replay-validated rework
   packet from the prior nay; omission or substitution fails closed.

There is no majority, quorum, abstention, chair, tie-breaker, weighted vote, or
timeout approval. A diagnostic turn cap terminates `blocked` with unresolved
arguments; it can never approve.

`approved`, `blocked`, and `closed` are terminal for persona entries. A user or
safety close cannot be reopened into approval; changed work starts a legal new
cycle or review instead.

An unfinished or unclosed approved review may be closed as `superseded` when a
separate, replay-verified review of the same pull request names the current Git
head and a different commit. Its stored proposal must match the effective Git
diff. Both reviews must be free of open blockers and active nay votes, and the
replacement must be active or approved. The closing entry records the exact
replacement opening and proposal; validation replays that history later.
Supersession is never an approval and does not replace the new review's own
votes, checks, or merge gate. The Git check verifies the local checkout; the
coordinator must still verify the pull request's remote head. User, safety,
blocked, or already closed reviews cannot be superseded.

## State and commands

Coordinator-owned mutable state lives at:

```text
.optimizexp/runs/<runId>/consensus/<reviewId>/state.json
```

Writes are atomic and serialized; bus entries are never rewritten. The state
contains all six persona keys, subject digests, cycle, turn, status, investment,
arguments, blockers, final votes, and latest decision entry. Validators
cross-check state against the append-only bus.

```bash
# create/open
node --import tsx .agents/skills/optimizexp/workflows/cross-agent/consensus-loop.mts \
  --mode init --run <runId> --review <reviewId> --base-sha <sha> \
  --head-sha <sha> --proposal <manifest.json>

# append a position/reply/vote/resolution
node --import tsx .agents/skills/optimizexp/workflows/cross-agent/consensus-loop.mts \
  --mode append --run <runId> --review <reviewId> --entry <entry.json>

# inspect or advance one substantive turn
node --import tsx .agents/skills/optimizexp/workflows/cross-agent/consensus-loop.mts \
  --mode status --run <runId> --review <reviewId>
node --import tsx .agents/skills/optimizexp/workflows/cross-agent/consensus-loop.mts \
  --mode advance --run <runId> --review <reviewId> --persona <id>

# aggregate, validate, and gate merge
node --import tsx .agents/skills/optimizexp/workflows/cross-agent/consensus-loop.mts \
  --mode decide --run <runId> --review <reviewId>
node --import tsx .agents/skills/optimizexp/workflows/cross-agent/consensus-loop.mts \
  --mode validate [--run <runId>] [--review <reviewId>]
node --import tsx .agents/skills/optimizexp/workflows/cross-agent/consensus-loop.mts \
  --mode assert-yay --run <runId> --review <reviewId> \
  --base-sha "$(git merge-base origin/main HEAD)" \
  --head-sha "$(git rev-parse HEAD)" --proposal <manifest.json>

# record a genuinely unresolved evidence-backed blocker before closing blocked
node --import tsx .agents/skills/optimizexp/workflows/cross-agent/consensus-loop.mts \
  --mode block --run <runId> --review <reviewId> --reason <reason>

# close after a final current-head assertion (or close an honest blocked/user/safety result)
node --import tsx .agents/skills/optimizexp/workflows/cross-agent/consensus-loop.mts \
  --mode close --run <runId> --review <reviewId> --result approved \
  --base-sha "$(git merge-base origin/main HEAD)" \
  --head-sha "$(git rev-parse HEAD)" --proposal <manifest.json>

node --import tsx .agents/skills/optimizexp/workflows/cross-agent/consensus-loop.mts \
  --mode close --run <oldRunId> --review <oldReviewId> --result superseded \
  --replacement-run <newRunId> --replacement-review <newReviewId> \
  [--base-ref origin/main]
```

All non-help output is JSON. Invalid transitions and state/bus disagreement fail
closed with deterministic nonzero exits and an actionable invariant name.
`status`, `validate`, and `assert-yay` are read-only.

Policy-aware SDLC review runs set
`designerConsensusPolicy: "required-when-design-relevant"`. Their `scope.json`
records `designerConsensus.required`, `reviewId`, `baseSha`, `headSha`, and the
current `proposalPath`. A `required: false` decision must instead provide
changed paths, acceptance tags, and a deterministic
`internal-no-public-behavior` exemption. Run `assert-complete` replays persona
votes, recomputes the manifest, and fails on a missing decision, rejected
exemption, nay, stale base/head/proposal, short vote history, blocker, or
state/bus mismatch. Legacy non-SDLC runs remain unchanged.
Current-head Git checks discard inherited hook-local repository variables, so
linked-worktree and fixture validation always resolves the configured checkout.
Required reviews compare the proposal's sorted paths and SHA-256 of the
full-index binary Git diff with the effective base-to-head diff. Exemptions are
also base/head-bound and must list that exact diff; self-attested paths fail.
Binary evidence source payloads up to 16 MiB are inspected directly so
current-head validation does not fail on reviewed recordings or screenshots.

## SDLC gate

A change is design-relevant when paths or acceptance tags touch user-facing web,
TUI, CLI, docs, SDK/API, configuration, onboarding, examples, brand, motion,
interaction, design tokens, components, public errors, or OptimizeXP
evidence; when user/coordinator explicitly requests review; or when a prior
council cycle exists. A purely internal refactor may use a machine-readable,
justified exemption. Skipping silently is invalid.

For each design-relevant PR layer, SDLC closeout runs rubber-duck, adversarial,
independent review, evidence refresh, council, rework when needed, comment/check
repair, and `assert-yay` immediately before merge. Any post-consensus commit or
effective-base change invalidates approval and returns to evidence/council.
Billing-only CI exceptions waive only the CI condition, never council consensus.
`/sdlc --finish` is authorization to land work, not an approval bypass.

For stacks, review the whole stack's combined diff against trunk once, at the
top of the stack. After merging trunk or a lower-layer fix in, recompute the
proposal digest and reconvene whenever it changed.
`sdlc-state.md` records the council review ID, cycle, result, consensus entry,
proposal digest, reviewed head, and assertion time, but it is not authoritative.
