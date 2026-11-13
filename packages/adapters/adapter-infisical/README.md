# @hobo/adapter-infisical

Optional `SecretsPort` adapter (kind `infisical`) for
[Infisical](https://infisical.com). It is the first binding of the hosted CI
relay's config service (ADR-0179 (`docs/design/adr/hosted-relay-stateless.md`, from PR #1887)):
the relay reads its configuration and secrets from one Infisical folder, signing
in with the Vercel OIDC token it already has, so it keeps no secret to fetch its
secrets.

Not a default dependency of `@hobo/identity`; `@hobo/ci-vercel` and `@hobo/hobo`
take it explicitly.

## What it does

- **Sign-in** (`InfisicalAuth`):
  - `oidcAuth({ identityId, jwt })`: OIDC Auth with any JWT source. The relay
    passes `getVercelOidcToken()`; CI passes `githubActionsJwtSource()` (reads
    `ACTIONS_ID_TOKEN_REQUEST_URL` / `ACTIONS_ID_TOKEN_REQUEST_TOKEN`; the job
    needs `permissions: id-token: write`); tests pass a function.
  - `ownerAuthFromEnv(env)`: an owner's own machine. `INFISICAL_TOKEN` (an access
    token the Infisical CLI issued), or `INFISICAL_UNIVERSAL_AUTH_CLIENT_ID` +
    `INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET`, read at run time.
- **Client** (`createInfisicalClient`): one login, the access token cached in
  memory until a tenth of its lifetime (at most a minute) before `expiresIn`,
  one fresh login after a 401, bounded retries with exponential backoff on 429
  (honouring `Retry-After`), 5xx and transport failures, a 1 MiB answer cap, no
  redirects, a 10 s timeout per request.
- **Port** (`createInfisicalSecretsPort`): `access` / `accessVersion` read,
  `put` updates or creates (used only by `hobo ci`, the deploy workflow and
  the `hobo-mcp` secret capture; the relay's identity is read-only),
  `listVersions` returns the current version.
- **Sessions**: `signIn()` logs in now and says when the token expires;
  `revoke()` ends a token the client obtained by logging in (never one its
  owner supplied); `forBinding(binding)` binds the same sign-in to another
  project or folder on the same origin. The `hobo-mcp` secret capture uses all
  three for its one-use writer session: a Universal Auth client secret with
  `numUsesLimit: 1` spent by one login, writes to the relay's folder and the
  deploy project on that login, then a revoke.
  `valueRef` is the entry's `infisical://` SecretRef.
- **References**: `infisicalSecretRef(binding, key)` and
  `parseInfisicalSecretRef(ref)` map to the `infisical` scheme of
  [`@hobo/bindings`](../../bindings/src/secret-ref.ts):
  `infisical://<projectId>/<environment>/<folder>/…/<KEY>`.

## Endpoints used

| Call | Endpoint | Reference |
|---|---|---|
| OIDC login | `POST /api/v1/auth/oidc-auth/login` `{identityId, jwt}` → `{accessToken, expiresIn, accessTokenMaxTTL, tokenType}` | <https://infisical.com/docs/api-reference/endpoints/oidc-auth/login> |
| Universal Auth login | `POST /api/v1/auth/universal-auth/login` `{clientId, clientSecret}` | <https://infisical.com/docs/api-reference/endpoints/universal-auth/login> |
| List a folder | `GET /api/v4/secrets?projectId&environment&secretPath&viewSecretValue&recursive=false&expandSecretReferences=false&includeImports=false` | <https://infisical.com/docs/api-reference/endpoints/secrets/list> |
| Read one | `GET /api/v4/secrets/{secretName}?projectId&environment&secretPath&type=shared[&version]` | <https://infisical.com/docs/api-reference/endpoints/secrets/read> |
| Create | `POST /api/v4/secrets/{secretName}` | <https://infisical.com/docs/api-reference/endpoints/secrets/create> |
| Update | `PATCH /api/v4/secrets/{secretName}` | <https://infisical.com/docs/api-reference/endpoints/secrets/update> |
| Revoke an access token this client obtained | `POST /api/v1/auth/token/revoke` `{accessToken}` (no Authorization header) | <https://infisical.com/docs/api-reference/endpoints/universal-auth/revoke-access-token> |

Provisioning a store HoBo created or was handed (`src/admin.ts`, ADR-0179
amendment "Secret store chosen at deploy, provisioned by claim"), from
Infisical's OpenAPI document (<https://app.infisical.com/api/docs/json>, read
2026-11-12) and the
[automated bootstrapping guide](https://infisical.com/docs/self-hosting/guides/automated-bootstrapping):

| Call | Endpoint |
|---|---|
| Bootstrap a fresh self-hosted instance (once) | `POST /api/v1/admin/bootstrap` `{email, password, organization}` → admin user, organization, instance-admin identity with its Token Auth token |
| Create a project | `POST /api/v1/projects` `{projectName, slug, type: "secret-manager", shouldCreateDefaultEnvs: true}` |
| Create a folder | `POST /api/v1/folders` `{workspaceId, environment, name, path}` |
| Create a project identity with its role | `POST /api/v1/projects/{projectId}/identities` `{name, roles: [{role}]}` |
| Trust a workload issuer | `POST /api/v1/auth/oidc-auth/identities/{identityId}` |
| Replace that trust (repair) | `PATCH /api/v1/auth/oidc-auth/identities/{identityId}` |
| Delete an identity / probe a token | `DELETE` / `GET /api/v1/identities/{identityId}` (401 = the token is dead) |

`bootstrapInfisicalInstance` and `createInfisicalAdmin` make mutating calls
once, never retried (a create that timed out may have happened). Infisical
Cloud has no bootstrap and no agent or delegated way to create an
organization or an identity, so on Cloud only the calls after the bootstrap
apply, with the owner's own token. The boundary is pinned by
[`contracts/pacts/infisical-admin.pact.json`](contracts/pacts/infisical-admin.pact.json)
(consumer only: no stand-in serves the admin API).

Reads ask for literal values (`expandSecretReferences=false`) from the bound
folder only, so the relay reads exactly what was written there. A write that a
secret-protection policy turns into an approval request is reported as
`approval-required`, not as success.

## Configuration (not secrets)

| Name | Meaning | Default |
|---|---|---|
| `INFISICAL_SITE_URL` | Infisical origin | `https://app.infisical.com` |
| `INFISICAL_IDENTITY_ID` | The machine identity to sign in as (OIDC) | required for OIDC |
| `INFISICAL_PROJECT_ID` | Project id | required |
| `INFISICAL_ENVIRONMENT` | Environment slug, e.g. `prod` | required |
| `INFISICAL_SECRET_PATH` | Folder, e.g. `/hobo-ci-relay` | `/` |

## Redaction

`InfisicalError` names the operation, a code, the HTTP status and Infisical's
`reqId`, never a response body (Infisical's error bodies may echo input), a
token, a JWT or a value. The adapter logs nothing. Tests assert that an error
raised while the server echoes the token, the JWT and a value contains none of
them.

## Gates

- **TypeScript**: `pnpm --filter @hobo/adapter-infisical typecheck` and
  `typecheck:types` (tests and contracts too).
- **Protobuf**: [`data-models/adapter_infisical.proto`](data-models/adapter_infisical.proto),
  generated into `src/_generated/` by `pnpm run codegen`; Infisical's JSON is
  read into the generated records with `fromJson`.
- **CUE**: [`data-models/adapter_infisical.cue`](data-models/adapter_infisical.cue)
  constrains every record; `pnpm run codegen` vets the binding fixtures in
  `data-models/fixtures/`, and `test/binding.test.ts` checks the TypeScript
  parser accepts and refuses the same fixtures (parse, don't validate: the
  parsed derived types `ParsedInfisicalBinding`, `InfisicalSecretKey`,
  `InfisicalIdentityId` exist only after the parser).
- **PACT**: [`contracts/`](contracts/README.md): the consumer contract drives the
  client against the pact's mock over HTTP; the provider verification runs the
  pact against the local Infisical stand-in every unit test uses.

No test contacts Infisical. The owner's one-time setup is in
[`packages/ci-vercel/CONFIG-SERVICE.md`](../../ci-vercel/CONFIG-SERVICE.md).
