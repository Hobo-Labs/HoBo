# @hobo/secret-store-claim PACT inventory

The package's own boundary is the hand-off to the HoBo claim plane: the
claim bundle it produces, the one-time action `hobo claim open` redeems, and
the provider verification `hobo claim finalize` runs. The provider-facing
boundaries are pinned where their clients live:

- Infisical's admin API: `packages/adapters/adapter-infisical/contracts/pacts/infisical-admin.pact.json`.
- auth.md discovery, registration and claim: `packages/auth-md/contracts/pacts/`.
- Cloudflare temporary accounts: `packages/providers/provider-cloudflare` (its temporary-account tests and fixtures).

The one provider boundary this package owns is GitHub's REST API, read to
learn which OIDC subject the repository's tokens carry before any deploy
trust is written (`src/github-oidc.ts`).

| Boundary | Consumer | Provider | Protocol | Pact file/test | Provider verification | Mock used | Status |
|----------|----------|----------|----------|----------------|----------------------|-----------|--------|
| Secret-store provisioning hands the claim plane a refs-only bundle; open redeems once; finalize verifies HoBo's bootstrap token is refused | HoboClaimCeremony | HoboSecretStoreClaim | in-process (operation paths) | `pacts/secret-store-claim-plane.pact.json` | `provider/secret-store-claim-plane.provider.test.ts` (real provisioning against `test/support/stub-infisical.ts`) | local Infisical stand-in | provider_verified_against_stand_in |
| The OIDC subject a repository's GitHub Actions tokens carry: repository ids, subject template (immutable, legacy, 403 fails closed) | HoboSecretStoreDeployTrust | GitHubRestApi | HTTP/JSON | `pacts/github-oidc-subject.pact.json` / `consumer/github-oidc-subject.consumer.contract.test.ts` | none: GitHub does not verify this hand-authored fixture; shapes from GitHub's REST reference, read 2026-11-13 | pact mock (fetch seam) | consumer_only |
