---
type: Agent Skill Reference
title: "Epic proof reference"
description: "Implement and verify integrated behavior across proof packages."
tags: [hobo, draft, epic-proofs, contracts]
---

# Epic proof reference

Existing epic proofs live under `src/draft/epic-proofs/<slug>`. Complete integrated behavior in the owning packages, update affected consumers, and remove obsolete proofs and references.

Preserve meaningful executable behavior checks in the owning packages and run `pnpm run test:behavior` when relevant. Do not create ADRs, planning documents, or placeholder features.

Run the relevant staged checks, including `draft:cascade` for changed dependencies.
