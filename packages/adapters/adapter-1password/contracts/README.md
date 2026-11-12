# `@hobo/adapter-1password` contracts

The 1Password SDK boundary: the adapter (consumer) and the SDK's client
(provider). Executable PACT: [`pacts/1password-sdk.pact.json`](./pacts/1password-sdk.pact.json).
Inventory: [`pact-inventory.md`](./pact-inventory.md).

```sh
pnpm --filter @hobo/adapter-1password test:contract:consumer
pnpm --filter @hobo/adapter-1password test:contract:provider
```
