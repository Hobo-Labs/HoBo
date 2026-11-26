# `@hobo/adapter-infisical` contracts

The Infisical HTTP boundary: the adapter (consumer) and Infisical's API
(provider): OIDC Auth and Universal Auth login, and the v4 secrets endpoints.

Executable PACT: [`pacts/infisical-api.pact.json`](./pacts/infisical-api.pact.json).
Inventory: [`pact-inventory.md`](./pact-inventory.md).

```sh
pnpm --filter @hobo/adapter-infisical test:contract:consumer
pnpm --filter @hobo/adapter-infisical test:contract:provider
```
