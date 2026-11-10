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

Design: [`docs/design/provider-manifest.md`](../../docs/design/provider-manifest.md),
ADR-0177. A complete worked example is
[`examples/acme-cloud.provider.yaml`](./examples/acme-cloud.provider.yaml).

```bash
pnpm --filter @hobo/provider-manifest run build
node packages/provider-manifest/dist/cli.js check my-provider.yaml
node packages/provider-manifest/dist/cli.js lower my-provider.yaml out/
```

`check` prints every issue with its path (`billing.products[0].plans[1]...`) and
exits 1; `lower` writes `index.json`, `capabilities.json`, `auth.json`,
`cost.json`, and `pricing-catalog.json`.

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

- Not wired into `hobo registry add` yet; the registry consumes the lowered
  `CapabilityManifest` exactly as it does a coded provider's.
- A manifest declares; it does not realize. A data-only provider can be
  discovered, authenticated against, ranked, and quoted, but provisioning
  resources still needs a `realize()` implementation or a Resource Pack.
- The example provider and its prices are fictional.
