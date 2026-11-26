# `@hobo/adapter-1password` PACT inventory

The boundary is the official 1Password SDK's client, as the adapter calls it.
The SDK is in-process, so the pact records each call as a pseudo-HTTP request
(`POST /sdk/<call>`, the call's arguments as the body) and its result; the
consumer test answers the adapter's calls from the pact's mock, and the
provider verification answers the pact from the in-memory stand-in every unit
test uses.

| Boundary | Consumer | Provider | Protocol | Pact file/test | Provider verification | Mock used | Status |
|----------|----------|----------|----------|----------------|----------------------|-----------|--------|
| 1Password SDK `client.items` (list, get, create, put, not found) | HoboOnePasswordAdapter | OnePasswordSdk | in-process SDK calls (pseudo-HTTP) | `pacts/1password-sdk.pact.json` / `consumer/1password-sdk.consumer.contract.test.ts` | `provider/1password-sdk.provider.test.ts` (the stand-in `test/support/fake-1password.ts`) | pact mock + local stand-in | provider_verified_against_stand_in |

## Notes

- Shapes come from the SDK's published type declarations (`@1password/sdk` 0.4.0,
  read 2026-11-12). No test loads the SDK or contacts 1Password.
- No interaction carries a real token or value: the values are fixtures.
