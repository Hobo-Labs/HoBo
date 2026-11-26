---
type: Agent Skill Reference
title: "Experience proof reference"
description: "Verify implemented user, developer, customer, agent, and API experiences."
tags: [hobo, draft, exp-proofs]
---

# Experience proof reference

Experience proofs live under `src/draft/exp-proofs/<type>/<slug>`, where `dx` is developer, `ux` is user, `cx` is customer, `ax` is agent, and `api` is API or SDK experience. Implement the actual requested behavior and test the observable journey. Do not create design documents, personas, plans, or placeholder scenarios.

Keep `proof.json` aligned with the type folder and retain runnable examples and the required executed notebook. The artifact gate expects visual assets for UX, protobuf and CUE contracts for DX, executable customer tests or feature steps for CX, agent fixtures for AX, and type tests for API proofs. Capture evidence from the running behavior when it is needed to substantiate a claim.

Run the package tests and relevant staged checks; update affected consumers when contracts change. Keep default tests independent of live external services.
