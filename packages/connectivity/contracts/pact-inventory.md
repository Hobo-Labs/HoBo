# @hobo/connectivity PACT inventory

All external and package integration boundaries are exercised through
`@hobo/contract-harness` consumer tests (`createMockProviderFromPact` /
`createPactFetch`) with inventory + provider verification gates.

| Boundary | Consumer | Provider | Protocol | Pact file/test | Provider verification | Mock used | Status |
|----------|----------|----------|----------|----------------|----------------------|-----------|--------|
| Package host surface (naming, policy, DNS, metering) | HoboConnectivity | ConnectivityHost | in-process HTTP-shaped | `pacts/connectivity-host.pact.json` / `consumer/connectivity-host.contract.test.ts` | `provider/connectivity-host.provider.test.ts` | host handler + pact mock | provider_verified |
| Cloudflare DNS API | HoboConnectivity | CloudflareDnsApi | HTTPS REST | `pacts/cloudflare-dns-api.pact.json` / `consumer/cloudflare-dns.contract.test.ts` | `provider/external-apis.provider.test.ts` | `createPactFetch` | provider_verified |
| Cloudflare TrafficRouting API | HoboConnectivity | CloudflareLoadBalancingApi | HTTPS REST | `pacts/traffic-routing-cloudflare.pact.json` / `consumer/traffic-routing-cloudflare.contract.test.ts` | `provider/external-apis.provider.test.ts` | `createPactFetch` | provider_verified |
| Vercel TrafficRouting API | HoboConnectivity | VercelTrafficRoutingApi | HTTPS REST | `pacts/traffic-routing-vercel.pact.json` / `consumer/traffic-routing-vercel.contract.test.ts` | `provider/external-apis.provider.test.ts` | `createPactFetch` | provider_verified |
| Route53 DNS API | HoboConnectivity | Route53DnsApi | HTTPS REST + SigV4 | `pacts/route53-dns-api.pact.json` / `consumer/route53-dns.contract.test.ts` | `provider/external-apis.provider.test.ts` | `createPactFetch` | provider_verified |
| Tailscale control plane | HoboConnectivity | TailscaleControlApi | HTTPS REST | `pacts/tailscale-control-api.pact.json` / `consumer/tailscale-control.contract.test.ts` | `provider/external-apis.provider.test.ts` | `createPactFetch` | provider_verified |
| Netbird management | HoboConnectivity | NetbirdManagementApi | HTTPS REST | `pacts/netbird-management-api.pact.json` / `consumer/netbird-management.contract.test.ts` | `provider/external-apis.provider.test.ts` | `createPactFetch` | provider_verified |
| Stripe billing | HoboConnectivity | StripeBillingApi | HTTPS form REST | `pacts/stripe-billing-api.pact.json` / `consumer/stripe-billing.contract.test.ts` | `provider/external-apis.provider.test.ts` | `createPactFetch` | provider_verified |
| OPA policy evaluate | HoboConnectivity | OpaPolicyApi | HTTPS JSON | `pacts/opa-policy-api.pact.json` / `consumer/opa-policy.contract.test.ts` | `provider/external-apis.provider.test.ts` | `createPactFetch` | provider_verified |

## Notes

- Pure algorithms (SigV4 math, DPoP ES256, JWT-SVID claims, rego-lite parse) are still unit-tested under `test/pure/` for cryptographic correctness; they do **not** replace boundary contracts.
- All HTTP clients accept injectable `fetchImpl` and must be driven by PACT in consumer tests — no ad-hoc fetch stubs outside `createPactFetch`.
- The overlay credential minters' consumer pacts (Tailscale auth keys, NetBird setup keys) live with their tests in `../test/minters/pacts/` (`tailscale-auth-keys.pact.json`, `netbird-setup-keys.pact.json`), driven by `test/minters/minters.pact.test.ts`. They are consumer-only until provider-recorded interactions are committed under `../test/minters/recorded/` (assumption A13; see the root `fleet-fallbacks.json`).
