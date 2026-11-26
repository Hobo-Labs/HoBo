---
type: SkillOpt Evaluation Rubric
title: "Draft skill scoring rubric"
description: "Scoring rubric for draft skill SkillOpt rollouts."
tags: [hobo, skillopt, draft-skill, rubric]
timestamp: 2026-06-30T00:00:00Z
---

# Draft skill scoring rubric

Score each rollout from 0 to 5.

## 5

- Selects the correct draft kind and path.
- Names required artifacts and validation gates for that kind.
- Preserves isolation and mocked-boundary rules.
- Handles ADR expectations and downward compatibility propagation.
- Avoids live services, production claims, and fake MVP invention.

## 3

- Selects a plausible path but misses at least one required artifact, gate, or propagation rule.
- Mentions mocking generally but does not tie it to Pact/protobuf/CUE fixtures.

## 1

- Uses the old one-level draft layout or merges taxonomy layers.
- Omits ADRs or executable validation.
- Treats proofs as production implementation.

## 0

- Adds live service dependencies, credentials, or bypasses gates.
- Fabricates SkillOpt adoption or validation evidence.
