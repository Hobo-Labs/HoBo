---
type: Agent Skill Reference
title: "Technical proof reference"
description: "Implement and validate isolated technical behavior with executable evidence."
tags: [hobo, draft, technical-proofs, contracts]
---

# Technical proof reference

Implement the requested behavior in its owning package and keep the affected contract fixtures and tests aligned. Use deterministic boundaries for default tests, and preserve generated protobuf, CUE, and Pact contracts where they apply.

For `src/draft/technical-proofs/<slug>`, maintain an accurate `proof.json`, runnable examples with expected output, and the notebook required by `draft:artifacts`. Run a real benchmark when performance is relevant. Record an inapplicable requirement with a reason in the manifest; do not use a waiver to leave work unfinished. When a proof is retired, move missing behavior and meaningful tests into the owning package and remove the proof, its generated artifacts, and its promotion-ledger entry.

Run `pnpm --prefix src/draft/technical-proofs/<slug> test` and the relevant staged checks. Update and test referencing packages when their behavior changes. Do not create ADRs, design documents, or placeholder proofs.
