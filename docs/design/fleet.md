---
type: Design
title: "HoBo Fleet"
description: "One package, @hobo/fleet, for every fleet: member identity, enrollment, the registry, observation, many-active work (offers, claims, orders, receipts) and the one-active assignment register, for devices, sponsored backends and sponsored targets. NATS in operator mode behind @hobo/fleet-nats, peer-to-peer streams behind @hobo/fleet-p2p, an authority with a witness, sandbox tiers chosen on the device, and local mode for a process that owns its whole fleet."
tags: [hobo, design, fleet, ci, identity, security, nats]
---

# HoBo Fleet

**Status:** decided as [ADR-0183](./adr/fleet.md#adr-0183). Built and
tested in the repository (`@hobo/fleet`, `@hobo/fleet-nats`,
`@hobo/fleet-p2p`, `@hobo/fleet-agent`, `@hobo/fleet-authority`,
`@hobo/backend-routing`, `deploy/fleet/`); not proven in production until a
production observation is linked from the ADR. Operator steps are the
[fleet runbooks](../maintenance/fleet/index.md); a first device is the
[quick start](../maintenance/fleet/quick-start.md).

**Supersedes:** [CI Relay Mesh](./ci-relay-mesh.md),
[fleet enrollment and at-most-once claims](./fleet-enrollment-design.md)
(`fleet-v2`) and [ADR-0180](./adr/fleet-verdict.md#adr-0180)'s hosted
verdict and reporter layers. The [routing slip](./adr/routing-slips.md#adr-0181)
stays; its reasons come from `fleetVerdict`.

HoBo has several kinds of thing that join a group, are trusted, are watched
for health, and are chosen to do work: machines that run jobs, delivery
agents, junction hosts, storage backends behind a relay, deploy targets.
They are all members of fleets in one model, owned by one package, so there
is one place to fix a bug. A developer enrolls their own device in one
command with no shared secret on disk, and nothing that grants trust depends
on trusting the message bus operator.

## Terms

These words have exactly one meaning in the repository. `pnpm run fleet:vocabulary` checks the parts a machine can check; reviewers hold the rest.

| Term | Meaning |
|---|---|
| **Fleet** | A named set of members inside one tenant, with one policy and one coordination mode. `hobo` (the CI runners), a developer's own machines, and the hosted relay's cache backends are each a fleet |
| **Member** | One thing enrolled in one or more fleets. Its kind is `DEVICE`, `BACKEND` or `TARGET` |
| **Device** | A member that runs the agent and holds its own keys: a CI box, a laptop, a relay host, a delivery agent's host, a junction host |
| **Backend** | A member that is a service endpoint with no agent of ours on it: a database, a cache. It is enrolled and observed by a sponsor |
| **Target** | A member that is a place work is deployed to with no agent of ours on it: a cluster reached by push. Sponsored like a backend |
| **Sponsor** | The principal that enrolls a backend or target, holds the reference to its credential, and signs observations about it |
| **Coordination mode** | `MANY_ACTIVE`: members claim units of work ([Many-active fleets: offers, claims, orders and receipts](#many-active-fleets-offers-claims-orders-and-receipts)). `ONE_ACTIVE`: exactly one member is the active one, decided by the assignment register ([One-active fleets: the assignment register](#one-active-fleets-the-assignment-register)) |
| **Registry** | The record of fleets and members and their state. Served by an authority, or held in-process in local mode |
| **Authority** | The service that enrolls members, keeps the registry, issues credentials, answers NATS auth callouts and signs the audit log |
| **Local mode** | Using the fleet package inside one process that owns its whole fleet, with an in-process registry and no authority or bus |
| **Agent** | The fleet software running on a device. A device has at most one agent at a time; a second is a clone |
| **Role** | What a device may do in one fleet: `EXECUTOR`, `DISPATCHER`, `OBSERVER`, `RECONCILER`, `JUNCTION` |
| **Observation** | A signed, expiring statement of a member's health, capacity and usage. A device makes its own; a sponsor makes a backend's or target's |
| **Offer, Claim, Order, Receipt** | The four signed records by which a unit of work reaches a device in a `MANY_ACTIVE` fleet |
| **Assignment** | The decided statement of which member of a `ONE_ACTIVE` fleet is active for one epoch |
| **Grant** | An authority-signed, short-lived permission for two parties to open a transport session |
| **Mesh** | The coordination plane among the devices of a tenant: the bus they share and the transports between them. Not a package, not the network overlay, and not the in-process service router |
| **Transport** | A device-to-device data path: direct peer-to-peer, a network overlay, or relayed over the bus |
| **Overlay** | A network-layer virtual network (Tailscale, NetBird, WireGuard). One kind of transport. Owned by `@hobo/connectivity` |
| **Sandbox** | The isolation boundary work runs in, with a tier from [Sandbox tiers](#sandbox-tiers) |
| **Routing** | Choosing among providers or backends by cost and health. Never called a fleet. Lives in `@hobo/ci` (`runner-routing`) and `@hobo/backend-routing` |
| **Camp inventory** | The delivery system's record of deploy targets. Each Camp that is a machine or cluster is backed by a fleet member; its conditions are computed from that member's record and observations |
| **Internal router** | The in-process fetch interceptor for `*.hobo.internal` in `packages/hobo`. Renamed from "internal mesh" |
| **Routing slip** | The box relay's per-class routing answer (ADR-0181). Routing, not a fleet record. Its reasons come from `fleetVerdict` |

`@hobo/cd-kube-fleet` keeps its upstream name ("Kubernetes fleet"), so it needs an entry in `scripts/fleet-vocabulary-allow.json`.

## Rules

1. **Fail closed.** An unreadable policy, an unverifiable signature, an unknown critical field in a signed record, an unmapped region, or an unreachable authority on a decision that grants something, all deny.
2. **Degrade to standalone, never to stopped.** A member that cannot reach the bus or the authority keeps doing what it is already entitled to do by itself and refuses everything else.
3. **Sign the bytes you send.** Every signed record uses the envelope in [Signed envelope](#signed-envelope). No canonical JSON, no re-serialisation before verifying.
4. **No bearer secret outlives one use, with one named exception.** Bootstrap tokens are single-use, and everything a device or a person presents is proof of possession of a key. One existing bearer credential is kept on purpose and confined: the relay's account credential, accepted only on read routes and for submitting work ([Enrollment](#enrollment)). It cannot enroll, approve, issue a credential or open a session.
5. **The bus is not trusted.** A NATS administrator can write any subject. Anything that grants trust carries a signature and an expiry that readers verify against a trust record they have pinned.
6. **Trust machinery applies where a trust boundary is crossed, and only there.** A process that declares, observes and assigns its own fleet runs the same code in local mode with no signatures, because it would only be signing to itself.
7. **Repository standards apply in full:** protobuf first with generated types, CUE constraints for every message, parse-don't-validate constructors, PACT contracts at every service boundary, event-sourced state on the `EventStore` port, `// public-contract:` on exported literals, `// SAFETY:` on every type assertion (`AGENTS.md:399-407`, `oxlint.config.ts:47-63`).


## Design

### Shape

```
                 ┌───────────────────────── @hobo/fleet (one code base) ─────────────────────────┐
                 │  members · enrollment · registry · observations · views                        │
                 │  MANY_ACTIVE: offers, claims, orders, receipts     ONE_ACTIVE: assignment      │
                 └───────▲────────────────────────▲──────────────────────────────▲────────────────┘
        authority mode   │                        │ authority mode               │ local mode
  person ─ sign in ─▶ AUTHORITY ◀─ HTTPS ─ DEVICES (agent) ◀── P2P ──▶ DEVICES   HOSTED RELAY (one process)
                      enroll, registry,     executors, dispatchers,              declares its cache backends,
                      credentials, grants,  observers, reconcilers,              observes them, decides which
                      audit, NATS callout   junctions                            one is active; no authority,
                         │                        │                              no bus
                         └──── tenant NATS account: registry, observations, offers, claims, orders, events ────┘
```

Six packages, each with one reason to exist:

| Package | Path | Layer | Holds | May import |
|---|---|---|---|---|
| `@hobo/fleet` | `packages/fleet` | contract (1) | All domain logic, records, ports, in-memory adapters, local mode, the typed HTTP client, test kits. No I/O beyond `node:crypto` | `@hobo/core`, `@bufbuild/protobuf` |
| `@hobo/fleet-nats` | `packages/fleet-nats` | package (3) | Every NATS interaction: topology, credentials, auth callout, the bus ports, the journal event store, the relay transport | `@hobo/fleet`, `@hobo/core`, `@nats-io/*` |
| `@hobo/fleet-p2p` | `packages/fleet-p2p` | package (3) | The peer-to-peer transport adapter. The only package with the native binding | `@hobo/fleet`, `@number0/iroh` |
| `@hobo/fleet-agent` | `packages/fleet-agent` | package (3) | What a device needs beyond the domain: key stores, sandbox drivers, the egress proxy, host capacity, service installers. A library; it has no binary | `@hobo/fleet`, `@hobo/core` |
| `@hobo/fleet-authority` | `packages/fleet-authority` | package (3) | The authority service: HTTP API, sign-in providers, composition of the recorder and projection, operations, the status feed, the witness | `@hobo/fleet`, `@hobo/fleet-nats`, `@hobo/identity`, `@hobo/policy`, `@hobo/connectivity`, `@hobo/core`, `@hobo/runtime-local`, `@hobo/status-page`, `@hobo/adapter-infisical`, `@hobo/adapter-openbao` |
| `@hobo/backend-routing` | `packages/backend-routing` (renamed from `packages/backend-fleet`) | contract (1) | Cost-based choosing among storage backends: `decideFleet`, `routeFleetByBudget`, financial models, usage units. Nothing else | `@hobo/fleet`, `@hobo/core` |

`@hobo/fleet` sits in the contract layer so that `@hobo/data-postgres`, `@hobo/backend-routing`, runtimes and adapters may import it.

**Composition roots.** There are exactly four, and each says which work it carries:

| Root | Package | Runs as | Carries |
|---|---|---|---|
| `hobo fleet run` | `@hobo/hobo` | Every enrolled device except the box | Executor for `github-actions-job` and `oci-command`; all three transports (the overlay one from `@hobo/connectivity`); roles `OBSERVER`, `RECONCILER` and `JUNCTION` when the device has them |
| The box worker daemon | `@hobo/ci-gh-actions` | The dedicated CI box | Dispatcher and executor for `github-actions-job`, dispatcher for `oci-command`, with the worker's own admission as capacity |
| `hobo-fleet-authority` and `hobo-fleet-witness` | `@hobo/fleet-authority` | The authority service and its witness | Everything in [Enrollment](#enrollment) to [Audit, metering and observability](#audit-metering-and-observability) that the authority does |
| The hosted relay | `@hobo/ci-vercel` | A serverless function | Local mode for its cache-backend fleet; an HTTP client of the authority for device fleets |

### Fleets, members and roles

**A fleet** belongs to one tenant and has an id, an owner, a policy and a coordination mode.

**A member** has a kind, and that kind decides how it is enrolled and observed:

| Kind | Holds keys | Enrolled by | Observed by | Coordination it takes part in |
|---|---|---|---|---|
| `DEVICE` | Yes, its own ([Member identity and keys](#member-identity-and-keys)) | Itself, with proof of possession, approved per fleet policy | Itself | `MANY_ACTIVE` as executor or dispatcher; may also be a sponsor |
| `BACKEND` | No | A sponsor declares it | Its sponsor (probes) | `ONE_ACTIVE` (local mode only, [One-active fleets: the assignment register](#one-active-fleets-the-assignment-register)) as a candidate for the active member; holds a replica of the assignment log |
| `TARGET` | No | A sponsor declares it | Its sponsor | None in this package; the delivery system places work on it |

In authority mode an observation is accepted only with a `SIGN` key ([Observations, capacity and reliability](#observations-capacity-and-reliability)), so a sponsored member is observed only when its sponsor is a `DEVICE`. A service principal may declare members; their health then stays `UNKNOWN` in fleet views, and whatever consumes them reads reachability elsewhere.

**Member id.** For a device, `dev_` followed by the first 32 hex characters of the SHA-256 of its identity key's RFC 7638 thumbprint. For a sponsored member, `bkd_` or `tgt_` followed by the first 32 hex characters of `SHA-256(tenant ‖ 0x00 ‖ kind ‖ 0x00 ‖ fleet ‖ 0x00 ‖ name)`, where `fleet` is the fleet it is declared into; names are unique per fleet, so two fleets' backends of the same name get different ids. Every member also has a **name** unique within each of its fleets (`^[a-z0-9][a-z0-9_-]{0,62}$`, the existing backend-id pattern). Uniqueness is checked by the enrollment commands against the registry projection (error `name-taken`), not by a constraint on one record. Assignment entries refer to members by name, which keeps the stored log format of today's cache fleet.

**Membership is per fleet.** A member record lists its memberships, and each membership carries the roles it has in that fleet. "A dispatcher in fleet A" is therefore decidable from the record, and a device that dispatches in A and executes in B cannot issue orders in B.

**Roles** (devices only):

| Role | Can | Cannot |
|---|---|---|
| `EXECUTOR` | Observe itself, read offers, claim, receive its own orders, publish its own receipts and events, open granted transport sessions | Publish offers or orders, read another device's orders, write the registry |
| `DISPATCHER` | Everything an executor can, plus publish offers and orders, read claims and receipts, and delete an invalid claim | Write the registry, mint credentials |
| `OBSERVER` | Observe itself; read the registry, views and observations | Claim or dispatch |
| `RECONCILER` | As observer; receives SVIDs for the delivery feed | Claim CI work unless also an executor |
| `JUNCTION` | As observer; joins an overlay; registers dynamic DNS | Claim work unless also an executor |

The box worker is `DISPATCHER` and `EXECUTOR` in fleets `hobo` and `hobo-trunk`. A developer laptop is `EXECUTOR` in its owner's fleet. A long-running relay host is `OBSERVER`. The serverless hosted relay is not a device; it is a sponsor of its cache backends in local mode and an HTTP client of the authority.

**Two modes of use, one code path.**

- **Authority mode.** Members cross a trust boundary (other machines, other people). Records are signed, credentials are issued, the registry is served. Everything from [Threat model](#threat-model) on applies.
- **Local mode.** One process declares its own members from its own configuration, observes them, and coordinates them: `createLocalFleet` runs the same enrollment state machine on an in-memory event store, with the same records, the same observation model and the same assignment register. Nothing is signed because the process would only be signing to itself ([Rules](#rules) rule 6). The cache fleet uses this.

### Threat model

Applies to authority mode. In local mode the trust boundary is the process and the credentials of the stores it writes.

| Adversary | Can do | Control | Where |
|---|---|---|---|
| Malicious work author | Run arbitrary code in a job | Sandbox tier chosen on the device from facts it verifies; single-use sandbox; no host mounts; egress allowlist; per-order credentials only | [Many-active fleets: offers, claims, orders and receipts](#many-active-fleets-offers-claims-orders-and-receipts), [Sandbox tiers](#sandbox-tiers) |
| Malicious or compromised enrolled device | Lie in its observations, claim out of turn, read what it is sent, attack peers | Observations are bound to the registry and to their key; capacity is advice and reliability is measured by the authority; claims are server-enforced first-writer-wins and checked by the dispatcher; a device is suspended only on evidence it signed itself; orders are sealed per device; a device can touch only consumers named after itself; transport needs an authority grant | [NATS topology](#nats-topology) to [Many-active fleets: offers, claims, orders and receipts](#many-active-fleets-offers-claims-orders-and-receipts), [Transport](#transport) |
| Stolen device key (a clone) | Impersonate the device | The generation counter locks the device when the two copies diverge; credentials live minutes. A copy of a device that stays offline works until the original returns; a held key (tier T1 or above) is the defence | [Enrollment](#enrollment) |
| Stolen bootstrap token | Enroll an attacker's device | Single use, 10 to 30 minutes, scoped to one fleet and name, never on a command line; the approver sees the key fingerprint; dual control where policy says so | [Enrollment](#enrollment) |
| Phished approver | Approve an attacker's device | The browser flow starts from the CLI on the device; the device-code flow shows device name and fingerprint words and is refused for fleets that require dual control | [Enrollment](#enrollment) |
| Network attacker | Read or alter traffic | TLS to NATS and the authority; QUIC or WireGuard between devices; every trust-bearing record signed | [NATS topology](#nats-topology), [Transport](#transport) |
| NATS administrator or compromised server | Write any subject; drop, delay, replay or roll back messages | Every registry record, view, order and grant is signed against a pinned, witnessed trust record and expires; observations carry an issue time and are checked against their key; a rollback is bounded by record expiry (30 minutes for a member record); a compromised bus can delay work and hide revocation for that bound, never grant anything | [Rules](#rules) rule 5, [Signed envelope](#signed-envelope) |
| Compromised dispatcher | Send work to devices; mislabel it | A device accepts an order only for a claim it holds, checks it against its own verified fleet policy, and recomputes the trust class from facts the dispatcher cannot forge: the authority's signature on submitted work, and GitHub's own job context at the start fence. Dispatcher keys are enrolled, per-fleet and revocable | [Many-active fleets: offers, claims, orders and receipts](#many-active-fleets-offers-claims-orders-and-receipts) |
| Compromised authority | Enroll devices, sign registry records, mint credentials | Detected, not prevented: the witness recomputes the audit chain from its entries and refuses to co-sign a registry change that has no audit entry; the trust record can change only with the witness's co-signature; the NATS operator key is offline. Recovery is key rotation and a new incarnation | [Audit, metering and observability](#audit-metering-and-observability), [Deployment, availability and operations](#deployment-availability-and-operations) |
| Sybil enrollee | Enroll many fake devices | Enrollment is bound to a signed-in principal and a per-principal quota; nothing is granted to an unenrolled key | [Enrollment](#enrollment), [Policy, tenancy and residency](#policy-tenancy-and-residency) |
| Insider with repository write | Change workflows to target a fleet | Fleet policy names the repositories, refs and workflow digests it accepts; orders carry them; devices check | [Many-active fleets: offers, claims, orders and receipts](#many-active-fleets-offers-claims-orders-and-receipts), [Policy, tenancy and residency](#policy-tenancy-and-residency) |

### Member identity and keys

Sponsored members hold no keys; this section is about devices.

**One identity key per device.** The device generates it and it never leaves. It is an EC P-256 or an Ed25519 key (both, because hardware keystores such as the Secure Enclave and fielded TPM 2.0 offer only P-256). It signs exactly three things: the enrollment proof (including the DPoP proofs of the sign-in that precedes a browser enrollment, [Enrollment](#enrollment)), key bundles, and a rotation statement.

**Operational keys** do the daily work so that the identity key can sit in hardware and be used a few times a day. The device generates them and binds them in a **key bundle** that the identity key signs:

| Purpose | Key type | Used for | Generated with |
|---|---|---|---|
| `SIGN` | Ed25519 | Observations, claims, receipts, DPoP proofs after enrollment, the NATS connect proof | `node:crypto` |
| `SEAL` | X25519 | Receiving sealed order secrets; key agreement for the bus-relayed transport | `node:crypto` |
| `TRANSPORT` | Ed25519 | The peer-to-peer endpoint identity | The transport adapter; the bundle records the endpoint id, whichever side generated the key |

Each use has its own context string in the signed envelope ([Signed envelope](#signed-envelope)), so a signature made for one purpose never verifies for another. The device holds no NATS key at all ([NATS topology](#nats-topology)).

A bundle has a lifetime set by fleet policy (`key_bundle_hours`, default 24, at most 720) and is renewed when three quarters of it has passed. Readers reject a record signed by a key whose bundle has expired or whose member is not `ACTIVE`.

**Key stores.** `KeyStore` is a port ([the ports](../../packages/fleet/src/ports.ts)) with two shipped implementations:

- `file`: the default. Directory `HOBO_FLEET_HOME` (default `~/.hobo/fleet`, refused if it is inside a git checkout), mode `0700`, key files `0600`; refuses to load from a directory group or others can write. It also stores the generation, the pending refresh nonce, the pinned trust record and the last processed stream sequences.
- `external-signer`: a configured command that speaks a line-delimited JSON protocol (`{"op":"public"}`, `{"op":"sign","payloadB64":…}`) on standard input and output, for the identity key only. This is the seam for a Secure Enclave, TPM or hardware-token helper without native code in this repository.

**Attestation tiers.** Recorded in the member record and in every credential. Tiers 0 and 1 are never described as attestation.

| Tier | Proves | How it is verified | Use |
|---|---|---|---|
| `T0_SOFTWARE_KEY` | Continuity: the same key as last time | Signature plus the generation counter | Floor for every fleet |
| `T1_HELD_KEY` | Nothing more to the server; the identity key is claimed to be in a keystore or token | Self-declared when the device uses `external-signer` | Optional hardening; the defence against key copying |
| `T2_ORG_CERTIFIED` | The key was certified by the organisation's device authority | The enrollment request carries an X.509 chain for the identity key, validated against trust roots configured on the fleet | Required where fleet policy says so |
| `T3_PLATFORM_IDENTITY` | The agent runs on a specific cloud instance or CI job | A platform OIDC token whose audience names the authority and the identity key's thumbprint, validated against the issuer's published keys and the fleet's subject rules, accepted once | Ephemeral cloud and CI devices |

### Enrollment

Enrollment is one event-sourced aggregate, lifted from the delivery stack's engine and generalised to every member kind. Every path below ends in the same state machine.

```
        enroll / declare          approve-key + accept               suspend
 (none) ────────────────▶ PENDING ─────────────────────▶ ACTIVE ◀──────────▶ SUSPENDED
                             │      (or policy auto-accept)  │  ▲    resume
                             │ reject / token expiry         │  │ unlock (governed)
                             ▼                               ▼  │
                          REJECTED                         LOCKED        any state ── revoke ──▶ REVOKED (terminal)
                                                   (clone detected; devices only)
```

#### People sign in to the authority

Every governed action needs a person the authority has authenticated itself. A credential the CLI minted for itself is never accepted.

- `hobo fleet login` runs an authorization-code flow with PKCE against the authority on a loopback redirect. The authority delegates to a configured sign-in provider (`oidc` for an organisation's identity provider, `github`, or `atproto`) and learns a principal.
- The authority maps the principal to tenants and tags through a `PrincipalDirectory` (identity-provider group claims, GitHub organisation role, or the authority's own configuration), then issues a **person token**: a 15-minute JWT from the same issuer as device SVIDs, bound by DPoP to the CLI's **sign-in key**, with a refresh for up to 12 hours. For `hobo fleet login` the sign-in key is generated for that sign-in. For the sign-in inside `hobo fleet enroll` it is the device's identity key, so the person token, the fingerprint the person approves and the enrollment proof all name one key.
- The browser path in full: `POST /v1/fleet/signin/start` returns the provider's authorize URL; the provider redirects to the authority's `GET /v1/fleet/signin/callback`; the authority completes with the provider and redirects to its own approval page `GET /v1/fleet/approve/{state}`, which renders an `ApprovalView` (signed-in principal, host name, device name, platform, the four fingerprint words of the CLI's key); the person confirms with `POST /v1/fleet/approve/{state}`, which redirects to the CLI's loopback address with a one-time authority code; the CLI exchanges it at `POST /v1/fleet/signin/complete` with its PKCE verifier and a DPoP proof.
- On a machine with no browser the CLI uses a device-code flow: `signin/start` with `device_flow` returns a short one-time code and the verification URL. The person opens it elsewhere and enters the code (`POST /v1/fleet/signin/device`), signs in with the provider, and sees and confirms the same approval page. Meanwhile the CLI polls `POST /v1/fleet/signin/device/poll` with a DPoP proof; it gets `sign-in-pending` until the person confirms, then the person token.
- An account credential (the relay's existing kind, verified by an injected `AccountCredentialVerifier`) is accepted only on read routes and for submitting work. A GitHub Actions OIDC token is accepted only on the verdict route ([Observations, capacity and reliability](#observations-capacity-and-reliability)).

#### Devices enroll themselves

1. **Token.** A signed-in person runs `hobo fleet token create --fleet <id> --name <device name> --ttl 15m`. The authority authorises `fleet.member.invite`, records only the token's SHA-256, and returns `hft_…` once. On the device, `hobo fleet enroll --token-file <path>` (or the token on standard input; never an argument) generates keys and posts the enrollment.
2. **Browser.** `hobo fleet enroll --fleet <id>` on the device generates keys and signs the person in as above, with the identity key as the sign-in key (`SignInStart.dpop_thumbprint` is the identity thumbprint). The approval page shows the device name, platform and four fingerprint words derived from the identity key. The enrollment request carries the resulting person token, and the authority refuses it with `proof-invalid` unless the token's DPoP binding, the request's `identity_jwk` and the DPoP proof on the request are the same key. The device-code variant is refused for any fleet whose policy requires dual control.
3. **Workload identity.** `hobo fleet enroll --fleet <id> --oidc <provider>` presents a platform OIDC token requested with the audience `<authority issuer>#<identity thumbprint>`. If the fleet's `oidc_trust` rules match and the token has not been used before, the device is accepted without a person, as class `EPHEMERAL` at tier `T3`.

**What the authority binds:** tenant, identity key (the JWK itself and its thumbprint), key bundle, the fleet and roles of the first membership, device class (`PERSONAL`, `DEDICATED`, `EPHEMERAL`), attestation tier and evidence digest, the owner and the owner's linked identities (for example the GitHub account id the person signed in with), who invited and who approved, the token hash, platform, region, agent version.

**Approval.** Fleet policy sets `approval` to `AUTO_OWNER` (the inviting principal's sign-in is the approval; only when that principal is the fleet's owner), `SINGLE` or `DUAL`. `DUAL` needs `approve-key` and `accept` from two different principals; the engine enforces that, as the delivery engine does today.

**More fleets.** A person with the right adds an `ACTIVE` member to another fleet with `hobo fleet member assign` (governed `fleet.member.assign`), subject to that fleet's policy and approval mode.

#### Sponsors declare backends and targets

A sponsor (a service principal or a device) calls `declare` with the member's kind, name, fleet, a credential **reference** (a locator in the sense of ADR-0027, never the secret) and a digest of its endpoint. A person, a device, or a workload whose OIDC token matches an `oidc_trust` rule of the fleet with `sponsor` set may call it. The same policy check, approval mode, events and audit apply; `AUTO_OWNER` covers the usual case of an owner declaring its own backends. A sponsored member is never `LOCKED` and has no credentials of its own: its sponsor's credentials act for it, and revoking the member removes it from every view. Only a sponsor that is a `DEVICE` can observe it in authority mode ([Fleets, members and roles](#fleets-members-and-roles)).

#### Activation, refresh and clone detection

An `ACTIVE` device calls `POST /v1/fleet/members/{id}/credentials` with a DPoP proof made with its `SIGN` key, its current **generation** `g`, and a fresh random **refresh nonce** that it has first written to disk. The authority returns a JWT-SVID (15 minutes, bound to the `SIGN` key), a **session ticket** for NATS, the current signed member record, and generation `g+1`. The device refreshes five minutes before expiry.

The authority remembers the last `(g, nonce)` it answered:

- A request at the current generation is answered and the generation advances.
- A request that repeats the previous generation **with the same nonce** is a retry after a lost response: the authority answers again with the same new generation. A crash between the response and the disk write therefore does not lock an honest device.
- Anything else means two agents hold one key. The device becomes `LOCKED`, its record changes at once, and both are refused. `unlock` is a governed action that resets the generation after a person has decided which machine is real.

Detection needs both copies to refresh. A copy of a device that is switched off works until the original comes back; the owner sees the device live in `hobo fleet status` while their machine is off. Suspend a lost device, and use a held key where this matters.

**Rotation.** `POST /v1/fleet/members/{id}/keys` replaces the key bundle at any time. Replacing the identity key needs a rotation statement signed by the old identity key naming the new one; the member id does not change. Every thumbprint a member has ever had is recorded in a tenant-wide index, so a retired or revoked key can never enroll as a new device.

**Revocation.** `revoke` appends `fleet.MemberRevoked`, rewrites the registry record, and sends a control message. In order of speed: live readers stop honouring the member's signatures as soon as they see the registry change (under five seconds); the authority refuses its next refresh; its NATS session credential expires within ten minutes; the authority also asks the server to disconnect it where the pinned server supports that. `hobo fleet leave` is a device revoking itself with its own SVID.

### Credentials

| Credential | Issued by | Lifetime | Proves | Used for |
|---|---|---|---|---|
| Person token | Authority, after sign-in | 15 minutes, refreshable for 12 hours | A principal, its tenant and tags; bound to the CLI's sign-in key | Governed routes |
| Bootstrap token `hft_…` | Authority, on a person's request | 10 to 30 minutes, one use | An invitation to one fleet and name | Enrollment only |
| JWT-SVID | Authority, through `@hobo/identity` `JwtSvidIssuer` | 15 minutes | Member identity, tenant, memberships, tier; bound to the `SIGN` key | Calling HoBo HTTP services (authority, delivery feed, relay) with `Authorization: DPoP` |
| Session ticket | Authority | 15 minutes | That the device was `ACTIVE` at issue, in this incarnation | Presented with a per-connection proof to NATS |
| NATS user JWT | The authority's callout responder, signed by a scoped account signing key | 10 minutes | Nothing to the device; it is the server's enforcement record | Enforced by the server on every publish and subscribe |
| Session grant | Authority | Up to 60 minutes | That two named parties may open a transport session for a stated purpose | Transport accept decisions |
| Order secret | Dispatcher, sealed inside an order | The life of one order | — | The work itself (for example a single-use runner registration) |

The person-token and SVID signing key must be the same on every authority replica and survive restarts. `@hobo/identity` gains `loadSecretStoreKms`: it reads (or creates once) the RSA key through `SecretsPort` at start and returns a synchronous `KmsLike` holding it in memory. The authority accepts only tokens that verify against its own key set.

### NATS topology

**Server.** Pinned to 2.15.3 or later (ADR-0183 D13 allows raising it; never below 2.14.3, the first fixed line for the 2026 pre-authentication advisories). Operator mode with the full, NATS-based account resolver. JetStream on. TLS required on every listener. Listeners: client (4222, TLS), WebSocket (443, TLS), and cluster routes on a private interface only. The leaf-node and MQTT ports are off; gateways are off unless a multi-region deployment enables them; the monitoring port binds to localhost.

**Accounts.** `SYS` for operators, and one account `T_<tenant>` per tenant holding everything below. In operator mode the auth callout is part of each tenant account's own JWT, so there is no separate callout account. The callout is configured with `allowed_accounts` naming only the tenant account itself and an `xkey` for encrypted requests.

**Static users in each tenant account.** Their credentials live in the secret store, one secret each.

| User | Listed in `auth_users` | Permissions | Used by |
|---|---|---|---|
| `authority` | Yes | Subscribe to the callout request subject; read and write every `fleet.>` subject, the `fleet-registry`, `fleet-views` and `fleet-replay` buckets; consumer management on the fleet streams. No stream create, update, delete or purge | Authority replicas |
| `witness` | Yes | Read `FLEET_AUDIT` and `fleet-registry`; publish `fleet.audit.witness` | The witness |
| `provisioner` | Yes | Stream and bucket administration for the fleet streams only | `hobo fleet ops provision`, run by an operator, never by a service |
| `sentinel` | No | Deny everything | Every device. Its credentials are public (they are in discovery). A device presents them so the server knows which account the connection is for and invokes the callout |

**Scoped signing keys.** Three per tenant account, one per permission template. A device's template is the highest of `dispatcher`, then `executor`, then `observer` that any of its fleet memberships grants (roles `RECONCILER` and `JUNCTION` map to `observer`). `{{name()}}` is the `MemberId`.

Every consumer a device creates is a pull consumer with `ack_policy: none`, named exactly its `MemberId`; the device persists the last sequence it processed and resumes from it. That keeps acknowledgement and flow-control subjects out of the templates and stops one device touching another's consumers.

```
observer — publish allow:
  $KV.fleet-observations.{{name()}}.*
  fleet.event.{{name()}}.>
  $JS.API.INFO
  $JS.API.STREAM.INFO.KV_fleet-registry
  $JS.API.STREAM.INFO.KV_fleet-views
  $JS.API.STREAM.INFO.KV_fleet-observations
  $JS.API.DIRECT.GET.KV_fleet-registry.>
  $JS.API.DIRECT.GET.KV_fleet-views.>
  $JS.API.DIRECT.GET.KV_fleet-observations.>
  $JS.API.CONSUMER.CREATE.KV_fleet-registry.{{name()}}.>
  $JS.API.CONSUMER.CREATE.KV_fleet-observations.{{name()}}.>
  $JS.API.CONSUMER.CREATE.FLEET_CONTROL.{{name()}}.fleet.control.{{name()}}
  $JS.API.CONSUMER.MSG.NEXT.*.{{name()}}
  $JS.API.CONSUMER.INFO.*.{{name()}}
  $JS.API.CONSUMER.DELETE.*.{{name()}}
observer — subscribe allow:
  _INBOX.{{name()}}.>

executor — everything in observer, plus publish allow:
  fleet.claim.>
  fleet.relay.>
  $JS.API.STREAM.INFO.FLEET_OFFERS
  $JS.API.STREAM.INFO.FLEET_CLAIMS
  $JS.API.DIRECT.GET.FLEET_CLAIMS.>
  $JS.API.CONSUMER.CREATE.FLEET_OFFERS.{{name()}}.fleet.offer.>
  $JS.API.CONSUMER.CREATE.FLEET_ORDERS.{{name()}}.fleet.order.{{name()}}
executor — plus subscribe allow:
  fleet.relay.{{name()}}.>

dispatcher — everything in executor, plus publish allow:
  fleet.offer.>
  fleet.order.>
  $JS.API.STREAM.MSG.DELETE.FLEET_CLAIMS
  $JS.API.CONSUMER.CREATE.FLEET_CLAIMS.{{name()}}.fleet.claim.>
  $JS.API.CONSUMER.CREATE.FLEET_EVENTS.{{name()}}.fleet.event.>
  $JS.API.CONSUMER.CREATE.FLEET_SUBMISSIONS.{{name()}}.fleet.submission.>
```

Every client sets `inboxPrefix` to `_INBOX.<MemberId>`. No template contains `$JS.API.>`. Inside a tenant, the registry, fleet views, observations and offers are readable by every device of that tenant; none of them holds a secret, and secrets travel only in sealed orders. The exact list is proven by the permission probe suite of `@hobo/fleet-nats` against a real `nats-server`; a subject the pinned client needs and this list lacks is a contract amendment.

**Streams and buckets** (per tenant account; replicas 3 in the high-availability profile, 1 in the standalone profile; all created by `hobo fleet ops provision`, never by a device or a service)

| Name | Kind | Subjects or keys | Limits | Writer | Purpose |
|---|---|---|---|---|---|
| `fleet-registry` | KV, history 5 | keys `member.<MemberId>`, `fleet.<FleetId>`, `trust` | none | Authority | The registry read model. Every value is an authority-signed envelope with an expiry |
| `fleet-views` | KV, history 1 | key `fleet.<FleetId>` | TTL 120 s | Authority | Signed fleet views, including the reliability the authority measured |
| `fleet-observations` | KV, history 1 | key `<observer MemberId>.<observed MemberId>` | TTL 60 s | Each device, under its own id only | Observations: a device's of itself, and a sponsor's of each member it sponsors |
| `fleet-replay` | KV, history 1 | key `<scope>.<id>` | TTL 5 min | Authority | Proof and assertion ids already seen |
| `FLEET_SUBMISSIONS` | Stream | `fleet.submission.<FleetId>` | max age 24 h | Authority | Work submitted through the authority, signed by it |
| `FLEET_OFFERS` | Stream | `fleet.offer.<FleetId>` | max age 15 min | Dispatchers | Available work |
| `FLEET_CLAIMS` | Stream | `fleet.claim.<FleetId>.<WorkDigest>` | max age 120 s, `max_msgs_per_subject: 1`, `discard: new`, `discard_new_per_subject: true`, `deny_purge` | Executors | First writer wins, enforced by the server |
| `FLEET_ORDERS` | Stream | `fleet.order.<MemberId>` | max age 15 min | Dispatchers | Sealed work orders |
| `FLEET_EVENTS` | Stream | `fleet.event.<MemberId>.<kind>` | max age 30 days, `deny_delete`, `deny_purge` | Each device, its own subjects | Receipts, log chunks, session-close facts |
| `FLEET_CONTROL` | Stream | `fleet.control.<MemberId>` | max age 1 h | Authority | Drain, refresh-now, revoked notices |
| `FLEET_JOURNAL` | Stream | `fleet.journal.<streamId>` | no expiry, `deny_delete`, `deny_purge` | Authority | The event store in the high-availability profile ([Deployment, availability and operations](#deployment-availability-and-operations)) |
| `FLEET_AUDIT` | Stream | `fleet.audit.entry`, `fleet.audit.checkpoint`, `fleet.audit.trust`, `fleet.audit.witness` | no expiry, `deny_delete`, `deny_purge` | Authority; the witness on its one subject | The audit chain; `fleet.audit.trust` carries a proposed, authority-signed trust record; `fleet.audit.witness` carries the witness's co-signature of a checkpoint or of a proposed trust record |

`fleet.relay.<toMemberId>.<sessionId>` is plain publish-subscribe with no stream; see [Transport](#transport).

**The connect sequence**

1. The device connects over TLS presenting the tenant's sentinel credentials and, as `auth_token`, a `ConnectToken`: its session ticket envelope and a `ConnectProof` envelope (the ticket id and the nonce the server sent) signed by its `SIGN` key under the context `hobo-fleet/nats-connect/v1`.
2. The server sends the encrypted request to a callout responder.
3. The responder verifies, itself, in this order: the server's signature on the request; the ticket's authority signature, expiry and incarnation; that the proof names that ticket; the proof's signature against the `SIGN` key in the device's current registry record; that the proof's nonce is the one the server reports for this connection; that the device is `ACTIVE`; that the ticket's tenant is this account's.
4. It returns a user JWT for the server-generated per-connection key, with `name` set to the `MemberId`, a 10-minute expiry, signed by the scoped key for the device's template.

The device never holds a NATS key of its own: the sentinel's is public and the per-connection key is the server's. A responder has no write path other than the replay bucket, and holds three scoped signing seeds. Compromise of a responder cannot mint a credential wider than the dispatcher template.

### Observations, capacity and reliability

**One record for every kind of member.** An `Observation` says how one member is doing: its health, how long it has been failing, probe latency, what it has free (slots, memory, disk), how far a standby is behind the active member and whether it is ready to take over, what it has used this period, and until when the statement holds. A device observes itself; a sponsor observes each backend and target it sponsors. It replaces the mesh advertisement, the storage fleet's `FleetObservation` and `FleetRoutingObservation`, and the hand-built capacity snapshots.

**Health** is one closed set for everything: `REACHABLE`, `DRAINING`, `PRESSURED`, `UNREACHABLE`, `QUOTA_EXHAUSTED`, `AUTH`, `UNKNOWN`. The last four are the storage fleet's failure classes; a host maps its own errors to them with a `FailureClassifier`, as today. An absent figure is unknown, never zero.

**In authority mode a reader accepts an observation only if all of these hold.** Its bucket key is `<observer>.<member>` and both equal what the signed payload says; the envelope verifies against the observer's `SIGN` key in an unexpired bundle; the observer is an `ACTIVE` `DEVICE` and is either the member itself or the sponsor the registry records for it; the member is `ACTIVE` in every fleet the observation names; its `issued_at` is later than the last one accepted from that observer for that member; its `valid_until` is at most five minutes ahead plus one minute of clock skew. Anything else is ignored and counted once as `hobo_fleet_observation_rejected` with the reason. The three trust levels of the old mesh (`trusted`, `unverified`, `invalid`) and its `requireTrusted` switch are gone: an observation is verified or it is not used.

**Shared health functions** (pure; used by `MANY_ACTIVE` ranking, by the assignment register's callers and by `@hobo/backend-routing`):

- `fitWork(observation, needs)`: can this device take this work, and if not, what it lacks.
- `failingLongerThan(observation, ms)`.
- `eligibleForActive(observations, { mode, recoveryPointMs })`: for every observed member, by name, whether it could be made active now on health grounds alone, and the reasons when not. `mode` is `failover` (the active member is failing) or `switch` (a planned move). Rules: health must be `REACHABLE`; `ready` must not be `false` (absent means ready, because cache backends report neither readiness nor lag); in `failover` mode with a recovery point set, a member with no `lag_ms` is refused as `never-copied` and one further behind than the recovery point is refused; in `switch` mode, or with no recovery point, lag is not considered. These are exactly the health tests `decideFleet` applies today (`policy.ts:401-407`), with the reason strings it emits. Cost-based choosing ranks members using this answer and never re-tests health ([One-active fleets: the assignment register](#one-active-fleets-the-assignment-register)).

**Ranking** for work moves from `packages/ci/src/mesh/` with its behaviour unchanged apart from: the hash input is `(WorkDigest, MemberId)`; a device below the fleet's `min_agent_version` is not ranked; and the reliability weight comes from the authority.

**Reliability is measured, not asserted.** The authority computes each device's decayed share of delivered work from the signed receipts it records ([Many-active fleets: offers, claims, orders and receipts](#many-active-fleets-offers-claims-orders-and-receipts)) and publishes it in the fleet view. A device cannot raise its own score, and an observation's capacity figures remain advice: a device that claims work it cannot run loses reliability.

**Fleet view and verdict.** `fleetView(fleet)` lists a fleet's members with state, health, capacity, tier and reliability, at most 256 of them, with a summary that covers them all. The authority signs it and publishes it every 30 seconds to `fleet-views`. `fleetVerdict(fleet, label)` is the one answer runner routing needs: `OPEN`, `BUSY`, `NO_MEMBER` or `NO_CAPACITY`, with an expiry of at most 300 seconds. `BUSY` means there is no free slot only because members are running their own work; a box that is only busy is never refused (ADR-0181 R4). Each `Observation` says why it has no free slot (`refusal`), so the verdict can tell `BUSY` from `NO_CAPACITY`. It replaces the three repository variables and ADR-0180's verdict (superseded for transport by ADR-0181). The box's routing-slip issuer computes each class's reason from `fleetVerdict` on its local fleet view; the route job reads the slip (ADR-0181). The authority's verdict route remains a read surface; `packages/fleet/src/verdict-wire.ts`, a file with no imports, parses its answer. A missing, stale or unreadable slip changes nothing: routing reads GitHub's queue as it does today.

### Many-active fleets: offers, claims, orders and receipts

The fleet package does not know what a job is. A **work kind** is a plugin with two halves: a dispatcher half that produces offers and orders, and an executor half that runs an order in a sandbox. Two kinds ship:

| Kind | Where the work comes from | Dispatcher half | Executor half | Lives in |
|---|---|---|---|---|
| `github-actions-job` | GitHub's queue | Polls the queue (the existing poller), sizes the job by memory class, mints a just-in-time runner registration for the claimant | Starts the runner in the sandbox with that registration; runs one job | `@hobo/ci-gh-actions` |
| `oci-command` | `POST /v1/fleet/work` on the authority, which authorises it, signs a `WorkSubmission` and publishes it to `FLEET_SUBMISSIONS` | Reads submissions for its fleets and offers them | Runs the image in the sandbox, publishes log chunks and an output digest | `@hobo/fleet` (logic), `@hobo/fleet-agent` (driver) |

**Facts an offer carries.** Besides needs and expiry, an offer states where the work came from, so that each device can decide for itself how far to trust it ([Sandbox tiers](#sandbox-tiers)): `author` (a principal, for example `github:<numeric id>`), `origin` (`INTERNAL`, `FORK` or `UNKNOWN`), the repository, ref and workflow digest where there is one, and, for submitted work, the authority-signed `WorkSubmission` itself. The offer's own `trust_class` is only ever `ORG` or `UNTRUSTED`: the dispatcher's ceiling. `OWN` is never asserted by a dispatcher.

**The sequence**

1. **Offer.** A dispatcher publishes a signed `WorkOffer` to `fleet.offer.<fleet>`.
2. **Rank.** Every executor in the fleet that the offer fits computes the same order by weighted rendezvous hashing over `(WorkDigest, MemberId)` and waits its turn: 20 seconds per rank from the offer's `queued_at`, capped at 4 ranks. Weights are capacity for this work multiplied by the reliability in the authority's signed fleet view ([Observations, capacity and reliability](#observations-capacity-and-reliability)); with no fresh view, reliability counts as 1.
3. **Claim.** At its turn the executor publishes a signed `Claim` to `fleet.claim.<fleet>.<WorkDigest>`. The claim names the fleet, the work digest, the dispatcher, the offer's expiry, the claimant's rank as it computed it, and the sandbox tier it will use. The server accepts the first and refuses the rest. An executor that cannot reach NATS does not claim.
4. **Check the claim.** The dispatcher that owns the offer reads the claim and applies these rules in order:
   - Signature invalid, or payload fleet, digest or dispatcher different from the subject it arrived on or the offer it answers: delete it. Nothing is attributed to anyone, because anyone can publish garbage or replay somebody else's claim.
   - Signature valid and everything matches, but the signer is not `ACTIVE`, is not an executor in that fleet, does not fit the offer, or cannot provide the tier the work needs on that device: delete it and send a `ViolationReport` to the authority with the signed claim as evidence. The authority verifies the evidence itself and suspends the device.
   - Signature valid and in order, but earlier than the claimant's turn by more than one rank on the dispatcher's own ranking: delete it and count it. Three early claims from one device inside an hour are reported the same way. One rank of tolerance covers honest differences of view.
   - Otherwise the claim stands.
5. **Order.** The dispatcher asks the work kind to prepare the order for that claimant, seals the secret part to the claimant's `SEAL` key with the order id and `MemberId` as associated data, signs the whole, and publishes to `fleet.order.<MemberId>`.
6. **Verify and run.** The executor accepts an order only if all of these hold: the envelope verifies against the `SIGN` key of a device that the registry lists as `DISPATCHER` in the order's fleet; the order names this device; this device holds the claim for that work digest; the order id has not been seen before; the offer inside is unexpired; kind, repository, ref and workflow digest are allowed by its own verified copy of fleet policy; for submitted work, the `WorkSubmission` verifies against the authority; and the sandbox tier is at least what [Sandbox tiers](#sandbox-tiers) requires for the trust class this device derives. It then opens the sealed part and starts the work in a fresh sandbox.
7. **Start fence.** For `github-actions-job`, a pre-job hook inside the sandbox posts what GitHub's own job context says (repository, ref, actor id, event name, whether the head repository is a fork, job id) to the device's agent over the order's control endpoint before any step runs. The agent recomputes the trust class from those facts and allows the job only if the repository is the order's, fleet policy allows the ref, and the sandbox tier is still adequate. GitHub may assign the runner a different job of the same label than the one offered; that is allowed when it passes the same checks, and the receipt records the job actually run. A job that fails the fence is stopped before its first step. This is how a device defends itself against a dispatcher that mislabels work, and it is the one part of #1688 that is kept. The hook exits 41 (refused), 42 (conflict) or 43 (agent unreachable, fail closed). The work key is `<repo>#<jobId>@<runAttempt>` in both the offer and the hook.
8. **Receipt.** The executor publishes signed `WorkReceipt`s (`STARTED`, then `SUCCEEDED`, `FAILED`, `CANCELLED`, `ABANDONED` or `REFUSED` with a reason) to `fleet.event.<MemberId>.receipt`.

**Who records it.** The authority, not the dispatcher, reads offers, claims, orders (their signed, unsealed part) and receipts from the bus, verifies each envelope, and appends the `fleet-work-<WorkDigest>` events, the audit entries and the usage events. From receipts it computes each device's reliability and publishes it in the fleet view. A dispatcher writes nothing to the journal.

**No single point of failure.** Several dispatchers may serve one fleet; for each unit of upstream work they rank among themselves the same way, so exactly one normally offers it and another takes over one step later. A device that is both dispatcher and executor (the box worker) offers to the fleet and may claim its own offer. With no NATS it runs alone on work it can see itself, as it does today. GitHub remains the single assigner of each job, so the worst result of a disagreement is still an idle sandbox, never a job run twice. With the authority down, work continues; recording catches up from the streams when it returns.

**Dispatcher duplicates.** Two dispatchers that both mint a runner for one claim cost one idle registration; GitHub's single assignment decides.

### One-active fleets: the assignment register

A `ONE_ACTIVE` fleet has exactly one active member at a time, and the fleet itself holds the record of which. This is the storage-backend register that `@hobo/backend-fleet` held, moved into `@hobo/fleet` unchanged in algorithm, so that the cache fleet, a Postgres fleet and any future one-active fleet share one implementation.

**Local mode only.** A one-active fleet is run by the process that writes its members' stores: the cache fleet in the relay, the Postgres reconcile. The authority runs no one-active loop, serves no override, and refuses `defineFleet` with `ONE_ACTIVE` (`fleet-policy`, `detail.rule = "one-active-authority"`); authority-mode one-active fleets are out of scope for this design (ADR-0183 D39).

**What it is.** Every member keeps a small append-only log (a **replica**). An entry names the active member for one **epoch**. An epoch is decided when a majority of the fleet's members hold the same entry for it, and the current assignment is the highest decided epoch. Three local rules carry all the safety, exactly as in `packages/backend-fleet/src/assignment.ts:1-30`:

1. A member holds at most one entry per epoch.
2. A member takes an entry for epoch `e` only when its highest entry is `e - 1`, checked and written atomically on that member.
3. An entry that names a member as active is written to that member first, and to no other if it does not take it.

A reader needs answers from a majority; with fewer, or with an undecided newest epoch, the answer is `no-majority` or `undecided` and the caller stops. Planned moves seal the fleet first (nobody is active), then activate the target.

**What moves, under what name.** `proposeAssignment`, `resolveAssignment`, `readCurrentAssignment`, `completeAssignment`, `bootstrapAssignment`, `overrideAssignment`, `rejoinAssignmentReplicas`, `ephemeralAssignmentReplica` and the `AssignmentReplica` port keep their names and behaviour, in `@hobo/fleet/assignment`. The replica over one cache key uses the core `EphemeralStatePort`, as it does now; the SQL replica stays in `@hobo/data-postgres` and has a nullable `members` column.

**The stored log stays readable both ways.** The format-1 value is `FleetAssignmentLog { uint32 format = 1; repeated FleetAssignment entries = 2 }` as protobuf JSON, and the format-1 decoder refuses any `format` other than 1 and any unknown JSON field (`ephemeral-replica.ts:143-160`). The new `AssignmentLog` and `Assignment` keep those field numbers, names and types exactly (`uint64` epoch, decision time and loss window, so JSON strings; `optional` active and target) and add one field, `members`. `encodeAssignmentLog` writes `format: 1` with no `members` while no entry carries a member set, which is byte for byte what today's encoder writes, and `format: 2` once one does; `decodeAssignmentLog` reads both and refuses `members` under format 1. A fleet writes member sets only when its policy sets `membership_epochs`, which the relay turns on at the last step of the cutover ([install and upgrade](../maintenance/fleet/install-and-upgrade.md)). Until then the previous relay reads every log the new one writes, so the cutover can be reversed.

**What changes, and why.**

1. **The candidates come from the registry; the deciding set comes from the log.** The registry's `ACTIVE` members of the fleet, by name, are the *candidates*: the members the loop proposes to admit. Which members *decide* an epoch is never read from the registry or from configuration once a member set has been decided; it is read from the log (item 2). In local mode the registry is rebuilt from configuration at every cold start, so it can only propose; it mirrors the decided set by showing a candidate as part of the assignment only once the entry admitting it is decided.
2. **A membership change is itself a decided epoch** (when the fleet's policy sets `membership_epochs`). Without membership epochs, adding or removing a backend changes the majority size silently. The rules:
   - Every entry written with membership epochs on carries `members`, the sorted set that decides the *next* epoch. An ordinary entry copies its predecessor's set. A membership entry changes exactly one name and says which in its `reason` (`admit:<name>` or `remove:<name>`), and copies the active, sealed and target values of its predecessor.
   - **The set that decides epoch `e` is the `members` of decided epoch `e − 1`.** A reader derives it from entry `e` alone, so it still reads only the newest entry (`readCurrentAssignment` reads with limit 1, as today, and a log reseeded by `rejoinAssignmentReplicas` needs nothing older): for an ordinary entry it is `e.members`; for a membership entry it is `e.members` without the admitted name or with the removed name. A proposer computes `e.members` from decided `e − 1`, so all contenders for one epoch derive the same deciding set; where a reader also holds `e − 1`, a mismatch is a record error. `resolveAssignment(members, replies)` keeps its signature: `members` is who was asked, and the majority is counted over the deciding set; a member of the deciding set with no replica (removed from configuration before its removal was decided) counts as silent. `assignmentKey` includes `members`, so two entries differing only in their set are different decisions.
   - **Base case.** An entry with no `members` (every entry written before membership epochs are on, including every format-1 log and the `bootstrap` entry, which stays the same bytes whoever writes it) is decided by the configured set, as today. The first tick after `membership_epochs` is turned on proposes a **pin** entry: the current value, `reason: "pin-members"`, `members` = the sorted configured set, decided by the configured set. No membership change is proposed before the pin is decided. This needs every instance of the fleet to run one configuration while the pin is being decided, which holds for the relay (one deploy reads one configuration) and is stated in the runbook.
   - **Change.** After the pin, a candidate that is not in the decided set is admitted, and a decided member that is no longer a candidate is removed, one name per epoch through `proposeMembership`, each decided by the old set. Two decided sets therefore differ by at most one name, which is what makes any two majorities intersect. The active member and a sealed fleet's target are never removed (the loop first moves the fleet away), and the last member is never removed.
3. **Who decided is a process name.** `decided_by` stays free text naming the proposing process (`service:<name>`, or `bootstrap`). Entries are unsigned: only local mode runs a one-active fleet, and whoever can write the assignment key can already write everything the fleet stores (ADR-0183 D7). `overrideAssignment` stays a function for the host that owns the register; there is no route for it.
4. **Health is decided in one place; ranking is unchanged.** The register and `eligibleForActive` ([Observations, capacity and reliability](#observations-capacity-and-reliability)) are in `@hobo/fleet`. Deciding *whether* to keep, hold, switch or fail over, and *which* eligible member to prefer, is cost-based choosing and lives in `@hobo/backend-routing`. `decideFleet` and `routeFleetByBudget` keep their names, their outputs and their ranking, including today's preference in a failover for an affordable standby over a fresher one, which is a routing choice. What changes: each calls `eligibleForActive` (mode `failover` when the active member is failing, `switch` otherwise) instead of testing health itself, and takes each member's eligibility and reasons from it; `decideFleet` still returns every standby with its reasons (it reports `not-ready` as its existing `schema-not-current`), and `routeFleetByBudget` still lists unobserved and unreachable members with theirs and still lets a failover take a reachable member whose cost is unknown. Their input types change in one way only: `FleetDecisionInput.observations` and `FleetRoutingInput.observations` become `NamedObservation`s ([the ports](../../packages/fleet/src/ports.ts)) in place of `FleetObservation` and `FleetRoutingObservation`. The existing tests of both functions move with them and change only where they construct observations; the outputs they assert are unchanged.
5. **The health thresholds are fleet policy.** `failover_after_ms` and `recovery_point_ms` are fields of the fleet's `FleetPolicy`. The routing inputs keep their fields `FleetPolicy.rpoMs`, `FleetPolicy.failoverAfterMs` (routing package) and `FleetRoutingMarks.failoverAfterMs`; the host fills them from the fleet's policy. An unset `recovery_point_ms` means the members hold no replicated state (cache backends) and lag is never considered. The money thresholds (`exhaustionHorizonMs`, `hysteresisFactor`, `minDwellMs`, `switchAt`, `switchBackBelow`) stay with the routing package.

**A tick, for any one-active fleet.** With one member there is no register: `active()` answers that member and `tick()` returns `single` without reading or writing anything (`cache-fleet.ts:345,611`). Otherwise: read replies; complete an undecided epoch; re-admit a member whose log was lost (`rejoinAssignmentReplicas`, through `seed` where a replica has it); refresh log lifetimes (`refresh`, where a replica has it); on an empty register, bootstrap the first configured member; with membership epochs on, pin or change the member set; observe every member; if the fleet is sealed, activate, keep waiting, or reseal when the target is unreachable (asking `chooseAction` as a failover from the target); otherwise ask `chooseAction` and, on a switch or failover, seal and schedule activation. `createOneActiveFleet` in `@hobo/fleet/assignment` runs this loop over injected ports (the register, an observer, an asynchronous `chooseAction` that receives the members in configured order and computes the workload itself, a scheduler) and reports what it did as a `OneActiveTick` whose `action` is one of today's cache-fleet values (`single`, `bootstrap`, `activate`, `sealed-waiting`, `reseal`, `keep`, `hold`, `switch`, `failover`, `no-majority`, `undecided`) or `membership`. The cache fleet and the Postgres reconcile both become callers of it instead of each owning a copy of the loop.

### Sandbox tiers

A sandbox is single-use: created for one order, destroyed after it, sharing no writable state with any other order.

| Tier | Boundary | Mechanism shipped | Docker inside |
|---|---|---|---|
| `S1_CONTAINER` | Hardened container, shared host kernel | Rootless OCI runtime; all capabilities dropped; default seccomp profile; `no-new-privileges`; pids, memory and CPU limits; read-only root with a tmpfs work directory; no host mounts except a read-only source cache; no host Docker socket; network only through the agent's egress proxy | No, except on a `DEDICATED` device in a fleet with `allow_host_docker: true` |
| `S2_USER_KERNEL` | User-space kernel | The same driver with the gVisor runtime | No |
| `S3_MICROVM` | A virtual machine per order | Linux with KVM: a Kata Containers runtime class. macOS 26 on Apple silicon: Apple's `container` tool. The virtual machine has its own Docker daemon | Yes |

**Egress.** Every tier routes outbound traffic through a proxy in the agent that allows only the hosts the order names plus the fleet's allowlist, and always blocks link-local and cloud metadata addresses.

**The trust class is derived on the device, from facts it can check.** For an order the device is about to run:

- `UNTRUSTED` if the offer says so, or its `origin` is not `INTERNAL`.
- Otherwise `OWN` if the offer's `author` is one of the linked identities of this device's owner, as recorded in the device's own member record.
- Otherwise `ORG`.

A dispatcher never asserts `OWN`. For submitted work the author is inside the authority's signed `WorkSubmission`. For GitHub work the start fence re-derives the class from GitHub's own job context before any step runs ([Many-active fleets: offers, claims, orders and receipts](#many-active-fleets-offers-claims-orders-and-receipts) step 7).

| Trust class | `PERSONAL` device | `DEDICATED` device | `EPHEMERAL` device |
|---|---|---|---|
| `OWN` | `S1` or higher | `S1` or higher | `S1` or higher |
| `ORG` | `S3` only | `S3`; `S1` or `S2` only if the fleet sets `org_min_sandbox` lower and names the repositories | `S1` or higher |
| `UNTRUSTED` | Never | Never | `S3` |

An `UNTRUSTED` order's sealed part may hold only the single-use bootstrap credential its work kind needs in order to start (for GitHub, the runner registration); the dispatcher attaches nothing else, and GitHub itself withholds repository secrets from fork runs. A device advertises the tiers it can actually provide, found by a self-test at start; a Windows device provides `S1` only and so runs `OWN` work only.

If GitHub assigns a just-in-time runner a job that fails the fence, that job fails before its first step. Fleets avoid this by serving distinct labels for distinct trust levels: a fleet whose policy admits only internal refs registers runners under a label that workflows use only for those refs, and the route job never sends fork runs to it.

Sandbox tier and device class are operator-side traits in the sense of ADR-0145.

### Transport

Coordination never needs a direct connection. Transport exists for three things: an interactive shell or attach into a running order, a port forward to something a device serves, and bulk transfer of caches and artifacts between devices.

`FleetTransport` is a port with three adapters, tried in this order:

1. **`p2p`** (`@hobo/fleet-p2p`): direct QUIC between devices, dialled by the endpoint id in each device's key bundle, with hole punching and encrypted relay fallback through relays HoBo runs. The public relays are never used.
2. **`overlay`** (`@hobo/connectivity`): where a tenant already runs Tailscale, NetBird or WireGuard, a TCP stream over the overlay address. The join credential is minted by the authority at enrollment through the overlay provider's API and returned inside the enrollment response; `HOBO_TAILSCALE_AUTHKEY` and every other static overlay key are removed.
3. **`bus-relay`** (`@hobo/fleet-nats`): frames over `fleet.relay.<toMemberId>.<sessionId>`, always available, slowest. End-to-end encrypted with keys agreed from the two `SEAL` keys and the session id, so the bus sees ciphertext and a forged publish fails authentication.

**Authorisation is the same for all three.** Opening a session needs a `SessionGrant` from the authority naming both parties (each with its transport identity and seal key), the purpose (`SHELL`, `FORWARD`, `BLOB`), an optional target (order id, port, blob digests) and an expiry. The accepting device verifies the grant's authority signature, that the peer's proven transport identity is the one in the grant, that both members are `ACTIVE`, and that fleet policy allows the purpose. A person's CLI obtains a grant with their person token; the shell runs inside the order's sandbox, never on the host. Both sides publish a signed session-close fact with byte counts.

**Blob transfer** is content-addressed (SHA-256), verified by the receiver, and limited to digests named in a grant.

### Policy, tenancy and residency

- **Tenant** is the core `TenantId`. One tenant, one NATS account, one registry. Nothing crosses tenants. An authority serves many tenants; a request's tenant comes from its token, and unauthenticated discovery names it in the path.
- **Principals.** A `PrincipalDirectory` maps a signed-in principal to the tenants it may act in and its tags there (for example `fleet-admin`, `fleet-approver`, `auditor`). The shipped implementations read identity-provider group claims, GitHub organisation roles, and the authority's configuration.
- **Every governed action** is a `PolicyRequest` to the core `PolicyEngine`, and its outcome is recorded as a `policy.Decided` event built by `@hobo/policy` `createPolicyDecidedEvent` (injected as `PolicyDecisionRecorder`, because the contract-layer `@hobo/fleet` may not import `@hobo/policy`). `policy.Decided` is never retried (ADR-0136). The actions: `fleet.define`, `fleet.policy.change`, `fleet.member.invite`, `.declare`, `.approve-key`, `.accept`, `.reject`, `.assign`, `.suspend`, `.resume`, `.unlock`, `.revoke`, `fleet.session.grant`, `fleet.work.submit`, `fleet.trust.rotate`.
- **Fleet policy** is a record ([the records](../../packages/fleet/data-models/)): coordination mode, approval mode, allowed member kinds, roles and device classes, minimum attestation tier, sandbox minimums, allowed work kinds, repository, ref and workflow-digest rules, OIDC trust rules, device-certificate trust roots, egress allowlist, member quota per principal, minimum agent version, key-bundle lifetime, health thresholds, residency constraint, `allow_host_docker`, allowed session purposes, the runner labels it serves.
- **Residency.** A member declares its region at enrollment. Where a fleet or an offer carries a residency rule, the dispatcher calls `evaluateResidency` with the member's region and excludes it unless the result is `ok` (ADR-0146); the device repeats the check for itself. An undeclared or unmapped region excludes.
- **Environment membership** (`@hobo/connectivity` `EnvMembership`) refers to a member id. A membership whose member is not `ACTIVE` is ineffective.

### Audit, metering and observability

**Recording.** The authority runs a recorder that reads offers, claims, the signed part of orders, receipts, observations summaries and session-close facts from the bus, verifies each envelope, and appends events to the journal. Together with the authority's own enrollment, policy, credential and grant events, that is the complete history.

**Audit.** Every journal event becomes an entry in a hash chain (`entry_hash = SHA-256(previous_hash ‖ entry_bytes)`) on `FLEET_AUDIT`. Every 60 seconds, or 1,000 entries, the authority signs a checkpoint. A checkpoint is final only when co-signed by the **witness**: a separate process with its own key and its own NATS user. The witness reads the entries itself, recomputes the chain from its last co-signed checkpoint, and also watches `fleet-registry`: it refuses to co-sign while any registry change it saw has no matching audit entry. A **registry change** is a value whose record sequence the witness has not seen for that key (`record_sequence` of a member record, `revision` of a fleet record, `sequence` of the trust record); it is **matched** by an audit entry with the same `subject` (the registry key) and `subject_sequence`. The authority re-signs member and fleet records every 10 minutes and before `not_after` with the sequence unchanged, so a re-sign is not a change and is ignored; a record's sequence increases exactly when its content other than `issued_at` and `not_after` changes. So an authority, or someone holding its key, cannot rewrite history or change the registry quietly. The witness co-signs a trust record the same way: the authority publishes the new, authority-signed `TrustRecord` on `fleet.audit.trust` (only `hobo fleet ops rotate-key` does this, under the governed action `fleet.trust.rotate`); the witness co-signs it only if its `sequence` is one above the pinned record's, it verifies against a pinned authority key, and a `fleet.TrustRotated` audit entry whose data digest matches it is already in the chain. Final checkpoints are exported as CloudEvents to the tenant's configured sink. `hobo fleet audit verify` recomputes the chain and checks both signatures. In the standalone profile the witness runs on the same host as the authority, under a different operating-system account; that protects against a database writer, not against whoever controls the host, and the profile's documentation says so.

**Metering.** Core `UsageEventType` gains four types, all emitted by the authority so that nothing bills itself: `fleet.member.active` (member-hours, from registry state), `fleet.work.sandbox` (sandbox-seconds by tier, from receipts), `fleet.transport.relay` and `fleet.transport.direct` (bytes, from the acceptor's session-close fact, cross-checked against the initiator's).

**Logs and events.** The repository convention holds: `log(event, fields)` with names `hobo_fleet_*`, each mapped to a CloudEvent type in the `fleet.*` family ([Event family](#event-family)). Spans use the existing OTLP JSON writer.

**Service levels.** The latency and correctness objectives are verified by the acceptance soak (`pnpm run fleet:soak`). The availability objectives cannot be verified by a soak: the authority publishes its availability events to `@hobo/status-page`, and they are measured in production from there. Before cutover only the emission of those events is checked.

| Objective | Target | Verified by |
|---|---|---|
| Enrollment API availability | 99.9% monthly | Measured in production from the status page; not verified before production (the soak checks only that the events are emitted) |
| New NATS connection authorised | 99.95% monthly | Measured in production from the status page; not verified before production |
| Callout decision latency | p99 under 300 ms | The soak (`callout_p99_ms`) |
| Revocation takes effect for ranking and orders, on live readers | under 5 s | The revocation tests of `@hobo/fleet` |
| Revocation takes effect at the bus | under 10 min, without relying on a disconnect | The revocation tests of `@hobo/fleet` |
| First claim after an offer, healthy fleet | p95 under 2 s after the first rank's turn | The soak (`first_claim_p95_ms`) |
| Authority recovery after losing one replica (high-availability profile) | no event lost; under 60 s | The soak (`events_recorded`, `recovery_s`) |

### Surfaces

**HTTP** (authority; bodies are protobuf JSON of the named record from [the records](../../packages/fleet/data-models/); errors in [Errors](#errors)). "Person" means a person token; "device" means a member SVID; both with DPoP.

| Method and path | Auth | Request → response |
|---|---|---|
| `GET /.well-known/hobo-fleet` | none | → `AuthorityDiscovery` |
| `GET /v1/fleet/tenants/{tenant}/discovery` | none | → `Discovery` |
| `GET /v1/fleet/jwks` | none | → JWKS |
| `POST /v1/fleet/signin/start` | none | `SignInStart` → `SignInChallenge` |
| `GET /v1/fleet/signin/callback?state=&code=` | the sign-in provider's redirect | `SignInCallback` (query) → redirect to `GET /v1/fleet/approve/{state}` |
| `POST /v1/fleet/signin/device` | none (the person at the verification page) | `SignInDeviceCode` → `SignInChallenge` (the provider's authorize URL) |
| `GET /v1/fleet/approve/{state}` | the browser session the callback set | → `ApprovalView`, rendered as a page |
| `POST /v1/fleet/approve/{state}` | the same browser session | `ApprovalDecision` → `ApprovalResult` (a redirect to the CLI's loopback address; empty for the device flow) |
| `POST /v1/fleet/signin/complete` | DPoP with the CLI's sign-in key | `SignInComplete` → `PersonCredential` |
| `POST /v1/fleet/signin/device/poll` | DPoP with the CLI's sign-in key | `SignInPoll` → `PersonCredential`, or `sign-in-pending` |
| `POST /v1/fleet/signin/refresh` | person | `SignInRefresh` → `PersonCredential` |
| `POST /v1/fleet/tokens` | person | `TokenCreateRequest` → `TokenCreateResponse` |
| `GET /v1/fleet/tokens`, `DELETE /v1/fleet/tokens/{hash}` | person | → `TokenList` (`DELETE` answers the list after removal) |
| `POST /v1/fleet/members` | DPoP proof with the identity key, plus a token, a person token bound to that same identity key, or an OIDC assertion | `EnrollmentRequest` → `EnrollmentResponse` |
| `POST /v1/fleet/members:declare` | person; a device that policy allows to sponsor; or a workload OIDC token matching an `oidc_trust` rule with `sponsor` set | `DeclareRequest` → `EnrollmentResponse` |
| `POST /v1/fleet/members/{id}/approve-key`, `/accept`, `/reject`, `/suspend`, `/resume`, `/unlock`, `/revoke` | person | `LifecycleRequest` → signed `MemberRecord` |
| `POST /v1/fleet/members/{id}/memberships` | person | `MembershipRequest` → signed `MemberRecord` |
| `POST /v1/fleet/members/{id}/credentials` | DPoP proof with the `SIGN` key | `CredentialRequest` → `CredentialResponse` |
| `POST /v1/fleet/members/{id}/keys` | device | `KeyRotationRequest` → signed `MemberRecord` |
| `POST /v1/fleet/members/{id}/leave` | device (itself) | → signed `MemberRecord` |
| `GET /v1/fleet/members`, `GET /v1/fleet/members/{id}` | person, device or account credential | → `MemberList`, signed `MemberRecord` |
| `GET /v1/fleet/fleets`, `GET /v1/fleet/fleets/{id}` | as read | → `FleetList`, signed `FleetRecord` |
| `PUT /v1/fleet/fleets/{id}` | person | `FleetRecord` (policy and mode) → signed `FleetRecord` |
| `GET /v1/fleet/fleets/{id}/view` | as read | → signed `FleetView` |
| `GET /v1/fleet/fleets/{id}/verdict?label=` | as read, or a GitHub Actions OIDC token for a repository the fleet lists | → `FleetVerdict` |
| `POST /v1/fleet/sessions` | person or device | `SessionRequest` → signed `SessionGrant` |
| `POST /v1/fleet/work` | person or account credential | `WorkSubmissionRequest` → `WorkStatus` |
| `GET /v1/fleet/work/{id}`, `GET /v1/fleet/work/{id}/logs` | submitter, or person with read | → `WorkStatus`, `WorkLogs` |
| `POST /v1/fleet/reports` | device with role `DISPATCHER` | `ViolationReport` → `MemberRecord` |
| `GET /v1/fleet/audit/checkpoints`, `GET /v1/fleet/audit/entries?from=&to=` | person with tag `auditor` | → `AuditCheckpoints`, `AuditEntries` |
| `GET /healthz`, `GET /readyz` | none | liveness, readiness |

Every route except `healthz` and `readyz` is exactly one method of `FleetApi` in [the ports](../../packages/fleet/src/ports.ts), which names the method, its request and its response. The service maps routes to those methods and nothing else.

**CLI** (`hobo fleet …`; `fleet` is added to `CANONICAL_VERBS`). The "Calls" column is the contract `packages/hobo/test/fleet-command.contract.test.ts` tests: each command calls exactly these `FleetClient` methods ([the ports](../../packages/fleet/src/ports.ts)), in this order, and the local functions named; "local" means it calls no client method.

| Command | Does | Calls |
|---|---|---|
| `login` | Sign a person in to the authority | `signInStart`, then `signInComplete` (browser) or `signInPoll` until it answers (device code) |
| `logout` | Forget the person token | local: deletes the stored person token |
| `enroll --token-file` / `--oidc` | Generate keys and enroll this device | local key generation, then `enroll` (through `createFleetAgent.enroll`) |
| `enroll --fleet` | The same, signing the person in with the identity key | `signInStart`, `signInComplete` or `signInPoll`, then `enroll` |
| `run [--fleets]` | Run the agent in the foreground | local: `createFleetAgent(...).start()`; the agent itself calls `credentials` |
| `service install\|uninstall\|status` | Install `hobo fleet run` as a systemd unit, launchd agent or Windows service | local: `installService` |
| `status [--fleet]` | Members, state, health, slots, memory, disk, reliability, tier (replaces the table in `hobo ci status`) | `listFleets` (when no `--fleet`), then `fleetView` per fleet |
| `doctor` | Self-test: keys, authority, bus, sandbox tiers available, transport reachability, clock skew | `authorityDiscovery`, `discovery`, `jwks`; local: key store load, `sandboxDrivers`, a bus connect, a transport self-dial |
| `token create\|list\|revoke` | Bootstrap tokens | `issueToken`, `listTokens`, `revokeToken` |
| `member list\|show` | Read members | `listMembers`, `getMember` |
| `member declare` | Declare a backend or target | `declare` |
| `member approve` | Approve a pending device's key | `approveKey` |
| `member accept\|reject\|suspend\|resume\|unlock\|revoke` | Lifecycle | the method of the same name |
| `member assign` | Add a membership in another fleet | `assign` |
| `member rotate` | Replace this device's key bundle or identity key | `rotateKeys` |
| `fleet list\|show\|apply\|verdict` | Fleets and policy (`apply` reads a policy file) | `listFleets`, `getFleet`, `defineFleet`, `fleetVerdict` |
| `connect <member> [--order] [--forward L:R]` | Shell or port forward over a granted session | `grantSession`, then local `FleetTransport.dial` |
| `cp <src> <dst>` | Blob transfer over a granted session | `grantSession`, then local `FleetTransport.dial` and blob fetch |
| `submit --fleet --image --digest -- <args>` | Submit `oci-command` work | `submitWork` |
| `work show\|logs` | Follow submitted work | `workStatus`, `workLogs` |
| `audit verify` | Check the audit chain | `auditCheckpoints`, `auditEntries`, then local `verifyAuditChain` |
| `audit export` | Export the audit chain | `auditCheckpoints`, `auditEntries` |
| `leave` | Revoke this device and delete its keys | `leave`, then local key deletion |
| `ops provision\|ceremony\|rotate-key\|backup\|restore` | Operator tasks ([Deployment, availability and operations](#deployment-availability-and-operations)) | local: `provisionTopology`, `runCeremony`, `rotateKey`, `backup`, `restore` |

**MCP.** The relay's `list_mesh_nodes` tool and `hobo-ci://mesh/nodes` resource are renamed `list_fleet_members` and `hobo-ci://fleet/members` and re-implemented as calls to the authority through the typed client. New read tools `get_fleet_view` and `get_fleet_verdict`. No write tools.

**Environment** (the only variables; everything else comes from discovery)

| Variable | Default | Meaning |
|---|---|---|
| `HOBO_FLEET_AUTHORITY_URL` | none | The authority's origin |
| `HOBO_FLEET_TENANT` | from the token or sign-in | The tenant |
| `HOBO_FLEET_HOME` | `~/.hobo/fleet` | Keys, generation, pinned trust, state |
| `HOBO_FLEET_FLEETS` | all the device is in | Fleets to serve |
| `HOBO_FLEET_SANDBOX` | highest available | Cap the sandbox tier offered |
| `HOBO_FLEET_TRANSPORTS` | `p2p,overlay,bus-relay` | Transport order |
| `HOBO_FLEET_KEYSTORE` | `file` | `file` or `external-signer:<command>` |
| `HOBO_FLEET_NATS_SERVER_BIN` | `nats-server` on `PATH` | Test-only: the server binary for integration tests |

On a developer device these variables apply as listed. On the box daemon, fleet settings come only from committed config (the `fleet` block of `.hobo/ci.json`, beside `runnerRouting`) or from the enrolled `AgentState`, never from the environment (ADR-0181 R2, ADR-0183 D61). Only a file path to the state or the token may come from the process.

Removed: every `HOBO_CI_MESH_*`, `HOBO_CI_NATS_*`, `HOBO_CI_FLEET_STATE`, `HOBO_CI_FLEET_CAPACITY*`, `HOBO_CI_FLEET_ROUTES`, `HOBO_CI_LOCAL_RUNNER`, `HOBO_CI_LOCAL_REPOSITORY`, `HOBO_CI_LOCAL_TRUSTED`, `HOBO_TAILSCALE_AUTHKEY`.

### Deployment, availability and operations

**Two profiles, one codebase**

| | Standalone | High availability |
|---|---|---|
| NATS | One server, replicas 1 | Three servers in one cluster, replicas 3; optional gateways between regions |
| Authority | One replica | Two or more behind a load balancer; all are callout responders in one queue group |
| Event store | SQLite through `createRuntimeLocalEventStore` (ADR-0135: one writer) | `createJournalEventStore` on `FLEET_JOURNAL`: every append is one message holding the batch, with `Nats-Expected-Last-Subject-Sequence` as the compare-and-set, so replicas agree without a leader. Both satisfy `FleetEventStore` ([the ports](../../packages/fleet/src/ports.ts)). A Postgres store is deferred with `@hobo/storage-postgres`, which is not on the base |
| Witness | Same host, different operating-system account | A separate host |
| Peer-to-peer relays | One | Two or more, in different regions |

**State.** The authority's only durable state is the event store. The registry bucket, fleet views and verdicts are rebuilt from it and from live observations. Losing every bucket loses nothing.

**Assets** (all under `deploy/fleet/`, built and attested by the release workflow; see the [release service images runbook](../maintenance/fleet/release-service-images.md)): server configuration templates for both profiles; container images and Compose files; Kubernetes manifests; a systemd unit, a launchd agent and a Windows service definition that run `hobo fleet run`; the peer-to-peer relay; the provisioning job.

**Key ceremony.** `hobo fleet ops ceremony` generates the NATS operator identity key offline and prints it as two shares; it is used only to sign operator signing keys. The operator signing key, each tenant account's static-user credentials and scoped signing seeds, the token-signing key, the authority's record-signing key and the witness key live in the secret store behind `SecretsPort`, one secret per key, each readable by exactly one workload identity. `hobo fleet ops rotate-key <which>` does add, publish, switch, remove, in that order, and is safe to interrupt at any step. Rotating the record-signing key issues a new trust record, which takes effect only with the witness's co-signature.

**Backup and restore.** `hobo fleet ops backup` writes the event store (a consistent SQLite snapshot in the standalone profile, a stream snapshot of `FLEET_JOURNAL` in the other) and `FLEET_AUDIT` to an archive with a manifest of digests. `restore` loads it into a fresh deployment, rebuilds the buckets, and increments the authority **incarnation** carried in every ticket and record, so credentials issued before the restore are refused and every device refreshes.

**Emergency revocation without the authority.** Remove a scoped signing key from the tenant account and push the account. No credential of that template can be minted or renewed until a new key is provisioned. This path uses only the NATS operator tools.

**Supply chain.** Authority and agent images and the `hobo` CLI ship with build provenance and a bill of materials. A fleet's `min_agent_version` is enforced at ranking and at credential refresh.

**Runbooks** (under [`docs/maintenance/fleet/`](../maintenance/fleet/index.md)): install and upgrade; enroll, suspend, unlock, revoke; rotate each key; backup and restore drill; NATS server loss; callout outage; clone alarm; claim-violation alarm; witness outage; relay outage; one-active fleet stuck sealed.


## Contracts

The records are protobuf with CUE constraints in [`packages/fleet/data-models/`](../../packages/fleet/data-models/); the ports are [`packages/fleet/src/ports.ts`](../../packages/fleet/src/ports.ts); each entry point's declarations are snapshotted in its package's `contracts/api.snapshot.d.ts` and checked by `pnpm run fleet:contracts`.

### Signed envelope

```
signature = Sign(key, utf8(context) || 0x00 || payload)
```

`payload` is the protobuf binary encoding of the record, exactly as transmitted. A verifier checks the signature over the received bytes and only then decodes them. Nothing is re-serialised. In JSON transports the envelope is protobuf JSON, so `payload` and `signature` are base64.

| Context | Payload | Signed by | Verified against |
|---|---|---|---|
| `hobo-fleet/trust-record/v1` | `TrustRecord` | Authority and witness | The pinned trust record (rule below) |
| `hobo-fleet/key-bundle/v1` | `KeyBundle` | Device identity key | `identity_jwk` in the member record |
| `hobo-fleet/rotation/v1` | `RotationStatement` | The old device identity key | `identity_jwk` in the member record before the change |
| `hobo-fleet/member-record/v1` | `MemberRecord` | Authority | `TrustRecord.authority_keys` |
| `hobo-fleet/fleet-record/v1` | `FleetRecord` | Authority | same |
| `hobo-fleet/fleet-view/v1` | `FleetView` | Authority | same |
| `hobo-fleet/session-ticket/v1` | `SessionTicket` | Authority | same |
| `hobo-fleet/session-grant/v1` | `SessionGrant` | Authority | same |
| `hobo-fleet/work-submission/v1` | `WorkSubmission` | Authority | same |
| `hobo-fleet/control/v1` | `MemberControl` | Authority | same |
| `hobo-fleet/audit-checkpoint/v1` | `AuditCheckpoint` | Authority, then witness | `authority_keys`, `witness_keys` |
| `hobo-fleet/nats-connect/v1` | `ConnectProof` | Device `SIGN` key | the bundle in the member record |
| `hobo-fleet/observation/v1` | `Observation` | Observer's `SIGN` key | same, for the observer |
| `hobo-fleet/claim/v1` | `Claim` | Device `SIGN` key | same |
| `hobo-fleet/receipt/v1`, `hobo-fleet/log/v1`, `hobo-fleet/session-close/v1` | `WorkReceipt`, `WorkLogChunk`, `SessionClose` | Device `SIGN` key | same |
| `hobo-fleet/offer/v1`, `hobo-fleet/order/v1` | `WorkOffer`, `WorkOrder` | Dispatcher `SIGN` key | the bundle of a member whose membership in that fleet has role `DISPATCHER` |
| `hobo-fleet/host-attestation/v1` | `@hobo/identity` launch measurement, as JSON bytes | Device `SIGN` key | same |

`// public-contract:` each context string. A change to what any record means needs a new version suffix. A verifier accepts a record only under the one context listed for it.

**Sealing.** `seal(recipient, plaintext, context, associatedData)`: generate an ephemeral X25519 key; `key = HKDF-SHA-256(ikm = X25519(ephemeral, recipient), salt = ephemeral_public ‖ recipient_public, info = utf8(context), 32 bytes)`; encrypt with ChaCha20-Poly1305, a random 12-byte nonce, and additional data `utf8(context) ‖ 0x00 ‖ associatedData`. Order secrets use context `hobo-fleet/order-secret/v1` and associated data `order_id ‖ 0x00 ‖ member_id`. `sessionKeys` is `HKDF-SHA-256(ikm = shared secret, salt = utf8(session_id), info = "hobo-fleet/session/v1/i2a" or ".../a2i", 32 bytes)`.

**The trust anchor.**

- A device receives its tenant's `TrustRecord` in a `WitnessedEnvelope` at enrollment, over TLS from the authority origin the person configured, and stores it. That is the pin.
- `acceptTrust(pinned, next)` accepts a new record only if its `sequence` is higher, its authority signature verifies against a key in the **pinned** record's `authority_keys`, and its witness signature verifies against a key in the **pinned** record's `witness_keys`. A leaked authority key alone cannot replace the trust record.
- Every `RegistryView` verifies each record's envelope against the pinned trust, rejects one past its `not_after`, and rejects one whose `record_sequence` (or `revision`) is lower than the highest it has seen for that key in this process. A reader that has just started can therefore be shown a record at most 30 minutes old; that is the stated bound on a rollback by whoever controls the bus.

### Event family

All events are in one new family, `fleet.*` ([event families](./event-families.md)). Streams are on the core `EventStore` port. In local mode the store is in memory and nothing is exported.

| Stream id | Events | Written by |
|---|---|---|
| `fleet-token-<sha256>` | `fleet.TokenIssued`, `fleet.TokenConsumed`, `fleet.TokenRevoked` | Enrollment commands. Single use is a compare-and-set on this stream |
| `fleet-thumbprint-<thumbprint>` | `fleet.ThumbprintBound` | Enrollment and rotation. A second bind to a different member is refused |
| `fleet-member-<MemberId>` | `fleet.EnrollmentRequested`, `fleet.MemberDeclared`, `fleet.KeyApproved`, `fleet.EnrollmentAccepted`, `fleet.EnrollmentRejected`, `fleet.MemberActivated`, `fleet.MembershipAssigned`, `fleet.CredentialsIssued`, `fleet.KeysRotated`, `fleet.IdentityKeyRotated`, `fleet.MemberSuspended`, `fleet.MemberResumed`, `fleet.MemberLocked`, `fleet.MemberUnlocked`, `fleet.MemberRevoked`, `fleet.ViolationReported` | Enrollment commands. `fleet.CredentialsIssued` carries the ticket id, generation and nonce digest, never a token |
| `fleet-fleet-<FleetId>` | `fleet.FleetDefined`, `fleet.FleetPolicyChanged` | Fleet commands. One-active assignments are not events: they live in the members' own logs, in local mode ([One-active fleets: the assignment register](#one-active-fleets-the-assignment-register)) |
| `fleet-signin-<state>` | `fleet.SignInStarted`, `fleet.SignInAuthenticated`, `fleet.SignInApproved`, `fleet.SignInCompleted` | Sign-in (start, provider callback, the person's confirmation, the code or poll exchange); shared by replicas, each step single use by compare-and-set |
| `fleet-person-<principal digest>` | `fleet.PersonSignedIn` | Sign-in |
| `fleet-session-<sessionId>` | `fleet.SessionGranted`, `fleet.SessionClosed` | Grant command; the recorder |
| `fleet-work-<WorkDigest>` | `fleet.WorkSubmitted`, `fleet.WorkOffered`, `fleet.WorkClaimed`, `fleet.WorkOrdered`, `fleet.WorkStarted`, `fleet.WorkSucceeded`, `fleet.WorkFailed`, `fleet.WorkCancelled`, `fleet.WorkAbandoned`, `fleet.WorkRefused` | The submit command; the recorder, from verified envelopes on the bus. Each recorded event's `meta` carries the bus stream and sequence it came from; on start the recorder resumes each subscription from `{ after: <highest recorded> }` (`BusStart`) |
| `fleet-trust` | `fleet.TrustRotated` | Key rotation |
| `fleet-audit` | `fleet.AuditCheckpointed` | The audit chain |
| policy decisions | `policy.Decided` | Through the injected recorder; never retried |

Commands are the methods of `EnrollmentAuthority`. Each reads its stream, decides, and appends with `expectedSeq`, retrying on conflict up to 8 times. Each command is idempotent on its natural key (a token, a `(generation, nonce)` pair, an order id), so two authority replicas interleaving on one store agree. Projections: the registry (per member and per fleet, published to `fleet-registry`), fleet views and verdicts, reliability per device, work status, and the audit chain. Every projection is rebuilt by replay; snapshots are caches. The read stores are the `fleet-registry` and `fleet-views` buckets and, for work logs, `FLEET_EVENTS`.

Log event names (`FleetLogEvent`): each `hobo_fleet_<snake_case>` maps to `fleet.<PascalCase>` for the events above, plus operational ones with no stream: `hobo_fleet_bus_status`, `hobo_fleet_observation_rejected`, `hobo_fleet_offer_unfit`, `hobo_fleet_claims_unreachable`, `hobo_fleet_claim_discarded`, `hobo_fleet_capacity`, `hobo_fleet_capacity_exhausted`, `hobo_fleet_capacity_restored`, `hobo_fleet_callout_refused`, `hobo_fleet_transport_selected`, `hobo_fleet_sandbox_unavailable`, `hobo_fleet_update_required`, `hobo_fleet_clock_skew`, `hobo_fleet_assignment_tick`, `hobo_fleet_assignment_sealed_too_long` (a one-active fleet sealed for longer than twice `sealWaitMs`, F24), `hobo_fleet_witness_lag` (three checkpoints in a row left without a co-signature, F13), `hobo_fleet_witness_refused` (the witness refused a checkpoint or trust record, with the reason, F12).

### Errors

`FleetErrorCode` is a closed union. HTTP status in brackets.

| Code | Meaning |
|---|---|
| `invalid-request` [400] | The body does not parse or breaks a constraint |
| `unauthenticated` [401] | No valid token, proof or sign-in; a self-minted token |
| `proof-invalid` [401] | A DPoP proof or envelope signature failed |
| `proof-replayed` [401] | The proof's or assertion's id was seen before |
| `forbidden` [403] | Policy denied the action; `detail.decision` is the decision id |
| `token-invalid` [401], `token-used` [409], `token-expired` [410] | Bootstrap token problems |
| `fleet-unknown` [404], `member-unknown` [404], `work-unknown` [404] | |
| `fleet-policy` [403] | The request is outside fleet policy; `detail.rule` names which |
| `quota-exceeded` [429] | The principal's member quota for the fleet |
| `attestation-insufficient` [403] | Below the fleet's minimum tier |
| `key-known` [409] | The identity key has been bound to a member before |
| `approval-pending` [409] | The member is `PENDING` |
| `member-suspended` [403], `member-locked` [423], `member-revoked` [410] | |
| `generation-mismatch` [423] | The clone alarm; the member is now `LOCKED` |
| `incarnation-stale` [401] | A credential from before a restore |
| `agent-outdated` [426] | Below `min_agent_version` |
| `conflict` [409] | Compare-and-set lost after retries |
| `residency-denied` [403] | `evaluateResidency` refused |
| `evidence-invalid` [400] | A violation report whose evidence does not prove the violation |
| `sandbox-inadequate` | The device cannot provide the tier the work needs |
| `order-invalid` | An order failed verification on the device; `detail.check` names which |
| `assignment-mismatch` | The start fence refused |
| `session-denied` | A transport accept refused |
| `no-majority`, `undecided` | The one-active register cannot answer |
| `sign-in-pending` [428] | The device-code sign-in has not been confirmed yet; poll again after `interval_seconds` |
| `name-taken` [409] | The name is already used by another member of that fleet |
| `unavailable` [503] | A dependency is down; safe to retry |


## Failure scenarios

| # | Failure | What happens | Bound |
|---|---|---|---|
| F1 | Authority down | Running work continues. Devices keep their bus connection until its 10-minute credential expires, then run standalone: a dispatcher-executor keeps taking the work it can see itself; a plain executor idles. No enrollment, refresh or recording; recording catches up from the streams afterwards | Recovery under 60 s in the high-availability profile |
| F2 | Every callout responder down | Existing connections continue; new connections fail. Same as F1 after 10 minutes | Two or more responders in one queue group |
| F3 | One NATS server lost (cluster of three) | Clients reconnect to another. Streams stay available at replicas 3 | No loss |
| F4 | NATS quorum lost or all servers down | Claims and offers stop. A dispatcher-executor runs standalone as today; duplicate starts are bounded by GitHub's single assignment. Receipts queue on disk in the agent and are published on reconnect | Duplicate start-up work only |
| F5 | Registry or view bucket lost | Rebuilt by the authority from the event store and live observations | Minutes; nothing lost |
| F6 | Event store lost | Restore from backup; incarnation increments; every device refreshes; members enrolled after the backup enroll again | Recovery point of the last backup in the standalone profile; zero in the other |
| F7 | Device key copied | When both copies have refreshed once, the generations diverge and the device is `LOCKED`. A copy of a device that stays off works until the original returns | One refresh interval (10 minutes) when both are online; unbounded for an offline original. Suspend lost devices; use a held key |
| F8 | Bootstrap token leaked before use | Whoever uses it first is `PENDING` or `ACTIVE` under the invited name; the real device gets `token-used` and the person sees an unfamiliar fingerprint | Token lifetime; revoke the member |
| F9 | Enrolled device turns hostile | It can lie in its observations (it loses measured reliability); claim at its own legitimate turns, receiving that work's bootstrap secret in a sandbox tier policy allows; claim early or out of fleet (the claim is deleted within one dispatcher beat and, on its own signature, it is suspended). It cannot read others' orders, write the registry, delete others' consumers or open an ungranted session | Its share of work by rank, until suspended |
| F10 | Dispatcher compromised | It can offer and order only what fleet policy allows, to devices that hold the claim and that re-derive the trust class themselves; it holds upstream credentials, which are rotated; revoke its membership | Revocation under 5 s for orders |
| F11 | NATS administrator hostile | Can delay, drop, replay within expiry, and show a freshly started reader a registry record up to 30 minutes old. Cannot forge a registry record, view, order, grant, observation or trust record | Availability; a 30-minute window on revocation for readers that restart inside it |
| F12 | Authority record-signing key leaked | The holder can sign registry records until rotation. It cannot replace the trust record (the witness must co-sign) and cannot hide what it did (the witness refuses a checkpoint while a registry change has no audit entry, and alarms). Rotate, increment the incarnation | Until rotation; detected within one checkpoint interval |
| F13 | Witness down | Checkpoints are signed by the authority but not final; an alarm fires after three; trust rotation waits; nothing else stops | Operator action |
| F14 | Peer-to-peer relays down | Transport falls to overlay, then to the bus relay | Slower sessions |
| F15 | A sandbox driver fails its self-test | The device does not advertise that tier; work needing it goes elsewhere | — |
| F16 | Clock skew on a device | Observations more than six minutes ahead are rejected; DPoP proofs outside ±60 s are rejected; the agent logs its skew against the authority's `Date` header | Device unusable until fixed |
| F17 | No routing slip, or a stale one, for the route job | Routing reads GitHub's queue exactly as today (ADR-0181) | No change |
| F18 | An agent below `min_agent_version` | Not ranked; told `UPDATE_REQUIRED`; refresh refused with `agent-outdated` | — |
| F19 | A refresh response is lost | The device retries with the same generation and nonce and gets the same answer | No lock |
| F20 | Two authority replicas decide concurrently | Compare-and-set on the stream; the loser retries on fresh state | Up to 8 retries, then `conflict` |
| F21 | A majority of a one-active fleet's members is unreachable | `no-majority`: the caller stops rather than guess the previous active member (the cache fleet raises its retryable unavailable error, as today) | Until a majority answers |
| F22 | A one-active member loses its log | `rejoinAssignmentReplicas` seeds it once a majority of the others agree on the current entry | One tick |
| F23 | The configured member list of a local-mode fleet changes | With `membership_epochs` on, the fleet proposes one membership epoch per changed name, decided by the old set, before the new set counts; today's silent majority change no longer happens. Before `membership_epochs` is on (until the last cutover step) the fleet behaves exactly as today | One tick per changed member |
| F24 | A one-active fleet stays sealed (activation never ran) | The next tick activates or reseals; an alarm fires if a fleet is sealed for longer than twice `sealWaitMs` | One tick |

## What this replaced

Every earlier fleet, mesh, overlay, membership and enrollment implementation
was moved into these packages or deleted; none remains as a second
implementation. `pnpm run fleet:vocabulary` refuses a reappearance.

| Earlier | Now |
|---|---|
| The compute mesh: `@hobo/ci` `mesh/` (ranking, claim turns, trust list, monitor, reliability, report) and the `mesh-*.ts` files, `mesh.proto` and `mesh:trust`/`mesh:demo` scripts of `@hobo/ci-gh-actions` | `@hobo/fleet/observation`, `@hobo/fleet/work`, `@hobo/fleet/keys` and the registry; `@hobo/fleet-nats` for the bus; `packages/fleet/examples/demo.ts` on the in-memory bus. The hand-edited trusted-key list is gone |
| The local runner (`local-runner.ts`, `LOCAL-DEVELOPMENT.md`) and its variables | An enrolled `PERSONAL` executor running `hobo fleet run` ([quick start](../maintenance/fleet/quick-start.md)) |
| The box worker's mesh wiring and host Docker socket by default | `createFleetAgent` with roles `DISPATCHER` and `EXECUTOR`; the worker's admission is its `CapacitySource`, its poller the `github-actions-job` work source, and its containers carry the `S1` hardening, with the host socket only under `allow_host_docker` |
| Fleet state, capacity and routes in repository variables | `FleetCapacity` and `fleetVerdict`; the route job reads the [routing slip](./adr/routing-slips.md#adr-0181), whose reasons come from `fleetVerdict` on the box and whose leader is rank 0 of `rankMembers` |
| `fleet-v2` (#1688): device and cluster enrollment, the Postgres controller store, the start fence | Fleet enrollment; the start fence and pre-job hook rebuilt in `@hobo/fleet/work` and `@hobo/ci-gh-actions` |
| The hosted fleet verdict and its reporters (#1952, [ADR-0180](./adr/fleet-verdict.md#adr-0180)) | A reporter is an enrolled device, a report is an observation, agreement is `fleetVerdict`. The relay's MCP tools are `list_fleet_members`, `get_fleet_view` and `get_fleet_verdict`, calls to the authority through `@hobo/fleet/client` |
| The delivery agent's enrollment, DPoP and JOSE code in `@hobo/cd` | `@hobo/cd`'s `AgentEnrollment` is a thin adapter over `@hobo/fleet/client`: a reconciler is a device with role `RECONCILER`, `hcd_bt_` tokens are `hft_` tokens, and every Camp is backed by a fleet member (a `DEVICE`, or a `TARGET` the Station declares). `hobo deploy agent …` commands are aliases of `hobo fleet …` |
| Three DPoP and two SVID implementations, one signing with a public default secret | `@hobo/fleet/keys` is the one DPoP implementation; `@hobo/identity` `JwtSvidIssuer` and `loadSecretStoreKms` the one SVID issuer |
| Static overlay keys (`HOBO_TAILSCALE_AUTHKEY`) and unreachable overlay joins | Overlay join credentials minted by the authority at enrollment; `@hobo/connectivity` `createOverlayTransport`; the junction agent is a `JUNCTION` device |
| `@hobo/backend-fleet`: the assignment register, the cache-key replica, backend ids and cost-based choosing | The register and replica in `@hobo/fleet/assignment`, member names and `Health` in `@hobo/fleet`; cost-based choosing in `@hobo/backend-routing` (`decideFleet`, `routeFleetByBudget`, unchanged outputs) |
| The hosted relay's cache fleet loop and `@hobo/data-postgres` reconcile loop | Callers of `createOneActiveFleet` in local mode |
| Provider selection named "fleet" in `@hobo/ci` (`fleet/`, `fleet-overflow.ts`) | [Runner routing](./ci-fleet-balancing.md) (`runner-routing/`, `admission/memory.ts`) |
| The internal mesh in `packages/hobo` (`*.hobo.internal`) | The internal router (`INTERNAL_ROUTER_HOST`, `installInternalRouter`) |

## Related

- [ADR-0183](./adr/fleet.md#adr-0183): the decisions behind this design.
- [Fleet runbooks](../maintenance/fleet/index.md) and the
  [quick start](../maintenance/fleet/quick-start.md).
- [Event families](./event-families.md): the `fleet.*` family.
- [Security and networking](./security-networking.md) and the
  [CLI spec](./cli-spec.md) (`hobo fleet`).
- Package READMEs: [`@hobo/fleet`](../../packages/fleet/README.md),
  [`@hobo/fleet-nats`](../../packages/fleet-nats/README.md),
  [`@hobo/fleet-p2p`](../../packages/fleet-p2p/README.md),
  [`@hobo/fleet-agent`](../../packages/fleet-agent/README.md),
  [`@hobo/fleet-authority`](../../packages/fleet-authority/README.md),
  [deployment assets](../../deploy/fleet/README.md).
