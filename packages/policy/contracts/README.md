Executable PACT consumer evidence for `@hobo/policy` service boundaries.

| Pact | Boundary |
|---|---|
| [`pacts/agent_guardrail.pact.json`](./pacts/agent_guardrail.pact.json) | Gateway/runtime agent guardrail evaluation |

Run consumer tests:

```sh
pnpm --filter @hobo/policy test:contract:consumer
```
