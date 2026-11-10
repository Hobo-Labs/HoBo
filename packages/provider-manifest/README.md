# @hobo/provider-manifest

A provider's auth flows, capability mappings, and billing models, declared as
**one YAML or JSON document** instead of a provider package. The manifest is
deserialized into types HoBo already runs on:

| Section | Lowers to | Function |
|---|---|---|
| `billing` | `@hobo/pricing` `PricingCatalog` (products, meters, rate cards) | `toPricingCatalog` |
| `capabilities` | `@hobo/core` `capabilities.json` document | `toCapabilitiesDocument` |
| `auth` | `@hobo/core` `auth.json` document, flows preference-ordered | `toAuthDocument`, `resolveAuthFlows` |
| all three | `@hobo/core` `CapabilityManifest` (the four published documents) | `toCapabilityManifest` |
| all three | a registrable provider for `hobo registry add` | `providerFromManifest` |
| `api` | a TypeScript API client, a code-mode MCP server, MCP client config | `generateApiClient`, `generateCodeModeServer`, `generateMcpClientConfig` |

Design: [`docs/design/provider-manifest.md`](../../docs/design/provider-manifest.md),
ADR-0177. A complete worked example is
[`examples/acme-cloud.provider.yaml`](./examples/acme-cloud.provider.yaml).

```bash
pnpm --filter @hobo/provider-manifest run build
node packages/provider-manifest/dist/cli.js check my-provider.yaml
node packages/provider-manifest/dist/cli.js lower my-provider.yaml out/
node packages/provider-manifest/dist/cli.js generate my-provider.yaml out/   # or a bare OpenAPI file
hobo registry add my-provider.yaml
```

`check` prints every issue with its path (`billing.products[0].plans[1]...`) and
exits 1; `lower` writes `index.json`, `capabilities.json`, `auth.json`,
`cost.json`, and `pricing-catalog.json`; `generate` writes API clients and MCP
artifacts (below).

## Registering: `hobo registry add`

`hobo registry add <manifest>` parses the manifest and appends a
`provider.Registered` fact to the registry stream. A manifest declares
capabilities but cannot provision them, so the provider is registered **held**:
listed by `hobo registry`, never matched. Running the same command again
appends `provider.Approved`, which is the explicit decision to make it
matchable. When the manifest declares billing, the pricing catalog is stored in
the same append as the registration. Running it again with edited prices appends
the new catalog (and re-registers, so the ranking price follows) while keeping
approval; an unchanged manifest writes nothing. The command refuses a manifest with issues (whole, listing each
one), one with no capability mappings, and one whose `provider.id` belongs to
a provider compiled into the runtime.

The registry catalog keys a provider's definitions by port. When several
mappings share a port the first is registered and the others are reported as
`shadowedMappings`.

## API specs, clients, and MCP

```yaml
api:
  specs:
    - { id: pets, format: openapi, path: petstore.openapi.yaml, auth: [console-oauth] }
    - { id: events, format: asyncapi, url: https://acme.example.com/asyncapi.yaml }
  mcpServers:
    - { id: remote, url: https://mcp.acme.example.com/mcp }
```

A spec names its standard (`openapi`, `asyncapi`, `graphql`, `grpc`, or an
`x-…` extension) and exactly one location: a `url` where it is published, or a
`path` beside the manifest. All of them are published in `capabilities.json`
under `apis`. **Generation covers OpenAPI 3.0/3.1**; other formats are declared
and reported as skipped.

`generate <file> <outDir>` takes a manifest *or a bare OpenAPI file* and writes:

| Output | When | What it is |
|---|---|---|
| `<id>.client.ts` | every OpenAPI spec with a `path` | Dependency-free `fetch` client, one method per operation. Parameters are named and typed required/optional; bodies and responses are `unknown` (schemas are not interpreted). |
| `<id>.mcp-server.mjs` | the provider declares **no** `mcpServers` — including the bare-spec case | A code-mode MCP server (below). |
| `mcp.json` | any MCP server exists | Client configuration: the provider's own servers by URL, generated ones by command. |

A provider that already runs an MCP server is used as-is. A `url`-only spec is
not fetched — the command makes no network call and says what to do instead.

### The code-mode MCP server

Instead of one tool per endpoint, the generated server exposes two:

- `search` — find operations; returns call signatures such as
  `api.getPet({ petId, X-Trace-Id? })`.
- `execute` — run model-written JavaScript: the body of an async function with
  one binding, `api`. Each `api.<operation>(args)` resolves to
  `{ status, ok, body }`, so a model chains, loops, and filters in one round
  trip.

It is a single ESM file with no dependencies, speaking MCP over stdio, and
needs Node 22.13+. Configure it with `API_TOKEN` (and optionally
`API_BASE_URL`, `API_AUTH_HEADER`, `API_AUTH_PREFIX`, `CODE_TIMEOUT_MS`).

How model code is contained, and where that stops:

- It runs in a separate Node process started with `--permission`: no
  filesystem, no child processes, no workers, and an empty environment.
- It never holds the credential. `api.*` calls are messages to the parent,
  which builds each request from the operation table, pins it to the
  configured server, and adds the auth header.
- Each run is killed at the timeout.
- **It is not a network sandbox.** Node's permission model does not restrict
  outbound connections here, so code can send what the API returned to another
  host. Run the server where that egress is acceptable or blocked.


## Auth flows

Each flow declares exactly one variant:

| Variant | Published type | Notes |
|---|---|---|
| `oauth2` | by `grant`: `authorization-code` → `oauth2-authorization-code`, `device-code` → `device-code`, `token-exchange` → `oauth2-obo`, `jwt-bearer` → `oauth2-xaa`, `client-credentials` → `oauth2-client-credentials` | Endpoints spelled out or discovered via `metadataUrl`. Authorization code is always PKCE S256. |
| `authMd` | `auth-md` | [auth.md](../../AUTH.md) agent registration. Discovery URLs are derived from `resource` by `@hobo/auth-md`. |
| `oidcFederation` | `oidc-federation` | Keyless workload federation. |
| `apiKey` | `api-key` | A static secret; ranked last. |
| `extension` | the declared `x-…` type | Parsed and published, marked `supported: false`, never brokered. |

Flows are published most-preferred first (`AUTH_FLOW_PREFERENCE`): keyless
before delegated before static secrets. `staticSecrets` in `auth.json` is
`true` only when no brokerable keyless flow exists — `@hobo/core`'s
`parsePublishedManifest` refuses such a bundle, as it does for coded providers.

## Billing models

Authors define their own vocabulary of **billables** — `gpu-time` in seconds,
`input-tokens`, `workload`, `seat`, `filament` in kilograms. `category`, `kind`,
and `unit` are open strings; nothing in this package enumerates them.

A product has plans; a plan has charges; a charge is one of:

| Charge | Covers | Kernel model |
|---|---|---|
| `recurring` | Flat fee per `once`/`daily`/`weekly`/`monthly`/`yearly`, optionally `per` a billable (seats, instances) | `FixedCharge` |
| `metered` + `unitPrice` | Price per unit: per second, per request, **per workload** | `UsageCharge.perUnit` |
| `metered` + `package` | Price per N units, pro-rata: **"3.00 per 1,000,000 tokens"**, "1.80 per 3600 seconds" | `UsageCharge.perUnit` (exact quotient) |
| `metered` + `package` with `whole: true` | Indivisible packages; partial usage rounds up | `UsageCharge.package` |
| `metered` + `graduated` / `volume` | Tiered rates | `UsageCharge.graduated` / `.volume` |
| `external` | A model the kernel cannot execute (`x-spot-auction`) | none — see below |

A charge's `when` map becomes rate-card selectors, so one plan can price by
model, region, or any workload attribute.

Fail-closed rules worth knowing:

- **Money is a decimal string end to end.** YAML `amount: 0.10` is read from its
  source text, never through a float.
- **Prices carry a source and a date** (`billing.source.url`, `.checkedAt`).
  Transcribed third-party prices are ranking input, never billing input.
- **A plan with an `external` charge gets no rate card.** It is returned in
  `unrated`; pricing it without that charge would under-quote.
- **A pro-rata package must divide exactly.** `1.00 per 3` has no exact per-unit
  price and is refused rather than rounded.
- **`included` usage is reported, not granted.** An `AllowanceGrant` belongs to a
  tenant and needs dated evidence a public manifest cannot supply.
- **`cost.json` carries a single price only when one is honest**: a plan that is
  exactly one unconditional flat-rate metered charge. Everything else is
  `pricingStatus: "unknown"`, which the legacy matcher ranks last, not free.

## Contracts and gates

- **Protobuf** — `data-models/provider_manifest.proto` is the record source;
  `src/_generated/` is generated (`pnpm --filter @hobo/provider-manifest run codegen`).
  The protobuf JSON form *is* the authoring format, and unknown fields are refused.
- **CUE** — `data-models/provider_manifest.cue` pins vocabularies, formats, and
  one-of rules; `fixtures/{valid,invalid}` exercise it
  (`pnpm --filter @hobo/provider-manifest run test:schema`). `test/parse.test.ts`
  runs the same corpus through the runtime parser so the two cannot disagree.
- **Generated code is executed in tests** — `test/generate.test.ts` runs the
  generated client against a local HTTP server and drives the generated MCP
  server over stdio, including the sandbox refusals.
- **PACT** — `contracts/pacts/provider-manifest-lowering.pact.json` is the
  hand-authored registry-ingest consumer expectation
  (`pnpm --filter @hobo/provider-manifest run test:contract:consumer`).
- **TypeScript** — `test/billing.test.ts` rates every billing model through the
  real `@hobo/pricing` kernel, not a stand-in.

## Architecture boundaries

Parse, don't validate: `parseProviderManifest` is the single boundary. It
returns a branded `ParsedProviderManifest` (a narrowing of the generated
message) or the complete issue list; every lowering accepts only the parsed
type.

This package is a pure function from a document to derived documents. It has
no command handler, actor, event-store write, materialized view projection,
snapshot, or read store, and it makes no network call — an auth flow's
endpoints are declared, not dereferenced. Registering the result is the
caller's job: the registry's existing `provider.Registered` /
`provider.Approved` command → event path appends to the event store
and its `registry-catalog` projection builds the materialized view.

## Honest scope

- `hobo registry add` stores the derived pricing catalog as a
  `pricing.CatalogRegistered` fact beside the registration, and refreshes it
  when the manifest's prices change (see the design doc). Dropping the billing
  section does not clear a stored catalog, and nothing feeds it into
  quote-engine financial state yet.
- Client and MCP generation reads OpenAPI 3.0/3.1 only, resolves only local
  `#/components/parameters` references, and does not type request or response
  bodies.
- A manifest declares; it does not realize. A data-only provider can be
  discovered, authenticated against, ranked, and quoted, but provisioning
  resources still needs a `realize()` implementation or a Resource Pack.
- The example provider and its prices are fictional.
