# mTLS data-path contract POC

Independent proof for HOBO-117.

This package pins the M0 data-path mTLS contract from:

- `docs/design/security-networking.md`: service identities use SVIDs shaped as `spiffe://<tenant>/<bindle>/<resource>`, mTLS is default across every connectivity tier, and Identity owns certificate issuance/rotation.
- `docs/design/adr/02-identity-security.md#adr-0008`: SVIDs are short-lived workload identities consumed by downstream seams.
- `docs/design/adr/02-identity-security.md#adr-0023`: zero-trust means every hop authenticates and authorizes by workload identity, not network position.

The parser accepts both SPIFFE forms present in the current design record:
`spiffe://<tenant>/<bindle>/<resource>` for the per-tenant trust-domain contract
and `spiffe://yard/<tenant>/<bindle>/<resource>` for compatibility with the
existing SVID proof package. In both forms, the derived tenant must match the
connection tenant before allow-list authorization runs.

The proof covers:

- `hobo.mtls-data-path/v1` schema fields for tenant, trust domain, source SVID, peer certificate, bind-derived allow-list, and Identity certificate material reference.
- Stub SVID pair handshake acceptance without implementing a CA, TLS stack, or network tier realization.
- Rejection of a same-tenant peer outside the bind-derived allow-list.
- Rejection of a valid-looking peer from another platform tenant trust boundary.
- Fail-closed expiry and stale-rotation checks for peer SVID material.
- Scope guard that rejects embedded private key or issuing material; this contract consumes `identity://` certificate material only.

Scope boundary: this POC does not issue or rotate SVIDs, implement the policy engine, provision networking tiers, or perform real TLS. It defines and tests the mTLS data-path decision contract those later slices consume.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Mtls Data Path Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
