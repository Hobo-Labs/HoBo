---
name: scaffold-exercises
description: Build complete, runnable exercises with learner instructions and reference solutions.
---

# Build Complete Exercises

Follow `AGENTS.md`. Implement each requested exercise and verify its observable behavior. Do not leave placeholder files, unfinished code, deferred-work markers, explanatory code comments, or planning and design documents.

Use dash-case section directories named `XX-section-name/` inside `exercises/` and exercise directories named `XX.YY-exercise-name/` inside each section. Preserve the requested order and use `git mv` when moving tracked exercises.

Create the requested variants:

- `problem/` contains a runnable learner workspace and instructions describing the task and how to check the result.
- `solution/` contains a working reference implementation and instructions for running it.
- `explainer/` contains complete learner-facing material with runnable examples when appropriate.

Give each variant a substantive `readme.md` with working links. Implement meaningful checks for executable examples and exercise solutions. Run the relevant tests and, when the project provides it, `pnpm ai-hero-cli internal lint`. Resolve failures before finishing.
