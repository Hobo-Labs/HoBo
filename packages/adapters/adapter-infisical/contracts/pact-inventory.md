# @hobo/adapter-infisical PACT inventory

The boundary is Infisical's HTTP API: OIDC and Universal Auth login, and the v4
secrets endpoints. The pact records the requests the adapter makes, exactly
(query order included), and the answers it must handle: success, a refused
login, 403, 404, 429 with `Retry-After` and 503.

| Boundary | Consumer | Provider | Protocol | Pact file/test | Provider verification | Mock used | Status |
|----------|----------|----------|----------|----------------|----------------------|-----------|--------|
| Infisical login and v4 secrets (read, list, names, update, create, 401/403/404/429/503) | HoboInfisicalAdapter | InfisicalApi | HTTP/JSON | `pacts/infisical-api.pact.json` / `consumer/infisical-api.consumer.contract.test.ts` | `provider/infisical-api.provider.test.ts` (the local stand-in `test/support/fake-infisical.ts`, always) | pact mock over HTTP + local stand-in | provider_verified_against_stand_in |
| Provisioning a store HoBo created: self-hosted bootstrap (and its refusal), project, folder, project identities, OIDC trust, bootstrap-identity deletion, token probe (200/401/403) | HoboInfisicalProvisioner | InfisicalAdminApi | HTTP/JSON | `pacts/infisical-admin.pact.json` / `consumer/infisical-admin.consumer.contract.test.ts` | none: no stand-in serves the admin API; shapes from Infisical's OpenAPI document, read 2026-11-12 | pact mock over HTTP | consumer_only |

## Notes

- The provider side is verified against the local stand-in that every unit
  test uses, not against Infisical: no test contacts Infisical. The pact's
  shapes come from the Infisical API reference cited in its `metadata`.
- Assumed, not observed: a PATCH of a secret that does not exist answers 404
  (the reference documents 404 for the endpoint), which is when the adapter
  creates it with POST.
- No interaction carries a real token, JWT or secret: the values are fixtures.
