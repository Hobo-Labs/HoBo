# multi-cloud-shop

A HoBo example shop: a **storefront web app**, a **shop API**, a **products kv
store**, an **orders queue**, and the **bindle** that wires them — one unchanged
bindle. Provider selection belongs on a **Yard**, not inside the Bindle. The
local Yard advertises `kv` + `queue`, so `hobo plan` / `hobo up` can demo this
package on the default lane. Live AWS/Azure apply is still credential-gated.

## The pieces

| File | What it is |
|---|---|
| `src/api.ts` | The shop API — a plain fetch handler exposing `GET /products` and `POST /orders`. |
| `src/webapp.ts` | The storefront (plain fetch handler) that is bound to the API. |
| `src/bindle.ts` | The bindle config that does the wiring — strictly provider-neutral (provider pins are forbidden on a Bindle). |
| `test/bindle.test.ts` | Proves the graph, the handlers, the pact pin, and manifest determinism. |

```ts
export default bindle("multi-cloud-shop", (b) => {
	const products = b.kv().allow("get", "set");
	const orders = b.queue().allow("enqueue");
	const api = b.api(() => shopApi).dependsOn(products, orders);
	const web = b.web(() => storefront).dependsOn(api);
	return { products, orders, api, web };
});
```

## Two providers, one bindle

The bindle is provider-agnostic by rule: `assertNoBindleProviderSelection`
(`@hobo/bindles`) throws `bindle-provider-selection-forbidden` on any cloud
provider pin. Provider selection belongs on a **Yard** — attach this same
definition to a provider-specific Yard (for example
`yard("aws-prod", { provider: "aws", camps: [camp("prod")] })`, see
`examples/self-host-yard`) per target cloud. `targetFromBindleDefinition`
(from `@hobo/cli`) plus `collectBindleManifest` (from `@hobo/bindles`) compile
it to the same manifest IR with the same canonical hash on every run — the
test asserts this — so deploying to a second provider changes zero bindle
bytes. The cost-gated CI lanes in
`.github/workflows/fixtures.yml` point at this package via
`HOBO_E2E_FIXTURE=examples/multi-cloud-shop` with `HOBO_E2E_PROVIDERS=aws,azure`.

## Run it

```bash
pnpm hobo plan --cwd examples/multi-cloud-shop
pnpm hobo up --cwd examples/multi-cloud-shop
pnpm --filter @hobo/example-multi-cloud-shop test
```

(`pnpm hobo` builds `@hobo/hobo` on first use; `pnpm --filter @hobo/hobo exec
hobo …` does not work because pnpm never self-links a package's own bin.)

If `hobo plan` still exits `HOBO_PLAN_REJECTED`, the printed remediations name
the unsatisfied port. The local Yard must advertise `kv` and `queue` (see
`createBareMetalProvider` in `@hobo/hobo`). Do not invent a cloud provider pin
on the Bindle — attach a provider-specific Yard instead.
