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
definition to a provider-specific Camp/Yard (for example
`camp("prod", { defaultProvider: providerSelection("aws") })`, see
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

## How this maps to HoBo's architecture

The API is protobuf-first: its shapes live in `data-models/shop.proto` with
matching CUE constraints in `data-models/shop.cue`, and `src/api.ts` imports the
**generated** `Product`/`ProductList`/`OrderRequest`/`OrderAccepted` types from
`src/_generated/shop_pb.ts` (run
`buf generate data-models --template ../../buf.gen.yaml -o src/_generated` to
regenerate). Following **parse, don't validate**, `src/api.ts` runs untrusted
order JSON through a single parse boundary (`parseOrderRequest`) that returns
that **derived domain type** (`OrderRequest`) instead of re-checking raw fields
downstream.

In HoBo's event-driven model placing an order is a **command**; the API
**actor** appends `order.Placed` **events** to the **event store**, a
**projection** (materialized view) folds them into an order-book **snapshot**,
and the storefront reads that snapshot from the **read store**. This example
declares the resources for that plane (the `orders` queue, the `products` kv)
but stops before running it: the handlers here are in-memory, honest fixtures —
no live provider, event store, or read store is exercised. The web→API boundary
is pinned by the executable PACT in `contracts/pacts/web-to-api.pact.json`.
