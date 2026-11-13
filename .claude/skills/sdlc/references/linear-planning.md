---
type: Agent Skill Reference
title: "SDLC Linear capture"
description: "Turn an approved plan into Linear initiative/projects/milestones/issues with one-shot contracts."
tags: [hobo, sdlc, linear]
timestamp: 2026-07-02T00:00:00Z
---

# Linear capture

Structure: **initiative** per major scope → **projects** for stage/epic-sized chunks →
**milestones** for subsystem groupings → **issues** for independently-implementable slices.
Reuse workspace conventions (team HoBo; labels `slice`/`spike`/`hardening`/`security`/
`adversarial`/`user-story`; severity→priority).

## The one-shot contract (every issue body)

A low-capability LLM with ONLY the issue and the repo must be able to implement it. Sections:
**Why** (stage goal + fit) · **Context & references** (design docs, draft proofs, ADRs — with the
load-bearing decisions QUOTED, not just linked) · **Scope in/out** (exact file/package paths;
name the issue that owns excluded work) · **Steps** (numbered, mechanical, incl. repo setup) ·
**Acceptance criteria** (runnable commands + expected outcomes; these become the failing tests) ·
**Guardrails** (PACT/proto+CUE/parse-don't-validate/CQRS; TS-only; no src/draft forks) ·
**Definition of done** (green gates + docs freshness + dependsOn).

Additionally REQUIRED per issue: the **verifiable outputs** (what artifact proves completion) and
the **draft artifacts** the layer demands (proof.json, executed examples, notebook, bench/features/
per-type assets — see the draft skill). An issue without runnable acceptance is not dispatchable.

## Mechanics

- Creation is **paced, single-writer** (one save_issue at a time, retry on throttle) — the
  2026-06-24 burst rate-limit lesson in docs/implementation-plan.md.
- Create in dependency order so `blockedBy` targets exist; stage M0/acceptance issues block their
  skeletons.
- If Linear MCP access is unavailable, stage the full scope in `plans/<name>-backlog.md`
  with an import runbook. `plans/` is ignored by git: a plan or backlog is never committed
  (AGENTS.md, "Plans are not committed").
- Before authoring, read `docs/plans/dispatch-log.md` — recurring failure classes there are
  contract defects; fix the template, not just the issue.

Exit: issues exist (or staged); state file updated (phase: captured, issue list).
