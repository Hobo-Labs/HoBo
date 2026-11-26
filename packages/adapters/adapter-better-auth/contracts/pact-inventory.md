# @hobo/adapter-better-auth PACT inventory

This package is pure: it parses, maps, and describes. Its boundary is therefore
an in-process, HTTP-shaped one — the authoring/plan surface hands it an authored
config or a verified claim set and gets back a parsed record, a mapped
principal, or a refusal carrying a `code` and remediation.

| Boundary | Consumer | Provider | Protocol | Pact file/test | Provider verification | Mock used | Status |
|----------|----------|----------|----------|----------------|----------------------|-----------|--------|
| Better Auth issuer adapter surface (config parse, claims mapping, runtime gate) | HoboAuthAuthoring | HoboBetterAuthAdapter | in-process HTTP-shaped | `pacts/better-auth-issuer-boundary.pact.json` | not executed — see note | none | pact_only |

## Notes

- Three of the six interactions are **refusals**, which is the point of the
  document: the inline-secret rejection, the missing-`basePath` rejection, the
  unmapped-claim rejection, and the gated-runtime rejection are the behaviors a
  consumer most needs pinned, because each of them is a case where degrading
  quietly would be easy and wrong.
- **No executable consumer/provider tests ship here.** The refusal codes,
  remediation strings, and mapped-principal shapes in the pact are asserted
  directly by `test/config.test.ts`, `test/claims.test.ts`,
  `test/claims-conformance.test.ts`, and `test/descriptor.test.ts` against the
  same parse boundaries. The pact records the boundary's shape for a future host
  that mounts it over real HTTP; it is not yet driven by a verifier, and this
  row says so rather than claiming `provider_verified`.
- The signing secret appears in every interaction as a **locator**
  (`hobo-secret://…`). No interaction in this file carries signing material,
  and the inline-secret interaction exists to prove one cannot be introduced.
