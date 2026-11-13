# `@hobo/fleet/keys` (L01)

Keys, signatures and sealing for HoBo Fleet. `node:crypto` only; no JOSE dependency.

## Entry points

The frozen entry points of design §7.3 live in `index.ts`. The other modules in this directory belong to this lane and are not part of the contract.

| Entry point | What it does |
|---|---|
| `parsePublicJwk`, `jwkThumbprint` | Parses an EC P-256 or OKP Ed25519 public JWK. Private members, RSA, X25519 and points off the curve are refused. Computes the RFC 7638 thumbprint |
| `memberIdFromJwk`, `sponsoredMemberId` | `dev_` plus the first 32 hex characters of SHA-256(the base64url thumbprint text). `bkd_` or `tgt_` plus the first 32 hex characters of SHA-256(`tenant ‖ 0x00 ‖ BACKEND\|TARGET ‖ 0x00 ‖ fleet ‖ 0x00 ‖ name`) |
| `signEnvelope`, `verifyEnvelope` | `Sign(key, utf8(context) ‖ 0x00 ‖ payload)` with ES256 (IEEE P1363) or EdDSA. The verifier checks the context, the key id and the algorithm against a `PublicKeyRef`, then the signature over the received bytes. A bare JWK has no key id, so only the algorithm is checked |
| `verifyWitnessed`, `acceptTrust` | Both signatures must cover the same payload, made by a listed `AUTHORITY` key and a listed `WITNESS` key. `acceptTrust` checks the next record against the **pinned** record's keys, and needs a higher sequence and the same tenant. The first pin must be signed by keys listed in the record itself |
| `mintDpopProof`, `verifyDpopProof` | RFC 9449 proofs. The verifier checks `typ`, `alg`, `jwk`, `htm`, `htu` (query and fragment removed; a path-only expectation matches the path), `iat` within ±60 s and `ath`. It then claims the `jti` in `ReplayStore` with scope `dpop:<jkt>` until `iat + 60 s` |
| `seal`, `openSealedWith`, `sessionKeys` | Uses the exact §7.4 parameters: X25519, HKDF-SHA-256 and ChaCha20-Poly1305 with additional data `context ‖ 0x00 ‖ ad`. Session keys use HKDF with salt `session_id` and info `hobo-fleet/session/v1/i2a` or `a2i` |
| `fingerprintWords` | Takes the first 44 bits of the thumbprint as four indexes into the vendored BIP-39 English list (`bip39-english.ts`, checked against the list's published SHA-256) |
| `generateDpopKey` | A fresh ES256 key. Its signer's key id is `<dev id>#identity`, because it is the identity key of the device it would enroll |
| `createMemoryKeyStore` | ES256 identity, Ed25519 `SIGN` and X25519 `SEAL` keys, held in a closure. The state is copied on write and read |
| `createMemoryCredentialIssuer` | ES256 JWTs through the same JOSE code. Member tokens carry `aud`, and `verify` checks it. Person tokens carry no `aud` because only the issuing authority accepts them. Both are bound by `cnf.jkt` |

## Ported code

`jose.ts`, `dpop.ts`, `dpop-verifier.ts` and `replay.ts` were ported from the delivery stack's `packages/cd/src/agent/`, not rewritten. They were changed in three ways:

- They sign through the `Signer` port.
- They return fleet error codes (`proof-invalid`, `proof-replayed`, `unavailable`).
- The replay scope is the proof key rather than the reconciler.

`replay.ts` keeps only the claim-once rule, in memory. The durable replay store is the bus's (L08).

## Vectors

The tests check these published vectors:

| Source | What is checked |
|---|---|
| RFC 7638 §3.1 | The RSA example, for canonicalisation only |
| RFC 8037 A.3, A.4 | The Ed25519 thumbprint and the JWS signature |
| RFC 9449 §4.1 | The example proof verifies, and its key's `jkt` is `0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I` |

The outcome tests are `test/keys/envelope.property.test.ts` (O7) and `test/keys/trust.test.ts` (O14).
