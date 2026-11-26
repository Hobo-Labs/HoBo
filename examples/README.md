# HoBo reference examples

Atomic copyable patterns live in [`packages/patterns`](../packages/patterns/README.md) (`@hobo/patterns`, ADR-0153). `examples/*` stay full apps — they are not the catalog.

`examples/*` are HoBo's reference example apps: runnable, production-grade
packages that make the product story inspectable without becoming a hidden
implementation lane (scope and proof modes:
[`docs/design/example-apps.md`](../docs/design/example-apps.md)). Examples are
tests — they double as CI fixtures ([`architecture.md`](../docs/design/architecture.md#plan-10))
— and every example is a production package under the architecture guard:
protobuf + CUE in `data-models/`, generated runtime types in
`src/_generated/`, executable PACTs in `contracts/`, parse-don't-validate
derived types, and event-driven CQRS shape.

| Example | What it proves | Local run |
|---|---|---|
| [`hello-bindle/`](./hello-bindle/README.md) | Minimal Bindle: private API + public web via mesh. Consumes shared [`@hobo/adapter-hono`](../packages/adapters/adapter-hono/README.md); `src/api.ts` is bundled to wasm for isolated-wasm. | **`pnpm hobo up --cwd examples/hello-bindle` / `pnpm hobo dev --cwd examples/hello-bindle`** (the root `pnpm hobo` script builds the CLI on first use). Also `pnpm --filter @hobo/example-hello-bindle test`. |
| [`firecrawl-research/`](./firecrawl-research/README.md) | External developer-service wiring with `b.connector(firecrawl)`: connector metadata from `@hobo/connector-firecrawl`, the official Firecrawl SDK as a separate app dependency, and Station-issued Connection tokens that can resolve personal/team/organization-authorized access. | Tests-first; live connector needs a Station-issued token. |
| [`multi-cloud-shop/`](./multi-cloud-shop/README.md) | A shop (storefront, API, kv store, orders queue) as one unchanged Bindle. Provider pins belong on a Yard, never the Bindle. | **`hobo plan` / `hobo up`** on the local Yard (kv + queue ports). Tests: `pnpm --filter @hobo/example-multi-cloud-shop test`. |
| [`durable-agent/`](./durable-agent/README.md) | A durable, tool-invoking agent on `@hobo/runtime`'s authoring surface (`agent()` + `createWorkflowEngine()`). | **Tests only** — no `src/bindle.ts`, so `hobo up` is the wrong verb. `pnpm --filter @hobo/example-durable-agent test`. |
| [`self-host-yard/`](./self-host-yard/README.md) | Operating your own Yard: the whole control plane composed in-process with a SQLite event log. | In-process `yard.cli.run(["plan"\|"up"\|"down"])` from tests / `src/yard.ts`. |
| [`ci-runner-balancing/`](./ci-runner-balancing/README.md) | A credit-aware CI runner dispatcher balancing GitHub-hosted, self-hosted, and third-party Actions runner providers by usage/budget then billable cost — free credits before realtime billing (ADR-0071 `maximize-credits`). Dogfooded by this repo's own CI. | Tests / CI fixture. |
| [`try-site/`](./try-site/README.md) | Browser catalog for the GitHub Pages Home Station console. | Pages runs **browser-wit** apps (hello-world / todo-api) fully in-page — the WIT runtime ships with the deploy. Same apps deploy by CLI: `pnpm hobo up --cwd examples/try-site/apps/hello-world`. OpenSaaS / Swaghaus ship via `pnpm --filter hobo-site run examples:bridge` + `?bridge=http://127.0.0.1:8787`. |

## GitHub Pages try catalog

`examples/try-site/apps/<id>/` is the source of truth for the public Examples
tabs. Each app owns its display metadata, sparse budget policy, provider-specific
Yard/Junction topology, executable runtime descriptor, and real
`@hobo/bindles` source. The site build parses those files and emits a static
catalog; the browser never relies on repository directory listing.

To add an app, copy one existing app folder, choose a unique DNS-safe id, keep
the runtime descriptor and Bindle declaration aligned, and add its acceptance
case to the `try-site` package tests. Policies are sparse and merge in this
order: Home Station defaults, app policy, then deployment policy. `maxReplicas`
limits live Environment Stations; `maxConcurrent` only limits bootstrap work.
Every Yard names one provider. Multi-provider deployments list multiple Yards
and compose them through the example's Junction.

The static site never provisions a remote provider directly. The
`browser-wasm` Yard hosts **in-page** on the deployed site (the WIT runtime
ships with the Pages deploy; `scripts/deploy-site.mts` refuses to publish
without it, and `examples:verify-dist` drives the built artifact end-to-end
before every publish). Webernetes/Lakebed stations provision through the
optional local bridge (`?bridge=`); Cloudflare, Netlify, and Vercel report a
precise executor/bridge requirement until a trusted bootstrap path exists —
per-target failures skip with remediation and never abort the pool. No token,
claim URL, or account-level credential belongs in app metadata, generated
catalogs, terminal output, or browser storage.

## Conventions

- Package name `@hobo/example-<name>`, private, ESM, scripts `test`,
  `typecheck`, `lint` (see [`hello-bindle/package.json`](./hello-bindle/package.json)).
- All `.proto`/`.cue` live under the package-local `data-models/` only; every
  proto message carries a matching CUE `#Type:` constraint; generated output
  is checked in under `src/_generated/` (`buf generate data-models --template
  ../../buf.gen.yaml -o src/_generated`).
- Service boundaries ship executable PACT contracts under `contracts/pacts/`.
- `npm run architecture:guard` must pass for any example change.
