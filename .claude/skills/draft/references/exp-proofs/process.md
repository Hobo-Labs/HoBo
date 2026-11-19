---
type: Agent Skill Reference
title: "Experience proof reference"
description: "Verify implemented user, developer, customer, agent, and API experiences."
tags: [hobo, draft, exp-proofs]
---

# Experience proof reference

Experience proofs live under `src/draft/exp-proofs/<type>/<slug>`, where `dx` is developer, `ux` is user, `cx` is customer, `ax` is agent, and `api` is API or SDK experience. Implement the actual requested behavior and test the observable journey. Do not create design documents, personas, plans, or placeholder scenarios.

Move missing behavior and meaningful checks into the owning package, update dependents, and remove obsolete experience proofs and artifacts. Capture evidence from running behavior when needed to substantiate a claim.

Run the package tests and relevant staged checks; update affected consumers when contracts change. Keep default tests independent of live external services.
