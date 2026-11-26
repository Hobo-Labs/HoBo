---
type: Agent Skill Reference
title: "OptimizeXP DX — testing systems"
description: "Test lane design that keeps agent and human loops fast while preserving confidence."
tags: [hobo, optimizexp, dx, testing]
timestamp: 2026-07-30T00:00:00Z
---

# DX — testing systems

## Lane ladder (narrow → wide)

1. Smoke single file
2. Named test / file test
3. Package turbo test
4. Changed-scope
5. Contract / schema / behavior
6. Final/all validation

## HoBo anchors

- `pnpm run test:smoke|test:file|test:name`
- `pnpm run test:unit|test:schema|test:contract:*|test:behavior`
- `pnpm agent:check` impact policy
- No default E2E against live services
- Draft: `proof.json`, executed examples, cucumber for epics

## Friction smells

- Agent policy forbids broad suites, docs still recommend them mid-loop
- Flaky tests without quarantine story
- Contract tests used as discovery tools

## Uncertainty smells

- Exit 0 with skipped critical suites
- Behavior tests non-executable (prose Gherkin only)
- Coverage theater without boundary tests (PACT/protobuf/CUE)

## Optimization moves

- Encode lane choice in agent skills (`repo`, `sdlc`)
- Make acceptance criteria become failing tests first (ATDD)
- Keep live evals manual/release-only
