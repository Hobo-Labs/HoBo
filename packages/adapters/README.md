# HoBo adapters (`packages/adapters/*`)

**L2 framework adapters** — optional packages that bridge popular app frameworks
into HoBo’s framework-free surfaces.

| Package | Purpose |
|---------|---------|
| [`@hobo/adapter-hono`](./adapter-hono/) | Wire [Hono](https://hono.dev) apps as bindle HTTP entrypoints |
| [`@hobo/adapter-infisical`](./adapter-infisical/) | Optional `SecretsPort` (kind `infisical`) over Infisical's HTTP API, signing in with a workload OIDC token (Vercel, GitHub Actions) so the hosted CI relay reads its config and secrets with no secret zero (ADR-0179) |
| [`@hobo/adapter-opensesame`](./adapter-opensesame/) | Optional `SecretsPort` that runs HoBo under OpenSesame's proxied invocation and holds an `osr_` surrogate instead of a credential, in the environment it builds (Vercel; AWS is `provider_not_brokered`; see its README for what is and is not guaranteed) |

## Boundary

```
apps / examples  →  packages/adapters/*  →  @hobo/core
                         (L2)                  (L0)
```

- Adapters may depend on `@hobo/core` + their framework (e.g. `hono`).
- **Core never depends on adapters.**
- **`@hobo/hobo` does not hard-depend on adapters** — apps that want Hono add
  `@hobo/adapter-hono` themselves.
- Examples (like `hello-bindle`) are **consumers**, not the home of adapter code.

## Use from any project

```bash
pnpm add @hobo/adapter-hono hono
```

```ts
import { Hono } from "hono";
import { honoEntrypoint } from "@hobo/adapter-hono";
import { bindle } from "@hobo/bindles";

const api = new Hono().get("/hello", (c) => c.json({ ok: true }));

export default bindle("my-app", (b) => ({
  api: b.api(honoEntrypoint(api)),
}));
```

New frameworks follow the same layout: `packages/adapters/adapter-<name>/`.
