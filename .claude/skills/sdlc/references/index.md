# SDLC skill references

Progressive-disclosure bundle for the sdlc coordinator skill. Route by phase:

- [finish.md](finish.md) — **`--finish`**: land the current session (commit, merge latest trunk in, conflicts, supersession check, open/update the one workstream PR, push, combined-diff closeout, merge-commit landing of all session work).
- [brainstorm.md](brainstorm.md) — idea generation + adversarial/rubber-duck hardening, exit criteria.
- [linear-planning.md](linear-planning.md) — one-shot issue contracts, initiative/milestone structure, paced creation.
- [dispatch.md](dispatch.md) — permission gate, harness-detected backend matrix (cloud coding agents preferred for isolated issues), claim protocol, dual-transport handback, Done rule, resume/reconcile, incremental checkins.
- [stacked-prs.md](stacked-prs.md) — parent-owned `gh stack` layers landed as one unit, subagent checkins, one PR per workstream, supersession check, combined-diff rubber-duck/adversarial review, comment/check repair, merge-commit landing (never squash or rebase-merge).
- [loops-and-gates.md](loops-and-gates.md) — red/green inner loop, narrow-then-wide outer loop, required test lanes.
- [cascade.md](cascade.md) — how requirement changes ripple through plans, proofs, ADRs, and Linear.

SKILL.md keeps Codex-valid frontmatter; OKF concept metadata lives in these references
(validated by `pnpm run docs:okf`; mirror equality by `pnpm run skills:mirror-check`).

Companion CLI skill (all agents): `gh-stack` under `.agents/skills/gh-stack` and `.claude/skills/gh-stack`.
