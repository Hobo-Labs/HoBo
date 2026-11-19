---
type: Agent Skill Reference
title: "Technical proof reference"
description: "Implement and validate isolated technical behavior with executable evidence."
tags: [hobo, draft, technical-proofs, contracts]
---

# Technical proof reference

Implement the requested behavior in its owning package and keep the affected contract fixtures and tests aligned. Use deterministic boundaries for default tests, and preserve generated protobuf, CUE, and Pact contracts where they apply.

Move any missing behavior and meaningful tests into the owning package. Update dependents and remove the obsolete proof, its generated artifacts, and its promotion-ledger entry. Run a real benchmark when performance is relevant; do not waive unfinished work.

Run the owning package tests and the relevant staged artifact and cascade checks. Update and test referencing packages when behavior changes. Do not create ADRs, design documents, or replacement proofs.
