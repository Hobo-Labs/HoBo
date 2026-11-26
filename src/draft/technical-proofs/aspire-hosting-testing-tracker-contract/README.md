# HOBO-705 Aspire.Hosting.Testing tracker contract

Draft proof for [HOBO-705](https://linear.app/quickdeploy-ai/issue/HOBO-705) / GAP-026:
the Aspire competitor tracker must not mark `Aspire.Hosting.Testing` as ✅ unless Plan 09
documents a whole-graph in-process harness spec.

## Contract surface

- `evaluateAspireHostingTestingTracker({ aspireMarkdown, generatedStackMarkdown })`
  returns a machine-readable parity/overclaim verdict.
- `loadRepoAspireHostingTestingTracker(repoRoot)` reads the live design docs.
- `assertAspireHostingTestingTracker(...)` fails closed on overclaim.

## Acceptance evidence

- ✅ without a Plan 09 whole-graph hook fails.
- ◐ plus the iteration hook passes.
- Repo docs on branch satisfy HOBO-705 acceptance bullet 1.

## Verification

```bash
pnpm exec turbo run test --filter ./src/draft/technical-proofs/aspire-hosting-testing-tracker-contract
```
