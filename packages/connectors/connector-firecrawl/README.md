# `@hobo/connector-firecrawl`

HoBo connector metadata for [Firecrawl](https://firecrawl.dev/).

The package exports an opaque `firecrawl` symbol for Bindle connectivity declarations:

```ts
import { bindle } from "@hobo/bindles";
import { firecrawl } from "@hobo/connector-firecrawl";

export default bindle((b) => {
  const web = b.connector(firecrawl).allow("search");
  // use `web` from an app entrypoint through its Station runtime context
  return { api: b.api() };
});
```

This is **not a Firecrawl client wrapper**. Application code imports Firecrawl's official SDK separately:

```ts
import { Firecrawl } from "firecrawl";
```

At runtime the Station resolves the connector binding against its Connection inventory. A Bindle asks that Connection for a short-lived token and passes the returned token to the vendor SDK. This keeps personal/team/organization authorization, Auth.md/ID-JAG exchange, rotation, policy, and audit outside application configuration.

The package contains no Firecrawl credential and has no dependency on the Firecrawl SDK.

## Advertised capabilities

- `search`
- `scrape`
- `map`
- `extract`

Auth discovery is rooted at Firecrawl's published `https://www.firecrawl.dev/auth.md`. Connector capability names are HoBo's logical least-privilege contract; the Station/identity broker maps them to the concrete authorization scopes advertised by the service at resolution time.

## Architecture evidence

The declaration follows parse, don't validate: `defineConnector` lowers the
literal onto parsed derived types (`ConnectorDefinition`) or throws — a
symbol never registers with a malformed kind, id, or origin. The wire form
is pinned in [`data-models/connector_firecrawl.proto`](./data-models/connector_firecrawl.proto)
(+ CUE bounds); the auth-discovery boundary is fixtured in
[`contracts/pacts/connector-firecrawl-boundary.pact.json`](./contracts/pacts/connector-firecrawl-boundary.pact.json).
This package emits no events: a connector declaration is static authoring
content. In the platform's command → event pipeline, the Station-owned
resolver is the actor — its connection commands append `connection.*` facts
to the event store, and materialized views / projections (with snapshots
feeding read stores) expose connection state; this package only supplies
the parsed declaration those flows consume.
