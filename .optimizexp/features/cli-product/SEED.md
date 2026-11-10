# Feature seed

A developer or agent runs the real product CLI (`hobo` from `@hobo/cli`) and
gets discoverable help, honest JSON envelopes, and non-zero exits on failure —
without live cloud credentials.

Scenarios invoke the actual binaries (built `packages/cli/dist/bin/hobo.js`
when present, else `pnpm exec tsx packages/cli/src/bin/hobo.ts`). One-time setup for the
`hobo` bin: `pnpm --filter @hobo/cli... run build`.

Known-defect characterizations live in KNOWN-DEFECTS.md; affected scenarios
are tagged `@known-defect` and assert CURRENT behavior so the suite stays
green until the owning fix flips them.

evidence:
hobo-help-lists-the-canonical-verbs
