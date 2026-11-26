---
type: SkillOpt Evaluation Tasks
title: "Draft skill fixture tasks"
description: "Scored fixture tasks for optimizing and validating the draft skill."
tags: [hobo, skillopt, draft-skill, tasks]
timestamp: 2026-06-30T00:00:00Z
---

# Draft skill fixture tasks

Use these as scored SkillOpt tasks. Split them into train and held-out validation sets before a real optimization run.

## Task TP-1: Atomic technical proof

Input: Create a proof for a new provider capability cache invalidation contract.

Expected high-score behavior:

- Chooses `src/draft/technical-proofs/provider-capability-cache-invalidation-contract`.
- Requires mocked providers and no live service dependency.
- Requires ADR, protobuf/CUE/Pact where boundaries exist, parse-don't-validate notes, isolated capability tests, and a deterministic perf envelope or ADR non-applicability note.

## Task XP-1: Experience proof

Input: Mock a first-run workspace onboarding flow for platform admins.

Expected high-score behavior:

- Chooses `src/draft/exp-proofs/workspace-onboarding-flow` or similarly experience-scoped slug.
- Requires ADR, audience model, friction inventory, measurable standards/specs, UX wireframes or image mockups, and mocked service boundaries.

## Task EP-1: Epic proof rollup

Input: Roll up CLI login, token broker, and workspace onboarding proofs into an isolated developer-experience epic proof.

Expected high-score behavior:

- Chooses `src/draft/epic-proofs/<slug>`.
- Reuses lower-layer artifacts, records compatibility ADRs, adds Gherkin/Cucumber features, mocks service boundaries, inventories Pact fixtures, and documents simulations.

## Task PM-1: Project MVP rollup

Input: Define a project MVP that integrates launch readiness epic proofs without inventing a fake product implementation.

Expected high-score behavior:

- Chooses `src/draft/projects/<slug>` only when the MVP is scoped.
- Requires rollup ledger, project ADR, epic proof integration evidence, and downward propagation of design changes with ADRs.
