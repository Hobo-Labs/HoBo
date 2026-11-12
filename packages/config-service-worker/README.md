# @hobo/config-service-worker

HoBo's config-service Worker: a config document and secrets in a Durable
Object on a Cloudflare account the owner claims. **An experiment**
([ADR-0179 amendment, The Cloudflare experiment](../../docs/design/adr/hosted-relay-stateless.md#the-cloudflare-experiment)):
`hobo ci secret-store provision --offer cloudflare-temporary --experiment-worker`
uploads it into a Cloudflare temporary account before the owner claims the
account. It is not the hosted relay's store; the relay keeps Infisical, and
nothing here is wired into the relay's loader, Yard or deploy workflow.

## Routes

| Route | Who | Does |
|---|---|---|
| `GET /v1/health?nonce=` | anyone | the store id and the nonce, nothing else |
| `GET /v1/folders/relay` | the relay (Vercel OIDC), the owner | `ConfigFolderRead` |
| `GET /v1/folders/deploy` | the deploy workflow (GitHub Actions OIDC), the owner | `ConfigFolderRead` |
| `PATCH /v1/folders/relay` | the deploy workflow, the owner | `ConfigFolderWrite` → names only |
| `PATCH /v1/folders/deploy` | the owner | `ConfigFolderWrite` → names only |
| `POST /v1/seed` | the single-use bootstrap credential, once | `ConfigServiceSeed` |
| `GET /v1/audit` | the owner | names only, never values |

## How callers authenticate

- **The relay**: `Authorization: Bearer <Vercel OIDC token>`. The Worker
  fetches the team issuer's keys by OpenID discovery (`jwks_uri` must be on
  the issuer's host) and pins issuer, audience, `sub`, `owner_id`,
  `project_id` and `environment` to the deploy-time binding.
- **The deploy workflow**: `Authorization: Bearer <GitHub Actions OIDC
  token>` requested with the audience `urn:hobo:config-service:<store id>`;
  `repository` and `ref` pinned, `repository_id` too when known.
- **HoBo's provisioning, once**: `Authorization: HoBo-Bootstrap <credential>`.
  The Worker holds only its SHA-256 (in the binding), compares in constant
  time, and burns it in the same storage write as the seed.
- **The owner, after the claim**: a Cloudflare Access application in front of
  a custom-domain route of the Worker; the owner sets `HOBO_CONFIG_OWNER_ACCESS`
  (`{"issuer":"https://<team>.cloudflareaccess.com","audience":"<AUD tag>"}`,
  `formatOwnerAccess`) in their dashboard, and the Worker verifies the
  `Cf-Access-Jwt-Assertion` against the team's keys. Until then there is no
  owner route. There is no unauthenticated write path.

No root secret: values live in the Durable Object's storage, private to the
account and reachable only through this Worker; temporary accounts list no
secret bindings, and a key held by the same Worker would protect against no
one who could not already reach the values.

## What is in here

- `src/worker/`: the Worker's own modules, Web platform only, compiled by
  `tsc` and uploaded as they are (`configServiceWorkerModules` refuses a
  module that imports anything but its siblings). `index.ts` is the main
  module and exports only the handler and `ConfigStore` (workerd's rule);
  `handler.ts` routes and authenticates; `jwt.ts` verifies RS256 with
  WebCrypto; `store.ts` is the Durable Object; `records.ts` parses.
- `src/binding.ts`: the deploy-time binding (`formatWorkerBinding`), the
  bootstrap credential, the owner's Access variable.
- `src/client.ts`: `createConfigServiceClient`, for every caller.
- `src/stand-in.ts`: the real handler and class over in-memory storage
  (`createInMemoryConfigService`), for tests and local runs.

## Records and contracts

- [`data-models/config_service_worker.proto`](data-models/config_service_worker.proto)
  and [`.cue`](data-models/config_service_worker.cue), with valid and invalid
  binding fixtures: a GitHub audience naming another store, Vercel's global
  issuer mode, a credential in place of its hash, or a foreign GitHub issuer
  is unrepresentable.
- [`contracts/pacts/config-service-worker.pact.json`](contracts/pacts/config-service-worker.pact.json):
  its callers ⇄ the Worker, verified against the real handler and class.
- `test/miniflare.test.ts`: the compiled modules in workerd with a
  SQLite-backed Durable Object, as Cloudflare would run them.

## Parse, don't validate

The binding, the owner's variable, seed and write bodies each cross one
parser in `src/worker/records.ts` and become derived types, branded and
frozen (`WorkerBinding`, `OwnerAccess`, `ParsedSeed`, `ParsedWrite`); tokens become
`VerifiedClaims` only after signature, issuer, audience and lifetime checks.
Types are narrowings of the generated protobuf records, imported as types so
the uploaded modules carry no runtime dependency.

## Event architecture

The store is a single-writer **actor**: one Durable Object instance per
account takes **commands** (seed, write) one at a time and records each as an
audit **event** (`audit:<seq>`, names only) in the same storage write as the
change; that append-only log is the store's **event store**, and the folders
(`folder:relay`, `folder:deploy`, each with a version) are its current-state
**projection**, the **snapshot** a read returns. The Durable Object's SQLite
storage is the **read store**; there is no separate materialized view, since
one folder is read whole. The claim that hands the account over is a
`@hobo/claims` bundle attached by an `AttachClaimBundle` command to the
deployment's claim event stream, as for every secret store.

## Honest scope

No request to Cloudflare, Vercel or GitHub has been made from this
repository. What the first live run must check is listed in the ADR
(the temporary token accepting the Durable Object migration on upload, the
workers.dev route's answer and delay, the deletion timing finalize relies
on).

```sh
pnpm --filter @hobo/config-service-worker run build
pnpm --filter @hobo/config-service-worker run test
```
