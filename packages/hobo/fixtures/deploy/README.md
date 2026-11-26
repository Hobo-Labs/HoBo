# Deploy fixtures (provider defaults)

Known-good platform entry artifacts used by `@hobo/hobo`'s Cloudflare and Vercel
deploy providers (`createCloudflareDeployProvider` / `createVercelDeployProvider`).

These are **not** part of the `examples/hello-bindle` source tree. Hello-bindle is
a barebones bindle (`src/` + tests only). Live deploy lanes and provider defaults
point here so examples stay free of deploy/boilerplate folders.

| Path | Used by |
|------|---------|
| `cloudflare/worker.mjs` | Cloudflare Workers Script Upload default module |
| `vercel/` | Vercel Create Deployment default file tree |

Override via `workerModulePath` / `templateDir` options when a bindle ships its own artifacts.
