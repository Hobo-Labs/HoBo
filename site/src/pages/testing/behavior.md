---
layout: ../../layouts/Docs.astro
title: Behavior & Cucumber
description: "Gherkin evidence with Pact-derived mocks — not live full-stack E2E against real clouds."
---

# Behavior & Cucumber

Behavior specs document **journeys** as executable evidence. HoBo does **not** use traditional live E2E against real downstream clouds in default PR gates.

## Allowed

| Pattern | Detail |
|---|---|
| Gherkin / Cucumber | Features under behavior specs |
| Playwright as **driver** | Browser UI with **mocked** service boundaries |
| Contract-derived mocks | From Pact / EffectSpec / fixtures |
| Local Camp lane | `hobo dev` / sandbox against in-memory or SQLite |

## Forbidden as default gates

- Real AWS/GCP/Azure mutates in PR CI
- “E2E” that requires live provider credentials
- Hand-written mocks that drift from contracts

## Behavior evidence

Behavior specs use executable features with contract-derived mocks.

## Related

[Testing overview](/HoBo/testing/) · [Contracts](/HoBo/testing/contracts/) · [Deployment rehearsal](/HoBo/testing/deployment/)
