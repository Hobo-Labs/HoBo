# `@hobo/adapter-opensesame` contracts

The proxied-run boundary: HoBo's process, started under
`opensesame dev --agent run`, and OpenSesame, which swaps an `osr_` surrogate
for the real token at the provider's own host.

Executable PACT: [`pacts/opensesame-proxied-run-boundary.pact.json`](./pacts/opensesame-proxied-run-boundary.pact.json).
Inventory and the status mapping: [`pact-inventory.md`](./pact-inventory.md).

```sh
pnpm --filter @hobo/adapter-opensesame test:contract:consumer
pnpm --filter @hobo/adapter-opensesame test:contract:provider
HOBO_OPENSESAME_KIT=<dir> pnpm --filter @hobo/adapter-opensesame test:real   # the real binary
```
