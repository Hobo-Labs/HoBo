# @hobo/secret-store-claim

The `secrets.config-service/v1` capability: the config/secret store a HoBo
deployment chooses **when it runs**, provisions, and hands to its owner **by
claim** (ADR-0179 amendment
[Secret store chosen at deploy, provisioned by claim](../../docs/design/adr/hosted-relay-stateless.md#amendment-secret-store-chosen-at-deploy-provisioned-by-claim)).
No human pre-setup, nothing in Vercel environment secrets, nothing in GitHub
secrets or variables.

## Offers, in HoBo's preference order

| # | Kind | Agent auth | Owner's claim | Relay binding |
|---|---|---|---|---|
| 1 | `auth-md` | anonymous registration through [`@hobo/auth-md`](../auth-md/README.md) | the store's claim page | designed |
| 2 | `cloudflare-temporary` | a Cloudflare temporary account through [`@hobo/provider-cloudflare`](../providers/provider-cloudflare) | Cloudflare's claim URL, within 60 minutes | designed |
| 3 | `infisical-self-hosted` | the self-hosted admin bootstrap through [`@hobo/adapter-infisical`](../adapters/adapter-infisical/README.md) | a sealed sign-in; finalize revokes HoBo | built |
| 4 | `infisical-cloud-attach` | none (attach-only) | the owner's own `infisical login` | built |

Each offer carries its cost, availability, source and the date its facts were
read (`DEFAULT_SECRET_STORE_OFFERS`). `selectSecretStore` is the routing seam:
hard gates (evidence gathered by the deploy; the relay's runtime binding built
unless `allowDesigned`), then preference. It returns the choice and every skip
with its reason.

## What is in here

- `offers.ts`: the offer kinds, claim mechanisms and defaults; `parseSecretStoreOffer`.
- `select.ts`: `parseSecretStoreEvidence`, `selectSecretStore`.
- `binding.ts`: `SecretStoreBinding`, the coordinates committed as
  `deploy/secret-store.binding.json`; parse, read and format.
- `claim.ts`: the claim bundle (`@hobo/claims`), one-time action sealing
  scoped the way `hobo claim open` redeems.
- `auth-md.ts`: `probeAuthMdStore`, `provisionAuthMdStore`.
- `cloudflare.ts`: `provisionCloudflareTemporaryStore`.
- `infisical.ts`: `relayStoreLayout`, `provisionSelfHostedInfisical`,
  `verifySelfHostedInfisicalClaim`, `attachInfisicalCloud`,
  `updateDeployIdentityTrust` (a connect re-run replaces the deploy
  identity's OIDC trust in place).
- `github-oidc.ts`: `resolveGithubOidcSubject` reads from GitHub the OIDC
  subject a repository's tokens carry (`sub_claim_prefix`, or the immutable
  `repo:<owner>@<ownerId>/<repo>@<repoId>` form from its ids) and fails
  closed when GitHub does not say; `githubDeployTrust` binds it on a branch
  with `repository_id` and `repository_owner_id` pinned. Pinned by
  `contracts/pacts/github-oidc-subject.pact.json`.

The CLI is `hobo ci secret-store plan|provision` in `@hobo/hobo`
([CI.md](../hobo/CI.md#choose-the-relays-secret-store-hobo-ci-secret-store));
agents drive it through the [`hobo-deploy`](../../.claude/skills/hobo-deploy/SKILL.md)
skill.

## Bearer material

A claim URL, a sealed sign-in and HoBo's bootstrap token are bearer
credentials. They go only into a `OneTimeActionStore` (encrypted, bound to
tenant, project, session and audience, with an expiry; single-use for the
owner's action). Nothing this package returns, throws, or puts in a bundle or
binding carries one; the tests assert it. The owner reveals their action with
`hobo claim open secret-store` in their own terminal.

## Records and contracts

- [`data-models/secret_store_claim.proto`](data-models/secret_store_claim.proto)
  and [`.cue`](data-models/secret_store_claim.cue), with valid and invalid
  binding fixtures (`#SecretStoreClaim` is the binding): a URL with userinfo,
  one identity for both roles, one project for both, or an unknown kind is
  unrepresentable.
- [`contracts/pacts/secret-store-claim-plane.pact.json`](contracts/pacts/secret-store-claim-plane.pact.json):
  the hand-off to the claim plane (provision → open once → finalize verified
  through Infisical), verified by the real provisioning against a local
  Infisical stand-in. Infisical's admin API is pinned in
  `@hobo/adapter-infisical`'s `infisical-admin.pact.json`.

## Parse, don't validate

Offers, evidence and bindings cross one parser each (`parseSecretStoreOffer`,
`parseSecretStoreEvidence`, `parseSecretStoreBinding`) and become parsed
derived types (`ParsedSecretStoreOffer`, `ParsedSecretStoreEvidence`,
`ParsedSecretStoreBinding`, narrowings of the generated protobuf records with
the CUE constraints applied); routing, provisioning and the CLI accept only
those. A credential-shaped binding is unrepresentable past the parser.

## Event architecture

This package is a pure core plus provider calls; it appends nothing itself.
The claim bundle it returns is attached by the caller as an
`AttachClaimBundle` **command** to the claim coordinator **actor**, which
appends to the deployment's claim **event store** stream
(`claim:<deployment>`), where the `@hobo/claims` reducer emits
`ClaimItemStarted`, `OwnershipVerified` and the rest; the claim status view is
the **materialized view** (projection) `hobo claim status` reads, rebuilt by
replay; snapshots back its read store like any other claim bundle.

## Honest scope

Exercised against local stand-ins only: no request to Infisical, Cloudflare,
an auth.md store, Vercel or GitHub has been made from this repository. The
config-service Worker, an auth.md store's runtime binding, the Yard placing
Infisical on the compute fleet, the Vercel deploy-token claim step, and the
verification of Cloudflare and auth.md claims are designed, not built.

```sh
pnpm --filter @hobo/secret-store-claim run build
pnpm --filter @hobo/secret-store-claim run test
```
