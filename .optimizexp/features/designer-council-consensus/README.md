# Designer council consensus

Executable acceptance scenarios for deterministic investment decay, unanimous
binary voting, rework routing, and stale-head invalidation. Jony Ive and Steve
Jobs are the scenario viewpoints; the exercised protocol always aggregates the
full canonical six-person council.

Run the binding smoke tests after the protocol implementation is present:

```bash
pnpm run test:file .optimizexp/features/designer-council-consensus/test/designer-council-consensus.bindings.test.ts
```

Cross-cutting forgery, stale-manifest, blocker-persistence, max-turn, and
conversation-order regressions live in
`test/designer-council-adversarial.test.ts`. Review-loop bus and completion
integration is protected by `test/designer-council-review-loop.test.ts`.
Canonical persona scope, relevant-check routing, and standing approval for safe
OptimizeXP preflight repairs are pinned by the corresponding
`test/designer-council-*.test.ts` and
`test/optimizexp-preflight-approval.test.ts` policy regressions.
