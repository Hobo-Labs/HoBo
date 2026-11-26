# S3-05 Allow Triple Effects POC

Draft POC for **HOBO-631**: wire S1-17 `.allow()` declarations through one compiler that emits exactly three effects (FR-002, Plan 21):

1. **Least-privilege IAM** — provider actions derived from declared verbs.
2. **WASM link table** — deny-by-default entries scoped to allowed verbs.
3. **Token-scope ceiling** — broker refuses `request_token` outside the ceiling with `token.Denied`.

Promotes least-privilege scope-narrowing scenarios from `src/draft/epic-proofs/identity-auth-secrets-cross-app-access-xaa/`.

## Verification

```bash
pnpm --prefix src/draft/technical-proofs/s3-05-allow-triple-effects-poc test
```

Golden fixture: `fixtures/hello-bindle-golden.json` pins the IAM+link+scope triple for `hello-bindle`.

## Scope

In scope: compile-time triple emission, golden assertion, broker ceiling enforcement with auditable denial.

Out of scope: production promotion to `packages/identity/`, real IaC program emission (S2-06), wasm host runtime (S1-04). Those remain blocked on upstream slices.

## Architecture Evidence

- `architecture/` — protobuf + CUE contract artifacts.
- `architecture/pacts/` — PACT boundary fixture.
- `ADR.md` — parse-don't-validate and triple-effect seam notes.
