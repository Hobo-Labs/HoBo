# Cross-agent deterministic runner

For hosts without native workflows (or as a scoring co-processor for all hosts).

```bash
node --import tsx .agents/skills/optimizexp/workflows/cross-agent/review-loop.mts --help
# without installed deps:
node --experimental-strip-types .agents/skills/optimizexp/workflows/cross-agent/review-loop.mts --help
```

Modes: `init` | `status` | `should-stop` | `equilibrium` | `assert-complete` | `mark-complete` | `validate-bus` | `read-bus` | `aggregate-bus` | `score` | `plateau`.

Design-relevant SDLC work additionally uses `consensus-loop.mts`:

```bash
node --import tsx .agents/skills/optimizexp/workflows/cross-agent/consensus-loop.mts --help
```

Its deterministic modes are `init`, `append`, `advance`, `status`, `decide`,
`validate`, `assert-yay`, and `close`. See `../../references/design-council.md`.

**Completion:** only `assert-complete` exit 0 + `mark-complete` ends an invocation. `should-stop` plateau is cycleStop only.

## Designer council protocol

`consensus-loop.mts` persists exact-six council state and append-only council bus entries. Approval is reconstructed from the six persona-authored final vote entries; a coordinator-authored `consensus` payload is never authority by itself. Replay does not trust a hand-written opening snapshot: cycle zero is re-derived from `proposal-cycle-0.json` plus the effective base/head, later cycles use the validated prior state and deterministic carryover reducer, and every persona/coordinator transition, intermediate state digest, and final snapshot must match. Current approval assertions bind the effective base, head, canonical proposal subject, diff, acceptance/evidence digests, and normalized relevance/evidence signals:

```bash
node --import tsx .agents/skills/optimizexp/workflows/cross-agent/consensus-loop.mts \
  --mode assert-yay --run <run> --review <review> \
  --base-sha <effective-base> --head-sha <current-head> --proposal <manifest.json>
```

An honestly unresolvable evidence-backed hard blocker transitions to `blocked` before close; it never becomes approval:

```bash
node --import tsx .agents/skills/optimizexp/workflows/cross-agent/consensus-loop.mts \
  --mode block --run <run> --review <review> --reason "<external impediment and evidence context>"
node --import tsx .agents/skills/optimizexp/workflows/cross-agent/consensus-loop.mts \
  --mode close --run <run> --review <review> --result blocked
```

Policy-aware SDLC design-review runs set `designerConsensusPolicy: "required-when-design-relevant"` in `scope.json` and persist a `designerConsensus` decision. A required decision supplies `reviewId`, `baseSha`, `headSha`, `proposalPath`, and optionally the effective `baseRef` (default `origin/main`); completion compares those values with the actual checkout. A `required: false` decision is accepted only with `changedPaths`, optional `acceptanceTags`, `explicitlyRequested`, `priorCouncilCycle`, and a machine-validated `no-visual-design-change` exemption (or the legacy `internal-no-public-behavior` code); persisted council state also forces `priorCouncilCycle` true. Legacy non-SDLC runs remain unchanged.

Optional WDK notes: `../../references/cross-agent/vercel-wdk.md`.
Plain runner has **zero** extra dependencies beyond repo `tsx`.
