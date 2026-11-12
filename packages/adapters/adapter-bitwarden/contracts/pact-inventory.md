# `@hobo/adapter-bitwarden` PACT inventory

The boundary is the official Bitwarden SDK's client, as the adapter calls it.
The SDK is in-process, so the pact records each call as a pseudo-HTTP request
(`POST /sdk/<call>`, the call's arguments as the body) and its result; the
consumer test answers the adapter's calls from the pact's mock, and the
provider verification answers the pact from the in-memory stand-in every unit
test uses.

| Boundary | Consumer | Provider | Protocol | Pact file/test | Provider verification | Mock used | Status |
|----------|----------|----------|----------|----------------|----------------------|-----------|--------|
| Bitwarden Secrets Manager SDK `client.secrets()` (list, get, create, update, not found) | HoboBitwardenAdapter | BitwardenSecretsManagerSdk | in-process SDK calls (pseudo-HTTP) | `pacts/bitwarden-sdk.pact.json` / `consumer/bitwarden-sdk.consumer.contract.test.ts` | `provider/bitwarden-sdk.provider.test.ts` (the stand-in `test/support/fake-bitwarden.ts`) | pact mock + local stand-in | provider_verified_against_stand_in |

## Notes

- Shapes come from the SDK's published type declarations (`@bitwarden/sdk-napi` 1.0.0,
  read 2026-11-12). No test loads the SDK or contacts Bitwarden.
- No interaction carries a real token or value: the values are fixtures.
