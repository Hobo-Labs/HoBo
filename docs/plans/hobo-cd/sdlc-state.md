---
type: Delivery State
title: "HoBo.CD delivery state"
description: "Durable delivery history and coordination state for the HoBo.CD implementation (plan 0024): contract commit, work-package branches, decisions taken during delivery, and what the coordinator still owns."
tags: [cd, delivery, state]
---

# HoBo.CD delivery state

Plan: [0024 — HoBo.CD design and swarm implementation plan](../0024-hobo-cd-swarm-instruction.md).
Decisions: [ADR-0180](../../design/adr/01-architecture-core.md#adr-0180). Design:
[continuous-delivery.md](../../design/continuous-delivery.md).

## 2026-11-12 — swarm dispatched

- **Contract commit:** `b633769e` on `integration/hobo-cd` holds plan 0024 and every
  Appendix A frozen file (`packages/cd/{package.json,tsconfig.json,vitest.config.ts,LICENSE}`,
  `data-models/{buf.yaml,cd.proto}`, `src/{events,ports,index}.ts`) plus generated code.
- **Work packages:** WP1–WP25 dispatched at once, one worktree and one branch
  `cd/wp<NN>-<slug>` each, branched from the contract commit.
- **Rolling integration:** the coordinator merges each branch into `integration/hobo-cd`,
  runs the gates in plan 0024 §11, and records promoted proofs in `scripts/promotions.json`.
  Landing is one PR from `integration/hobo-cd`, per the `sdlc` skill.

## Decisions taken during delivery

- **ADR number.** Plan 0024 R3 names the decision record ADR-0178. ADR-0178 (provider
  manifest) and ADR-0179 (stateless hosted relay) were already assigned on `main`, so the
  record is **ADR-0180** in `docs/design/adr/01-architecture-core.md` (WP21). The plan text is
  frozen and still says ADR-0178.
- **Turbo and boundary registration** for `cd`, `cd-gitops`, `cd-kube-fleet`,
  `resolver-components` and `storage-postgres` landed before the directories merge
  (WP21); `storage-postgres` is classified as engine-specific storage.
- **Runbooks** in `docs/runbooks/cd/` are assembled from each module README's Runbook
  section as it stood on its work-package branch; the module READMEs stay the source of truth.

## Coordinator-owned, open

- Merge every work-package branch and run the full gate list (plan 0024 §11 step 3).
- Record the promoted proof ids from each work-package report in `scripts/promotions.json`.
- Re-assemble `docs/runbooks/cd/` if a module's Runbook section changed after WP21 read it.
- Dogfooding: the follow-up package that delivers HoBo CI's hosted relay, runner controllers
  and self-hosted runner fleets through HoBo.CD (`hoboCiDogfoodSources` is the starting seam).
