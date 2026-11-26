# Hosting credential scope proofs

`createVerifiedHostingCredentialLease` resolves one version of a credential,
copies and freezes its material, and gives provider constructors a resolver that
returns only that captured material. Its public credential locator pins the
version. Rotating an environment variable or a vault entry cannot switch the
account used by an operation after admission.

Each phase calls `verifyCredentialScope` before provider IO. The lease obtains a
fresh random challenge bound to the tenant, provider, billing account, credential
locator and phase operation ID. A configured Ed25519 issuer signs the challenge,
native account identity, material digest, version and expiry. The verifier checks
a pinned issuer key and an explicit native account allowlist, then consumes the
proof with a single SQLite append CAS. An embedded key is never trusted. Reusing
the same proof fails across independent connections and after restart; a resumed
phase can request a new proof for the same immutable credential snapshot.

Issuer enrollment is a trust boundary. Enroll native identities from an
authenticated account read or an independently trusted inventory authority; a
caller-supplied account string does not establish ownership. Enrollment includes
an evidence reference and a validity deadline. The verifier checks the actual
clock after attestation IO, and every lease use checks its binding deadline.
Construct a new lease to rotate material or renew an expired enrollment.

SQLite also pins each tenant, provider, account, locator and credential version to
one material digest and native account. A restarted issuer cannot enroll different
material under an existing version. Rotate the version when rotating the secret;
otherwise an uncertain anonymous create could derive a different native identity
while appearing to reuse the original intent.

The durable replay stream stores issuer, key, proof and operation IDs, hashes and
timestamps. It stores neither tokens nor provider responses. The checked-in JSON
fixture describes the wire contract and deliberately contains a syntactic dummy
signature. Runtime tests create real Ed25519 signatures and real SQLite stores;
the CUE tests independently reject malformed digests, credential-bearing URLs,
invalid times, unsigned records and embedded keys.

`createProductionHostingProviderCatalog` composes the shipped AWS, Azure, GCP,
Cloudflare, DigitalOcean, Hetzner, Hostinger, Kubernetes, Netlify, Vercel, Railway,
Neon, Prisma and Upstash registries. Native provider IDs and their package IDs are
explicit aliases of one binding; Prisma maps to `@hobo/provider-prisma-postgres`.
Unknown products have no resolver. The catalog requires an operating liability
reader, and accepts the independently signed lifecycle reader used by execution.
Constructing a catalog does not prove account authorization, resource readiness
or a final bill.

Azure subscription and resource group, GCP project, Cloudflare account, Netlify
account, Vercel team, Railway project and environment, and Kubernetes API origin
must match the signed native scope. AWS, DigitalOcean, Hetzner, Hostinger and the
anonymous data entries require `providerAccountId` to identify their native
account; a logical ledger alias cannot substitute for that identifier. Claimable
driver scopes must also match the signed tenant and account. Native options,
phase identities and captured credential material cannot change when the caller
later mutates its configuration object.

Spaces and Object Storage use separate verified key leases. Storage Box and
database passwords, and Kubernetes Secret contents, are enrolled per logical
resource in copied lease maps. Every secondary lease must match the primary
tenant, provider, native account and billing account. Unverified resolver
callbacks hidden in native options are overwritten, so JavaScript callers cannot
bypass this rule by supplying properties omitted from the TypeScript type.

The catalog acceptance suite constructs all fourteen actual registries with real
SQLite journals, runs challenged scope verification through every explicit
alias, and drives the shipped Cloudflare resolver over a real loopback HTTP
server. It validates composition and request behavior without claiming those
local responses were returned by the cloud providers.

The catalog also compiles desired metadata for each selected native product.
Lambda, Container Apps, Cloud Run, DigitalOcean compute and Hetzner servers get
the ownership hash and graph artifact marker their APIs implement. These markers
never replace the independently observed image or file digest. Netlify, Vercel
and Railway get the stable operation identifier needed by their mutation journal.
Claimable database parameters stay within their strict native vocabulary.
Conflicting supplied control metadata and image content pins fail before IO.

New named native resources use the incarnation-specific logical name; existing
source names and approved parent project, service, site and environment IDs are
preserved. Immutable deployments within an approved existing Netlify site or
Vercel project retain their approved input name and receive a new journaled
native deployment identity. This prevents a generic metadata spread from either
breaking a strict driver or adopting an old resource under a reused create name.

The metadata suite feeds compiled parameters into the actual shipped mutation
paths for AWS, Azure, GCP, DigitalOcean, Hetzner, Netlify, Vercel, Neon, Prisma and
Upstash, with scoped fixture HTTP or process dispatch and real SQLite custody.
It asserts that native guards reach the expected mutation boundary and that
metadata does not change the approved native account or parent resource.

For Neon, Prisma and Upstash entries, the primary verified string lease holds a
private host key encoded as canonical base64url with at least 32 decoded bytes.
It must survive process restarts in host custody. The catalog captures that exact
verified key version and derives native operation identities with HMAC; public
tenant IDs, resource names and idempotency seeds cannot reveal the native bearer
identifiers. A public `anonymous` placeholder is refused before allocation.
Native identifiers remain in secret custody; durable outcomes contain an opaque
public resource identity and a custody locator instead.
