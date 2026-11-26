# Firecrawl research

A minimal HoBo app that uses a real external developer service while keeping authorization out of Bindle-local configuration.

The example exposes an inline `GET /research?q=...` handler. It declares Firecrawl with `b.connector(firecrawl)`, asks the hosting Station to resolve an authorized Connection, obtains a short-lived token from that Connection, and then uses Firecrawl's official Node SDK normally.

## The separation

```text
@hobo/connector-firecrawl       firecrawl
        │                          │
        │ connector symbol         │ official vendor SDK
        ▼                          ▼
   b.connector(...) ──► Station Connection ──► Firecrawl({ apiKey: token })
                              │
                              └─ personal / team / organization authorization
```

The connector package is metadata, not a client wrapper. It contains Firecrawl's service identity, Auth.md discovery location, and logical capabilities. The application separately depends on the official `firecrawl` package.

## Bindle

```ts
import { bindle } from "@hobo/bindles";
import { firecrawl as firecrawlConnector } from "@hobo/connector-firecrawl";
import { Firecrawl } from "firecrawl";

export default bindle("firecrawl-research", (b) => {
  const firecrawl = b.connector(firecrawlConnector).allow("search");

  const api = b.api((ctx) => {
    if (!ctx) throw new Error("Station runtime context required");

    return async (request: Request) => {
      const query = new URL(request.url).searchParams.get("q")?.trim();
      if (!query) {
        return Response.json({ error: "missing query parameter: q" }, { status: 400 });
      }

      const connection = ctx.connector(firecrawl);
      const { token } = await connection.token({ action: "search" });
      const client = new Firecrawl({ apiKey: token });
      return Response.json(await client.search(query, { limit: 5 }));
    };
  }).dependsOn(firecrawl);

  return { api };
});
```

There is no `FIRECRAWL_API_KEY`, secret ref, connector credential, or endpoint environment variable in the Bindle. The Station decides which healthy Connection satisfies the Firecrawl declaration. That Connection can later represent an organization-authorized Firecrawl account without changing this application.

## Desired connector contract demonstrated here

- A connector package exports an opaque symbol consumed by `b.connector(symbol)`.
- Connector metadata and application SDKs remain separate dependencies.
- `.allow("search")` is the Bindle's least-privilege logical capability declaration.
- `api → connector:firecrawl` is recorded in the Bindle graph; Firecrawl is not represented as a HoBo resource.
- At serve time the Station supplies `BindleRuntimeContext` and resolves the declaration against Station Connection inventory.
- `ConnectionClient.token()` remains the credential boundary. The Station/identity broker may satisfy it through Auth.md/ID-JAG, an existing user grant, or an organization-authorized Connection.
- The vendor SDK receives the resulting short-lived token through its normal `apiKey` constructor option.

Firecrawl's current official Node SDK is the `firecrawl` npm package and documents `new Firecrawl({ apiKey })` plus `client.search(query, { limit })`.

## Run tests

```bash
pnpm --filter @hobo/connector-firecrawl test
pnpm --filter @hobo/example-firecrawl-research test
pnpm --filter @hobo/example-firecrawl-research typecheck
```

## References

- Firecrawl Node SDK: `https://www.npmjs.com/package/firecrawl`
- Firecrawl repository: `https://github.com/firecrawl/firecrawl`
- Firecrawl Auth.md: `https://www.firecrawl.dev/auth.md`
