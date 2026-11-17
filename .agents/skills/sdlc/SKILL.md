---
name: sdlc
description: Implement and validate repository changes, using incremental commits and stacked pull requests when appropriate.
---

# SDLC coordinator

Follow the repository rules in `AGENTS.md` for every task and harness.

1. Inspect the request, relevant code, and existing tests. Complete unfinished work found in scope.
2. Implement the change directly with self-documenting names, types, and functions. Do not create plans, design documents, or session state files.
3. Run the narrow relevant checks, then the repository-required staged checks. Fix failures before continuing.
4. Use incremental commits. For dependent changes, use the repository's `gh-stack` skill to create and update a stack of reviewable pull requests.
5. Report the implemented behavior, validation, and concrete blockers. Do not merge or deploy unless the user authorized it.
