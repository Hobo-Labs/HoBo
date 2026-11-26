# HoBo Relay contract POC

Independent proof for HOBO-167, HOBO-197 SSRF/lateral-movement hardening, and HOBO-244
SVID-authenticated outbound reverse tunnel acceptance.

This package pins the connected-private Relay boundary from:

- `docs/design/platform-engineering.md`: the Relay is an outbound-only TCP 443 reverse tunnel from a customer private network to the Yard, with Executors behind it and work/results flowing over the tunnel.
- `docs/design/security-networking.md`: the Relay is control-plane traffic, not part of the tenant data-plane connectivity tiers, and one Relay can route multiple private targets by target id.
- `docs/design/adr/02-identity-security.md#adr-0074`: `relay register` and `relay attach` are governed control-plane actions and must be deny-by-default.
- `src/draft/technical-proofs/mtls-data-path-contract`: attach consumes the existing SVID-keyed mTLS data-path evaluator rather than defining a second identity model.

The proof covers:

- Registering and attaching a Relay only after governed `hobo:relay:register` and `hobo:relay:attach` decisions.
- Outbound-only transport: the Relay must dial the Yard over TCP 443 and may not expose inbound listeners into the private network.
- SVID-authenticated attach using the existing mTLS data-path contract.
- Unauthenticated, expired, or cross-tenant Relay SVID attach attempts fail closed.
- Work dispatch from Yard to Executor behind the Relay and result return to the Yard.
- Credential no-egress: Yard work frames carry private-network credential references, never credential material.
- Multiple private targets routed by target id through one Relay.
- Fail-closed rejection for invalid/expired/cross-tenant SVIDs and unknown target ids.
- SSRF/lateral-movement resistance: every private-network connection must name a registered target
  id, target ids cannot be rebound to arbitrary IPs or metadata endpoints, the Relay refuses to act
  as a general forward proxy, Yard-side work requires an explicit registered target resource scope,
  and an authorized target tunnel cannot be reused to open a second target.

Scope boundary: this POC does not implement a real TCP tunnel, executor sandbox, provider credentials, SVID issuance, air-gapped disconnected mode, or data-plane connectivity tiers. It defines and tests the branch-sized Relay contract those later slices consume.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Hobo Relay Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
