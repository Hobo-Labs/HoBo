# `@hobo/cd/ingest`: push ingress for Freight

Freight normally enters HoBo CD by pull: `@hobo/cd/sources` (WP2) polls
registries, Git, package indexes and HoBo CI, with a verified read. This
folder holds the optional push paths and the trusted-publisher verifier
(D3, I15). It is work package WP1 of
[plan 0024](../../../../docs/plans/0024-hobo-cd-swarm-instruction.md).

| Export | What it does |
|---|---|
| `createFreightIngest` | Implements the frozen `FreightIngest` port: `manifest`, `attestation` and `cdevent`. |
| `createTrustedPublisherVerifier` | Implements `TrustedPublisherVerifier`: `trust` a `TrustedPublisherRecord`, and `verify` an OIDC ID token from any CI. |
| `parsePurl`, `artifactFromSubject`, `sourcesForPurl` | Purl handling for attestation subjects and CDEvent artifact ids. |
| `parseArtifactCdEvent` | The inbound CDEvent parse boundary. |
| `writeFreightManifest` | Re-exported from `../freight`, so one subpath covers the push path. |
| `INGEST_REASON`, `INGEST_METRIC` | Refusal codes and metric names (wire contract). |

## Paths

Every path authorizes `freight.record` for the effective principal (the
verified workload, or the calling HoBo principal) before the ledger records
anything. A proposal-only principal is refused (`ingest-proposal-only`).

- **`manifest`**: a `hobo.freight-manifest/v1` document. A `publisherToken`
  makes the principal the verified workload, and the publisher record must
  list the Bindle (`publisher-bindle-scope`). Provenance that a pushed
  manifest *claims* is stored with `verified: false`. Only a verifier can set
  it.
- **`attestation`**: the bytes of an in-toto Statement v1 with an SLSA v1
  predicate, parsed by `@hobo/registry` `parseProvenanceStatement`. SLSA v1's
  `runDetails.builder.id` is presented to that parser as `predicate.builder`;
  the verified bytes are unchanged.
  - The Bindle declaration hash comes from
    `predicate.buildDefinition.externalParameters["hobo.cd/declaration-hash"]`
    (`DECLARATION_HASH_PARAMETER`).
  - Subjects become artifacts. The subject name is the coordinate, and the
    kind and ecosystem come from the purl type.
  - The `ProvenanceVerifier` (Sigstore bundle or HoBo-signed, WP3) must verify
    the statement. The trusted builder ids and signer identities it receives
    are pinned by the Bindle's source subscriptions.
  - Ingest then checks the result independently: every returned ref must be
    `verified`, and together the refs must cover every subject digest.
- **`cdevent`**: `dev.cdevents.artifact.published` or `.packaged`, bare or
  as CloudEvent data, at most 1 MiB.
  - The purl in `subject.id` is mapped to the matching sources:
    - an OCI subscription by `repository_url`, or by name;
    - a package subscription by ecosystem and full name;
    - a Git subscription by `owner/repo`.
  - Ingest calls `FreightSources.schedule` for each matching source. A webhook
    only nudges; the poll is the verified read.
  - Freight is created only from an attestation carried in
    `customData["hobo.cd/attestation"]` (`{ bindle, statement, bundle }`,
    base64), verified exactly like the `attestation` path. If that
    attestation does not verify, the polls still run, and the call returns
    `unverified-trigger` followed by the verifier's reasons.

## Trusted publishers

A `TrustedPublisherRecord` names an `https` issuer, an audience, exact-match
`required_claims` and at least one Bindle. A record with no required claim is
refused: it would trust every repository on the issuer. `trust` is governed
(`publisher.trust`) and appends `publisher.Trusted` to `cd-publisher-<name>`.
A later record for the same name replaces the earlier one.

`verify` checks, in order:

1. The token is a compact RS256 JWT with a `kid`, at most 16 KiB.
2. A trusted publisher exists for `iss`. An unconfigured issuer is refused
   before any network call.
3. `exp` and `nbf` hold within the injected clock skew (default
   `CD_DEFAULTS.dpopSkewMs`, 60 s). `nbf` is required.
4. The audience matches a publisher's.
5. The signature verifies against the issuer JWKS, using `@hobo/identity`
   `verifyJwtWithJwks`. The JWKS is reached by OIDC discovery over the
   injected `HttpTransport`. Discovery must name the same issuer, and
   `jwks_uri` must be https.
6. Every required claim is string-equal.

Discovery documents and the JWKS are cached for `Cache-Control: max-age`
(capped at 24 h). Nothing is cached on `no-store`, on `no-cache`, or when the
header is absent. An unknown `kid` refetches the JWKS once, which handles key
rotation.

The principal is `{ kind: "service", id: "workload:<publisher>:<sub>" }`.
`@hobo/core` has no `workload` principal kind, so the workload is named in the
id.

## Promoted proofs

- `slsa-provenance-certification-contract`:
  - tampering with a signed subject digest fails verification ("a tampered
    subject digest is refused");
  - Freight cannot be recorded from an attestation without complete verified
    provenance ("does not trust a verifier result that is unverified or
    leaves a subject uncovered");
  - an unsigned statement is refused.

## Metrics

All metrics are counters on `TelemetrySink`, with a `tenant` attribute:

- `hobo.cd.ingest.accepted` (`path`)
- `hobo.cd.ingest.refused` (`path`, `code`)
- `hobo.cd.ingest.polls_scheduled` (value = sources)
- `hobo.cd.publisher.verified` (`publisher`)
- `hobo.cd.publisher.refused` (`code`)
- `hobo.cd.publisher.oidc_fetch` (`url`)

## Runbook

| Symptom | Meaning | Action |
|---|---|---|
| `publisher-issuer-unconfigured` | No publisher trusts the token's `iss`. | Trust a publisher for that issuer, or check that the CI is minting tokens for the right issuer (for example, GitHub Enterprise Server issuers differ). |
| `publisher-audience-mismatch` | The token was minted for another audience. | Request the token with the publisher's `audience` (GitHub: `core.getIDToken(aud)`; GitLab: `id_tokens.<name>.aud`). |
| `publisher-claims-mismatch` | A required claim is missing or differs. The message names the claim. | Publish from the configured repository, workflow and environment. If the pipeline moved, trust an updated record. |
| `publisher-token-expired` | The token is outside `nbf`/`exp` plus skew. | Mint the token immediately before the push. Check clock sync on the CD service. |
| `publisher-token-invalid` | The token is malformed, not RS256, has no `nbf`, or the signature failed. | Send the CI token unchanged. A signature failure that persists after a JWKS refetch means the token was not minted by that issuer. |
| `publisher-discovery-failed` | Discovery or the JWKS is unreachable or inconsistent. | Check egress to the issuer. Fail-closed by design: no cached fallback is used past its `max-age`. |
| `publisher-bindle-scope` | The publisher is not trusted for this Bindle. | Add the Bindle to its record (a governed `publisher.trust`). |
| `attestation-declaration-missing` | No `hobo.cd/declaration-hash` external parameter. | Add it to the build's external parameters, or push a manifest instead. |
| `provenance-unverified` | The verifier refused, or its result left a subject uncovered or unverified. | Re-sign the exact statement with a trusted builder and signer. Check the source subscriptions' trusted builder and signer pins. |
| `unverified-trigger` on a CDEvent | The carried attestation did not verify. The polls in the message were still scheduled. | Nothing is lost: the poll reads the source. Fix the attestation if push creation is wanted. |
| `cdevent-unsupported` | Not an artifact event. | Send other CDEvents to the outbound boundary, not to Freight ingest. |
