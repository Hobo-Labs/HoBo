# @hobo/config-service-worker PACT inventory

The boundary is the Worker's HTTP API, as its three callers use it through
`createConfigServiceClient`: the relay's loader (`HOBO_CI_CONFIG_SERVICE=hobo-worker`
in `@hobo/ci-vercel`), HoBo's provisioning (`@hobo/secret-store-claim`) and the
deploy workflow. Cloudflare's provisioning API, which uploads this Worker, is
pinned in `@hobo/secret-store-claim`'s `cloudflare-provisioning.pact.json`.

| Boundary | Consumer | Provider | Protocol | Pact file/test | Provider verification | Mock used | Status |
|----------|----------|----------|----------|----------------|----------------------|-----------|--------|
| Health, the single-use seed, the relay's OIDC read and its refusal of the deploy folder, the deploy workflow's OIDC write, an unauthenticated refusal | HoboCiRelay | HoboConfigServiceWorker | HTTP/JSON | `pacts/config-service-worker.pact.json` / `consumer/config-service-worker.consumer.contract.test.ts` | `provider/config-service-worker.provider.test.ts` (the real handler and Durable Object class on the in-process stand-in, tokens from local issuers) | pact mock (in-process) | provider_verified_against_stand_in |

## Notes

- `test/miniflare.test.ts` runs the compiled modules HoBo uploads in workerd
  (Miniflare), with a SQLite-backed Durable Object, as a second, stronger
  check of the provider side; it is not a pact verification.
- Header values in braces are placeholders: no interaction carries a real
  token, credential or secret.
