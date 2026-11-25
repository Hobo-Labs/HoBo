# EXPERIENCE: designer-council-consensus

- entryCommand: `node --import tsx .agents/skills/optimizexp/workflows/cross-agent/consensus-loop.mts --mode validate`
- driver: cli
- intent: Deterministically prove that only current-head exact-six unanimous approval unlocks SDLC closeout.

## Rubber-duck (explain to a new teammate)

1. Who is the persona and what are they trying to finish in the next 2 minutes?
   - A council reviewer or SDLC coordinator must determine whether a design-relevant change can close, or receive an exact rework obligation.
2. What exact command / UI path do they take from a clean machine?
   - Run `node --import tsx .agents/skills/optimizexp/workflows/cross-agent/consensus-loop.mts --mode validate`, then operate a review through the same noninteractive CLI.
3. What do they see first? (quote expected chrome, not vibes)
   - JSON with `"ok": true` for valid state, or a failed invariant naming the missing vote, blocker, or stale digest.
4. What would make them think they opened the wrong product?
   - A prose-only review, a majority tally, or output that omits reviewed head and proposal digest would not be the council protocol.
5. Happy path: step-by-step (Given/When/Then in prose first).
   - Given six current-subject yay votes and no blocker, when consensus is asserted, then merge eligibility is true.
6. Failure path: how do they break it, what must the product say?
   - Supply one nay or change the reviewed head; the protocol must emit rework or reject stale approval with a non-zero assertion.
7. What evidence will prove a human/agent actually ran this? (driver + command)
   - CLI driver output from focused protocol and binding tests, plus append-only council entries produced by fixture reviews.
8. What is deliberately out of scope for this feature folder?
   - Generating persona prose, contacting live providers, or automating GitHub merge operations.

## Adversarial critique (must check all)

- [x] Did not skip default entry because a secondary verb is easier to automate
- [x] Not testing a monorepo script instead of the product binary
- [x] No When-step is only “exercise the surface” without a real command
- [x] Scores cannot be invented without reading stdout/TUI
- [x] Persona vocabulary/asserts considered for shared paths
- [x] Security: secrets, destructive promote, network—fail-closed
- [x] Cognitive load: journey stays within persona thresholds
- [x] Confusion twin: majority approval / stale approval / prose review—covered
- [x] If this feature were the only one we ship, the persona would not still be lost

## Verdict

- accept
- primaryCommand: `node --import tsx .agents/skills/optimizexp/workflows/cross-agent/consensus-loop.mts --mode validate`
- driver: cli
- scenarios: preference decay, nay rework, unanimous current-head approval, stale-head invalidation
