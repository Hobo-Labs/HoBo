# `@hobo/adapter-bitwarden` contracts

The Bitwarden SDK boundary: the adapter (consumer) and the SDK's client
(provider). Executable PACT: [`pacts/bitwarden-sdk.pact.json`](./pacts/bitwarden-sdk.pact.json).
Inventory: [`pact-inventory.md`](./pact-inventory.md).

```sh
pnpm --filter @hobo/adapter-bitwarden test:contract:consumer
pnpm --filter @hobo/adapter-bitwarden test:contract:provider
```
