# @hobo/secret-store-claim PACT inventory

The package's own boundary is the hand-off to the HoBo claim plane: the
claim bundle it produces, the one-time action `hobo claim open` redeems, and
the provider verification `hobo claim finalize` runs. The provider-facing
boundaries are pinned where their clients live:

- Infisical's admin API: `packages/adapters/adapter-infisical/contracts/pacts/infisical-admin.pact.json`.
- auth.md discovery, registration and claim: `packages/auth-md/contracts/pacts/`.
- Cloudflare temporary accounts: `packages/providers/provider-cloudflare` (its temporary-account tests and fixtures), and the experiment's REST flow and Worker upload below.
- HoBo's config-service Worker: `packages/config-service-worker/contracts/pacts/config-service-worker.pact.json`.

| Boundary | Consumer | Provider | Protocol | Pact file/test | Provider verification | Mock used | Status |
|----------|----------|----------|----------|----------------|----------------------|-----------|--------|
| Secret-store provisioning hands the claim plane a refs-only bundle; open redeems once; finalize verifies HoBo's bootstrap token is refused | HoboClaimCeremony | HoboSecretStoreClaim | in-process (operation paths) | `pacts/secret-store-claim-plane.pact.json` | `provider/secret-store-claim-plane.provider.test.ts` (real provisioning against `test/support/stub-infisical.ts`) | local Infisical stand-in | provider_verified_against_stand_in |
| The Cloudflare experiment: challenge, account creation after consent, Worker upload with the account's token, workers.dev route, subdomain read | HoboSecretStoreClaim | CloudflareTemporaryAccountsApi | HTTP/JSON (multipart upload) | `pacts/cloudflare-provisioning.pact.json` / `consumer/cloudflare-provisioning.consumer.contract.test.ts` | none: Cloudflare cannot be verified offline; shapes from the claim-deployments page (read 2026-11-12) and the Workers upload metadata | pact mock (in-process) + the real Worker in memory | consumer_only |
