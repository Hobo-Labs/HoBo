# PACT inventory

- `packages/adapters/adapter-better-auth/contracts/pacts/better-auth-issuer-boundary.pact.json` — claims mapping conformance boundary on the adapter implementation.
- `contracts/pacts/auth-adapter-config-boundary.pact.json` — config parse boundary exercised by `test/contract.test.ts`.
- `test/config.test.ts` — executable expectations for `parseBetterAuthConfig` and `parseBetterAuthSecretRef`.