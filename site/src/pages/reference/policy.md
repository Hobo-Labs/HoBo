---
layout: ../../layouts/Docs.astro
title: Policy plane
description: "Policy packs, mandatory deny ceilings, obligations, policy.Decided, ABAC, and composition inside Gatekeeper."
---

# Policy plane

Policy is **versioned, signed-pack evaluated** authorization and obligation logic. It is not “config flags scattered in YAML.” The policy engine holds IR and agent guardrails; Gatekeeper composes policy with contracts and cost.

## Packs

A **policy pack** attaches to Yard/Junction (and can be proposed by Platform Engineer Crew):

| Kind | Behavior |
|---|---|
| **Mandatory** | Deny ceilings — children may only further restrict |
| **Default** | Overridable baselines |

Evaluation is deny-by-default for unlisted `(role, action, resource)` on control-plane surfaces. CLI/MCP verbs map to `hobo:<resource>:<verb>` or conformance fails.

## Decisions

Every evaluation emits **`policy.Decided`** — including **allows**. Reasons are machine-readable for agents and humans.

High-risk actions (destroy, prod mutate, spend above cap) resolve to:

- `allow`
- `require-approval` (obligation)
- `deny`

## Obligations

When decision is `require-approval` or similar, Gatekeeper records **obligations** (who, deadline, what satisfies). Unsatisfied obligations block mutate paths. A2H handoffs create human obligations with the same machinery.

## Never retry policy denials

Resilience layers **must not** retry `policy.Decided` denials. That class is terminal for the attempt — change policy or request approval, do not spin.

## Guardrails

AI operators and generation paths evaluate content/tool guardrails (PII, jailbreak, unsafe tools). Blocks emit `guardrail.Blocked` **and** `policy.Decided`.

## Composition order (Gatekeeper)

1. Contracts / can-deploy 
2. **Policy pack** 
3. Obligations 
4. Cost / quota 
5. Optional secretless-config / can-migrate / effects visibility 

## Related

[Contracts & Gatekeeper](/HoBo/reference/contracts/) · [Security](/HoBo/security/) · [Effects](/HoBo/reference/effects/)
