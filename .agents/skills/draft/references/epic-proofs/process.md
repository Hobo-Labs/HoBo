---
type: Agent Skill Reference
title: "Epic proof reference"
description: "Implement and verify integrated behavior across proof packages."
tags: [hobo, draft, epic-proofs, contracts]
---

# Epic proof reference

Epic proofs live under `src/draft/epic-proofs/<slug>`. Implement the requested integrated behavior, reuse the owning packages, and keep `proof.json` references aligned with actual dependencies. Update affected lower-level implementations and their callers when compatibility changes, and remove obsolete proofs and references.

Keep `features/*.feature` and their step definitions executable, preserving meaningful checks in the owning packages, and run the package tests and `pnpm run test:behavior` when relevant. The artifact gate also checks runnable examples and the executed notebook. Do not create ADRs, planning documents, or placeholder features.

Run the relevant staged checks, including `draft:cascade` for changed dependencies.
