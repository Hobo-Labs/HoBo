Executable PACT consumer evidence for `@hobo/identity` service boundaries.

| Pact | Boundary |
|---|---|
| [`pacts/identity-boundary.pact.json`](./pacts/identity-boundary.pact.json) | Gateway verifies attested-workload JWT-SVID via OIDC JWKS (identity service boundary) |

Run consumer tests:

```sh
pnpm --filter @hobo/identity test:contract:consumer
```
