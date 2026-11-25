# HOBO-134 Tier-Five Public mTLS Proof

Proof package: [`src/draft/technical-proofs/tier-five-public-mtls-contract`](../../../../src/draft/technical-proofs/tier-five-public-mtls-contract/README.md)

This branch proves the public-connectivity fallback without expanding into Identity issuance,
governance policy authoring, provider ingress provisioning, or adjacent tier implementation.

Executable evidence:

- `npm.cmd --prefix src\draft\technical-proofs\tier-five-public-mtls-contract test`

Acceptance mapping:

- Public-tier edge accepts only the bound SVID over mTLS:
  `public-tier edge exposes explicit public topology and accepts only the bound client SVID over mTLS`.
- Valid-but-unauthorized SVID rejection:
  `valid but unauthorized client SVID is rejected before public endpoint reachability is granted`.
- Plain TLS downgrade refusal:
  `plain TLS downgrade with no client certificate is refused`.
- Topology output records tier 5 and public exposure:
  the happy-path test asserts `ConnectivityTier.PUBLIC_MTLS`, `public: true`, and `publicExposure: true`.
- Prod policy forbidding public tier blocks deploy:
  `prod public-tier deny blocks deploy before exposing a public endpoint`.

The proof consumes the existing HOBO-117 mTLS data-path contract, HOBO-129 tier-four fallback
boundary, and HOBO-210 can-deploy policy enforcement seam.
