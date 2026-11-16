---
name: verify-connection-lifecycle
description: Check provider connection authorization and revocation state transitions when changing the listed HoBo code; run a bounded TLA+ model and focused real-code checks.
---

# Provider connection authorization and revocation

**Property:** Revocation is terminal: a revoked connection must not later resolve for token use.

**Why:** A connection presented as revoked can become usable again.

**Review basis:** commit `c87a967a4133814654e49a12bd10d5ad81b9ddf5`. The prior implementation allowed reauthorization after revocation. Existing token guard tests and create-new remediation establish terminal revocation; the corrected command and replay checks pass.

## Covered code

- `packages/identity/src/connection.ts`
- `packages/identity/src/connection-events.ts`
- `packages/identity/src/token-broker.ts`
- `packages/identity/test/connection-lifecycle.property.test.ts`

## Run

From the repository root:

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-connection-lifecycle
```

The command runs the real-code checks, fast-check histories, and TLC 1.7.4 with the pinned checksum. It uses `TLA2TOOLS` if set; otherwise it downloads the jar into a temporary directory. Java 11+, Node with the repo's `tsx`, `curl`, and `sha256sum` are required. Read each TLA+ result with `/statechart`; it can draw the model using the view in `models/`.

## Scope and evidence

One connection and one authorized subject; create, authorization, reauthorization, rotation, revocation, late facts, and token resolution are modeled. TLC reaches five states. The generated real-code check runs 200 histories (seed 614447), mixing authorization, rotation, reauthentication, repeated revocation, and late creation, authorization, health, reauthentication, and rotation facts. It checks that revocation remains terminal and rejected commands emit no events. The projection ignores facts that would revive a revoked connection.

Mutation evidence: Scratch source mutations allowing reauthorization or late replay fail the generated real-code check. Allowing authorization after revocation in the model violates `RevokedRemainsRevoked`.

A TLC pass checks this model, not the entire implementation. The tests exercise the stated real-code cases, not all possible implementations or production integrations. See the identity README for the user-facing chart.

## Keep in sync

Before trusting a result, inspect changes to the covered files since `c87a967a4133814654e49a12bd10d5ad81b9ddf5`, including uncommitted changes. If behavior changed, update the model and real-code checks; distinguish a real counterexample from a model mismatch by replaying it against the code. Run the check, reproduce a deliberately broken variant in a scratch copy, then move this sync commit forward only after confirming the model still describes the code. Use `/maintain-formal-verification-skill` for that update.
