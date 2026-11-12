---
type: Implementation Plan
title: "HoBo Mesh: one-shot delivery plan"
description: "Complete end-to-end design and swarm handoff for one device-enrollment and compute-membership system: device identity, account-bound enrollment, NATS-enforced per-device credentials, signed work dispatch, sandbox tiers, peer-to-peer transport, audit and operations, with every existing mesh, fleet, overlay and enrollment implementation consolidated onto it."
tags: [hobo, mesh, enrollment, nats, identity, security, p2p, ci, cd, connectivity, implementation, sdlc]
---

# HoBo Mesh: one-shot delivery plan

**Design authority (created by this plan):** `docs/design/mesh-compute-network.md` and ADR-0182 in `docs/design/adr/mesh-compute-network.md`. Until those files exist, this document is the authority.
**Base commit:** `main` at `62dbc5d4c` plus the preconditions in [§11.1](#111-preconditions).
**Supersedes:** `docs/design/ci-relay-mesh.md` (kept, marked superseded), plan 0025 layers 02 to 06, and [Hobo-Labs/HoBo#1688](https://github.com/Hobo-Labs/HoBo/pull/1688).

## 1. How to use this document

This file is the whole handoff. It is written so that a coordinator and a swarm of implementers with no other context can build the complete system in one pass.

- **There are no delivery phases.** Every work package in [§11](#11-delivery) starts at the same time. They can do so because [§7](#7-frozen-contracts) freezes every record, port, subject, route and error code, and because the coordinator lands one mechanical seed commit ([§11.2](#112-the-seed-commit)) that makes those contracts importable.
- **There is no staged rollout.** [§11.6](#116-cutover) is a single cutover. That is safe because the current mesh has never run on more than one real box ([§5.1](#51-repository-facts), fact R3).
- **Contracts are frozen.** An implementer who finds a contract wrong does not change it. They report it in `.sdlc/report.json` under `requirementChanges` and the coordinator decides.
- **One implementation of each idea.** [§8](#8-consolidation-ledger) lists every existing mesh, fleet, overlay, membership and enrollment implementation and what happens to it. Nothing in that ledger may survive as a second implementation.
- **Read order for an implementer:** §4 (terms), §6 (design), §7 (contracts), your work package in §11.4, then §11.3 (rules for everyone).

## 2. Problem

HoBo has machines that run work (CI boxes, developer laptops, relay hosts, delivery agents, junction hosts). How those machines get an identity, join, are trusted, are assigned work and are reached is implemented several times, differently, and none of the implementations is secure enough to let a developer enroll their own device.

| # | What is wrong | Evidence |
|---|---|---|
| P1 | Five enrollment models exist and share nothing | Hand-listed keys (`packages/ci-gh-actions/scripts/mesh-trust.mts`); a repository variable (`HOBO_CI_LOCAL_RUNNER`); device and cluster enrollment with no credential code ([#1688](https://github.com/Hobo-Labs/HoBo/pull/1688)); reporter keys in relay config (plan 0025); bootstrap token to key to SVID (`packages/cd/src/agent/enrollment.ts` on the delivery stack) |
| P2 | Ten node-identity types | `OverlayIdentity`, `NetbirdPeer`, Tailscale device, `EnvMembership.nodeId`, two `JwtSvidClaims`, `LaunchMeasurement.hostId`, `JunctionMemberManifest`, backend id, `MeshNodeReport` |
| P3 | NATS is used with no security model | `packages/ci-gh-actions/src/mesh-nats.ts:135-137`: one shared token or password; no TLS options; every node calls `kvm.create` and so needs stream-admin rights |
| P4 | Job claims are not safe | A KV create is a publish with a header the client chooses; any node with publish rights can overwrite, delete or purge a claim ([§5.2](#52-external-facts), fact E6) |
| P5 | A developer machine runs jobs with no sandbox | `packages/ci-gh-actions/LOCAL-DEVELOPMENT.md`: same-user jobs see the disk, the Docker daemon and credentials; the node key sits inside the checkout; registration needs the developer's own repository-administrator login |
| P6 | The box worker mounts the host Docker socket by default | `packages/ci-gh-actions/src/isolated-worker/cli-docker-driver.ts:392-440`: no user namespace remap, seccomp profile, capability drop, `no-new-privileges`, pids limit or read-only root |
| P7 | The mesh schema is split across packages | Types hand-declared in `packages/ci/src/mesh/`; protobuf in `packages/ci-gh-actions/data-models/mesh.proto` under `hobo.ci.gh_actions.v1`; CUE in `onboarding.cue` |
| P8 | Fleet state reaches routing through three repository variables with hand-written parsers | `HOBO_CI_FLEET_STATE`, `HOBO_CI_FLEET_CAPACITY`, `HOBO_CI_FLEET_ROUTES`; the capacity variable has two incompatible schemas and its route-side reader always returns `undefined` |
| P9 | Three DPoP implementations and two SVID implementations | `packages/connectivity/src/crypto/dpop.ts`, `packages/cd/src/agent/dpop*.ts`; `packages/connectivity/src/crypto/jwt-svid.ts` against `packages/identity/src/issuer.ts` |
| P10 | Overlay joins are unreachable | `createTailscaleOverlay`, `createNetbirdOverlay` and `createJunctionAgent` are called only from inside `packages/connectivity` |
| P11 | No rotation, revocation list, clone detection, attestation, audit trail, minimum agent version, deployment assets or runbooks | `docs/design/ci-relay-mesh.md` "Open questions"; no `nats.conf` or service unit anywhere in the repository |

## 3. Goals, non-goals and rules

### 3.1 Goals

1. **One system.** A single domain package, `@hobo/mesh`, owns device identity, enrollment, membership, capacity, claims, work dispatch, sandbox policy, transport sessions and audit. Every other package consumes it.
2. **A developer can enroll their own device** in one command, with no shared secret on disk, and be running work in under five minutes.
3. **Secure by construction** against the adversaries in [§6.3](#63-threat-model), with no step that depends on trusting the message bus operator.
4. **NATS used properly and in one place:** operator mode, an account per tenant, per-device credentials minted by auth callout, permissions templated to the device id, TLS everywhere. Only `@hobo/mesh-nats` imports a NATS client.
5. **Peer-to-peer where it pays:** direct, authenticated device-to-device streams for shells, port forwards and bulk transfer, with automatic relay fallback.
6. **Enterprise-ready on day one:** single sign-on, role-based approval with dual control, policy and residency checks, tamper-evident audit, metering, high availability, backup and restore, key ceremonies, signed releases, runbooks and measurable service levels.
7. **Dogfooded.** HoBo's own CI runners, delivery agents, junction hosts and developer machines are enrolled devices of this system and of nothing else.

### 3.2 Non-goals, with reasons

| Not in this plan | Why |
|---|---|
| An open marketplace where strangers' work runs on strangers' devices | Not securable on consumer hardware. Confidential-computing attestation fails against whoever holds the machine (E14), and open enrollment has no Sybil defence without a central authority or stake (E15). Pools are closed: a device runs work only for principals its pool policy names |
| Measured-boot or trusted-execution attestation | Same evidence. The attestation ladder in [§6.4](#64-device-identity-and-keys) stops at tiers that can be verified honestly |
| Running fork or public pull-request work on personally owned devices | [§6.10](#610-sandbox-tiers) forbids it. Such work goes to operator-managed, single-use hosts |
| Replacing budget and pricing selection | Choosing a provider by cost stays in `@hobo/ci` (`fleet/balance.ts`) and `@hobo/backend-fleet`. Mesh supplies their health and capacity inputs. See [§14](#14-considered-and-rejected) |
| Cloud key-management or hardware-security-module adapters for the authority's signing keys | The `KmsLike` port is the seam. This plan ships the secret-store-backed implementation; a non-exportable-key adapter is a provider adapter behind the same port |
| Adopting AT Protocol or Nostr as the identity substrate | Neither has per-device keys with scoped, revocable authority (E11, E12). AT Protocol ships as an optional sign-in provider. The owner-attestation idea from Buzz is adopted natively as the key bundle in [§6.4](#64-device-identity-and-keys) |
| The component runtime's host lattice (ADR-0031) | That ADR describes the wasmCloud v1 lattice over NATS, which wasmCloud v2 removed (E9). It needs its own decision; see [§12](#12-owner-inputs) |

### 3.3 Rules that bind every work package

1. **Fail closed.** An unreadable policy, an unverifiable signature, an unknown field in a signed record's critical section, an unmapped region, or an unreachable authority on a decision that grants something, all deny.
2. **Degrade to standalone, never to stopped.** A device that cannot reach NATS or the authority keeps running work it is already entitled to start by itself and refuses everything else. This preserves the property of the current mesh.
3. **Sign the bytes you send.** Every signed record uses the envelope in [§7.4](#74-signed-envelope). No canonical JSON, no re-serialisation before verifying.
4. **No bearer secret outlives one use.** Bootstrap tokens are single-use. Everything else is proof of possession of a device key.
5. **The bus is not trusted.** A NATS administrator can write any subject. Anything that grants trust (registry records, work orders, session grants) carries an authority or dispatcher signature that readers verify.
6. **Repository standards apply in full:** protobuf first with generated types, CUE constraints for every message, parse-don't-validate constructors, PACT contracts at every service boundary, event-sourced state on the `EventStore` port, `// public-contract:` on exported literals, `// SAFETY:` on every type assertion (`AGENTS.md:399-407`, `oxlint.config.ts:47-63`).

## 4. Terms

These words have exactly one meaning after this plan. [§11.4](#114-work-packages) WP-22 adds a guard for the parts of that a machine can check; reviewers hold the rest.

| Term | Meaning |
|---|---|
| **Mesh** | The set of enrolled devices of one tenant, their membership records and the rules by which they take work. Not the network overlay, and not the in-process service router |
| **Device** | One machine with one identity key. Identified by a `DeviceId` |
| **Node** | A running instance of the mesh agent on a device. A device has at most one node at a time; a second is a clone |
| **Authority** | The service that enrolls devices, keeps the registry, issues credentials, answers NATS auth callouts and signs the audit log |
| **Dispatcher** | A node role that holds upstream credentials (for example the GitHub App key), turns upstream work into offers and delivers sealed work orders |
| **Executor** | A node role that claims offers and runs work in a sandbox |
| **Observer** | A node role that only reads (a relay host, a status page) |
| **Pool** | A named set of devices inside a tenant with one policy: who may enroll, what work may run, the minimum sandbox and attestation tiers |
| **Advert** | A device's signed, expiring statement of its capacity and health |
| **Offer** | A dispatcher's signed statement that a unit of work is available to a pool |
| **Claim** | A device's signed, server-enforced, first-writer-wins statement that it will take an offer |
| **Order** | The dispatcher's signed instruction to the claimant, with its secret part sealed to that device |
| **Receipt** | A device's signed statement of what happened to an order |
| **Grant** | An authority-signed, short-lived permission for two devices (or a person and a device) to open a transport session |
| **Transport** | The device-to-device data path: direct peer-to-peer, a network overlay, or relayed over NATS |
| **Overlay** | A network-layer virtual network (Tailscale, NetBird, WireGuard). One kind of transport. Owned by `@hobo/connectivity` |
| **Sandbox** | The isolation boundary work runs in, with a tier from [§6.10](#610-sandbox-tiers) |
| **Fleet** | A set of interchangeable *providers or backends* chosen by budget policy: the CI runner fleet in `@hobo/ci`, the storage backend set in `@hobo/backend-fleet`. Never a set of devices |
| **Camp inventory** | The delivery system's record of deploy targets. Fed by mesh device status; not a second membership system |
| **Internal router** | The in-process fetch interceptor for `*.hobo.internal` in `packages/hobo`. Renamed from "internal mesh" |

## 5. Facts the design rests on

### 5.1 Repository facts

| # | Fact | Where |
|---|---|---|
| R1 | The pure mesh core (ranking, claim turns, trust, monitor, reliability, report) is 1,546 lines and imports only `node:crypto` and one fleet helper | `packages/ci/src/mesh/` |
| R2 | The NATS adapter loads the client lazily and is the only NATS client code in the repository | `packages/ci-gh-actions/src/mesh-nats.ts:121-123`; `@nats-io/*` 3.4.0 only in `packages/ci-gh-actions/package.json` |
| R3 | The mesh has not run on two real boxes | `docs/design/ci-relay-mesh.md` "Increments", rows 3 and 8 |
| R4 | The best existing enrollment engine is event-sourced on `DurableEventStore`, single-use tokens by compare-and-set, two-grant acceptance, DPoP-bound 15-minute JWT-SVIDs, P-256 or Ed25519 keys | `packages/cd/src/agent/` on `claude/loving-allen-jry6qe-cd-6-surfaces` |
| R5 | `EventStore.append` takes `expectedSeq`; idempotency is `meta.idempotencyKey` per stream; event types match `family.PastTenseFact` | `packages/core/src/ports/eventstore.ts:18,43,122`; `packages/core/src/envelope.ts:67` |
| R6 | An event-store adapter is proven by `runEventStoreConformance` | `packages/conformance/src/suites/eventstore.ts:55` |
| R7 | `JwtSvidIssuer` signs RS256 through `KmsLike`; the only `KmsLike` is in memory | `packages/identity/src/issuer.ts:10,12,92` |
| R8 | `SecretsPort` (`put`, `access`, `accessVersion`, `listVersions`) has Infisical and OpenBao adapters | `packages/identity/src/secrets-port.ts:38`; `packages/adapters/` |
| R9 | Authorization decisions go through the core `PolicyEngine` port; residency through `evaluateResidency`, which fails closed | `packages/core/src/ports/policy-engine.ts:51`; `packages/core/src/ports/jurisdiction.ts:388` |
| R10 | Metering is `createMeteringBus` in core with a closed `UsageEventType` union | `packages/core/src/ports/metering.ts:80` |
| R11 | A human signs in with `hobo login` (a development SVID through OIDC); the relay has GitHub OAuth owner sessions and account credentials with scopes | `packages/cli/src/shell/verbs.ts`; `packages/ci-gh-actions/src/github-oauth-session.ts`; `control-auth.ts:15` |
| R12 | A CLI verb must be in `CANONICAL_VERBS` or the registry throws | `packages/cli/src/shell/registry.ts:66` |
| R13 | A new top-level package must be added to `KNOWN_PACKAGE_PATHS`, and to `CONTRACT_PACKAGE_PATHS` if adapters import it. Contract-layer packages may import only core and each other | `packages/conformance/src/boundaries.ts:73-262,700-815` |
| R14 | The route job runs on a GitHub-hosted runner with nothing installed and imports package source by relative path | `scripts/ci/route-runner.mts:28-41` |
| R15 | The relay mints just-in-time runner configs with its GitHub App key and verifies GitHub Actions OIDC tokens | `packages/ci-gh-actions/src/hosted-relay.ts:2041`; `oidc.ts` |
| R16 | The box worker holds the App key and mints its own just-in-time configs | `packages/ci-gh-actions/scripts/isolated-worker-daemon-main.mts:245`; `container-controller.ts:1534` |
| R17 | There is no logger port and no OpenTelemetry dependency; the convention is `log(event, fields)` and hand-written OTLP JSON | `packages/ci-gh-actions/src/relay-trace.ts` |
| R18 | Release images are attested with GitHub build provenance and a software bill of materials | `.github/actions/release-oci-attest` |
| R19 | No micro-VM or user-space-kernel sandbox exists anywhere | Search of `packages/runtimes`, `packages/hobo/src/local-substrates.ts` |
| R20 | The implementer rules forbid editing shared files; the coordinator applies those edits one at a time | `.claude/agents/implementer.md:50-54`; `.claude/skills/sdlc/SKILL.md:222-225` |

### 5.2 External facts

Checked 2026-11-12. Sources are in [§15](#15-sources). "Unverified" items are repeated in [§13](#13-assumptions-to-check-first) with the test that settles each.

| # | Fact |
|---|---|
| E1 | NATS keys (NKeys) are Ed25519. Operators sign accounts; accounts sign users. A scoped signing key fixes a permission template; users it signs carry no permissions of their own |
| E2 | Templates can substitute whole subject tokens with `{{name()}}`, `{{subject()}}`, `{{account-name()}}` and `{{tag(x)}}`. Documented in the server change and a vendor tutorial, not on a reference page (unverified on the pinned version) |
| E3 | Auth callout (server 2.10 and later) hands an external service the connection's options, nonce, TLS state and a per-connection user key, and accepts a signed user JWT in return. The project recommends it for external identity. It is a single point of failure for new connections |
| E4 | A JetStream KV bucket is a stream `KV_<bucket>` on subjects `$KV.<bucket>.>`. "Each client writes only its own key" is enforceable with permissions |
| E5 | A stream with `discard: new`, `discard_new_per_subject: true` and `max_msgs_per_subject: 1` refuses a second message on a subject until the first ages out |
| E6 | Create-only cannot be enforced by permissions on a KV bucket: create, delete, purge and rollup are all publishes distinguished by client-chosen headers |
| E7 | NATS logged 28 security advisories in 2026, several of them pre-authentication crashes on the leaf-node and WebSocket ports. Fixed lines are 2.14.3 and 2.12.12 or later. Current is 2.15.3 |
| E8 | `@nats-io/jwt` can encode operator, account and user JWTs, scoped signers and authorization responses. It is pre-1.0 |
| E9 | wasmCloud v2 (March 2026) reduced NATS to an operator-to-host control plane and moved identity to SPIFFE and OCI attestation |
| E10 | iroh 1.0 (June 2026) declares its wire protocol and APIs stable, dials peers by Ed25519 key over QUIC with relay fallback, reports about 95% of data flowing directly, and officially supports Node.js. No independent audit was found; three relay-side fixes shipped since |
| E11 | AT Protocol account keys are P-256 or secp256k1 and are usually held by the hosting server. It has no per-device keys and no headless or client-credentials grant |
| E12 | Buzz (Block, July 2026) is a single self-hosted Nostr relay. Its owner-attestation draft has no revocation and relies on agent-declared timestamps |
| E13 | tailcat (Tailscale, August 2026) is a Go-only library whose own security note says its threat model has not historically included malicious adversaries |
| E14 | Physical attacks costing under 1,000 US dollars forge attestation on SEV-SNP, SGX and TDX (BadRAM, Battering RAM, TEE.fail) |
| E15 | io.net saw about 1.8 million fake GPUs attempt to join; the fix was to stop trusting self-reported capacity |
| E16 | Teleport's bound-keypair join pins the device's public key at first use, keeps a join-state counter that locks the identity when a copy appears, and rotates keys on request |
| E17 | The OAuth device-code flow is a known phishing vector (RFC 10027 / BCP 247). Mitigations: start from an authenticated client, short one-time codes, show what is being approved, bind the result to a key |
| E18 | Secure Enclave and fielded TPM 2.0 keys are P-256, not Ed25519. From pure Node.js there is no access to either |
| E19 | GitHub's guidance: self-hosted runners should almost never serve public repositories; a just-in-time runner runs at most one job, and reusing its host can leak data between jobs |
| E20 | Buildkite agents verify job signatures so that a compromised control plane cannot inject work |
| E21 | In-flight incidents share causes: persistent runners with weak approval defaults (PyTorch), caches shared across trust boundaries (TanStack, 2026), runner registration used as a backdoor (Shai-Hulud 2.0) |

## 6. Design

### 6.1 Shape

```
                         ┌────────────────────────── tenant NATS account ──────────────────────────┐
  person ── hobo login ─▶│                                                                          │
     │                   │  mesh-registry (KV, authority-signed)     MESH_CLAIMS (first writer wins)│
     ▼                   │  mesh-adverts  (KV, one key per device)   MESH_OFFERS  MESH_ORDERS       │
 ┌───────────┐  HTTPS    │  MESH_EVENTS (receipts, lifecycle)        MESH_CONTROL MESH_AUDIT        │
 │ AUTHORITY │◀──────────┤                                                                          │
 │ enroll    │  callout  └───────▲──────────────────────▲──────────────────────────▲────────────────┘
 │ registry  │◀── $SYS.REQ.USER.AUTH                    │                          │
 │ SVIDs     │                   │ TLS, per-device JWT  │                          │
 │ grants    │           ┌───────┴───────┐      ┌───────┴───────┐          ┌───────┴───────┐
 │ audit     │           │ DISPATCHER    │      │ EXECUTOR      │◀── P2P ─▶│ EXECUTOR /    │
 └───────────┘           │ (GitHub App   │      │ (laptop, box) │  (iroh,  │ person's CLI  │
   EventStore            │  key, offers, │      │ sandbox tiers │  overlay │               │
   (JetStream,           │  sealed       │      │               │  or NATS │               │
    SQLite or            │  orders)      │      │               │  relay)  │               │
    Postgres)            └───────────────┘      └───────────────┘          └───────────────┘
```

Five packages, each with one reason to exist:

| Package | Path | Layer (R13) | Holds | May import |
|---|---|---|---|---|
| `@hobo/mesh` | `packages/mesh` | contract (1) | All domain logic, records, ports, in-memory adapters, the typed HTTP client, test kits. No I/O beyond `node:crypto` | `@hobo/core`, `@bufbuild/protobuf` |
| `@hobo/mesh-nats` | `packages/mesh-nats` | package (3) | Every NATS interaction: topology, credentials, auth callout, board, claims, registry view, event store, relay transport | `@hobo/mesh`, `@hobo/core`, `@nats-io/*` |
| `@hobo/mesh-iroh` | `packages/mesh-iroh` | package (3) | The peer-to-peer transport adapter. The only package with the native binding | `@hobo/mesh`, `@number0/iroh` |
| `@hobo/mesh-node` | `packages/mesh-node` | package (3) | The device agent: key stores, enrollment client, run loop, sandbox drivers, egress proxy, service installers | the three above, `@hobo/core` |
| `@hobo/mesh-authority` | `packages/mesh-authority` | package (3) | The authority service: HTTP API, sign-in providers, composition, deployment images | `@hobo/mesh`, `@hobo/mesh-nats`, `@hobo/identity`, `@hobo/core`, `@hobo/policy` |

`@hobo/mesh` sits in the contract layer so that runtimes, `@hobo/backend-fleet` and adapters may import its types.

### 6.2 Roles

A device's roles are set at enrollment by pool policy and recorded in its registry record. A role decides which scoped NATS signing key signs its session credential ([§6.7](#67-nats-topology)).

| Role | Can | Cannot |
|---|---|---|
| `executor` | Advertise, read offers, claim, receive its own orders, publish its own receipts and events, open granted transport sessions | Publish offers or orders, read another device's orders, write the registry |
| `dispatcher` | Everything an executor can, plus publish offers and orders and delete an invalid claim | Write the registry, mint credentials |
| `observer` | Read registry, adverts, offers, claims | Publish anything but its own advert |
| `reconciler` | Advertise; used by delivery agents. Receives SVIDs for the delivery feed | Claim CI work unless also an executor |
| `junction` | Advertise; join an overlay; register dynamic DNS | Claim work unless also an executor |
| `authority` | Reserved for authority replicas. Never granted by enrollment | — |

A box worker is `dispatcher` and `executor`. A developer laptop is `executor`. The hosted relay on Vercel is not a node (it cannot hold a NATS connection); it is an HTTP client of the authority.

### 6.3 Threat model

| Adversary | Can do | Control | Where |
|---|---|---|---|
| Malicious work author | Run arbitrary code in a job | Sandbox tier by trust class; single-use sandbox; no host mounts; egress allowlist; per-order credentials only | §6.10 |
| Malicious or compromised enrolled device | Lie about capacity, squat claims, read what it is sent, attack peers | Signed adverts bound to registry state; capacity treated as advice and reliability measured, not asserted; server-enforced claims; forged claim suspends the device; orders sealed per device; transport needs an authority grant | §6.8, §6.9, §6.11 |
| Stolen device key (a clone) | Impersonate the device | Generation counter locks the device on first divergence; credentials live minutes | §6.5 |
| Stolen bootstrap token | Enroll an attacker's device | Single use, 10 to 30 minutes, scoped to one pool and name, never on a command line, enrollment shows the key fingerprint to the approver, dual control where policy says so | §6.5 |
| Phished approver | Approve an attacker's device | Browser flow starts from the authenticated CLI on the device; device-code flow shows device name and fingerprint words and is refused for pools that require dual control | §6.5 |
| Network attacker | Read or alter traffic | TLS to NATS and the authority; QUIC or WireGuard between devices; every trust-bearing record signed | §6.7, §6.11 |
| NATS administrator or compromised NATS server | Write any subject, drop or replay messages | Registry records, orders and grants are authority- or dispatcher-signed and expire; adverts are device-signed; replay bounded by expiry; a compromised bus can delay work, never grant it | §3.3 rule 5 |
| Compromised dispatcher | Send work to devices | Orders are verified against pool policy on the device; dispatcher keys are enrolled, role-limited and revocable; upstream platform (GitHub) remains the single assigner of each job | §6.9 |
| Compromised authority | Enroll devices, sign registry records | Scoped NATS signing keys cap what any credential can do; operator key is offline; audit checkpoints are co-signed by an independent witness and exported; dual control on policy change | §6.13, §6.15 |
| Sybil enrollee | Enroll many fake devices | Enrollment is bound to an authenticated principal and a pool quota; nothing is granted to an unenrolled key | §6.5, §6.12 |
| Insider with repository write | Change workflows to target a pool | Pool policy names the repositories, refs and workflow digests it accepts; orders carry them; devices check | §6.9, §6.12 |

### 6.4 Device identity and keys

**One identity key per device.** The device generates it and it never leaves. It is an EC P-256 or an Ed25519 key (both, because hardware keystores only offer P-256, E18). It signs exactly two things: enrollment proofs and the key bundle below.

**`DeviceId`** is `dev_` followed by the first 32 hex characters of the SHA-256 of the identity key's RFC 7638 JWK thumbprint. One key, one device; a revoked key can never enroll again.

**Operational keys** do the daily work so that the identity key is used rarely and can sit in hardware. The device generates them and binds them in a **key bundle** that the identity key signs and the authority countersigns:

| Purpose | Key type | Used for | Generated with |
|---|---|---|---|
| `sign` | Ed25519 | Adverts, claims, receipts, DPoP proofs after enrollment | `node:crypto` |
| `nats` | Ed25519 (NKey, `U…` encoding) | Signing the NATS connect nonce | `@nats-io/nkeys` `createUser()` |
| `seal` | X25519 | Receiving sealed order secrets and relay-transport key agreement | `node:crypto` |
| `transport` | Ed25519 | The peer-to-peer endpoint identity | The transport adapter (the bundle records the resulting endpoint id, whichever side generated it) |

Each purpose has its own key. A NATS login signs whatever nonce the server sends; if that key also signed adverts, a hostile server could obtain a signature over a forged advert. Separate keys and the context string in the envelope ([§7.4](#74-signed-envelope)) rule that out.

A bundle carries `not_after` (24 hours from issue). The node renews it at every credential refresh. Readers reject a record signed by a key whose bundle has expired or whose device is not `ACTIVE`.

**Key stores.** `KeyStore` is a port ([§7.3](#73-ports)) with two shipped implementations:

- `file`: the default. Directory `HOBO_MESH_HOME` (default `~/.hobo/mesh`, never inside a repository checkout), mode `0700`, key files `0600`; refuses to load from a directory group or others can write (the rule today in `mesh-node.ts`).
- `external-signer`: a configured command that speaks a line-delimited JSON protocol (`{"op":"public"}`, `{"op":"sign","payloadB64":…}`) on standard input and output. This is the seam for a Secure Enclave, TPM or hardware-token helper without native code in this repository.

**Attestation tiers.** Recorded in the registry and in every credential. Tiers 0 and 1 are never described as attestation.

| Tier | Proves | How it is verified | Use |
|---|---|---|---|
| `T0_SOFTWARE_KEY` | Continuity: the same key as last time | Signature plus the generation counter | Floor for every pool |
| `T1_HELD_KEY` | Nothing more to the server; the key is claimed to be in a keystore or token | Self-declared by the node when it uses `external-signer` | Optional hardening |
| `T2_ORG_CERTIFIED` | The key was certified by the organisation's device authority | The enrollment request carries an X.509 chain for the identity key; the authority validates it against trust roots configured on the pool | Required for pools that run organisation work, where policy says so |
| `T3_PLATFORM_IDENTITY` | The node runs on a specific cloud instance or CI job | A platform-issued OIDC token (GitHub Actions, GCP, AWS, Azure, Kubernetes) validated against the issuer's published keys and the pool's subject rules | Ephemeral cloud and CI devices |

### 6.5 Enrollment

Enrollment is one event-sourced aggregate, lifted from the delivery stack's engine (R4) and generalised. All three flows end in the same `enroll` command.

**State machine**

```
            enroll                approve-key + accept            suspend
  (none) ──────────▶ PENDING ───────────────────────────▶ ACTIVE ◀────────▶ SUSPENDED
                        │         (or policy auto-accept)   │  ▲   resume
                        │ reject / token expiry             │  │ unlock (governed)
                        ▼                                   ▼  │
                     REJECTED                             LOCKED      any state ──revoke──▶ REVOKED (terminal)
                                                   (clone detected)
```

**Flows**

1. **Token.** A signed-in person runs `hobo mesh token create --pool <id> --name <device name> --ttl 15m`. The authority authorises `mesh.device.invite` through `PolicyEngine`, records only the token's SHA-256, and returns `hmt_…` once. On the device, `hobo mesh enroll --token-file <path>` (or the token on standard input; never an argument) generates keys and posts the enrollment.
2. **Browser.** `hobo mesh enroll --pool <id>` on the device generates keys, starts an authorization-code flow with PKCE against the authority on a loopback redirect, and opens the browser. The person signs in through the configured provider and sees the device name, platform and four fingerprint words derived from the identity key. Approval yields a code the CLI exchanges together with its proof of possession. On a machine with no browser the CLI falls back to a device-code flow that prints a short one-time code and the same fingerprint words; the authority refuses the device-code flow for any pool whose policy requires dual control (E17).
3. **Workload identity.** `hobo mesh enroll --pool <id> --oidc <provider>` presents a platform OIDC token. If the pool's `oidc_trust` rules match issuer, audience and subject pattern, the device is accepted without a person, as class `EPHEMERAL` at tier `T3`.

**What the authority binds at enrollment:** identity key thumbprint, key bundle, tenant, pool, roles, device class (`PERSONAL`, `DEDICATED`, `EPHEMERAL`), attestation tier and evidence digest, the principal who invited and the principals who approved, the token hash, platform, agent version.

**Approval.** Pool policy sets `approval` to `AUTO_OWNER` (the inviting principal's sign-in is the approval; only for a pool whose `owner` is that principal), `SINGLE` or `DUAL`. `DUAL` needs `approve-key` and `accept` from two different principals, exactly as the delivery engine does today.

**Activation and refresh.** An `ACTIVE` device calls `POST /v1/mesh/devices/{id}/credentials` with a DPoP proof made with its `sign` key and its current **generation**. The authority checks state and generation, increments the generation, and returns:

- a JWT-SVID (15 minutes, `cnf.jkt` bound to the `sign` key, audience from the request),
- a **session ticket** (authority-signed, 15 minutes) for NATS,
- the countersigned key bundle,
- the new generation.

The node refreshes five minutes before expiry.

**Clone detection.** The node stores the generation beside its keys. If a request arrives with a generation that is not the one the authority last issued, the device becomes `LOCKED`, its registry record changes within one write, and both the real node and the copy are refused. `unlock` is a governed action (`mesh.device.unlock`) that resets the generation after a person has decided which machine is real (E16).

**Rotation.** `POST /v1/mesh/devices/{id}/keys` replaces the key bundle (signed by the identity key) at any time. Replacing the identity key itself needs a statement signed by the old identity key naming the new one; the `DeviceId` does not change, and the old thumbprint is kept in the record so that it can never enroll as a new device.

**Revocation.** `revoke` appends `device.Revoked`, rewrites the registry record, and publishes a control message. Effects, in order of speed: every reader stops honouring the device's signatures as soon as it sees the registry change (under five seconds); the authority refuses its next refresh; its NATS session credential expires within ten minutes; the authority also asks the server to disconnect it at once where the pinned server supports that ([§13](#13-assumptions-to-check-first), A4).

### 6.6 Credentials

| Credential | Issued by | Lifetime | Proves | Used for |
|---|---|---|---|---|
| Bootstrap token `hmt_…` | Authority, on a person's request | 10 to 30 minutes, one use | An invitation to one pool and name | Enrollment only |
| JWT-SVID | Authority, through `@hobo/identity` `JwtSvidIssuer` | 15 minutes | Device identity, tenant, pool, roles, tier; bound to the `sign` key | Calling HoBo HTTP services (authority, delivery feed, relay) with `Authorization: DPoP` |
| Session ticket | Authority | 15 minutes | That the device was `ACTIVE` at issue, with its roles and `nats` key | Presented once per NATS connection |
| NATS user JWT | Authority's callout responder, signed by a scoped account signing key | 10 minutes | Nothing to the device; it is the server's enforcement record | Enforced by the server on every publish and subscribe |
| Session grant | Authority | Up to 60 minutes | That two named parties may open a transport session for a stated purpose | Transport accept decisions |
| Order credentials | Dispatcher, inside the sealed part of an order | The life of one order | — | The work itself (for example a single-use runner registration) |

The SVID signing key must be the same on every authority replica and survive restarts. `@hobo/identity` gains `createSecretStoreKms`, a `KmsLike` backed by `SecretsPort` (R7, R8).

### 6.7 NATS topology

**Server.** Pinned to 2.15.3 or later ([§12](#12-owner-inputs) may raise it; never below 2.14.3, E7). Operator mode with the full, NATS-based account resolver. JetStream on. TLS required on every listener. Listeners: client (4222, TLS) and WebSocket (443, TLS) only. The leaf-node, MQTT and gateway ports are off unless a multi-region deployment enables gateways; the monitoring port binds to localhost.

**Accounts**

| Account | Holds | Who connects |
|---|---|---|
| `SYS` | System account | Operators only |
| `AUTH` | The auth-callout responders | Authority replicas, as static `auth_users` |
| `T_<tenant>` | One per tenant. All mesh streams and buckets below | That tenant's devices, through callout |

The callout is configured on each tenant account with `allowed_accounts` naming only itself and an `xkey` for encrypted requests.

**Scoped signing keys** in each tenant account, one per role. The callout signs a session credential with the key for the device's highest role; the server applies that key's permission template. `{{name()}}` is the `DeviceId`.

Template for `executor` (the other roles add or remove the marked lines):

```
publish allow:
  $KV.mesh-adverts.{{name()}}
  mesh.claim.>
  mesh.event.{{name()}}.>
  mesh.relay.>
  $JS.API.INFO
  $JS.API.STREAM.INFO.KV_mesh-registry
  $JS.API.STREAM.INFO.KV_mesh-adverts
  $JS.API.STREAM.INFO.MESH_OFFERS
  $JS.API.STREAM.INFO.MESH_CLAIMS
  $JS.API.DIRECT.GET.KV_mesh-registry.>
  $JS.API.DIRECT.GET.KV_mesh-adverts.>
  $JS.API.DIRECT.GET.MESH_CLAIMS.>
  $JS.API.CONSUMER.CREATE.KV_mesh-registry.*.$KV.mesh-registry.>
  $JS.API.CONSUMER.CREATE.KV_mesh-adverts.*.$KV.mesh-adverts.>
  $JS.API.CONSUMER.CREATE.MESH_OFFERS.*.mesh.offer.>
  $JS.API.CONSUMER.CREATE.MESH_CLAIMS.*.mesh.claim.>
  $JS.API.CONSUMER.CREATE.MESH_ORDERS.*.mesh.order.{{name()}}
  $JS.API.CONSUMER.CREATE.MESH_CONTROL.*.mesh.control.{{name()}}
  $JS.API.CONSUMER.INFO.*.*
  $JS.API.CONSUMER.DELETE.*.*
  $JS.FC.>
subscribe allow:
  _INBOX.{{name()}}.>
  mesh.relay.{{name()}}.>
dispatcher adds publish:   mesh.offer.>   mesh.order.>   $JS.API.STREAM.MSG.DELETE.MESH_CLAIMS
observer removes publish:  mesh.claim.>   mesh.relay.>
```

Every client sets `inboxPrefix` to `_INBOX.<DeviceId>`. No template ever contains `$JS.API.>`. The exact list is proven by the permission probe suite in WP-07; if the pinned client needs a subject this list lacks, WP-07 reports it and the coordinator amends this section.

**Streams and buckets** (per tenant account; replicas 3 in the high-availability profile, 1 in the standalone profile; all created by `hobo mesh ops provision`, never by a device)

| Name | Kind | Subjects | Limits | Writer | Purpose |
|---|---|---|---|---|---|
| `mesh-registry` | KV, history 5 | keys `device.<DeviceId>`, `pool.<PoolId>`, `trust`, `config` | none | Authority only | The registry read model. Every value is a signed envelope from the authority |
| `mesh-adverts` | KV, history 1 | key `<DeviceId>` | TTL 60 s | Each device, its own key | Capacity and health |
| `MESH_OFFERS` | Stream | `mesh.offer.<PoolId>` | max age 15 min | Dispatchers | Available work |
| `MESH_CLAIMS` | Stream | `mesh.claim.<PoolId>.<WorkDigest>` | max age 120 s, `max_msgs_per_subject: 1`, `discard: new`, `discard_new_per_subject: true`, `deny_purge` | Executors | First writer wins, enforced by the server (E5) |
| `MESH_ORDERS` | Stream | `mesh.order.<DeviceId>` | max age 15 min | Dispatchers | Sealed work orders |
| `MESH_EVENTS` | Stream | `mesh.event.<DeviceId>.<kind>` | max age 30 days, `deny_delete`, `deny_purge` | Each device, its own subjects | Receipts and lifecycle facts |
| `MESH_CONTROL` | Stream | `mesh.control.<DeviceId>` | max age 1 h | Authority | Drain, refresh-now, revoked notices |
| `MESH_JOURNAL` | Stream | `mesh.journal.<streamId>` | no expiry, `deny_delete`, `deny_purge` | Authority only | The event store ([§6.15](#615-deployment-availability-and-operations)) |
| `MESH_AUDIT` | Stream | `mesh.audit.entry`, `mesh.audit.checkpoint` | no expiry, `deny_delete`, `deny_purge` | Authority only | The audit chain |

`mesh.relay.<toDeviceId>.<sessionId>` is plain publish-subscribe with no stream; see [§6.11](#611-transport).

**The connect sequence**

1. The node connects over TLS with an authenticator that returns `nkey` (its `nats` public key), `sig` (its signature over the server nonce) and `auth_token` (its session ticket).
2. The server sends the request to a callout responder.
3. The responder verifies, itself, in this order: the server's signature on the request; the session ticket's authority signature and expiry; that the ticket's `nats` key equals the presented `nkey`; the nonce signature against that key; the device's current registry state is `ACTIVE`; the tenant account matches.
4. It returns a user JWT for the server-generated per-connection key, with `name` set to the `DeviceId`, a 10-minute expiry, and signed by the scoped key for the device's role.

A responder has no write path: it reads the registry bucket through a local watch and holds one scoped signing seed per role. Compromise of a responder cannot mint a credential wider than a role template.

### 6.8 Membership, capacity and reliability

The ranking, claim-turn, reliability, monitor and report code moves from `packages/ci/src/mesh/` unchanged in behaviour, with four changes:

1. **Identity.** A node's id is its `DeviceId`. The old host-derived id becomes `display_name`.
2. **Trust.** The three levels `trusted`, `unverified`, `invalid` and the `requireTrusted` switch are removed. A reader ranks an advert only if its envelope verifies against a `sign` key in an unexpired bundle of an `ACTIVE` device that the registry lists in the offer's pool. Everything else is not ranked and is counted once as `hobo_mesh_advert_rejected` with a reason.
3. **Work keys.** `MeshJob.jobId: number` becomes `WorkKey` (a string) and its digest. Ranking hashes `(WorkDigest, DeviceId)`.
4. **Agent version.** An advert carries `agent_version`. A pool's `min_agent_version` removes older nodes from ranking and tells them to update.

Capacity stays advice. A device that advertises capacity it does not have loses reliability, exactly as today, and its reliability is also computed by dispatchers from receipts, so a device cannot inflate its own score (E15).

**Pool view and verdict.** `poolView(pool)` is the per-pool list of devices with state, capacity, tier and reliability. `poolVerdict(pool, label)` is the one answer routing needs: `OPEN`, `NO_NODE` or `NO_CAPACITY`, with an expiry. It replaces the three repository variables and plan 0025's verdict. The authority serves both. The route job reads the verdict over HTTPS with its GitHub Actions OIDC token and parses it with `packages/mesh/src/verdict-wire.ts`, a file with no imports (R14). A missing, stale or unreadable verdict changes nothing: routing reads GitHub's queue as it does today.

### 6.9 Work: offers, claims, orders and receipts

Mesh does not know what a job is. A **work kind** is a plugin with two halves: a dispatcher half that produces offers and orders, and an executor half that runs an order in a sandbox. This plan ships two kinds:

| Kind | Dispatcher half | Executor half | Lives in |
|---|---|---|---|
| `github-actions-job` | Polls GitHub's queue (the existing poller), sizes the job by memory class, mints a just-in-time runner config for the claimant | Starts the runner in the sandbox with that config; runs exactly one job | `@hobo/ci-gh-actions` |
| `oci-command` | Accepts a submitted command (image digest, arguments, inputs) from an authorised principal over the authority API | Runs the image in the sandbox, streams logs, returns outputs | `@hobo/mesh` (logic), `@hobo/mesh-node` (driver) |

**The sequence**

1. **Offer.** A dispatcher publishes a signed `WorkOffer` to `mesh.offer.<pool>`: work key, kind, needs (memory, disk, platform, labels, whether it needs a Docker daemon), trust class, the repository, ref and workflow digest where applicable, queued-at time, expiry.
2. **Rank.** Every executor in the pool that the offer fits computes the same order by weighted rendezvous hashing and waits its turn (20 seconds per rank, capped at 4 ranks), as today.
3. **Claim.** At its turn the executor publishes a signed `Claim` to `mesh.claim.<pool>.<WorkDigest>`. The server accepts the first and refuses the rest. An executor that cannot reach NATS does not claim and, unless it is also a dispatcher for that work, does not start it.
4. **Order.** The dispatcher that owns the offer reads the claim, verifies it (signature, device `ACTIVE`, pool membership, fit, sandbox tier adequate for the trust class), builds the order, seals the secret part to the claimant's `seal` key, signs the whole, and publishes to `mesh.order.<DeviceId>`. An invalid claim is deleted at once and reported; the authority suspends the claimant on the first forged or out-of-pool claim.
5. **Verify and run.** The executor verifies the dispatcher's signature against a `dispatcher` device in the registry, checks the order against its own copy of pool policy (kind allowed, repository and ref allowed, trust class allowed for this device class, sandbox tier), opens the sealed part, and starts the work in a fresh sandbox.
6. **Start fence.** For `github-actions-job`, a pre-job hook inside the sandbox asks the node whether the job GitHub actually assigned matches the order's work key. A mismatch stops the job before any step runs. This is the one part of #1688 that is kept.
7. **Receipt.** The executor publishes a signed `WorkReceipt` (`STARTED`, then `SUCCEEDED`, `FAILED`, `CANCELLED` or `ABANDONED` with a reason) to `mesh.event.<DeviceId>.receipt`. Dispatchers fold receipts into reliability.

**No single point of failure.** Several dispatchers may serve one pool; for each unit of upstream work they rank among themselves the same way, so exactly one normally offers it and another takes over one step later. A node that is both dispatcher and executor (a box worker) offers to the pool and may claim its own offer. With no NATS it runs alone, as it does today. GitHub remains the single assigner of each job, so the worst result of a disagreement is still an idle sandbox, never a job run twice.

**Dispatcher duplicates.** Two dispatchers that both mint a runner for one claim cost one idle registration; the start fence and GitHub's single assignment decide.

### 6.10 Sandbox tiers

A sandbox is single-use: created for one order, destroyed after it, sharing no writable state with any other order.

| Tier | Boundary | Mechanism shipped | Docker inside |
|---|---|---|---|
| `S1_CONTAINER` | Hardened container, shared host kernel | Rootless OCI runtime; all capabilities dropped; default seccomp profile; `no-new-privileges`; pids, memory and CPU limits; read-only root with a tmpfs work directory; no host mounts except a read-only source cache; **no host Docker socket**; network only through the node's egress proxy | No, except on a `DEDICATED` device in a pool with `allow_host_docker: true` |
| `S2_USER_KERNEL` | User-space kernel | The same driver with the gVisor runtime | No |
| `S3_MICROVM` | A virtual machine per order | Linux with KVM: a Kata Containers runtime class. macOS 26 on Apple silicon: Apple's `container` tool. The virtual machine has its own Docker daemon | Yes |

**Egress.** Every tier routes outbound traffic through a proxy in the node that allows only the hosts the order names plus the pool's allowlist, and always blocks link-local and cloud metadata addresses.

**Which tier for which work**

| Trust class of the work | Meaning | `PERSONAL` device | `DEDICATED` device | `EPHEMERAL` device |
|---|---|---|---|---|
| `OWN` | The work's author is the device's owner | `S1` or higher | `S1` or higher | `S1` or higher |
| `ORG` | Authored inside the tenant by someone else | `S3` only | `S3`; `S1` or `S2` only if the pool sets `org_min_sandbox` lower and names the repositories | `S1` or higher |
| `UNTRUSTED` | A fork, a public pull request, or anything unattributed | Never | Never | `S3`, with no secrets in the order |

The dispatcher computes the trust class from upstream facts (event type, head repository, author association, the pool's repository list). The executor recomputes what it can and refuses on disagreement. A device advertises the tiers it can actually provide, found by a self-test at start; a Windows device provides `S1` only and is therefore limited to `OWN` work.

Sandbox tier and device class are operator-side traits in the sense of ADR-0145.

### 6.11 Transport

Coordination never needs a direct connection (it is all NATS). Transport exists for three things: an interactive shell or attach into a running order, a port forward to something a device serves, and bulk transfer of caches and artifacts between devices.

`MeshTransport` is a port with three adapters, tried in this order:

1. **`iroh`** (`@hobo/mesh-iroh`): direct QUIC between devices, dialled by the endpoint id in each device's key bundle, with hole punching and encrypted relay fallback through relays HoBo runs ([§6.15](#615-deployment-availability-and-operations)). The public relays are never used.
2. **`overlay`** (`@hobo/connectivity`): where a tenant already runs Tailscale, NetBird or WireGuard, a TCP stream over the overlay address. The join credential is minted by the authority at enrollment through the overlay provider's API and handed to the node inside the enrollment response; `HOBO_TAILSCALE_AUTHKEY` and every other static overlay key are removed.
3. **`nats-relay`** (`@hobo/mesh-nats`): frames over `mesh.relay.<toDeviceId>.<sessionId>`, always available, slowest. End-to-end encrypted with a key agreed from the two `seal` keys (X25519, HKDF-SHA-256, ChaCha20-Poly1305), so the bus sees ciphertext and a forged publish fails authentication.

**Authorisation is the same for all three.** Opening a session needs a `SessionGrant` from the authority naming both parties, the purpose (`SHELL`, `FORWARD`, `BLOB`), an optional target (order id, port) and an expiry. The accepting node verifies the grant's authority signature, that the peer's transport identity is the one in the grant, that both devices are `ACTIVE`, and that pool policy allows the purpose. A person's CLI obtains a grant with their SVID; the shell runs inside the order's sandbox, never on the host.

**Blob transfer** is content-addressed (SHA-256), verified by the receiver, and limited to digests named in an order or a grant.

### 6.12 Policy, tenancy and residency

- **Tenant** is the core `TenantId`. One tenant, one NATS account, one registry. Nothing crosses tenants.
- **Every governed action** (`mesh.device.invite`, `.approve-key`, `.accept`, `.suspend`, `.resume`, `.unlock`, `.revoke`, `mesh.pool.define`, `mesh.session.grant`, `mesh.work.submit`, `mesh.policy.change`) is a `PolicyRequest` to the core `PolicyEngine`, and its outcome is recorded as a `policy.Decided` event built by `@hobo/policy` `createPolicyDecidedEvent` (injected as `PolicyDecisionRecorder`, because the contract-layer `@hobo/mesh` may not import `@hobo/policy`). `policy.Decided` is never retried (ADR-0136).
- **Pool policy** is a record ([§7.1](#71-records)): owner, approval mode, allowed roles and device classes, minimum attestation tier, sandbox minimums, allowed work kinds, repository, ref and workflow-digest rules, OIDC trust rules, device-certificate trust roots, egress allowlist, device quota per principal, minimum agent version, residency constraint, `allow_host_docker`.
- **Residency.** A device declares its region at enrollment. Where a pool or an order carries a `ResidencyConstraint`, the dispatcher calls `evaluateResidency` with the device's region and excludes the device unless the result is `ok` (ADR-0146). An undeclared or unmapped region excludes.
- **Environment membership** (`@hobo/connectivity` `EnvMembership`) refers to a `DeviceId`. A membership whose device is not `ACTIVE` is ineffective.

### 6.13 Audit, metering and observability

**Audit.** Every enrollment, approval, credential issue, policy decision, grant, order and receipt becomes an entry in a hash chain (`entry_hash = SHA-256(previous_hash ‖ entry_bytes)`) on `MESH_AUDIT`. Every 60 seconds, or 1,000 entries, the authority signs a checkpoint. A checkpoint is final only when co-signed by a **witness**: an independent key held by a different principal and process (deployed with the dispatcher by default). Checkpoints are exported as CloudEvents to the tenant's configured sink. `hobo mesh audit verify` recomputes the chain and checks both signatures. A database writer alone cannot rewrite history without the witness refusing.

**Metering.** Core `UsageEventType` gains `mesh.device.active` (device-hours), `mesh.work.sandbox` (sandbox-seconds by tier), `mesh.transport.relay` (bytes relayed) and `mesh.transport.direct` (bytes direct). Dispatchers emit work usage from receipts; nodes never bill themselves.

**Logs and events.** The repository convention holds (R17): `log(event, fields)` with names `hobo_mesh_*`. Each maps to a CloudEvent type in the families of [§7.5](#75-event-families). Spans use the existing OTLP JSON writer.

**Service levels** (measured by WP-24's acceptance harness and published by `@hobo/status-page`)

| Objective | Target |
|---|---|
| Enrollment API availability | 99.9% monthly |
| New NATS connection authorised (callout) | 99.95% monthly; p99 under 300 ms |
| Revocation takes effect for ranking and orders | under 5 s |
| Revocation takes effect at the bus | under 10 min, without relying on a disconnect |
| First claim after an offer, healthy pool | p95 under 2 s |
| Authority recovery point / recovery time (high-availability profile) | 0 events / under 60 s |

### 6.14 Surfaces

**HTTP** (authority; all bodies protobuf JSON; errors in [§7.6](#76-errors))

| Method and path | Auth | Does |
|---|---|---|
| `GET /.well-known/hobo-mesh` | none | Discovery: issuer, JWKS URL, NATS URLs, relay URLs, trust record, minimum agent version |
| `GET /v1/mesh/jwks` | none | SVID verification keys |
| `POST /v1/mesh/tokens` | Person SVID | Create a bootstrap token |
| `GET, DELETE /v1/mesh/tokens[/{hash}]` | Person SVID | List, revoke |
| `GET /v1/mesh/enroll/authorize`, `POST /v1/mesh/enroll/code`, `POST /v1/mesh/enroll/device-code` | Sign-in provider | The browser and device-code flows |
| `POST /v1/mesh/enrollments` | DPoP proof with the identity key, plus a token, code or OIDC assertion | Enroll |
| `POST /v1/mesh/enrollments/{id}/{approve-key,accept,reject}` | Person SVID | Approval |
| `POST /v1/mesh/devices/{id}/credentials` | DPoP proof with the `sign` key | Activate or refresh |
| `POST /v1/mesh/devices/{id}/keys` | DPoP proof; body signed by the identity key | Rotate |
| `POST /v1/mesh/devices/{id}/{suspend,resume,unlock,revoke}` | Person SVID | Lifecycle |
| `GET /v1/mesh/devices[/{id}]`, `GET /v1/mesh/pools[/{id}]` | Person SVID, device SVID or account credential with `policy:read` | Read |
| `PUT /v1/mesh/pools/{id}` | Person SVID | Define a pool or change its policy |
| `GET /v1/mesh/pools/{id}/view` | as read | Pool view |
| `GET /v1/mesh/pools/{id}/verdict?label=` | as read, or a GitHub Actions OIDC token for a repository the pool lists | Pool verdict |
| `POST /v1/mesh/sessions` | Person or device SVID | Session grant |
| `POST /v1/mesh/work` | Person SVID or account credential | Submit `oci-command` work |
| `GET /v1/mesh/audit/checkpoints`, `GET /v1/mesh/audit/entries` | Person SVID with audit scope | Audit export |
| `GET /healthz`, `GET /readyz` | none | Liveness, readiness |

**CLI** (`hobo mesh …`; `mesh` is added to `CANONICAL_VERBS`, R12)

| Command | Does |
|---|---|
| `enroll [--pool] [--token-file] [--oidc]` | Generate keys and enroll this device |
| `run [--pools] [--roles]` | Run the node in the foreground |
| `service install\|uninstall\|status` | Install the node as a systemd unit, launchd agent or Windows service |
| `status [--pool]` | Devices, state, slots, memory, disk, reliability, tier (replaces the table in `hobo ci status`) |
| `doctor` | Self-test: keys, authority, NATS, sandbox tiers available, transport reachability |
| `token create\|list\|revoke` | Bootstrap tokens |
| `device list\|show\|approve\|accept\|reject\|suspend\|resume\|unlock\|revoke\|rotate` | Device lifecycle |
| `pool list\|show\|apply\|verdict` | Pools and policy (`apply` reads a policy file) |
| `connect <device> [--order] [--forward L:R]` | Shell or port forward over a granted session |
| `cp <src> <dst>` | Blob transfer over a granted session |
| `submit --pool --image --digest -- <args>` | Submit `oci-command` work |
| `audit verify\|export` | Check or export the audit chain |
| `leave` | Revoke this device and delete its keys |
| `ops provision\|rotate-signing-key\|backup\|restore\|ceremony` | Operator tasks ([§6.15](#615-deployment-availability-and-operations)) |

**MCP.** The relay's `list_mesh_nodes` tool and `hobo-ci://mesh/nodes` resource stay, re-implemented as calls to the authority through the typed client. New read tools `get_mesh_pool_view` and `get_mesh_pool_verdict`. No write tools.

**Environment** (the only variables; everything else comes from discovery)

| Variable | Default | Meaning |
|---|---|---|
| `HOBO_MESH_AUTHORITY_URL` | none | The authority's origin |
| `HOBO_MESH_HOME` | `~/.hobo/mesh` | Keys, generation, state |
| `HOBO_MESH_POOLS` | all the device is in | Pools to serve |
| `HOBO_MESH_SANDBOX` | highest available | Cap the sandbox tier offered |
| `HOBO_MESH_TRANSPORTS` | `iroh,overlay,nats-relay` | Transport order |
| `HOBO_MESH_KEYSTORE` | `file` | `file` or `external-signer:<command>` |
| `HOBO_MESH_NATS_SERVER_BIN` | `nats-server` on `PATH` | Test-only: the server binary for integration tests |

Removed: every `HOBO_CI_MESH_*`, `HOBO_CI_NATS_*`, `HOBO_CI_FLEET_STATE`, `HOBO_CI_FLEET_CAPACITY*`, `HOBO_CI_FLEET_ROUTES`, `HOBO_CI_LOCAL_RUNNER`, `HOBO_CI_LOCAL_REPOSITORY`, `HOBO_CI_LOCAL_TRUSTED`, `HOBO_TAILSCALE_AUTHKEY`.

### 6.15 Deployment, availability and operations

**Two profiles, one codebase**

| | Standalone | High availability |
|---|---|---|
| NATS | One server, replicas 1 | Three servers in one cluster, replicas 3; optional gateways between regions |
| Authority | One replica | Two or more replicas behind a load balancer; all are callout responders in one queue group |
| Event store | SQLite through `createRuntimeLocalEventStore` (ADR-0135: one writer) | `createJetStreamEventStore` on `MESH_JOURNAL`: every append is one message holding the batch, with `Nats-Expected-Last-Subject-Sequence` as the compare-and-set, so replicas agree without a leader. Postgres through `@hobo/storage-postgres` is supported behind the same port |
| Dispatcher and witness | Same host | Separate hosts from the authority |
| Peer-to-peer relays | One | Two or more, in different regions |

**State.** The authority's only durable state is the event store. The registry bucket, pool views and verdicts are projections rebuilt from it by replay. Losing every projection loses nothing.

**Assets** (all under `deploy/mesh/`, built and attested by the release workflow, R18): server configuration templates for both profiles; container images and a Compose file; Kubernetes manifests; systemd units, a launchd agent and a Windows service definition for the node; the peer-to-peer relay; a provisioning job.

**Key ceremony.** `hobo mesh ops ceremony` generates the NATS operator identity key offline and prints it for split custody; it is used only to sign operator signing keys. The operator signing key, each tenant account's scoped signing seeds, the SVID signing key, the authority's record-signing key and the witness key live in the secret store behind `SecretsPort`, one secret per key, each readable by exactly one workload identity. `hobo mesh ops rotate-signing-key <which>` does add, push, switch, remove, in that order, and is safe to interrupt at any step.

**Backup and restore.** `hobo mesh ops backup` snapshots `MESH_JOURNAL` and `MESH_AUDIT`; `restore` replays into a fresh deployment and rebuilds projections. A restore increments an authority **incarnation** number carried in every ticket, so credentials issued before the restore are refused.

**Emergency revocation without the authority.** Remove a role's scoped signing key from the tenant account and push the account. Every device of that role is disconnected at its next connection and no credential can be minted until a new key is provisioned. This path uses only the NATS operator tools.

**Supply chain.** Node and authority images and the `hobo` CLI ship with build provenance and a bill of materials (R18). The node verifies the provenance of an update before applying it. A pool's `min_agent_version` is enforced at ranking ([§6.8](#68-membership-capacity-and-reliability)) and at credential refresh.

**Runbooks** (WP-23, under `docs/maintenance/mesh/`): install and upgrade; enroll, suspend, unlock, revoke; rotate each key; restore; NATS node loss; callout outage; clone alarm; forged-claim alarm; audit witness outage; relay outage.

## 7. Frozen contracts

The seed commit ([§11.2](#112-the-seed-commit)) writes everything in this section into the repository verbatim. Implementers build against it and do not change it.

### 7.1 Records

`packages/mesh/data-models/mesh.proto`. All timestamps are RFC 3339 UTC strings with milliseconds. Field numbers are final.

```proto
syntax = "proto3";
package hobo.mesh.v1;

// ── Keys and signatures ────────────────────────────────────────────────────
enum KeyAlgorithm {
  KEY_ALGORITHM_UNSPECIFIED = 0;
  KEY_ALGORITHM_ES256 = 1;   // ECDSA P-256, IEEE P1363 signature encoding
  KEY_ALGORITHM_EDDSA = 2;   // Ed25519
}
enum KeyPurpose {
  KEY_PURPOSE_UNSPECIFIED = 0;
  KEY_PURPOSE_IDENTITY = 1;
  KEY_PURPOSE_SIGN = 2;
  KEY_PURPOSE_NATS = 3;
  KEY_PURPOSE_SEAL = 4;
  KEY_PURPOSE_TRANSPORT = 5;
  KEY_PURPOSE_AUTHORITY = 6;
  KEY_PURPOSE_WITNESS = 7;
}
// One public key. `value` encoding by purpose: IDENTITY = RFC 7517 JWK JSON;
// SIGN, SEAL, AUTHORITY, WITNESS = raw key, base64url, no padding;
// NATS = NKey public string (U...); TRANSPORT = the adapter's endpoint id.
message PublicKeyRef {
  KeyPurpose purpose = 1;
  string key_id = 2;        // "<DeviceId>#<purpose>", "authority#<n>", "witness#<n>"
  KeyAlgorithm algorithm = 3;
  string value = 4;
}
// §7.4. `signature` is over  utf8(context) || 0x00 || payload.
message SignedEnvelope {
  string context = 1;
  string key_id = 2;
  KeyAlgorithm algorithm = 3;
  bytes payload = 4;
  bytes signature = 5;
}
message DeviceKeyBundle {
  string device_id = 1;
  uint32 sequence = 2;                 // strictly increasing per device
  repeated PublicKeyRef keys = 3;      // exactly one each of SIGN, NATS, SEAL; at most one TRANSPORT
  string issued_at = 4;
  string not_after = 5;                // at most 24h after issued_at
}
// X25519 + HKDF-SHA-256 + ChaCha20-Poly1305.
message SealedBox {
  string recipient_key_id = 1;
  string ephemeral_public_key = 2;     // raw X25519, base64url
  bytes nonce = 3;                     // 12 bytes
  bytes ciphertext = 4;                // includes the 16-byte tag
}

// ── Devices ────────────────────────────────────────────────────────────────
enum DeviceState {
  DEVICE_STATE_UNSPECIFIED = 0;
  DEVICE_STATE_PENDING = 1;
  DEVICE_STATE_ACTIVE = 2;
  DEVICE_STATE_SUSPENDED = 3;
  DEVICE_STATE_LOCKED = 4;
  DEVICE_STATE_REVOKED = 5;
  DEVICE_STATE_REJECTED = 6;
}
enum DeviceClass {
  DEVICE_CLASS_UNSPECIFIED = 0;
  DEVICE_CLASS_PERSONAL = 1;
  DEVICE_CLASS_DEDICATED = 2;
  DEVICE_CLASS_EPHEMERAL = 3;
}
enum DeviceRole {
  DEVICE_ROLE_UNSPECIFIED = 0;
  DEVICE_ROLE_EXECUTOR = 1;
  DEVICE_ROLE_DISPATCHER = 2;
  DEVICE_ROLE_OBSERVER = 3;
  DEVICE_ROLE_RECONCILER = 4;
  DEVICE_ROLE_JUNCTION = 5;
}
enum AttestationTier {
  ATTESTATION_TIER_UNSPECIFIED = 0;
  ATTESTATION_TIER_T0_SOFTWARE_KEY = 1;
  ATTESTATION_TIER_T1_HELD_KEY = 2;
  ATTESTATION_TIER_T2_ORG_CERTIFIED = 3;
  ATTESTATION_TIER_T3_PLATFORM_IDENTITY = 4;
}
enum SandboxTier {
  SANDBOX_TIER_UNSPECIFIED = 0;
  SANDBOX_TIER_S1_CONTAINER = 1;
  SANDBOX_TIER_S2_USER_KERNEL = 2;
  SANDBOX_TIER_S3_MICROVM = 3;
}
enum TrustClass {
  TRUST_CLASS_UNSPECIFIED = 0;
  TRUST_CLASS_OWN = 1;
  TRUST_CLASS_ORG = 2;
  TRUST_CLASS_UNTRUSTED = 3;
}
message Platform {
  string os = 1;
  string arch = 2;
}
// The registry value for key device.<DeviceId>. Always stored inside a
// SignedEnvelope with context hobo-mesh/device-record/v1.
message DeviceRecord {
  string device_id = 1;
  string tenant = 2;
  string display_name = 3;
  DeviceState state = 4;
  DeviceClass device_class = 5;
  repeated DeviceRole roles = 6;
  repeated string pools = 7;
  AttestationTier attestation_tier = 8;
  string attestation_digest = 9;       // sha256:<hex> of the evidence, or empty
  string identity_thumbprint = 10;     // RFC 7638
  repeated string retired_thumbprints = 11;
  SignedEnvelope key_bundle = 12;      // context hobo-mesh/key-bundle/v1, signed by the identity key
  Platform platform = 13;
  string region = 14;
  string agent_version = 15;
  string owner = 16;                   // "<kind>:<id>" of a PrincipalRef
  string invited_by = 17;
  string key_approved_by = 18;
  string accepted_by = 19;
  string enrolled_at = 20;
  string state_changed_at = 21;
  string state_reason = 22;
  uint32 record_sequence = 23;         // strictly increasing per device
  uint32 authority_incarnation = 24;
}

// ── Pools ──────────────────────────────────────────────────────────────────
enum ApprovalMode {
  APPROVAL_MODE_UNSPECIFIED = 0;
  APPROVAL_MODE_AUTO_OWNER = 1;
  APPROVAL_MODE_SINGLE = 2;
  APPROVAL_MODE_DUAL = 3;
}
enum SessionPurpose {
  SESSION_PURPOSE_UNSPECIFIED = 0;
  SESSION_PURPOSE_SHELL = 1;
  SESSION_PURPOSE_FORWARD = 2;
  SESSION_PURPOSE_BLOB = 3;
}
message RepositoryRule {
  string repository = 1;               // "owner/name"
  repeated string refs = 2;            // glob over refs/...; empty means none
  repeated string workflow_digests = 3;// sha256:<hex>; empty means any workflow at an allowed ref
}
message OidcTrustRule {
  string issuer = 1;
  string audience = 2;
  string subject_pattern = 3;          // anchored regular expression
  map<string, string> required_claims = 4;
  repeated DeviceRole roles = 5;
}
message ResidencyRule {
  repeated string classifications = 1;
  repeated string allowed_jurisdictions = 2;
  repeated string denied_jurisdictions = 3;
}
message PoolPolicy {
  ApprovalMode approval = 1;
  repeated DeviceRole allowed_roles = 2;
  repeated DeviceClass allowed_classes = 3;
  AttestationTier min_attestation_tier = 4;
  SandboxTier org_min_sandbox = 5;     // S3 when unspecified
  repeated string work_kinds = 6;
  repeated RepositoryRule repositories = 7;
  repeated OidcTrustRule oidc_trust = 8;
  repeated string device_ca_roots_pem = 9;
  repeated string egress_allow = 10;   // exact host names
  uint32 device_quota_per_principal = 11;
  string min_agent_version = 12;
  ResidencyRule residency = 13;
  bool allow_host_docker = 14;
  repeated SessionPurpose session_purposes = 15;
  repeated string labels = 16;         // runner labels this pool serves
}
// The registry value for key pool.<PoolId>, inside an envelope with context
// hobo-mesh/pool-record/v1.
message PoolRecord {
  string pool_id = 1;
  string tenant = 2;
  string owner = 3;
  PoolPolicy policy = 4;
  uint32 revision = 5;
  string updated_at = 6;
  string updated_by = 7;
}

// ── Enrollment and credentials ─────────────────────────────────────────────
message EnrollmentRequest {
  string pool = 1;
  string display_name = 2;
  string identity_jwk = 3;             // public JWK JSON: EC P-256 or OKP Ed25519
  SignedEnvelope key_bundle = 4;
  Platform platform = 5;
  string region = 6;
  string agent_version = 7;
  DeviceClass device_class = 8;
  repeated DeviceRole requested_roles = 9;
  oneof proof {
    string bootstrap_token = 10;
    string authorization_code = 11;
    string oidc_assertion = 12;
  }
  string code_verifier = 13;           // with authorization_code
  repeated string certificate_chain_pem = 14; // tier T2 evidence, leaf first
  bool held_key = 15;                  // tier T1 self-declaration
}
message OverlayJoin {
  string provider = 1;                 // "tailscale" | "netbird"
  string credential = 2;               // single use
  string expires_at = 3;
  repeated string tags = 4;
}
message EnrollmentResponse {
  SignedEnvelope device_record = 1;
  repeated OverlayJoin overlay_joins = 2;
}
message CredentialRequest {
  uint32 generation = 1;
  repeated string audiences = 2;
  SignedEnvelope key_bundle = 3;       // optional renewal
  string agent_version = 4;
}
// Carried in NATS connect `auth_token`, inside an envelope with context
// hobo-mesh/session-ticket/v1.
message SessionTicket {
  string ticket_id = 1;
  string device_id = 2;
  string tenant = 3;
  repeated DeviceRole roles = 4;
  string nats_public_key = 5;
  string issued_at = 6;
  string expires_at = 7;
  uint32 authority_incarnation = 8;
}
message CredentialResponse {
  string svid = 1;
  string svid_expires_at = 2;
  SignedEnvelope session_ticket = 3;
  uint32 generation = 4;
  SignedEnvelope device_record = 5;
}
message BootstrapTokenRecord {
  string token_hash = 1;               // sha256 hex of the token
  string pool = 2;
  string display_name = 3;
  DeviceClass device_class = 4;
  repeated DeviceRole roles = 5;
  string issued_by = 6;
  string expires_at = 7;
  string consumed_by = 8;              // DeviceId, or empty
}

// ── Membership ─────────────────────────────────────────────────────────────
message CapacityFree {
  optional uint32 memory_mb = 1;
  optional uint32 disk_mb = 2;
}
message ReliabilitySamples {
  double delivered = 1;
  double dropped = 2;
}
// The value of mesh-adverts key <DeviceId>, inside an envelope with context
// hobo-mesh/advert/v1 signed by the SIGN key. An absent optional is unknown,
// never zero.
message Advert {
  string device_id = 1;
  repeated string pools = 2;
  uint32 free_slots = 3;
  optional uint32 total_slots = 4;
  bool healthy = 5;
  repeated string labels = 6;
  string valid_until = 7;              // at most 5 min ahead of the reader's clock, plus 1 min skew
  CapacityFree free = 8;
  Platform platform = 9;
  optional double reliability = 10;    // the device's own figure; dispatchers prefer theirs
  ReliabilitySamples samples = 11;
  string since = 12;
  repeated SandboxTier sandbox_tiers = 13;
  string agent_version = 14;
  repeated string transports = 15;     // "iroh" | "overlay" | "nats-relay"
  string region = 16;
  uint32 bundle_sequence = 17;
}
enum Availability {
  AVAILABILITY_UNSPECIFIED = 0;
  AVAILABILITY_LIVE = 1;
  AVAILABILITY_UNHEALTHY = 2;
  AVAILABILITY_LOST = 3;
}
message PoolDeviceView {
  string device_id = 1;
  string display_name = 2;
  DeviceState state = 3;
  Availability availability = 4;
  uint32 free_slots = 5;
  optional uint32 total_slots = 6;
  CapacityFree free = 7;
  Platform platform = 8;
  AttestationTier attestation_tier = 9;
  repeated SandboxTier sandbox_tiers = 10;
  optional double reliability = 11;
  ReliabilitySamples samples = 12;
  string since = 13;
  string last_seen = 14;
  string agent_version = 15;
  repeated string labels = 16;
  DeviceClass device_class = 17;
}
message PoolCapacity {
  uint32 live = 1;
  uint32 healthy = 2;
  uint32 total_slots = 3;
  uint32 free_slots = 4;
  optional uint32 free_memory_mb = 5;
  optional uint32 free_disk_mb = 6;
  optional uint32 max_memory_mb = 7;
}
message PoolView {
  string pool = 1;
  repeated PoolDeviceView devices = 2; // at most 256
  PoolCapacity capacity = 3;           // covers every device, listed or not
  bool truncated = 4;
  string as_of = 5;
}
enum VerdictState {
  VERDICT_STATE_UNSPECIFIED = 0;
  VERDICT_STATE_OPEN = 1;
  VERDICT_STATE_NO_NODE = 2;
  VERDICT_STATE_NO_CAPACITY = 3;
}
message PoolVerdict {
  string pool = 1;
  string label = 2;
  VerdictState state = 3;
  uint32 devices = 4;
  uint32 free_slots = 5;
  string as_of = 6;
  string expires_at = 7;               // at most 300 s after as_of
}

// ── Work ───────────────────────────────────────────────────────────────────
message WorkNeeds {
  optional uint32 memory_mb = 1;
  optional uint32 disk_mb = 2;
  Platform platform = 3;
  repeated string labels = 4;
  bool docker = 5;
  SandboxTier min_sandbox = 6;
}
// Envelope context hobo-mesh/offer/v1, signed by a dispatcher's SIGN key.
message WorkOffer {
  string work_key = 1;                 // kind-defined, unique per unit of work
  string work_digest = 2;              // first 32 hex of sha256(kind || 0x00 || work_key)
  string kind = 3;
  string pool = 4;
  string label = 5;
  WorkNeeds needs = 6;
  TrustClass trust_class = 7;
  string repository = 8;
  string ref = 9;
  string workflow_digest = 10;
  string queued_at = 11;
  string expires_at = 12;
  string dispatcher = 13;              // DeviceId
  ResidencyRule residency = 14;
}
// Envelope context hobo-mesh/claim/v1, signed by the claimant's SIGN key.
message Claim {
  string work_digest = 1;
  string pool = 2;
  string device_id = 3;
  string claimed_at = 4;
  SandboxTier sandbox_tier = 5;
}
// Envelope context hobo-mesh/order/v1, signed by the dispatcher's SIGN key.
message WorkOrder {
  string order_id = 1;
  WorkOffer offer = 2;
  string device_id = 3;
  SandboxTier sandbox_tier = 4;
  repeated string egress_allow = 5;
  map<string, string> parameters = 6;  // non-secret, kind-defined
  SealedBox secret = 7;                // kind-defined secret bytes
  string issued_at = 8;
  string expires_at = 9;
}
enum ReceiptStatus {
  RECEIPT_STATUS_UNSPECIFIED = 0;
  RECEIPT_STATUS_STARTED = 1;
  RECEIPT_STATUS_SUCCEEDED = 2;
  RECEIPT_STATUS_FAILED = 3;
  RECEIPT_STATUS_CANCELLED = 4;
  RECEIPT_STATUS_ABANDONED = 5;
  RECEIPT_STATUS_REFUSED = 6;
}
// Envelope context hobo-mesh/receipt/v1, signed by the executor's SIGN key.
message WorkReceipt {
  string order_id = 1;
  string work_digest = 2;
  string device_id = 3;
  ReceiptStatus status = 4;
  string reason = 5;                   // an error code from §7.6, or empty
  string at = 6;
  SandboxTier sandbox_tier = 7;
  uint32 sandbox_seconds = 8;
  string output_digest = 9;
}

// ── Transport ──────────────────────────────────────────────────────────────
message SessionParty {
  string device_id = 1;                // empty when the party is a person's CLI
  string principal = 2;                // "<kind>:<id>"
  string transport_identity = 3;
  string seal_public_key = 4;
}
// Envelope context hobo-mesh/session-grant/v1, signed by the authority.
message SessionGrant {
  string session_id = 1;
  string tenant = 2;
  SessionParty initiator = 3;
  SessionParty acceptor = 4;
  SessionPurpose purpose = 5;
  string order_id = 6;
  uint32 port = 7;
  repeated string blob_digests = 8;
  string issued_at = 9;
  string expires_at = 10;              // at most 60 min after issued_at
}

// ── Control, trust, audit, errors ──────────────────────────────────────────
enum ControlKind {
  CONTROL_KIND_UNSPECIFIED = 0;
  CONTROL_KIND_DRAIN = 1;
  CONTROL_KIND_REFRESH_NOW = 2;
  CONTROL_KIND_REVOKED = 3;
  CONTROL_KIND_UPDATE_REQUIRED = 4;
}
// Envelope context hobo-mesh/control/v1, signed by the authority.
message DeviceControl {
  string device_id = 1;
  ControlKind kind = 2;
  string reason = 3;
  string at = 4;
}
// The registry value for key `trust`, and part of discovery.
message TrustRecord {
  string tenant = 1;
  repeated PublicKeyRef authority_keys = 2;
  repeated PublicKeyRef witness_keys = 3;
  uint32 authority_incarnation = 4;
  string issuer = 5;
  string jwks_uri = 6;
}
message Discovery {
  string issuer = 1;
  string jwks_uri = 2;
  repeated string nats_urls = 3;
  repeated string relay_urls = 4;
  TrustRecord trust = 5;
  string min_agent_version = 6;
  repeated string sign_in_providers = 7;
}
message AuditEntry {
  uint32 sequence = 1;
  string previous_hash = 2;            // sha256 hex; 64 zeros for the first
  string event_type = 3;
  string event_id = 4;
  string subject = 5;
  string actor = 6;
  string at = 7;
  string data_digest = 8;              // sha256 hex of the event data
}
// Envelope context hobo-mesh/audit-checkpoint/v1.
message AuditCheckpoint {
  uint32 sequence = 1;
  string entry_hash = 2;
  string at = 3;
  uint32 authority_incarnation = 4;
}
message WitnessedCheckpoint {
  SignedEnvelope authority = 1;
  SignedEnvelope witness = 2;          // same payload bytes as `authority`
}
message MeshError {
  string code = 1;                     // §7.6
  string message = 2;
  map<string, string> detail = 3;
}
```

### 7.2 Constraints

`packages/mesh/data-models/mesh.cue` defines one definition per message and enum above and a root `#Mesh` that is their disjunction (required by the fixture gate, `packages/schema-tools/src/cue.ts:140-162`). It must enforce at least:

| Field or record | Constraint |
|---|---|
| `DeviceId` (every `device_id`, `dispatcher`, `consumed_by`) | `^dev_[0-9a-f]{32}$` |
| `PoolId` (every `pool`, `pool_id`) | `^[a-z0-9][a-z0-9-]{0,62}$` |
| `tenant` | the core tenant pattern |
| `key_id` | `^(dev_[0-9a-f]{32}#(identity\|sign\|nats\|seal\|transport)\|authority#[0-9]+\|witness#[0-9]+)$` |
| `context` | one of the strings in [§7.4](#74-signed-envelope) |
| `work_digest` | `^[0-9a-f]{32}$` |
| `DeviceKeyBundle.keys` | exactly one `SIGN`, one `NATS`, one `SEAL`; at most one `TRANSPORT`; no `IDENTITY`, `AUTHORITY` or `WITNESS` |
| `DeviceRecord` | `state` set; `roles` non-empty and never containing a role outside `DeviceRole`; `pools` non-empty when `ACTIVE`; `accepted_by != key_approved_by` when both are set and neither starts with `policy:` |
| `PoolPolicy` | `approval` set; `allow_host_docker` true only if `allowed_classes` is exactly `[DEDICATED]`; `org_min_sandbox` below `S3` only if `repositories` is non-empty; every `egress_allow` entry a lower-case DNS name with no wildcard |
| `Advert` | `free_slots <= total_slots` when both set; `memory_mb <= 16777216`; `disk_mb <= 1073741824`; `labels` at most 32, each 1 to 80 characters; `reliability` in `(0, 1]` |
| `WorkOffer` | `trust_class` set; `UNTRUSTED` requires `needs.min_sandbox` = `S3` |
| `WorkOrder` | `device_id` set; `sandbox_tier >= offer.needs.min_sandbox`; an offer with `trust_class` `UNTRUSTED` carries no `secret` |
| `SessionGrant` | `purpose` set; `FORWARD` requires `port` in 1 to 65535; `BLOB` requires `blob_digests` non-empty |
| `PoolVerdict` | `state` set; `NO_NODE` requires `devices == 0`; `NO_CAPACITY` requires `devices > 0` and `free_slots == 0` |
| Every record | No field named or matching a private key, seed, token or password (the existing `mesh-advert-private-key.json` invalid fixture, generalised) |

Fixtures: at least one valid fixture per message and one invalid fixture per row above, under `packages/mesh/data-models/fixtures/{valid,invalid}/`.

### 7.3 Ports

`packages/mesh/src/ports.ts`. Record types are the generated ones from `./_generated/mesh_pb.js`. `DeviceId`, `PoolId`, `WorkDigest` and `KeyId` are branded strings with `parse*` constructors.

```ts
import type { EventInput, EventStore, MeteringBus, PolicyDecision, PolicyEngine, PolicyRequest, PrincipalRef, TenantId } from "@hobo/core";

export type Outcome<T> = Readonly<{ ok: true; value: T } | { ok: false; error: MeshFailure }>;
export type MeshFailure = Readonly<{ code: MeshErrorCode; message: string; detail?: Readonly<Record<string, string>> }>;
export type MeshLog = (event: MeshLogEvent, fields: Readonly<Record<string, string | number | boolean>>) => void;
export type Clock = () => number; // epoch milliseconds

// ── Keys ───────────────────────────────────────────────────────────────────
export interface Signer {
	readonly keyId: KeyId;
	readonly algorithm: KeyAlgorithm;
	sign(bytes: Uint8Array): Promise<Uint8Array>;
}
export interface KeyStore {
	/** Creates the identity and operational keys if absent. Never returns private material. */
	open(): Promise<DeviceKeys>;
	readGeneration(): Promise<number>;
	writeGeneration(generation: number): Promise<void>;
	/** Replaces the operational keys; the identity key is untouched. */
	rotateOperational(): Promise<DeviceKeys>;
	destroy(): Promise<void>;
}
export type DeviceKeys = Readonly<{
	deviceId: DeviceId;
	identityJwk: string;
	identity: Signer;
	sign: Signer;
	natsPublicKey: string;
	signNatsNonce(nonce: Uint8Array): Promise<Uint8Array>;
	sealPublicKey: string;
	openSealed(box: SealedBox): Promise<Uint8Array>;
	agree(peerSealPublicKey: string): Promise<Uint8Array>; // X25519 shared secret
	heldKey: boolean;
}>;

// ── Authority-side stores and issuers ──────────────────────────────────────
export interface RegistryView {
	device(id: DeviceId): Promise<DeviceRecord | undefined>;
	pool(id: PoolId): Promise<PoolRecord | undefined>;
	trust(): Promise<TrustRecord | undefined>;
	devicesInPool(id: PoolId): Promise<readonly DeviceRecord[]>;
	/** Resolves when the view has applied every change up to now. */
	caughtUp(): Promise<void>;
}
export interface RegistryPublisher {
	putDevice(record: SignedEnvelope, id: DeviceId): Promise<void>;
	putPool(record: SignedEnvelope, id: PoolId): Promise<void>;
	putTrust(record: TrustRecord): Promise<void>;
}
export interface SvidIssuer {
	issue(input: Readonly<{ device: DeviceRecord; audiences: readonly string[]; jkt: string; ttlMs: number }>): Promise<Readonly<{ token: string; expiresAtMs: number }>>;
	jwks(): Promise<string>;
}
export interface IdentityAssertionVerifier {
	/** Validates a platform OIDC token against its issuer's published keys. */
	verifyOidc(assertion: string): Promise<Outcome<Readonly<{ issuer: string; audience: string; subject: string; claims: Readonly<Record<string, string>> }>>>;
	/** Validates a leaf-first PEM chain for the given identity key against the pool's roots. */
	verifyCertificateChain(input: Readonly<{ chainPem: readonly string[]; identityJwk: string; rootsPem: readonly string[]; nowMs: number }>): Outcome<Readonly<{ digest: string }>>;
}
export interface SignInProvider {
	readonly id: string; // "oidc" | "github" | "atproto"
	beginAuthorization(input: Readonly<{ state: string; redirectUri: string }>): Promise<Readonly<{ url: string }>>;
	completeAuthorization(input: Readonly<{ code: string; state: string; redirectUri: string }>): Promise<Outcome<PrincipalRef>>;
}
export interface OverlayCredentialMinter {
	readonly provider: "tailscale" | "netbird";
	mint(input: Readonly<{ tenant: TenantId; deviceId: DeviceId; tags: readonly string[]; ttlMs: number }>): Promise<Outcome<OverlayJoin>>;
}
export interface ReplayStore {
	/** True the first time a (scope, id) pair is seen within its window. */
	firstUse(scope: string, id: string, expiresAtMs: number): Promise<boolean>;
}
export interface AuditWitness {
	cosign(checkpoint: SignedEnvelope): Promise<Outcome<SignedEnvelope>>;
}
/** Builds the `policy.Decided` event. Implemented in @hobo/mesh-authority with @hobo/policy, which this package may not import. */
export interface PolicyDecisionRecorder {
	toEvent(request: PolicyRequest, decision: PolicyDecision): EventInput;
}

// ── Bus-side ports (implemented in memory by @hobo/mesh and over NATS by @hobo/mesh-nats) ──
export interface AdvertBoard {
	advertise(advert: SignedEnvelope, id: DeviceId): Promise<void>;
	/** At most `limit` envelopes; reports when it stopped early. */
	read(limit: number): Promise<Readonly<{ adverts: readonly SignedEnvelope[]; capped: boolean }>>;
}
export interface ClaimLedger {
	/** First writer wins, enforced by the store. */
	claim(claim: SignedEnvelope, pool: PoolId, digest: WorkDigest): Promise<"claimed" | "held">;
	holder(pool: PoolId, digest: WorkDigest): Promise<SignedEnvelope | undefined>;
	/** Dispatcher only: remove an invalid claim. */
	reject(pool: PoolId, digest: WorkDigest): Promise<void>;
}
export interface OfferFeed {
	publish(offer: SignedEnvelope, pool: PoolId): Promise<void>;
	subscribe(pools: readonly PoolId[], handler: (offer: SignedEnvelope) => Promise<void>): Subscription;
}
export interface OrderChannel {
	deliver(order: SignedEnvelope, to: DeviceId): Promise<void>;
	subscribe(self: DeviceId, handler: (order: SignedEnvelope) => Promise<void>): Subscription;
}
export interface EventChannel {
	publish(event: SignedEnvelope, from: DeviceId, kind: string): Promise<void>;
	subscribe(kinds: readonly string[], handler: (event: SignedEnvelope, from: DeviceId) => Promise<void>): Subscription;
}
export interface ControlChannel {
	send(control: SignedEnvelope, to: DeviceId): Promise<void>;
	subscribe(self: DeviceId, handler: (control: SignedEnvelope) => Promise<void>): Subscription;
}
export interface Subscription { stop(): Promise<void>; }
export type MeshBus = Readonly<{
	registry: RegistryView; adverts: AdvertBoard; claims: ClaimLedger; offers: OfferFeed;
	orders: OrderChannel; events: EventChannel; control: ControlChannel;
	status(): "connected" | "disconnected" | "closed";
	close(): Promise<void>;
}>;
export interface MeshBusConnector {
	/** Connects as this device, presenting a session ticket; reconnects with a fresh ticket from `ticket()`. */
	connect(input: Readonly<{ natsUrls: readonly string[]; keys: DeviceKeys; ticket: () => Promise<SignedEnvelope>; log: MeshLog }>): Promise<MeshBus>;
}

// ── Work ───────────────────────────────────────────────────────────────────
export interface WorkSource {
	readonly kind: string;
	/** Upstream work visible now. Called on the dispatcher's beat. */
	poll(pool: PoolRecord): Promise<readonly Readonly<{ workKey: string; label: string; needs: WorkNeeds; trustClass: TrustClass; repository: string; ref: string; workflowDigest: string; queuedAtMs: number }>[]>;
	/** Builds the non-secret parameters and the secret bytes for one claimant. */
	prepare(offer: WorkOffer, claimant: DeviceRecord): Promise<Outcome<Readonly<{ parameters: Readonly<Record<string, string>>; secret: Uint8Array; egressAllow: readonly string[] }>>>;
	/** Whether upstream still wants this work started. */
	stillWanted(offer: WorkOffer): Promise<boolean>;
}
export interface WorkRunner {
	readonly kind: string;
	/** Runs one order inside the given sandbox; resolves when the work has ended. */
	run(input: Readonly<{ order: WorkOrder; secret: Uint8Array; sandbox: Sandbox; signal: AbortSignal; log: MeshLog }>): Promise<Readonly<{ status: ReceiptStatus; reason: string; outputDigest: string }>>;
	/** The start fence: does what upstream assigned match this order? */
	confirmAssignment?(order: WorkOrder, observed: Readonly<Record<string, string>>): boolean;
}
export interface SandboxDriver {
	readonly tier: SandboxTier;
	/** Self-test run at node start; a failing driver is not advertised. */
	available(): Promise<Outcome<Readonly<{ providesDocker: boolean }>>>;
	create(input: Readonly<{ orderId: string; image: string; limits: Readonly<{ memoryMb: number; cpus: number; pids: number; diskMb: number }>; egressProxyUrl: string; readOnlyMounts: readonly Readonly<{ source: string; target: string }>[]; hostDocker: boolean }>): Promise<Sandbox>;
}
export interface Sandbox {
	readonly id: string;
	readonly tier: SandboxTier;
	exec(input: Readonly<{ argv: readonly string[]; env: Readonly<Record<string, string>>; stdin?: Uint8Array; signal: AbortSignal; onOutput(chunk: Uint8Array): void }>): Promise<Readonly<{ exitCode: number }>>;
	writeSecret(path: string, bytes: Uint8Array): Promise<void>; // never through argv or env
	destroy(): Promise<void>;
}
export interface CapacitySource {
	read(): Promise<Readonly<{ freeSlots: number; totalSlots: number; healthy: boolean; free: CapacityFree; labels: readonly string[] }>>;
}

// ── Transport ──────────────────────────────────────────────────────────────
export type TransportKind = "iroh" | "overlay" | "nats-relay";
export interface MeshStream {
	readonly peer: string; // the authenticated transport identity
	read(): AsyncIterable<Uint8Array>;
	write(chunk: Uint8Array): Promise<void>;
	close(): Promise<void>;
}
export interface MeshTransport {
	readonly kind: TransportKind;
	/** The identity to record in the key bundle, once started. */
	start(keys: DeviceKeys): Promise<Readonly<{ transportIdentity: string }>>;
	dial(input: Readonly<{ grant: SignedEnvelope; signal: AbortSignal }>): Promise<Outcome<MeshStream>>;
	/** `authorise` is called with the peer's proven identity and its presented grant before any byte is delivered. */
	accept(authorise: (peer: string, grant: SignedEnvelope) => Promise<boolean>, handler: (stream: MeshStream, grant: SessionGrant) => Promise<void>): Subscription;
	stop(): Promise<void>;
}

// ── Composition roots take these ───────────────────────────────────────────
export type AuthorityDeps = Readonly<{
	tenant: TenantId; store: EventStore; registry: RegistryPublisher; view: RegistryView;
	policy: PolicyEngine; decisions: PolicyDecisionRecorder; svid: SvidIssuer; assertions: IdentityAssertionVerifier; replay: ReplayStore;
	recordSigner: Signer; witness: AuditWitness; metering: MeteringBus; overlayMinters: readonly OverlayCredentialMinter[];
	incarnation: number; now: Clock; log: MeshLog;
}>;
export type NodeDeps = Readonly<{
	keys: KeyStore; authorityUrl: string; connector: MeshBusConnector; capacity: CapacitySource;
	runners: readonly WorkRunner[]; sources: readonly WorkSource[]; sandboxes: readonly SandboxDriver[];
	transports: readonly MeshTransport[]; metering: MeteringBus; now: Clock; log: MeshLog;
	fetch: typeof fetch;
}>;
```

Public entry points of `@hobo/mesh` (subpath exports; names are final):

| Subpath | Exports (functions) |
|---|---|
| `@hobo/mesh/keys` | `parsePublicJwk`, `jwkThumbprint`, `deviceIdFromJwk`, `signEnvelope`, `verifyEnvelope`, `parseEnvelope`, `buildKeyBundle`, `verifyKeyBundle`, `mintDpopProof`, `verifyDpopProof`, `seal`, `openSealed`, `sessionKeys`, `fingerprintWords`, `createMemoryKeyStore` |
| `@hobo/mesh/enrollment` | `createEnrollmentAuthority(deps: AuthorityDeps)` returning `{ issueToken, revokeToken, enroll, approveKey, accept, reject, credentials, rotateKeys, suspend, resume, unlock, revoke, definePool, grantSession, verifyRequest }`; `projectRegistry`; `MESH_STREAMS`; `MESH_ACTIONS` |
| `@hobo/mesh/membership` | `rankDevices`, `claimTurn`, `fitWork`, `verifyAdvert`, `buildAdvert`, `createReliabilityLedger`, `createMembershipMonitor`, `poolView`, `poolVerdict` |
| `@hobo/mesh/work` | `createDispatcher`, `createExecutor`, `workDigest`, `resolveSandboxTier`, `checkOrderAgainstPolicy`, `trustClassOf`, `createOciCommandRunner`, `createOciCommandSource` |
| `@hobo/mesh/transport` | `createSessionAuthoriser`, `frameStream`, `createTransportSelector`, `serveShell`, `serveForward`, `serveBlob`, `fetchBlob` |
| `@hobo/mesh/audit` | `createAuditChain`, `verifyAuditChain`, `createLocalWitness` |
| `@hobo/mesh/node` | `createMeshNode(deps: NodeDeps)` returning `{ enroll, start, stop, status, drain }` |
| `@hobo/mesh/client` | `createMeshClient({ origin, auth })` with one method per route in [§6.14](#614-surfaces) |
| `@hobo/mesh/testing` | `createMemoryBus`, `createMemoryEventStore`, `createFakeAuthority`, `createFakeSandboxDriver`, `runBusConformance`, `runTransportConformance`, `runSandboxConformance`, `runKeyStoreConformance` |
| `@hobo/mesh/verdict-wire` | `parsePoolVerdict`, `verdictBlocks`. **This file has no imports** (R14) |

### 7.4 Signed envelope

```
signature = Sign(key, utf8(context) || 0x00 || payload)
```

`payload` is the protobuf binary encoding of the record, exactly as transmitted. A verifier checks the signature over the received bytes and only then decodes them. Nothing is re-serialised. In JSON transports the envelope is protobuf JSON, so `payload` and `signature` are base64.

| Context | Payload | Signed by | Verified against |
|---|---|---|---|
| `hobo-mesh/key-bundle/v1` | `DeviceKeyBundle` | Device identity key | `identity_jwk` at enrollment; afterwards the thumbprint in the device record |
| `hobo-mesh/device-record/v1` | `DeviceRecord` | Authority | `TrustRecord.authority_keys` |
| `hobo-mesh/pool-record/v1` | `PoolRecord` | Authority | same |
| `hobo-mesh/session-ticket/v1` | `SessionTicket` | Authority | same |
| `hobo-mesh/session-grant/v1` | `SessionGrant` | Authority | same |
| `hobo-mesh/control/v1` | `DeviceControl` | Authority | same |
| `hobo-mesh/audit-checkpoint/v1` | `AuditCheckpoint` | Authority, then witness | `authority_keys`, `witness_keys` |
| `hobo-mesh/advert/v1` | `Advert` | Device `SIGN` key | the bundle in the device record |
| `hobo-mesh/claim/v1` | `Claim` | Device `SIGN` key | same |
| `hobo-mesh/receipt/v1` | `WorkReceipt` | Device `SIGN` key | same |
| `hobo-mesh/offer/v1` | `WorkOffer` | Dispatcher `SIGN` key | the bundle of a device with role `DISPATCHER` in that pool |
| `hobo-mesh/order/v1` | `WorkOrder` | Dispatcher `SIGN` key | same |
| `hobo-mesh/rotation/v1` | new identity JWK and the `DeviceId` | Old device identity key | the thumbprint in the device record |

`// public-contract:` each context string. A change to what any record means needs a new version suffix; a verifier never accepts a context it does not list for the record it expects.

The trust anchor is `TrustRecord`. A node pins it at enrollment (it arrives over TLS from the authority origin the person configured) and accepts a changed record only when the new record is itself delivered in an envelope signed by a key in the record it already holds.

### 7.5 Event families

All events are in one new family, `mesh.*` (added to `docs/design/event-families.md`). Streams are on the core `EventStore` port.

| Stream id | Events | Notes |
|---|---|---|
| `mesh-token-<sha256>` | `mesh.TokenIssued`, `mesh.TokenConsumed`, `mesh.TokenRevoked` | Single use is a compare-and-set on this stream |
| `mesh-device-<DeviceId>` | `mesh.EnrollmentRequested`, `mesh.KeyApproved`, `mesh.EnrollmentAccepted`, `mesh.EnrollmentRejected`, `mesh.DeviceActivated`, `mesh.CredentialsIssued`, `mesh.KeysRotated`, `mesh.IdentityKeyRotated`, `mesh.DeviceSuspended`, `mesh.DeviceResumed`, `mesh.DeviceLocked`, `mesh.DeviceUnlocked`, `mesh.DeviceRevoked` | `mesh.CredentialsIssued` carries the ticket id and new generation, never a token |
| `mesh-pool-<PoolId>` | `mesh.PoolDefined`, `mesh.PoolPolicyChanged` | |
| `mesh-session-<sessionId>` | `mesh.SessionGranted` | |
| `mesh-work-<WorkDigest>` | `mesh.WorkOffered`, `mesh.WorkClaimed`, `mesh.ClaimRejected`, `mesh.WorkOrdered`, `mesh.WorkStarted`, `mesh.WorkSucceeded`, `mesh.WorkFailed`, `mesh.WorkCancelled`, `mesh.WorkAbandoned`, `mesh.WorkRefused` | Written by dispatchers from receipts |
| `mesh-replay-<DeviceId>-<bucket>` | `mesh.ProofAccepted` | Idempotency key is the DPoP `jti`; buckets are two clock-skews wide |
| `mesh-audit` | `mesh.AuditCheckpointed` | |
| policy decisions | `policy.Decided` | Through `@hobo/policy`; never retried |

Commands are the methods of `createEnrollmentAuthority`, `createDispatcher` and `createExecutor`. Each command reads its stream, decides, and appends with `expectedSeq`, retrying on conflict up to 8 times. Projections: the registry (per device and per pool, published to `mesh-registry`), the pool view, the pool verdict, reliability per device, and the audit chain. Every projection is rebuilt by replay; snapshots are caches. The read store is the `mesh-registry` bucket and, for work history, `MESH_EVENTS`.

Log event names (`MeshLogEvent`) and their CloudEvent types: each `hobo_mesh_<snake_case>` maps to `mesh.<PascalCase>` for the events above, plus operational ones with no stream: `hobo_mesh_bus_status`, `hobo_mesh_advert_rejected`, `hobo_mesh_offer_unfit`, `hobo_mesh_claims_unreachable`, `hobo_mesh_capacity`, `hobo_mesh_capacity_exhausted`, `hobo_mesh_capacity_restored`, `hobo_mesh_callout_refused`, `hobo_mesh_transport_selected`, `hobo_mesh_sandbox_unavailable`, `hobo_mesh_update_required`.

### 7.6 Errors

`MeshErrorCode` is a closed union. HTTP status in brackets.

| Code | Meaning |
|---|---|
| `invalid-request` [400] | The body does not parse or breaks a constraint |
| `unauthenticated` [401] | No valid SVID, proof or sign-in |
| `proof-invalid` [401] | A DPoP proof or envelope signature failed |
| `proof-replayed` [401] | The proof's id was seen before |
| `forbidden` [403] | Policy denied the action; `detail.decision` is the decision id |
| `token-invalid` [401], `token-used` [409], `token-expired` [410] | Bootstrap token problems |
| `pool-unknown` [404], `device-unknown` [404] | |
| `pool-policy` [403] | The request is outside pool policy; `detail.rule` names which |
| `quota-exceeded` [429] | The principal's device quota for the pool |
| `attestation-insufficient` [403] | Below the pool's minimum tier |
| `approval-pending` [409] | The device is `PENDING` |
| `device-suspended` [403], `device-locked` [423], `device-revoked` [410] | |
| `generation-mismatch` [423] | The clone alarm; the device is now `LOCKED` |
| `incarnation-stale` [401] | A credential from before a restore |
| `agent-outdated` [426] | Below `min_agent_version` |
| `conflict` [409] | Compare-and-set lost after retries |
| `residency-denied` [403] | `evaluateResidency` refused |
| `sandbox-inadequate` | The device cannot provide the tier the work needs |
| `order-invalid` | An order failed verification on the device; `detail.check` names which |
| `assignment-mismatch` | The start fence refused |
| `session-denied` | A transport accept refused |
| `unavailable` [503] | A dependency is down; safe to retry |

## 8. Consolidation ledger

Every existing implementation, and what happens to it. "Moves" means the code is relocated and adapted, its tests move with it, and the original is deleted in the same change. Nothing below may remain as a second implementation after this plan. The work package that owns each row is named.

### 8.1 The CI relay mesh

| Existing | Fate | WP |
|---|---|---|
| `packages/ci/src/mesh/rendezvous.ts`, `coordinator.ts`, `monitor.ts`, `reliability.ts`, `report.ts` and their tests | Move to `packages/mesh/src/membership/` and `src/work/`. Node id becomes `DeviceId`; job id becomes `WorkDigest`; the three trust levels are removed ([§6.8](#68-membership-capacity-and-reliability)) | 03, 04 |
| `packages/ci/src/mesh/trust.ts` | Replaced by `packages/mesh/src/keys/` (envelope, key bundle) and the registry. The hand-edited trusted-key list is deleted | 01 |
| `packages/ci/package.json` export `./mesh`; `packages/ci/src/mesh/index.ts` | Deleted. No re-export shim: the package is not published (CLAUDE.md) and every importer is in this repository | 14 |
| `packages/ci-gh-actions/src/mesh-nats.ts`, `mesh-records.ts`, `mesh-nodes-reader.ts` | Replaced by `@hobo/mesh-nats` | 07 |
| `packages/ci-gh-actions/src/mesh-node.ts`, `mesh-join.ts`, `mesh-worker.ts` | Replaced by `@hobo/mesh/node` and `@hobo/mesh-node`. The drop accounting in `mesh-worker.ts` moves to the executor and the dispatcher-side reliability ledger | 04, 09 |
| `packages/ci-gh-actions/data-models/mesh.proto`, the `#Mesh*` definitions in `onboarding.cue`, the `mesh-*` fixtures, `src/_generated/mesh_pb.ts` | Deleted; superseded by `packages/mesh/data-models/` | 15 |
| `packages/ci-gh-actions/scripts/mesh-trust.mts`, `mesh-demo.mts`; scripts `mesh:trust`, `mesh:demo` | Deleted. `hobo mesh device …` replaces the first; `packages/mesh/examples/demo.ts` on the in-memory bus replaces the second | 15, 06 |
| `packages/ci-gh-actions/package.json` export `./mesh-nats`; dependencies `@nats-io/*` | Removed. Only `@hobo/mesh-nats` may depend on a NATS client (guard, WP-22) | 15 |
| `packages/ci-gh-actions/src/fleet-state.ts`, `fleet-capacity.ts`, `fleet-routes.ts`, `fleet-absorb.ts` | Deleted. The pool verdict replaces all three published variables; absorb-slot arithmetic reads `PoolCapacity` | 15 |
| `packages/ci/src/fleet/capacity.ts`, `capacity-input.ts`, `route-table.ts` and their exports | Deleted | 14 |
| `packages/ci-gh-actions/src/local-runner.ts`, `scripts/local-runner.ts`, `LOCAL-DEVELOPMENT.md`, script `local:runner` | Deleted. A developer machine is an enrolled `PERSONAL` executor running `hobo mesh run`. `LOCAL-DEVELOPMENT.md` becomes a pointer to the mesh quick start | 15 |
| `packages/ci-gh-actions/scripts/isolated-worker-daemon-main.mts` mesh wiring (lines 145-262, 855-1111) | Replaced by `createMeshNode` with roles `DISPATCHER` and `EXECUTOR`; the worker's memory, storage and host-health admission become its `CapacitySource`; its GitHub poller becomes the `github-actions-job` `WorkSource`; its container launch becomes the `S1` runner path with the hardening of [§6.10](#610-sandbox-tiers). The host Docker socket mount is off unless the pool sets `allow_host_docker` | 15 |
| `packages/ci-gh-actions/src/hosted-control.ts` `/v1/mesh/nodes`; `relay-mcp-server.ts` `list_mesh_nodes`; `client.ts` `getMeshNodes`; `cloud-events.ts` `ci.Mesh*` types | Kept as surfaces, re-implemented as calls to `@hobo/mesh/client`. The `ci.Mesh*` CloudEvent types are replaced by `mesh.*` | 15 |
| `packages/hobo/src/ci-mesh-status.ts` and the mesh part of `hobo ci status` | The table moves to `hobo mesh status`; `hobo ci status` calls it | 17 |
| `scripts/ci/route-runner.mts` `parseFleetState`, capacity reader; `scripts/ci/load-fleet-capacity.mts`; `scripts/lib/ci-runner-contract.mts` fleet constants | The route job fetches one pool verdict and parses it with `packages/mesh/src/verdict-wire.ts`. `load-fleet-capacity.mts` is deleted; shard planning reads `free_slots` from the same verdict | 20 |
| Repository variables `HOBO_CI_FLEET_STATE`, `HOBO_CI_FLEET_CAPACITY`, `HOBO_CI_FLEET_ROUTES`, `HOBO_CI_LOCAL_RUNNER`; `.github/workflows/fleet-probe.yml` | Variables removed from every workflow and deleted at cutover. The probe workflow stays (it measures pickup, which the verdict does not) | 20 |
| `docs/design/ci-relay-mesh.md` | Marked superseded with a pointer; its still-true sections are folded into `docs/design/mesh-compute-network.md` | 23 |

### 8.2 In-flight branches

| Existing | Fate | WP |
|---|---|---|
| Delivery stack `packages/cd/src/agent/enrollment.ts`, `dpop.ts`, `dpop-verifier.ts`, `jose.ts`, `replay.ts`, `events.ts` | The engine moves to `packages/mesh/src/enrollment/` and `src/keys/`. `@hobo/cd` keeps its `AgentEnrollment` port, implemented as a thin adapter: a reconciler is a device with role `RECONCILER`, a Camp set is a pool, `hcd_bt_` tokens become `hmt_` tokens, and `/v1/cd/svid/refresh` verifies SVIDs issued by the mesh authority | 02, 18 |
| Delivery stack `packages/ci-gh-actions/src/runner-fleet-delivery.ts` | Kept; imports `PoolDeviceView` from `@hobo/mesh` instead of `MeshNode` from `@hobo/ci/mesh`. Its mapping of device status to Camp conditions is the single feed from mesh into Camp inventory | 15 |
| Delivery stack `CampStatusRecord`, `@hobo/cd-kube-fleet` | Unchanged. Camp inventory is a different thing ([§4](#4-terms)); clusters are not devices | — |
| [#1952](https://github.com/Hobo-Labs/HoBo/pull/1952) `packages/ci-gh-actions/src/fleet-verdict.ts`, `data-models/fleet_verdict.proto`, `packages/ci-vercel/src/fleet-verdict-cache.ts`, routes `/v1/fleet/verdicts/…` | Superseded by `PoolVerdict` and `GET /v1/mesh/pools/{id}/verdict`. If merged before this plan starts, WP-15 and WP-16 delete them; if not, the pull request is closed | 15, 16 |
| Plan 0025 layers 02 to 06 (signed reporters, reporter enrollment in relay config, evaluator, retirement) | Superseded: a reporter is an enrolled device, a report is an advert, agreement is `poolVerdict` | 23 |
| [#1688](https://github.com/Hobo-Labs/HoBo/pull/1688) `packages/ci/src/fleet-v2/`, `fleet_v2.proto`, the strict stores | Closed. Kept ideas: the start fence ([§6.9](#69-work-offers-claims-orders-and-receipts) step 6) and the pre-job hook template, both rebuilt in WP-15. Its Postgres controller store contradicts ADR-0179 and is not carried | 15 |

### 8.3 Connectivity, identity and the rest

| Existing | Fate | WP |
|---|---|---|
| `packages/connectivity/src/crypto/dpop.ts` | Deleted. `@hobo/mesh/keys` is the one DPoP implementation (ES256 and EdDSA). Importers (`packages/hobo/src/credential-presenter.ts`, `connectivity/src/env-isolation/elevated-capability.ts`) switch | 13, 17 |
| `packages/connectivity/src/crypto/jwt-svid.ts` (`mintJwtSvid`, `verifyJwtSvid`, its own `JwtSvidClaims`) | Deleted. `@hobo/identity` `JwtSvidIssuer` and `verifyJwtWithJwks` are the one SVID implementation | 13 |
| `packages/identity/src/issuer.ts` in-memory `KmsLike` only | Adds `createSecretStoreKms` over `SecretsPort`; the in-memory one remains for tests | 11 |
| `packages/identity/src/attestation.ts` `createFixtureHostAttestor` (HMAC), `LaunchMeasurement.hostId` | Adds `createDeviceHostAttestor`: the host signature is an envelope from the device's `SIGN` key and `hostId` is the `DeviceId`. The fixture stays for tests | 11 |
| `packages/core/src/ports/overlay.ts` `OverlayJoinOptions.authKey`, `OverlayIdentity.nodeId` | `authKey` stays on the port but is only ever an `OverlayJoin.credential` from the authority. `OverlayIdentity` gains optional `deviceId` | 12 |
| `packages/connectivity/src/overlay/tailscale.ts`, `netbird.ts`, their API clients | Kept as the overlay providers. New `createOverlayMeshTransport` wraps `OverlayNetwork` as a `MeshTransport`; new `createTailscaleCredentialMinter` and `createNetbirdCredentialMinter` implement `OverlayCredentialMinter`. The environment fallback `HOBO_TAILSCALE_AUTHKEY` is removed | 13 |
| `packages/connectivity/src/junction-agent.ts` | Rebuilt on `createMeshNode` with role `JUNCTION`: enrollment, heartbeat and health come from the node; overlay join, metering and dynamic DNS stay as its extensions. `JunctionAgentConfig.authKey` is removed | 13 |
| `packages/connectivity/src/env-isolation/membership.ts` `EnvMembership.nodeId` | Typed as `DeviceId`; `EnvMembershipService` takes a `RegistryView` and treats membership of a non-`ACTIVE` device as absent | 13 |
| `packages/connectivity/src/tenancy/isolation.ts`, `env-isolation/registry.ts` | Obtain overlays through the transport selector instead of constructing them | 13 |
| `packages/junctions/src/types.ts` `TrustAnchorExchange` | Carries a mesh `TrustRecord` per member Yard. Federation between Yards is an exchange of trust records; no second trust format | 19 |
| `packages/runtimes/runtime-celld/src/parse.ts` overlay enum (`tailscale`, `netbird`, `wireguard`) | Validated against the overlay provider list exported by `@hobo/mesh` so there is one list | 19 |
| `packages/hobo/src/bare-metal-host.ts` `INTERNAL_MESH_HOST`, `installInternalMesh`, `internalMeshBase`; `test/bare-metal-mesh.test.ts`; uses in `multi-host-serve.ts`, `yard-command.ts`, `wasm-host.ts`, `isolated-wasm-runtime.ts` | Renamed to `INTERNAL_ROUTER_HOST`, `installInternalRouter`, `internalRouterBase`, `bare-metal-router.test.ts`. Behaviour unchanged. This removes the last other use of the word | 17 |
| `packages/core/src/ports/metering.ts` `UsageEventType` | Gains the four mesh types of [§6.13](#613-audit-metering-and-observability) | 12 |
| `packages/cli/src/shell/verbs.ts` `CANONICAL_VERBS` | Gains `mesh` (role `compute`) | 17 |
| `@hobo/backend-fleet`, `packages/data-postgres/src/fleet/`, `packages/ci-vercel/src/cache-fleet.ts` | Unchanged in code. They choose one active storage backend from a configured list; their members are not devices and are not enrolled. The glossary records "fleet" as their word ([§4](#4-terms)), and the vocabulary guard keeps device concepts out of them | 22, 23 |
| `packages/ci/src/fleet/balance.ts`, `models.ts`, `offers.ts`, `pricing.ts`; `packages/ci/src/fleet-overflow.ts` | Unchanged in purpose (choosing a runner provider by role and budget). `FleetMemberState.healthy` and `activeJobs` for the `hobo` member, and `FleetMember.freeSlots`, are read from `PoolCapacity` | 14 |
| ADR-0122 ("Overlay mesh is a `mesh` port") | Amended: the port is named `overlay`, as it already is in `packages/core/src/ports/overlay.ts`. "Mesh" means [§4](#4-terms) | 23 |

## 9. Failure scenarios

| # | Failure | What happens | Bound |
|---|---|---|---|
| F1 | Authority down | Running work continues. Nodes keep their NATS connection until its 10-minute credential expires, then run standalone: a dispatcher-executor keeps taking the work it can see itself; a plain executor idles. No enrollment or refresh | Service level: 99.9%. Recovery under 60 s in the high-availability profile |
| F2 | Every callout responder down | Existing connections continue; new connections fail. Same as F1 after 10 minutes | Two or more responders in one queue group |
| F3 | One NATS server lost (cluster of three) | Clients reconnect to another. Streams stay available at replicas 3 | No loss |
| F4 | NATS quorum lost or all servers down | Claims and offers stop. A dispatcher-executor runs standalone as today; duplicate starts are bounded by GitHub's single assignment and the start fence. Events queue on disk in the node and are published on reconnect | Duplicate start-up work only |
| F5 | Registry bucket lost | Rebuilt by replaying `MESH_JOURNAL` | Minutes; no data lost |
| F6 | Event store lost | Restore from backup; incarnation increments; every device refreshes | Recovery point of the last backup in the standalone profile; zero in the high-availability profile |
| F7 | Device key copied | First use of the copy, or the next use of the original, mismatches the generation; the device is `LOCKED` and alarms | One credential lifetime (15 minutes) at most |
| F8 | Bootstrap token leaked before use | Whoever uses it first is `PENDING` or `ACTIVE` under the invited name; the real device gets `token-used` and the person sees an unfamiliar fingerprint | Token lifetime; revoke the device |
| F9 | Enrolled device turns hostile | It can lie in its adverts (it loses reliability), publish to its own event subjects (signed, attributable), and try a forged or out-of-pool claim (deleted, device suspended). It cannot read others' orders, write the registry or open an ungranted session | One delayed offer |
| F10 | Dispatcher compromised | It can offer and order only kinds, repositories and trust classes that pool policy allows, to devices that check policy themselves; it holds upstream credentials, which are rotated; revoke its device | Revocation under 5 s for orders |
| F11 | NATS administrator hostile | Can delay, drop or replay within expiry. Cannot forge a registry record, order, grant or advert | Availability only |
| F12 | Authority record-signing key leaked | Rotate through `ops rotate-signing-key`; the new `TrustRecord` is signed by the old key and by the witness; incarnation increments; audit shows every record the leaked key signed after the last witnessed checkpoint | Until rotation |
| F13 | Witness down | Checkpoints are signed by the authority but not final; an alarm fires after three unwitnessed checkpoints; nothing else stops | Operator action |
| F14 | Peer-to-peer relays down | Transport falls to overlay, then to `nats-relay` | Slower sessions |
| F15 | A sandbox driver fails its self-test | The node does not advertise that tier; work needing it goes elsewhere | — |
| F16 | Clock skew on a device | Adverts more than six minutes ahead are rejected; DPoP proofs outside ±60 s are rejected; the node logs its measured skew against the authority's `Date` header | Device unusable until fixed |
| F17 | Verdict endpoint unreachable from the route job | Routing reads GitHub's queue exactly as today | No change |
| F18 | A node below `min_agent_version` | Not ranked; told `UPDATE_REQUIRED`; refresh refused with `agent-outdated` after a grace period the pool sets | — |
| F19 | Restore from an old backup | Incarnation increments, so every ticket and SVID from before is refused; devices enrolled after the backup must enroll again | By design |
| F20 | Two authority replicas decide concurrently | Compare-and-set on the stream; the loser retries on fresh state | Up to 8 retries, then `conflict` |

## 10. Measurable outcomes

The work is done when every row is demonstrated by the named check. All checks are in the repository after this plan.

| # | Outcome | Check |
|---|---|---|
| O1 | One implementation of each idea | `pnpm run mesh:vocabulary` (WP-22) passes. It checks: no `@nats-io/*` or `@number0/iroh` import outside `packages/mesh-nats` and `packages/mesh-iroh`; no function named `verifyDpopProof`, `mintDpopProof`, `jwkThumbprint`, `signEnvelope`, `verifyEnvelope`, `rankDevices`, `rankNodes` or `claimTurn` defined outside `packages/mesh`; no `.proto` outside `packages/mesh/data-models` declaring a message named `Advert`, `DeviceRecord`, `PoolRecord`, `WorkOffer`, `WorkOrder`, `Claim` or `SessionGrant`; no identifier containing `InternalMesh` or `INTERNAL_MESH`; none of the removed environment variable names of [§6.14](#614-surfaces) anywhere outside this plan and the superseded design doc; none of the deleted paths of [§8](#8-consolidation-ledger) exists |
| O2 | A developer enrolls and runs their own job | Feature `features/mesh/enroll-and-run.feature`: token flow and browser flow each go from nothing to a `SUCCEEDED` receipt on the in-memory bus with a fake sandbox; the same scenario runs against a real `nats-server` in the integration lane |
| O3 | Per-device isolation on the bus | Permission probe suite (WP-07): for each role, every subject outside its template is refused, including another device's advert key, another device's orders, `mesh-registry` writes and all of `$JS.API.STREAM.{UPDATE,DELETE,PURGE}` |
| O4 | Claims are first-writer-wins at the server | Integration test: 8 connections race 500 claims; each has exactly one holder; a second publish, a delete and a purge from an executor are all refused |
| O5 | Revocation meets its service level | Integration test: after `revoke`, the device's next advert is not ranked and an order to it is not issued within 5 s; its publishes are refused within 10 min with no disconnect |
| O6 | Clone detection | Unit and integration: two nodes with one key directory; the second refresh locks the device and both are refused |
| O7 | The bus is not trusted | Property tests: any single-bit change to any envelope, or any record re-signed with a non-listed key, is rejected by every verifier; a replayed advert is dead at its expiry |
| O8 | Sandbox rules hold | `runSandboxConformance` for each driver present: no host Docker socket, no host mounts beyond those declared, capabilities empty, metadata address unreachable, non-allowlisted host unreachable, pids limit enforced, sandbox gone after the order. Policy table tests cover every cell of [§6.10](#610-sandbox-tiers) |
| O9 | The event store adapter is correct | `runEventStoreConformance` passes for `createJetStreamEventStore` (every assertion that does not need a fence token) |
| O10 | Transport works and is authorised | `runTransportConformance` for `iroh`, `overlay` (against a fake `OverlayNetwork`) and `nats-relay`: a granted session carries 64 MiB with correct digest; an ungranted, expired or wrong-peer dial is refused before any byte is delivered |
| O11 | Audit is tamper-evident | Test: altering, removing or reordering any entry fails `verifyAuditChain`; a checkpoint without a valid witness signature is reported as not final |
| O12 | HoBo runs on it | After cutover: the box worker, every relay host and every developer runner appear in `hobo mesh status` as `ACTIVE` devices; the route job's log shows a verdict read; no workflow references a removed variable |
| O13 | Repository gates | `pnpm run check:all` and `pnpm run verify:full` pass; `pnpm run lint:boundaries`, `lint:test-deps`, `codegen:check` pass for every new package; coverage for each new package is at or above the global floor (87/79/89/88) |
| O14 | Service levels are observable | The acceptance harness (WP-24) reports every row of the service-level table in [§6.13](#613-audit-metering-and-observability) from a 10-minute soak on the high-availability Compose profile |

## 11. Delivery

### 11.1 Preconditions

These are facts about the base branch, not phases. The coordinator confirms each before the seed commit.

| # | Precondition | If it is not true |
|---|---|---|
| B1 | The delivery stack ([#1940](https://github.com/Hobo-Labs/HoBo/pull/1940), [#1945](https://github.com/Hobo-Labs/HoBo/pull/1945) to [#1951](https://github.com/Hobo-Labs/HoBo/pull/1951)) is merged, so `packages/cd` and `@hobo/storage-postgres` exist on the base | Branch this work from `claude/loving-allen-jry6qe-cd-7-docs` and merge after it |
| B2 | [#1943](https://github.com/Hobo-Labs/HoBo/pull/1943) is merged (it removes the dead capacity reader) | WP-20 removes it |
| B3 | [#1688](https://github.com/Hobo-Labs/HoBo/pull/1688) is closed with a pointer to this plan | Close it |
| B4 | [#1952](https://github.com/Hobo-Labs/HoBo/pull/1952) is either merged or closed; the ADR-0180 number collision with [#1951](https://github.com/Hobo-Labs/HoBo/pull/1951) is settled | Close it. This plan takes ADR-0182 and leaves 0180 and 0181 to those two |
| B5 | Open pull requests that edit `scripts/isolated-worker-daemon-main.mts`, `container-controller.ts` or `hosted-relay.ts` ([#1794](https://github.com/Hobo-Labs/HoBo/pull/1794), [#1795](https://github.com/Hobo-Labs/HoBo/pull/1795), [#1797](https://github.com/Hobo-Labs/HoBo/pull/1797), [#1814](https://github.com/Hobo-Labs/HoBo/pull/1814), [#1819](https://github.com/Hobo-Labs/HoBo/pull/1819), [#1930](https://github.com/Hobo-Labs/HoBo/pull/1930), [#1931](https://github.com/Hobo-Labs/HoBo/pull/1931), [#1935](https://github.com/Hobo-Labs/HoBo/pull/1935)) are merged or closed | WP-15 rebases over whatever remains; expect conflicts in those three files |
| B6 | The answers in [§12](#12-owner-inputs) are recorded | Defaults in that table apply |
| B7 | The assumption tests in [§13](#13-assumptions-to-check-first) have been run by WP-07, WP-09 and WP-10 before those packages build on them | Each row names its fallback |

### 11.2 The seed commit

One commit by the coordinator, mechanical, taken verbatim from [§7](#7-frozen-contracts). It contains no logic. After it, every package compiles and every work package can start.

1. Scaffold `packages/mesh`, `packages/mesh-nats`, `packages/mesh-iroh`, `packages/mesh-node`, `packages/mesh-authority` from the `packages/backend-fleet` template: `package.json` (name, `"version": "0.0.1"`, `"license": "MIT"`, `"type": "module"`, `files`, `publishConfig`, the six standard scripts, subpath exports from [§7.3](#73-ports)), `tsconfig.json`, `LICENSE`, `README.md` with the "Gates" and "Architecture placement" sections (the README must state the parse-don't-validate rule and name commands, events, actors, the event store, projections, snapshots and the read store, to satisfy `scripts/check-architecture-guardrails.mjs:113-119,314-324`), `src/`, `test/`, `contracts/README.md` with one placeholder pact per package, `data-models/`.
2. `packages/mesh/data-models/`: `buf.yaml`, `mesh.proto` ([§7.1](#71-records)), `mesh.cue` ([§7.2](#72-constraints)), fixtures, `README.md`. Run `pnpm codegen --filter packages/mesh`; commit `src/_generated/mesh_pb.ts`. The other four packages each get a minimal `data-models/` with a local config record (`<pkg>_config.proto` and `.cue`) so the guard passes.
3. `packages/mesh/src/ports.ts` ([§7.3](#73-ports)), `src/errors.ts` ([§7.6](#76-errors)), `src/contexts.ts` ([§7.4](#74-signed-envelope)), `src/events.ts` ([§7.5](#75-event-families)), `src/ids.ts` (brands and `parse*`), and one file per subpath that exports the final function names with bodies that throw `MeshNotImplemented`. Every exported signature is final. Two pieces of plumbing are implemented in the seed because every package tests against them and they contain no decisions: `createMemoryBus` (maps with an injected clock; the claim ledger refuses a second writer; adverts and claims expire) and `createFakeSandboxDriver` (records what it was asked to run).
4. `packages/conformance/src/boundaries.ts`: add `packages/mesh` to `CONTRACT_PACKAGE_PATHS` and `KNOWN_PACKAGE_PATHS`; add the other four to `KNOWN_PACKAGE_PATHS`.
5. Provision `nats-server` 2.15.3 for the integration lane: through `mise.toml` if its registry carries the tool, otherwise a pinned, checksum-verified download step in that lane.
6. `cucumber.yaml`: add `features/mesh/*.feature`; create the feature files with scenario titles only (WP-24 fills the steps).
7. `docs/design/event-families.md`: add the `mesh.*` row. `docs/design/adr/index.md`: add the ADR-0182 row. `docs/design/glossary.md`: add the terms of [§4](#4-terms). `docs/design/index.md` and `docs/plans/index.md`: add rows.
8. `packages/core/src/ports/metering.ts`: add the four usage types (so consumers compile).
9. `pnpm install`; commit the lockfile.

The seed commit passes `pnpm run check:all`.

### 11.3 Rules for every implementer

1. Work in your own git worktree on your own branch. Touch only the paths your work package lists under "Owns". If you need a change anywhere else, put it in `.sdlc/report.json` under `cascadeDeltas` and carry on against the frozen contract.
2. Shared files are edited only by the coordinator: root `package.json`, the lockfile, `turbo.json`, `mise.toml`, `cucumber.yaml`, `konsistent.json`, `packages/conformance/src/boundaries.ts`, `.github/**`, `docs/**` indexes and the glossary, root `AGENTS.md` and `CLAUDE.md`, and every `src/_generated/**`. Work packages 20 and 23 are the coordinator's.
3. Several work packages share `packages/mesh`. Each owns a directory under `src/` and the matching directory under `test/`. Nobody but the coordinator edits `packages/mesh/package.json`, `src/ports.ts`, `src/errors.ts`, `src/contexts.ts`, `src/events.ts`, `src/ids.ts`, `data-models/` or `README.md`.
4. Test first: a failing unit test, a failing PACT test where a boundary is involved, then the code. Commit after each green step with a conventional, scoped message.
5. Before every commit: `pnpm agent:check -- --staged`. Before reporting done, also: `pnpm run lint:boundaries`, `pnpm run lint:test-deps`, `pnpm codegen:check --filter packages/<yours>`, `pnpm exec turbo run test --filter @hobo/<yours>`.
6. Types come from `src/_generated/`. A hand-written type that mirrors a record needs `// domain-view: <why>`. Every `as` except `as const` needs `// SAFETY: <why>`. Every exported string literal needs `// public-contract: <why>`. No `any`, no `unknown` parameters or returns, no module mocking, no `typeof` at runtime (`oxlint.config.ts:47-63`).
7. Tests that need a binary (`nats-server`, a container runtime, the peer-to-peer relay) are named `*.integration.test.ts`. When the binary is absent they fail if `CI` is set and skip otherwise.
8. Never log, store in an event, or pass on a command line: a private key, a seed, a bootstrap token, a session ticket, an SVID, a sealed order's secret, or an overlay credential.
9. Hand back `.sdlc/report.json` with `issue`, `branch`, `gates`, `cascadeDeltas` and `requirementChanges`, and mirror it in the pull request body.

Definition of done for every work package: its acceptance commands pass; the gates in rule 5 pass; coverage for the owned paths meets the global floor; the paths it was told to delete are gone; its README section is written; no file outside "Owns" is changed.

### 11.4 Work packages

All start after the seed commit and run concurrently. "Needs at run time" lists what a package calls through a frozen port. It builds and tests against the in-memory bus and fake sandbox from the seed. For any other port whose implementation has not merged yet, write a small test double against the frozen interface in your own `test/` directory and replace it with the real one when the lines of [§11.5](#115-merge-order) bring it in.

Each body below is a one-shot issue body in the house format: **Why** is the ledger rows and problems it names; **Context** is the sections it cites; **Scope in** is "Owns" and scope out is everything else; **Steps** is "Build"; **Acceptance** is "Accept"; **Guardrails** and **Definition of done** are [§11.3](#113-rules-for-every-implementer).

#### WP-01: keys and envelopes

- **Owns:** `packages/mesh/src/keys/`, `packages/mesh/test/keys/`.
- **Build:** JWK parsing (EC P-256, OKP Ed25519; never private material), RFC 7638 thumbprints, `deviceIdFromJwk`, the envelope of [§7.4](#74-signed-envelope) for ES256 (P1363 encoding) and EdDSA, key bundles, DPoP proofs (RFC 9449: `htm`, `htu`, `iat` within ±60 s, `jti`, `ath`) for both algorithms with a `ReplayStore`, `seal` and `openSealed` (X25519, HKDF-SHA-256 with the context as `info`, ChaCha20-Poly1305), `sessionKeys` (two directional keys from an X25519 agreement and the session id), `fingerprintWords` (four words from the BIP-39 English list of 2,048 words, vendored as a data file: the first 44 bits of the thumbprint), and the in-memory `KeyStore`. Port the delivery stack's `jose.ts`, `dpop.ts`, `dpop-verifier.ts` and `replay.ts` rather than rewriting them.
- **Accept:** `pnpm exec vitest run packages/mesh/test/keys`; property tests with fast-check for O7 (any bit flip rejected; wrong context rejected; wrong key rejected; an envelope for one context never verifies as another); RFC 9449 and RFC 7638 published test vectors pass.

#### WP-02: enrollment authority

- **Owns:** `packages/mesh/src/enrollment/`, `packages/mesh/test/enrollment/`, `packages/mesh/contracts/` (the authority HTTP pact, written here as the consumer side: `mesh-authority.pact.json`).
- **Build:** `createEnrollmentAuthority` on the core `EventStore` port, exactly [§6.5](#65-enrollment) and [§7.5](#75-event-families): tokens (hash only; compare-and-set single use; idempotent retry by the same key), the three proof kinds, pool-policy checks (roles, classes, quota, tier, OIDC rules, certificate chain through `IdentityAssertionVerifier`), approval modes, `credentials` with the generation counter and `LOCKED` on mismatch, key and identity rotation, suspend, resume, unlock, revoke, `definePool`, `grantSession`, `verifyRequest` (SVID plus DPoP), `projectRegistry` (signs and publishes device and pool records), incarnation handling. Every governed action goes through `PolicyEngine` and appends the event the injected `PolicyDecisionRecorder` builds. Start from the delivery stack's `enrollment.ts`.
- **Accept:** `pnpm exec vitest run packages/mesh/test/enrollment`; a table test with one case per transition and per refusal code of [§7.6](#76-errors); replay equals live state for every stream; two authority instances on one store interleaved at random never disagree (property test); O6.

#### WP-03: membership

- **Owns:** `packages/mesh/src/membership/`, `packages/mesh/test/membership/`, `packages/mesh/src/verdict-wire.ts`.
- **Build:** move `rendezvous.ts`, `reliability.ts`, `monitor.ts`, `report.ts` from `packages/ci/src/mesh/` with the four changes of [§6.8](#68-membership-capacity-and-reliability); `buildAdvert`, `verifyAdvert` (envelope, bundle expiry, device `ACTIVE`, pool listed, expiry bound, agent version); `poolView` (at most 256 devices, live before lost, lost devices kept one hour); `poolVerdict`; `verdict-wire.ts` with no imports. Move and adapt the existing property tests (`mesh-rendezvous`, `mesh-reliability`, `mesh-monitor`, `mesh-report`); do not delete the originals (WP-14 does).
- **Accept:** `pnpm exec vitest run packages/mesh/test/membership`; every numeric property in `docs/design/ci-relay-mesh.md` "What the tests establish" still holds over 6,000 work digests; `node --experimental-strip-types packages/mesh/src/verdict-wire.ts` loads with no dependency installed.

#### WP-04: work

- **Owns:** `packages/mesh/src/work/`, `packages/mesh/test/work/`.
- **Build:** `createDispatcher` (poll sources on a 10-second beat, rank among dispatchers, offer, read claims, verify, reject and report invalid ones, `prepare`, seal, sign, deliver, fold receipts into reliability and usage events, `stillWanted` before ordering); `createExecutor` (subscribe to offers, fit, take a turn, claim, wait for the order up to 30 s, verify it, `checkOrderAgainstPolicy`, `resolveSandboxTier` per [§6.10](#610-sandbox-tiers), create the sandbox, run, receipts, destroy, drop accounting from the old `mesh-worker.ts`); standalone behaviour when the bus is down ([§3.3](#33-rules-that-bind-every-work-package) rule 2); `trustClassOf`; the `oci-command` source and runner.
- **Accept:** `pnpm exec vitest run packages/mesh/test/work`; on the in-memory bus: 400 offers across three executors with 1, 2 and 5 slots are each run once, in that proportion; the largest executor dying costs one step; a forged claim is rejected and reported; every cell of the tier table has a test (O8, policy half); an order whose repository, ref or kind is outside policy is refused with `order-invalid`.

#### WP-05: audit and metering

- **Owns:** `packages/mesh/src/audit/`, `packages/mesh/test/audit/`.
- **Build:** `createAuditChain` (subscribes to the event store, appends entries, checkpoints every 60 s or 1,000 entries, requests the witness, exports checkpoints as CloudEvents through an injected emitter); `verifyAuditChain`; `createLocalWitness` (a second `Signer` that refuses a checkpoint that does not extend the last one it signed); usage-event builders for the four mesh types.
- **Accept:** `pnpm exec vitest run packages/mesh/test/audit`; O11.

#### WP-06: transport core, node core, client and test kit

- **Owns:** `packages/mesh/src/transport/`, `src/node/`, `src/client/`, `src/testing/`, `packages/mesh/examples/`, and the matching `test/` directories.
- **Build:** `createSessionAuthoriser` ([§6.11](#611-transport) rules); `frameStream` (length-prefixed AEAD frames with a counter nonce; used by `nats-relay` and available to any adapter that lacks its own encryption); `createTransportSelector` (try in order, report `hobo_mesh_transport_selected`); `serveShell`, `serveForward`, `serveBlob`, `fetchBlob`; `createMeshNode` (enroll through the client, refresh loop, bundle renewal, bus connect with ticket callback, advert beat every 10 s, control handling, drain, clock-skew measurement, composes dispatcher and executor by role); `createMeshClient` (one method per route; DPoP on every device call); the rest of the test kit (`createMemoryEventStore`, `createFakeAuthority`; the seed already has the bus and the fake sandbox); the four conformance suites; `examples/demo.ts`.
- **Accept:** `pnpm exec vitest run packages/mesh/test/{transport,node,client,testing}`; the in-memory bus and the fake sandbox pass their own conformance suites; `createMemoryEventStore` passes the applicable assertions of `runEventStoreConformance`, checked from `packages/mesh-nats/test/` (which depends on that suite already); `examples/demo.ts` runs three nodes and prints one receipt per offer.

#### WP-07: `@hobo/mesh-nats`

- **Owns:** `packages/mesh-nats/**`.
- **First:** run assumption tests A1 to A6 ([§13](#13-assumptions-to-check-first)) against the pinned server and record the results in `packages/mesh-nats/README.md`.
- **Build:** `provisionTopology` (accounts, scoped signing keys with the templates of [§6.7](#67-nats-topology), streams and buckets with the exact limits; idempotent; used by `hobo mesh ops provision`); operator, account and user JWT minting on `@nats-io/jwt` with a 30-line NKey codec where the library lacks one; `createCalloutResponder` (the six checks of the connect sequence, encrypted with the account `xkey`, queue-grouped, no write path); `createNatsBusConnector` implementing `MeshBusConnector` (TLS required, `inboxPrefix`, authenticator from `DeviceKeys` and the ticket callback, reconnect with a fresh ticket); the seven bus ports; `createJetStreamEventStore` (one message per append holding the batch; `Nats-Expected-Last-Subject-Sequence` for `expectedSeq`; `meta.idempotencyKey` deduplicated by reading the stream; `read`, `subscribe`, `snapshot`); `createNatsRelayTransport`; `createNatsRegistryPublisher`; a `ReplayStore` on a TTL bucket.
- **Accept:** `pnpm exec turbo run test --filter @hobo/mesh-nats` with `nats-server` present; `runBusConformance`, `runEventStoreConformance` (O9), `runTransportConformance` for `nats-relay`; O3, O4, O5; the callout refuses each of: bad server signature, expired ticket, ticket for another key, bad nonce signature, device not `ACTIVE`, wrong tenant.

#### WP-08: `@hobo/mesh-authority`

- **Owns:** `packages/mesh-authority/**`.
- **Build:** the HTTP service of [§6.14](#614-surfaces) over `createEnrollmentAuthority` (routes, protobuf JSON, error mapping, request size and time bounds, no redirects); the browser flow (authorization code with PKCE, loopback redirect only, state bound to the device fingerprint) and the device-code flow with its restrictions; sign-in providers `oidc` (generic OpenID Connect discovery), `github` (reusing the relay's OAuth session code path) and `atproto` (off unless configured); `IdentityAssertionVerifier` (OIDC with cached JWKS and issuer pinning; X.509 chain validation with `node:crypto`); `SvidIssuer` over `@hobo/identity` `JwtSvidIssuer` with `createSecretStoreKms`; verdict access by GitHub Actions OIDC token (reuse `createGithubOidcVerifier`); composition for both profiles from one config record; readiness that is false until the registry projection has caught up; `hobo-mesh-authority` binary; the witness process binary; the `PolicyDecisionRecorder` over `@hobo/policy`.
- **Needs at run time:** WP-02, WP-05, WP-07, WP-11.
- **Accept:** `pnpm exec turbo run test --filter @hobo/mesh-authority`; provider-side PACT verification of `mesh-authority.pact.json`; a test per route for each auth mode and each refusal; device-code flow refused for a `DUAL` pool; the service starts against the in-memory bus and event store with no network.

#### WP-09: `@hobo/mesh-node`

- **Owns:** `packages/mesh-node/**`.
- **First:** run assumption tests A9 to A11.
- **Build:** the `file` and `external-signer` key stores (`runKeyStoreConformance`); sandbox drivers `S1` (rootless OCI with the flags of [§6.10](#610-sandbox-tiers)), `S2` (the same with the gVisor runtime), `S3` on Linux (a Kata runtime class) and `S3` on macOS (Apple `container`), each with the self-test; the egress proxy (CONNECT proxy with an exact-host allowlist, link-local and metadata addresses always refused, per-order instance); `CapacitySource` from the host (slots from configuration; memory, disk, load as the box worker measures them today); the update check (verify provenance, then replace); service installers for systemd, launchd and Windows services; `hobo-meshd` binary; local state under `HOBO_MESH_HOME`.
- **Needs at run time:** WP-06, WP-07, WP-10.
- **Accept:** `pnpm exec turbo run test --filter @hobo/mesh-node`; O8 (driver half) for every driver whose runtime is present; the key directory rules (refuse group-writable directory; tighten a readable key; never inside a git checkout); a job in `S1` on a `PERSONAL` device cannot reach the host Docker API.

#### WP-10: `@hobo/mesh-iroh`

- **Owns:** `packages/mesh-iroh/**`.
- **First:** run assumption tests A7 and A8.
- **Build:** `createIrohTransport` implementing `MeshTransport`: an endpoint that uses only the configured relay URLs, one ALPN `hobo/mesh/1`, the grant sent as the first frame, `authorise` called with the peer's endpoint id before any payload is delivered, bidirectional streams mapped to `MeshStream`; the relay deployment files handed to WP-21 as `cascadeDeltas`.
- **Accept:** `pnpm exec turbo run test --filter @hobo/mesh-iroh`; `runTransportConformance` (O10) between two endpoints on one host with a local relay; a platform without a prebuilt binding reports itself unavailable and the selector moves on.

#### WP-11: `@hobo/identity`

- **Owns:** `packages/identity/**`.
- **Build:** `createSecretStoreKms(secrets: SecretsPort, { prefix })` implementing `KmsLike` (generate once, store, load on every replica, rotate by version); `createDeviceHostAttestor(signer)` and verification of an envelope host signature in `verifyWorkloadAttestation`; export what `@hobo/mesh-authority` needs.
- **Accept:** `pnpm exec turbo run test --filter @hobo/identity`; two `JwtSvidIssuer` instances over one secret store verify each other's tokens; rotation keeps the previous key in the JWKS until its tokens expire.

#### WP-12: `@hobo/core`

- **Owns:** `packages/core/src/ports/overlay.ts`, `packages/core/src/ports/metering.ts` and their tests.
- **Build:** `OverlayIdentity.deviceId?`; documentation on `authKey`; confirm the seed's usage types and add their `createUsageEvent` cases.
- **Accept:** `pnpm exec turbo run test --filter @hobo/core`; the core mutation gate still passes.

#### WP-13: `@hobo/connectivity`

- **Owns:** `packages/connectivity/**`.
- **Build:** every row of [§8.3](#83-connectivity-identity-and-the-rest) marked 13: delete `crypto/dpop.ts` and `crypto/jwt-svid.ts` and switch internal users; `createOverlayMeshTransport`; the two credential minters over the existing API clients (Tailscale: an auth key or federated token scoped to the device's tags, single use, short expiry; NetBird: a one-off setup key); the junction agent on `createMeshNode`; `EnvMembership.nodeId` as `DeviceId` with the registry check; remove `HOBO_TAILSCALE_AUTHKEY`.
- **Accept:** `pnpm exec turbo run test --filter @hobo/connectivity`; `runTransportConformance` for `overlay` against a fake `OverlayNetwork`; existing PACT tests still pass; a membership for a suspended device is ineffective.

#### WP-14: `@hobo/ci`

- **Owns:** `packages/ci/**`.
- **Build:** delete `src/mesh/`, the `./mesh` export, `src/fleet/capacity.ts`, `capacity-input.ts`, `route-table.ts`, their tests and fixtures; add `fleetMemberFromPool(capacity: PoolCapacity)` so `balance.ts` and `fleet-overflow.ts` read the `hobo` member's health and free slots from a pool; add `@hobo/mesh` as a dependency.
- **Accept:** `pnpm exec turbo run test --filter @hobo/ci`; `git grep -n "ci/mesh\|FLEET_CAPACITY_VARIABLE\|FLEET_ROUTES_VARIABLE" -- packages scripts` returns nothing.

#### WP-15: `@hobo/ci-gh-actions`

- **Owns:** `packages/ci-gh-actions/**`.
- **Build:** every row of [§8](#8-consolidation-ledger) marked 15. The `github-actions-job` work kind: `WorkSource` over the existing poller and job sizing, with `prepare` minting the just-in-time runner config and returning it as the secret; `WorkRunner` that writes the config with `Sandbox.writeSecret`, starts the runner, and implements `confirmAssignment`; the pre-job hook template that calls the node. The box worker daemon composed from `createMeshNode` with its admission as the `CapacitySource`. Container launch flags per [§6.10](#610-sandbox-tiers), with the host Docker socket only under `allow_host_docker`. Relay HTTP, MCP and client surfaces re-implemented on `@hobo/mesh/client`. `cloud-events.ts` mapping to `mesh.*`. `runner-fleet-delivery.ts` on `PoolDeviceView`.
- **Needs at run time:** WP-04, WP-06, WP-07, WP-09.
- **Accept:** `pnpm exec turbo run test --filter @hobo/ci-gh-actions`; the deleted paths are gone; no `@nats-io` in its manifest; the existing worker tests that do not concern the mesh pass unchanged; a new test drives one GitHub job from offer to `SUCCEEDED` receipt on the in-memory bus with a fake GitHub transport; the start fence refuses a mismatched assignment.

#### WP-16: `@hobo/ci-vercel`

- **Owns:** `packages/ci-vercel/**`.
- **Build:** the hosted relay reads pool views and verdicts through `@hobo/mesh/client` (authority origin from the config service); delete `fleet-verdict-cache.ts` if present; documentation.
- **Accept:** `pnpm exec turbo run test --filter @hobo/ci-vercel`; with no authority configured the relay answers `mesh: "not-configured"` as it does today.

#### WP-17: `@hobo/hobo` and `@hobo/cli`

- **Owns:** `packages/hobo/**`, `packages/cli/src/shell/verbs.ts` and its tests.
- **Build:** the `mesh` verb and every command of [§6.14](#614-surfaces) in `packages/hobo/src/mesh-command.ts` (strict `parseArgs`, a subcommand allowlist, tokens read from a file or standard input only); `hobo ci status` delegating to `hobo mesh status`; the internal-router rename; the switch of `credential-presenter.ts` to `@hobo/mesh/keys`.
- **Accept:** `pnpm exec turbo run test --filter @hobo/hobo --filter @hobo/cli`; `hobo mesh enroll --token <value>` is rejected with a message that names `--token-file`; `git grep -n "InternalMesh\|INTERNAL_MESH\|internalMesh" -- packages` returns nothing.

#### WP-18: `@hobo/cd`

- **Owns:** `packages/cd/**`.
- **Build:** `createAgentEnrollment` as an adapter over `createEnrollmentAuthority` per [§8.2](#82-in-flight-branches); delete `src/agent/dpop.ts`, `dpop-verifier.ts`, `jose.ts`, `replay.ts` and the engine in `enrollment.ts`; keep the egress guard and HTTP transport.
- **Accept:** `pnpm exec turbo run test --filter @hobo/cd`; the existing agent tests pass against the adapter; no DPoP or JWK code remains in the package.

#### WP-19: `@hobo/junctions` and `runtime-celld`

- **Owns:** `packages/junctions/**`, `packages/runtimes/runtime-celld/**`.
- **Build:** the two rows of [§8.3](#83-connectivity-identity-and-the-rest) marked 19.
- **Accept:** `pnpm exec turbo run test --filter @hobo/junctions --filter @hobo/runtime-celld`.

#### WP-20: scripts and workflows (coordinator)

- **Owns:** `scripts/ci/**`, `scripts/lib/ci-runner-contract.mts`, `scripts/test/route-runner*.test.ts`, `scripts/lint-actions.ts`, `.github/actions/route-runner/**`, `.github/workflows/**`.
- **Build:** the route job requests a GitHub Actions OIDC token, fetches the verdict for the run's pool and label, and treats `NO_NODE` or `NO_CAPACITY` as that backend refusing jobs; anything else changes nothing. Shard planning reads `free_slots` from the same response. Delete `load-fleet-capacity.mts`. Remove the retired variables from every workflow and from `scripts/lint-actions.ts`. Add an integration lane that installs `nats-server` and runs every `*.integration.test.ts`.
- **Accept:** `pnpm exec vitest run scripts/test/route-runner.test.ts`; the script still runs with nothing installed; `git grep -n "HOBO_CI_FLEET_\|HOBO_CI_LOCAL_RUNNER\|HOBO_CI_NATS_\|HOBO_CI_MESH_"` returns nothing outside this plan and the superseded design doc.

#### WP-21: deployment

- **Owns:** `deploy/mesh/**`, `deploy/release-images/hobo-mesh-authority/`, `deploy/release-images/hobo-meshd/`.
- **Build:** every asset of [§6.15](#615-deployment-availability-and-operations): `nats/standalone.conf` and `nats/cluster.conf` templates (operator mode, full resolver, TLS on every listener, client and WebSocket listeners only, monitoring on localhost, JetStream limits); `compose.standalone.yml` and `compose.ha.yml` (three NATS servers, two authorities, dispatcher with witness, two relays); Kubernetes manifests (StatefulSet for NATS, Deployment for the authority with two replicas and a disruption budget, non-root, read-only root, all capabilities dropped, `no-new-privileges`); `hobo-meshd.service`, a launchd property list and a Windows service definition; the provisioning job; release-image Dockerfiles in the style of `deploy/release-images/hobo-ci-serve/`.
- **Accept:** `docker compose -f deploy/mesh/compose.ha.yml config` validates; `shellcheck` passes on every script; the acceptance harness of WP-24 brings the high-availability profile up from these files alone.

#### WP-22: guards

- **Owns:** `scripts/check-mesh-vocabulary.mts`, `scripts/test/check-mesh-vocabulary.test.ts`, the `mesh:vocabulary` script entry (applied by the coordinator), `packages/conformance/src/suites/` additions if any.
- **Build:** the checks of O1, with a `--root` option and tests that show each check refusing a tree that breaks it (the pattern of `scripts/check-package-boundaries.mts`). Wire it into `check:all`.
- **Accept:** `pnpm run mesh:vocabulary` passes on the finished tree and fails on each fixture tree.

#### WP-23: documents (coordinator)

- **Owns:** `docs/**`, `site/public/llms.txt`, `site/public/llms-full.txt`, package READMEs' cross-links.
- **Build:** `docs/design/mesh-compute-network.md` (type `Design`; this plan's §4 to §9 as the standing description); `docs/design/adr/mesh-compute-network.md` (ADR-0182: the decisions of §3, §6.1, §6.4, §6.7 and §14 with consequences); the ADR-0122 amendment; `docs/design/ci-relay-mesh.md` marked superseded; `docs/design/security-networking.md` and `docs/design/cli-spec.md` updated; `docs/design/package-namespaces.md` rows; the runbooks of [§6.15](#615-deployment-availability-and-operations) under `docs/maintenance/mesh/`; a quick start (`docs/design/mesh-quick-start.md`); plan 0025 annotated as superseded for layers 02 to 06; `docs:okf` regenerated.
- **Accept:** `pnpm run lint:docs`; `pnpm run docs:freshness`; every `ADR-NNNN` mentioned is in the index; every backticked `mesh.*` event is covered by the family row.

#### WP-24: behaviour and acceptance

- **Owns:** `features/mesh/**`, `features/steps/mesh/**`, `packages/mesh-authority/acceptance/**`.
- **Build:** cucumber features on the in-memory bus for: enroll by token; enroll by browser approval; enroll by workload identity; dual-control approval; clone lock and unlock; revoke; rotate; own, organisation and untrusted work against each device class; a forged claim; a session granted and refused; audit verification; standalone degradation with the bus down. The acceptance harness: bring up `compose.ha.yml`, enroll three nodes, run a 10-minute soak of `oci-command` work while killing one NATS server and one authority, and report the service-level table.
- **Accept:** `pnpm run test:behavior` passes; the harness writes `acceptance-report.json` with every objective of [§6.13](#613-audit-metering-and-observability) met (O2, O14).

### 11.5 Merge order

Work is concurrent; merging is topological. Each line merges after the lines above it are green on the integration branch. The branch is checked at line boundaries, not between the members of a line.

1. Seed commit.
2. WP-01, WP-03, WP-05, WP-11, WP-12, WP-22.
3. WP-02, WP-04, WP-06.
4. WP-07, WP-10, WP-19.
5. WP-08, WP-09, WP-18.
6. WP-13, WP-14, WP-15, WP-16, WP-17, merged as one unit: they delete code that the others in this line still import until their own changes land.
7. WP-20, WP-21, WP-23, WP-24.

The coordinator applies `cascadeDeltas` between lines, one at a time. The whole set lands on `main` as one stack; nothing is released from an intermediate line.

### 11.6 Cutover

One operation, done once, after the stack is on `main`. It is not staged because only one box and a handful of relay hosts and developer runners exist (R3).

1. Run the key ceremony. Store the keys in the secret store.
2. Deploy NATS, the authority, the dispatcher with witness, and the relays from `deploy/mesh/` in the chosen profile. `hobo mesh ops provision` for the tenant.
3. `hobo mesh pool apply` for each pool (at least: `hobo`, `hobo-trunk`, one per developer who runs their own jobs).
4. On the box: stop the worker after it drains; `hobo mesh enroll` with a token; start the new worker. On each relay host and developer machine: enroll.
5. Check O12. Run one workflow end to end.
6. Delete the retired repository variables and the old NATS buckets (`*-mesh-nodes`, `*-mesh-claims`, `*-mesh-config`).

**Going back.** Before step 6, redeploying the previous worker image restores the old behaviour, because the old worker needs only GitHub and its own files. After step 6 there is no path back short of reverting the stack; do step 6 only after a full day of normal runs.

## 12. Owner inputs

Decisions only the owner can make. Each has the default this plan assumes.

| # | Question | Default |
|---|---|---|
| I1 | Merge the delivery stack before this work (B1)? | Yes |
| I2 | Close #1688 and fold #1952 and plan 0025 into this plan (B3, B4)? | Yes |
| I3 | ADR number | 0182 |
| I4 | Where NATS and the authority run, and their DNS names | The CI box for the standalone profile; three small hosts in one region for high availability |
| I5 | Sign-in provider for people | `github` (the relay already has it); `oidc` for an organisation with single sign-on |
| I6 | Tenant mapping | One tenant per relay account; HoBo's own CI is tenant `hobo` |
| I7 | May the dedicated box keep the host Docker socket for trusted repositories (`allow_host_docker`)? | Yes, for pools `hobo` and `hobo-trunk` only, until those jobs run in `S3` |
| I8 | Who holds the offline operator key shares | Two named people |
| I9 | Who runs the witness | The dispatcher host, under a different service account from the authority |
| I10 | Windows devices | Supported as `S1`, own work only |
| I11 | AT Protocol sign-in | Built, off by default |
| I12 | Is KVM available on the box (needed for `S3` there)? | Unknown; if not, the box provides `S1` and `S2` and organisation work needs `org_min_sandbox` lowered for named repositories |
| I13 | ADR-0031 names a NATS host lattice that its upstream removed (E9). Reopen it? | Out of this plan; open a separate decision |

## 13. Assumptions to check first

Each is an external behaviour this design uses and could not fully verify from primary documentation. The named work package tests it before building on it and records the result in its README. A failed assumption does not stop the swarm: the fallback is already designed.

| # | Assumption | Test | If false |
|---|---|---|---|
| A1 | The pinned server expands `{{name()}}` in scoped-key templates for publish and subscribe | Provision a scoped key; connect two users; each can write only its own advert key | Mint per-device permissions directly in the callout's user JWT, signed by an unscoped account signing key kept only in the responder. The scoped-key damage cap is lost; record that in the ADR |
| A2 | The callout request carries the client's `nkey`, `sig` and `auth_token`, and the nonce the client signed | Inspect a live request | Have the node sign the ticket id with its `nats` key inside `auth_token` and verify that instead |
| A3 | A user JWT's expiry ends a live connection, or at least its permissions | Connect with a 60-second credential and keep publishing | Rely on the registry check (5 s) for trust and on the disconnect of A4; shorten nothing |
| A4 | The server offers a request that disconnects a named client | Find and call it | Skip the disconnect; the 10-minute bound stands |
| A5 | A stream with `discard_new_per_subject` refuses the second publish with a distinct error, and `deny_purge` plus missing `$JS.API` rights block every removal path including rollup headers | The O4 test | Put a claim service on the dispatcher that performs the create on the executor's signed request; executors lose direct publish on `mesh.claim.>` |
| A6 | `@nats-io/jwt` exposes scoped signers and authorization responses under the names in E8, and `@nats-io/kv` can open a bucket it did not create without stream-admin rights | Compile and run | Encode the JWTs by hand (the format is base64url JSON plus an Ed25519 signature); read KV through direct-get and a plain consumer |
| A7 | `@number0/iroh` lets a caller set relay URLs, disable default discovery, register one ALPN, and read the remote endpoint id of an accepted connection | A two-endpoint test | Ship without `iroh`; `overlay` and `nats-relay` remain. Record it in the ADR |
| A8 | The binding accepts a caller-supplied secret key | Same test | Let it generate its own; the bundle records the resulting endpoint id (already allowed by [§6.4](#64-device-identity-and-keys)) |
| A9 | A rootless OCI runtime on the target hosts supports the flag set of `S1` | The sandbox conformance suite | Use rootful with user-namespace remapping; same properties required |
| A10 | gVisor and a Kata runtime class can be selected per container on the Linux hosts in scope | The driver self-tests | The node advertises only the tiers that pass; policy does the rest |
| A11 | Apple `container` on macOS 26 can run an OCI image with resource limits, a read-only mount and a proxy-only network | The driver self-test on a Mac | macOS devices provide `S1` only and run own work only |
| A12 | The Tailscale and NetBird APIs can mint a single-use, short-lived, tag-scoped join credential | The minters' PACT tests against recorded interactions | The overlay transport is offered only where an operator has joined the device by hand; nothing else changes |
| A13 | GitHub lets a workflow job request an OIDC token for a custom audience on GitHub-hosted runners in this repository | One workflow run | The verdict endpoint also accepts an account credential stored as a repository secret |

## 14. Considered and rejected

| Option | Why not |
|---|---|
| Keep the mesh in `@hobo/ci` and add enrollment there | Delivery agents, junction hosts and overlay joins are not CI. It would become the sixth enrollment model's home, not the only one |
| Merge `@hobo/backend-fleet` into the mesh | Its members are configured storage backends with exactly one active writer and replication lag; devices are enrolled, many are active, and they hold no data. One abstraction over both would be wrong for each. The word is disambiguated instead ([§4](#4-terms)) |
| Move provider budget selection (`ci/fleet/balance.ts`, `backend-fleet/routing.ts`) into the mesh | It is a pricing concern that already shares `evaluateBudgetPolicy` from core. Mesh supplies its health and capacity inputs |
| One package instead of five | The repository's boundary rules need the domain at the contract layer and I/O at the package layer (R13). A native binding and a NATS client in the domain package would block runtimes and adapters from importing it |
| NATS as the identity authority | Its JWT format is specific to it, and wasmCloud moved away from exactly that (E9). NATS enforces; the authority decides |
| NATS leaf nodes on devices | A second server on every laptop, and the leaf-node port had the year's worst advisories (E7) |
| libp2p for transport | Its main maintainer stopped in 2025 with no successor named; measured hole-punching success is about 70% |
| tailcat for transport | Go only, no stable wire format, and a threat model its authors say excludes malicious adversaries (E13). Revisit at its 1.0 |
| Tailscale or NetBird as the only transport | Needs a coordinator and an account per tenant. Kept as the `overlay` adapter for tenants that already have one |
| AT Protocol as the device identity | No per-device keys; the account key is usually held by the hosting server, which could then enroll a device for its user (E11). Kept as a sign-in provider |
| Nostr, as Buzz uses it | No key rotation or recovery, weak revocation, a different curve, and the relevant drafts are Block's alone (E12) |
| SPIRE as the authority | No attestor or key manager for laptops; on a developer device it reduces to the same join token this plan uses, plus a second control plane. SVIDs are kept as the credential format |
| Postgres as the default event store | Reintroduces the hosted database ADR-0179 removed. Supported behind the port; JetStream is the high-availability default |
| Trusted-execution attestation for untrusted work on personal devices | Broken by cheap physical attacks against the party who holds the device (E14) |
| A phased migration with both systems running | The current mesh has one real box (R3). A compatibility window would cost more code than the cutover it avoids |
| Per-device NATS accounts | Account JWT churn on every enrollment, and no gain over templated permissions inside a tenant account |
| Open, self-reported capacity for ranking | Kept only as advice; reliability is measured by dispatchers (E15) |

## 15. Sources

Repository facts cite paths inline. External facts:

- NATS: [decentralized auth](https://docs.nats.io/learn/security/decentralized-auth), [auth callout](https://docs.nats.io/learn/security/auth-callout), [scoped signing keys](https://docs.nats.io/using-nats/nats-tools/nsc/signing_keys), [template example](https://github.com/synadia-io/rethink_connectivity/blob/main/08-scoped-signing-keys), [per-subject discard](https://nats.io/blog/new-per-subject-discard-policy), [JetStream headers](https://docs.nats.io/reference/jetstream/api/headers), [advisories](https://advisories.nats.io), [2.14 notes](https://docs.nats.io/release-notes/whats_new/whats_new_214), [2.15 release](https://nats.io/blog/nats-server-2.15-release/), [governance resolution](https://www.cncf.io/announcements/2025/05/01/cncf-and-synadia-align-on-securing-the-future-of-the-nats-io-project)
- wasmCloud v2: [migration](https://wasmcloud.com/docs/migration)
- Transport: [iroh 1.0](https://www.iroh.computer/blog/v1), [iroh JavaScript](https://docs.iroh.computer/languages/javascript), [tailcat](https://github.com/tailscale/tailcat), [tailcat security note](https://github.com/tailscale/tailcat/blob/main/SECURITY.md), [libp2p maintenance](https://ipshipyard.com/blog/2025-libp2p-maintenance-update/), [hole-punching measurement](https://arxiv.org/abs/2510.27500)
- Identity protocols: [AT Protocol OAuth](https://atproto.com/specs/oauth), [AT Protocol cryptography](https://atproto.com/specs/cryptography), [Tangled spindles](https://tangled.org/docs/spindles/), [Buzz](https://github.com/block/buzz), [Buzz owner attestation draft](https://github.com/block/buzz/blob/main/docs/nips/NIP-OA.md)
- Enrollment practice: [Teleport bound keypair](https://goteleport.com/docs/reference/machine-workload-identity/bound-keypair/admin-guide/), [SPIRE agent](https://spiffe.io/docs/latest/deploying/spire_agent/), [RFC 9449 DPoP](https://www.rfc-editor.org/rfc/rfc9449.html), [cross-device flow security](https://datatracker.ietf.org/doc/draft-ietf-oauth-cross-device-security/), [WIMSE agent identity](https://datatracker.ietf.org/doc/draft-ietf-wimse-aims/), [Secure Enclave keys](https://developer.apple.com/documentation/security/protecting-keys-with-the-secure-enclave)
- Runners and isolation: [GitHub secure use](https://docs.github.com/en/actions/reference/security/secure-use), [Buildkite signed pipelines](https://buildkite.com/docs/agent/v3/signed-pipelines), [Docker Sandboxes](https://www.docker.com/blog/docker-sandboxes-run-claude-code-and-other-coding-agents-unsupervised-but-safely/), [Apple container](https://github.com/apple/container), [gVisor security model](https://gvisor.dev/docs/architecture_guide/security/), [Firecracker host setup](https://github.com/firecracker-microvm/firecracker/blob/main/docs/prod-host-setup.md)
- Incidents and limits: [PyTorch runner compromise](https://johnstawinski.com/2024/01/11/playing-with-fire-how-we-executed-a-critical-supply-chain-attack-on-pytorch/), [TanStack postmortem](https://tanstack.com/blog/npm-supply-chain-compromise-postmortem), [tj-actions advisory](https://www.cisa.gov/news-events/alerts/2025/03/18/supply-chain-compromise-third-party-tj-actionschanged-files-cve-2025-30066-and-reviewdogaction), [TEE.fail](https://tee.fail/), [BadRAM](https://badram.eu/), [Battering RAM](https://batteringram.eu/), [The Sybil Attack](https://www.microsoft.com/en-us/research/publication/the-sybil-attack/), [io.net fake GPUs](https://www.theblock.co/post/291315)
