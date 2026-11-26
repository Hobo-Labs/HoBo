Executable PACT consumer evidence for `@hobo/iac-pulumi` service boundaries.

| Pact | Boundary |
|---|---|
| [`pacts/iac_backend_boundary.pact.json`](./pacts/iac_backend_boundary.pact.json) | IaC backend conformance + adapter identity (per-resource stack model) |

Run consumer tests:

```sh
pnpm --filter @hobo/iac-pulumi test:contract:consumer
```
