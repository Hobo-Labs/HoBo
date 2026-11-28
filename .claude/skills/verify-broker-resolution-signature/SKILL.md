---
name: verify-broker-resolution-signature
description: Verify broker resolution signatures against an independently trusted key, the payload digest, matching key pairs and stable canonical ordering.
---

# Broker resolution signature authority

**Properties:** Verification requires an independently enrolled matching public key, a valid Ed25519 signature and the matching payload digest. Signing requires a matching Ed25519 key pair and accepts only public key material in the advertised field. Canonical object-key ordering is independent of locale. The previous verifier trusted its own embedded key and ignored the recorded digest; a private PEM could also be emitted as a public key.

**Review baseline:** commit `3557d0c3f1d9937d40f96caa9ec9857d080d00c6`. PASS for the generated tests, bounded models and symbolic guard obligations below.

## Covered code

- `packages/broker/src/signing.ts` snapshots signing inputs, checks key types and identities, emits normalized public PEM, canonicalizes JSON, and checks the expected key, digest, signature encoding and Ed25519 signature.
- `packages/broker/test/signature-authority.test.ts` covers untrusted and missing keys, changed public keys and digests, invalid signatures and encodings, private PEM leakage, changing key getters, locale changes and 120 generated request identities (seed 614518).
- `packages/broker/test/integrity.test.ts` and `quote-admission.test.ts` exercise signed receipt and rejection composition with the caller's trusted key.

## Run

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-broker-resolution-signature
```

The shared runner uses checksum-pinned TLC 1.7.4. Set `TLA2TOOLS` to its jar and `BUDGET_Z3_PYTHONPATH` to `z3-solver==4.15.4.0`, or allow the runner to obtain them. Java 11+, Python with pip, Node, Vitest, fast-check and workspace dependencies are required. Use `/statechart` on each model and its view.

## Scope and evidence

`ResolutionSignature` checks 256 states for signing and verification with abstract key enrollment, key agreement, signature validity, digest validity and public-only output. Its projection has nine states and six arrows and hides 128 same-label steps. `ResolutionCanonical` checks eight states for one abstract document on two hosts; its two-state projection hides four same-label steps. Seven weakened model guards or orderings yield counterexamples. The real-code tests reproduce foreign-key acceptance, digest changes, mismatched signing keys, private PEM output and locale-dependent ordering.

Z3 proves the Boolean acceptance guards imply the stated trust and matching properties; the premise has a witness and six removed guards yield counterexamples. This is not a cryptographic proof of Ed25519, SHA-256, key distribution, key-to-broker identity, implementation refinement, replay protection or receipt immutability after verification. The caller must establish the correct trusted key and scope. Signatures remain optional, and process-local delivery uses its own issued-receipt registry rather than this verifier.

The new `verifyResolution` API requires the trusted public key as its third argument. Canonical sorting uses UTF-16 code-unit order; signatures produced with the old locale-dependent order may need reissuance when their order differs. The public field accepts only an SPKI public PEM and emits a normalized public key. Do not place private material in it.

For implementation mutation, copy `packages/broker` to a scratch package with linked `node_modules` and set `BROKER_SIGNATURE_VERIFY_PACKAGE_ROOT`. Restore the old signing module, remove trusted-key or digest checks, accept private PEM, skip cryptographic verification, or restore locale ordering. The real-code checks must fail. Restore the source and rerun the skill.

## Keep in sync

Review covered code and uncommitted changes since the baseline, update the models and actual-code tests, replay counterexamples, run broken scratch variants and then the unmodified skill, and advance the baseline only after review. Use `/maintain-formal-verification-skill`.
