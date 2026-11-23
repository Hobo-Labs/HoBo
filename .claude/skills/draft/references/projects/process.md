---
type: Agent Skill Reference
title: "Project proof reference"
description: "Implement and verify project behavior integrated across proof packages."
tags: [hobo, draft, projects]
---

# Project proof reference

Project proofs live under `src/draft/projects/<slug>`. Implement the requested behavior and update the packages that own shared contracts rather than copying their logic. Keep `proof.json` references aligned with actual integrations, and remove obsolete proofs and references.

Run the project tests, integrated package checks, runnable examples, and the notebook required by the artifact gate. Document setup and usage only for behavior that exists. Capture evidence from a real run when needed; do not create ADRs, planning documents, synthetic ledgers, or placeholder projects.
