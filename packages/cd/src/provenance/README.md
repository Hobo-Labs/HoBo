# `@hobo/cd/provenance`: provenance verifier

Verifies in-toto/SLSA provenance for Freight (D3), as a Sigstore bundle or as
a HoBo-signed attestation, and returns `ProvenanceRef`s. Work package WP3 of
[plan 0024](../../../../docs/plans/0024-hobo-cd-swarm-instruction.md); the
artifact store and registry-digest verifier live in
[`../artifacts`](../artifacts/README.md).

| Export | What it does |
|---|---|
| `createProvenanceVerifier(d)` | The frozen `ProvenanceVerifier` port. `d.trustPolicy` is parsed once at construction; `d` may also carry `telemetry`. |
| `parseTrustPolicy`, `ProvenanceTrustPolicyError` | The trust-policy parse boundary; a malformed policy throws at construction. |
| `PROVENANCE_REASON` | Refusal codes (wire contract). |
| `SIGSTORE_PUBLIC_GOOD_SEED` | `"public-good-seed"`: use the public-good trusted root shipped with `sigstore@5.0.1`. |
| `signNpmProvenance`, `npmProvenanceStatement`, `githubActionsBuild`, `sigstoreKeylessSigner` | The signing counterpart for HoBo's own npm releases (below). |

## Signing npm provenance

`signNpmProvenance(pkg, build, signer)` builds the in-toto statement npm's
client builds for a GitHub Actions publish (Statement v1, SLSA provenance
v1, the GitHub Actions workflow build type, the run as builder), with the
tarball's sha512 (what npm checks) and sha256 (the Freight artifact digest,
what this verifier checks) as the one subject, has `signer` sign it, and
refuses a bundle that is not a DSSE envelope over exactly that statement.
npm's own check of an externally signed bundle (libnpmpublish 11.2.0
`verifyProvenance`: one subject, its purl name, `digest.sha512`) reads no
other digest key, and `test/provenance/signer.test.ts` runs a port of it on
the signed bundle; that the npmjs registry accepts the extra sha256 too is
shown only by the first live publish.
`githubActionsBuild(env)` reads the run from the job's env and fails closed
on any gap. `sigstoreKeylessSigner()` signs keyless with `sigstore@5.0.1`:
the job's GitHub OIDC token (audience `sigstore`, requested from the Actions
runtime at signing time, never returned or recorded) gets a Fulcio
certificate, and Rekor logs the signature. Signing reaches Fulcio and Rekor
through `sigstore`'s own client, so it runs in the build job, never in a
resolver or a decision. `test/provenance/signer.test.ts` signs under a
per-run trust root and verifies the bundle with `createProvenanceVerifier`.

## Trust policy

```json
{
  "builderIds": ["https://github.com/actions/runner/github-hosted"],
  "signerIdentities": ["https://github.com/acme/api/.github/workflows/release.yml@refs/tags/v1.4.0"],
  "sigstore": {
    "trustedRoot": "public-good-seed",
    "issuers": ["https://token.actions.githubusercontent.com"],
    "ctlogThreshold": 1,
    "tlogThreshold": 1
  },
  "hoboJwt": { "jwks": { "keys": [] }, "issuer": "https://identity.example", "audience": "hobo-cd" }
}
```

- `trustedRoot` is a Sigstore `TrustedRoot` JSON object (for example GitHub's
  own root for private-repository attestations, or one produced by
  `cosign trusted-root create`) or `"public-good-seed"`. Verification never
  fetches a root: `sigstore`'s top-level `verify()` would pull TUF metadata
  through its own HTTP client at decision time, bypassing the injected
  transport, so the verifier drives `sigstore@5.0.1`'s own verification
  closure (`@sigstore/verify`, `@sigstore/bundle`, `@sigstore/protobuf-specs`,
  resolved from the `sigstore` package) with the configured root.
- Thresholds can be raised, never lowered below 1. An empty policy is valid
  and trusts nothing.
- Pins: the caller's pins (a subscription's `trustedBuilderIds` /
  `trustedSignerIdentities`) and the policy's pins both apply when both are
  set; at least one must be set. Matching is exact.

## Checks, in order

1. A bundle is present (`provenance-unsigned`) and is a Sigstore bundle JSON
   or a compact JWT (`provenance-bundle-invalid`), with a matching verifier
   configured (`provenance-verifier-unconfigured`).
2. The signature covers exactly the statement: the DSSE payload is
   byte-identical and the payload type is in-toto (`provenance-payload-mismatch`);
   certificate chain, SCTs, Rekor SET and inclusion proof, and signature verify
   (`provenance-signature-invalid`). For a HoBo JWT, the
   `codeVersion.digest` claim must be the statement's sha256, verified with the
   registry `SignatureVerifier` key material.
3. Signer (certificate SAN or JWT `sub`) is pinned
   (`provenance-signer-untrusted`); the certificate issuer is in
   `sigstore.issuers` (`provenance-issuer-untrusted`); sigstore's identity
   policy is re-run for the matched pin.
4. The statement parses through `@hobo/registry` `parseProvenanceStatement`
   (`provenance-statement-invalid`). SLSA v1 puts the builder at
   `predicate.runDetails.builder.id`; the adapter lifts it into the field the
   registry parser reads and refuses a document that names two builders.
5. The builder is pinned (`provenance-builder-untrusted`).
6. Statement subject digests equal the artifact digests exactly
   (`provenance-subject-mismatch`).

The result is one `ProvenanceRef` (`verified: true`, `verifier: sigstore |
hobo-jwt`, sorted `subjectDigests`). Metric: `hobo.cd.provenance.verify`
(attribute `outcome`).

## Evidence

- `test/provenance/verifier.test.ts`: an actions/attest-shaped bundle (v0.3,
  DSSE, Fulcio-style certificate with the GitHub Actions extensions and an
  embedded SCT, Rekor `dsse` entry with SET and inclusion proof) signed under
  a per-run test trust root verifies; tampering, wrong signer, wrong issuer
  and unpinned builders fail. A real GitHub Actions bundle (npm provenance for
  `sigstore@5.0.1`) verifies cryptographically against the public-good seed
  root and is then refused at the statement step, because npm attests sha512
  subjects only.
- `contracts/artifacts.provenance.pact.json`, verified by
  `contracts/artifacts.consumer.test.ts`, against the committed fixture
  `test/provenance/fixtures/actions-attest.fixture.json` (public material
  only; regenerate with `node --import tsx test/provenance/fixtures/generate.ts`).

## Runbook

| Symptom | Code | Action |
|---|---|---|
| Every Sigstore bundle refused after a Sigstore key rotation | `provenance-signature-invalid` | The configured `trustedRoot` predates the new keys. Refresh it (fetch the current `trusted_root.json` through TUF on an operator machine) and redeploy the policy; `"public-good-seed"` only advances with the `sigstore` dependency. |
| A release suddenly refused as untrusted signer | `provenance-signer-untrusted` | The workflow path or ref changed (for example a tag moved to a branch build). Confirm the change is legitimate, then update the subscription's signer pin. Never widen a pin to a pattern. |
| `provenance-issuer-untrusted` | — | The certificate came from an OIDC issuer not in `sigstore.issuers` (another CI). Add the issuer only if that CI is yours. |
| `provenance-statement-invalid` | — | The statement is not in-toto v1 + SLSA provenance v1 with sha256 subjects. npm-style sha512-only provenance cannot back Freight; attest the artifact files with `actions/attest-build-provenance` (sha256). |
| `provenance-subject-mismatch` | — | The attestation covers different artifacts than the Freight. Re-attest exactly the published artifacts. |
| `provenance-verifier-unconfigured` | — | Add the `sigstore` or `hoboJwt` section to the trust policy. |
| Service fails to start with `provenance-trust-policy-invalid` | — | The policy JSON is malformed; the error names the field. |
