---
type: Competitive Reference
title: "Tailscale — Competitor Reference"
description: "Identity-keyed WireGuard mesh: an adopted adapter behind HoBo's mesh port, and the corpus's proof that connectivity should be a property of identity rather than of addresses."
tags: [hobo, competitors]
competitor:
  slug: tailscale
  name: "Tailscale"
  aliases: ["tailnet", "headscale"]
  primary_category: identity-networking-delivery
  categories: [identity-networking-delivery]
  directness: complementary
  role: "identity-keyed overlay network — an adopted adapter, and the strongest working demonstration that identity, not address, should determine reachability"
  posture: [adopt, provider-target, borrow, benchmark]
  hobo_surface: [identity-secrets, runtime-portability, governance]
  evidence: mixed
  status: active
  research_date: 2026-08-20
  sources:
    - https://tailscale.com/kb/1151/what-is-tailscale
    - https://tailscale.com/kb
    - https://github.com/juanfont/headscale
---

# Tailscale — Competitor Reference

> Captured for HoBo competitive analysis under the HoBo Competitive Research Contract.
> Research date **2026-08-20**. The adapter-level detail — how Tailscale sits behind the `mesh`
> port, ADR-0122's WireGuard floor, the Funnel traffic-routing adapter and the shipped-default gap —
> lives in the [technology reference](../technologies/tailscale.md) and is not repeated here.
> Read alongside [NetBird](netbird.md), the open-source analogue.

## What it is

Tailscale builds a **private WireGuard mesh between machines that authenticate as identities rather
than as addresses**. Its own description: it uses "the open source WireGuard protocol" for
"encrypted point-to-point connections" forming "a peer-to-peer mesh network (known as a tailnet)",
where "only devices on your private network can communicate with each other"
([what is Tailscale](https://tailscale.com/kb/1151/what-is-tailscale)).

- **Product boundary.** Connectivity and network-level access control. It does not deploy, host, or
  run workloads.
- **Operating model.** Commercial SaaS coordination plane with open-source clients; **Headscale** is
  a third-party self-hosted coordination server.
- **The differentiator is that it eliminates network configuration as a category.** Connections
  "work seamlessly across firewalls and Network Address Translation (NAT) without requiring port
  forwarding or complex firewall rules". The absence of that work is the product.

## Core primitives and mental model

| Primitive | What it is |
| --------- | ---------- |
| **Tailnet** | The private mesh; membership is by identity, and non-members have no route |
| **Node / tag** | A device or service, optionally carrying machine identity tags rather than a user's |
| **ACL grants** | A declarative policy file keyed on users, groups and tags — reviewed like code |
| **MagicDNS** | Stable names for nodes, so addresses stop being a thing anyone types |
| **DERP relay** | Encrypted fallback path when direct NAT traversal fails |
| **Subnet router / exit node** | Bridges to non-Tailscale networks, or routes all traffic like a classic VPN |
| **Funnel / Serve** | Public internet exposure, or tailnet-scoped exposure, of a local port with TLS at the edge |
| **Tailnet lock** | Cryptographic protection against a compromised coordination plane adding nodes |
| **tsnet** | An embedded userspace node, so a process joins the mesh with no agent |

The mental model is **the network is a consequence of identity**. A node is reachable because policy
says an identity may reach it, not because of where it sits. That inversion is the whole idea and it
is why this capture is `adopt` rather than `benchmark`.

## Feature surface

- Zero-configuration mesh across NAT and firewalls, with direct paths where possible and encrypted
  relay where not.
- Identity-provider login for devices; tagged machine identity for services.
- Declarative ACL grants as a reviewable file.
- MagicDNS naming, subnet routers and exit nodes.
- Funnel for public exposure and Serve for private sharing, both one command.
- Tailnet lock to constrain the coordination plane's authority.
- SSH brokered through the tailnet with policy-controlled access.
- Device posture signals as an input to access decisions.
- `tsnet` for agentless, in-process membership.
- Headscale as an independent self-hosted coordination server.

## Architecture

- **Control plane** — a coordination server that authenticates nodes, distributes public keys and
  the network map, and evaluates policy. **It never sees traffic**: it brokers keys, and data planes
  form directly between peers.
- **Data plane** — WireGuard, peer to peer, falling back to DERP relays that carry encrypted traffic
  they cannot read.
- **Trust boundary** — the coordination plane's power is to say who is in the tailnet, which is
  significant; tailnet lock exists precisely to bound it, and is a well-judged acknowledgement of
  the risk.
- **State authority** — the coordination server for membership and policy; keys are generated on the
  device.
- **Portability boundary** — the wire protocol is WireGuard and therefore standard; the coordination
  plane, ACL grant syntax, MagicDNS and Funnel are Tailscale's. Headscale re-implements enough of the
  coordination protocol to be a genuine exit, which is unusually good for a commercial network
  product.

## How it competes with HoBo

It does not compete. It is a dependency HoBo has chosen, and this capture exists to state the
boundary honestly.

| Contested HoBo surface | The relationship |
| ---------------------- | ---------------- |
| `identity-secrets` | **The borrowed idea**: nodes join by identity, congruent with SPIFFE-style workload identity |
| `runtime-portability` | Connectivity between Yards and Camps that would otherwise require provider-specific networking |
| `governance` | ACL grants as a reviewable policy file, congruent with HoBo's policy packs |

Per ADR-0122 the portable floor is **WireGuard**, and Tailscale is one opt-in managed-mesh adapter
behind the `mesh` port, selected per Junction, recorded, deny-by-default. The mesh is never the
portability boundary.

## Primitive mapping

| Tailscale | Nearest HoBo concept | Honest correspondence |
| --------- | -------------------- | --------------------- |
| Tailnet | Junction overlay realization | Close; HoBo's overlay is a port with Tailscale as one adapter. |
| Tagged node | Workload identity | **The instructive mapping.** Machine identity as a first-class, non-human principal is exactly what a workload needs, and Tailscale ships it. |
| ACL grants file | `@hobo/policy` pack | Close in shape and in review discipline; Tailscale's is network-scoped only. |
| MagicDNS | Service naming across a Junction | Partial. |
| Funnel / Serve | `overlay.funnel` offerings in the ADR-0143 fallback ladder | Directly adopted as a traffic-routing adapter. |
| DERP relay | Fallback path in the connectivity ladder | Close. |
| Tailnet lock | — | **No HoBo equivalent.** Bounding the control plane's own authority cryptographically is a pattern HoBo does not have. |
| tsnet | In-process membership for a component | Attractive for wasm hosts and agents; not currently used. |
| — | `match.Decided` / `PortabilityReport` | **No equivalent.** Tailscale connects; it never chooses. |

## Where Tailscale is stronger

- **It makes the hard part disappear.** NAT traversal, firewall rules and address management stop
  being work. Nothing else in this corpus removes an entire category of toil so cleanly.
- **Identity-keyed reachability, shipped.** The idea HoBo borrows is not theoretical here; it is in
  production at scale with a policy language people actually review.
- **The coordination plane cannot read traffic**, and tailnet lock bounds even its membership
  authority — a genuinely thoughtful answer to "why should I trust your SaaS with my network".
- **Funnel is a one-command public endpoint** with TLS handled, which is a better developer
  experience than any ingress configuration.
- **`tsnet` removes the agent**, which matters for embedded and serverless contexts where installing
  a daemon is not an option.
- **Headscale exists**, so the exit path is real rather than rhetorical.

## Where HoBo is stronger or intentionally different

State labels follow the research contract.

- **Different layer entirely** (*implemented*). HoBo describes and places applications; Tailscale
  connects machines. There is no contested ground, and claiming any would be dishonest.
- **Identity beyond the network** (*implemented*). HoBo's identity port covers workload and agent
  identity for authorization decisions, not only reachability.
- **Policy beyond connectivity** (*implemented*, `@hobo/policy`). ACL grants govern who can reach
  what; HoBo's packs govern whether a deployment happens at all.
- **Residency-aware placement** (*implemented*, ADR-0146). An overlay makes distance invisible, which
  is useful for connectivity and dangerous for jurisdiction — the two need to be reasoned about
  separately.
- **Honest caveat.** On everything Tailscale actually does, Tailscale is better, and HoBo depends on
  it rather than competing with it. The one caveat that matters is the shipped
  `@hobo/connectivity` default: it currently selects the Tailscale adapter with no WireGuard-floor
  adapter present, which contradicts ADR-0122's stated floor and is tracked as a GAPS.md finding.

## Adversarial critique

- **The coordination plane is a third-party dependency in the critical path** for *joining* the
  network. Existing sessions survive an outage; new nodes and policy changes do not.
- **The overlay makes topology invisible, which is a compliance hazard.** A workload reachable "as if
  local" may be in another jurisdiction, and the network layer neither knows nor cares. This is the
  precise reason HoBo's residency evaluation must not delegate to reachability.
- **Air-gapped and sovereign environments cannot use the SaaS**, which is why ADR-0036 environments
  fall back to Headscale, NetBird, or no overlay at all.
- **ACL grants are a policy language**, and policy languages grow. A large tailnet's grant file
  becomes a serious artifact with the usual review, testing and blast-radius problems.
- **Funnel exposes services through a vendor's edge**, which is convenient and is a dependency and a
  data path worth thinking about before it reaches production.
- **Machine tags are credentials.** A tagged node's authority is as good as the key on the machine,
  and the usual key-rotation and node-decommissioning discipline applies whether or not anyone
  applies it.
- **Pricing is per-user/per-device**, which interacts awkwardly with ephemeral workloads that join
  and leave the mesh constantly — exactly HoBo's pattern.
- **Depending on an overlay for connectivity is a portability claim with an asterisk.** If HoBo's
  cross-Yard story requires a specific mesh vendor, portability is bounded by that vendor. ADR-0122's
  WireGuard floor is the answer, and the shipped default currently does not honour it.

## Better-together / integration posture

- **Adopt** — the standing posture, as an opt-in adapter behind the `mesh` port, selected per
  Junction and recorded (ADR-0122, ADR-0143). Never a hard dependency.
- **Provider-target** — Funnel and Serve realize `overlay.funnel` offerings in the fallback ladder.
- **Borrow** — three ideas, two already taken:
  1. **Identity-keyed networking** — taken, and congruent with SPIFFE workload identity.
  2. **Policy as a reviewable file** — taken, and congruent with policy packs.
  3. **Tailnet lock**, not taken: cryptographically bounding what the control plane itself may do is
     a pattern HoBo's own control plane should consider, since HoBo asks for more trust than
     Tailscale does.
- **Benchmark** on zero-configuration developer experience, which is the bar for cross-Yard
  connectivity.
- Not a displace target under any reading.

## Threats and lessons

1. **Identity, not address, is the right basis for reachability.** This is a settled question in
   HoBo's design and Tailscale is the working proof. The remaining work is applying the same
   principle to workload-to-workload authorization, not just node-to-node.
2. **An overlay hides geography, and HoBo must not let it hide jurisdiction.** Fail-closed residency
   evaluation (ADR-0146) has to be independent of the network layer, because the network layer is
   designed to make location irrelevant.
3. **The shipped default contradicts the stated floor.** ADR-0122 names WireGuard as the portable
   default; `@hobo/connectivity` ships defaulting to the Tailscale adapter with no floor adapter.
   Recorded here as a live inconsistency, not a footnote.
4. **Bound your own control plane's authority.** Tailnet lock is a vendor voluntarily limiting what
   it can do to a customer's network. HoBo, which asks to make placement decisions on a customer's
   behalf, has a stronger obligation to offer the same kind of constraint and currently offers none.
5. **Removing a category of work beats improving it.** Tailscale's adoption comes from firewall rules
   ceasing to exist, not from better firewall rules. HoBo's equivalent claim — provider selection
   ceasing to be a decision someone hand-writes — should be argued in exactly those terms.

## Sources

- [What is Tailscale](https://tailscale.com/kb/1151/what-is-tailscale) — WireGuard mesh, tailnet definition, NAT/firewall traversal, access control, exit nodes, tailnet lock (quoted above)
- [tailscale.com/kb](https://tailscale.com/kb) — Funnel, Serve, grants, tsnet, subnet routers
- [Headscale](https://github.com/juanfont/headscale) — independent self-hosted coordination server
- Related: the [Tailscale technology reference](../technologies/tailscale.md) for HoBo's adapter integration, [NetBird](netbird.md) for the open-source analogue, [Control Plane](control-plane.md) for credential-free connectivity from the runtime side

Pricing, current device-posture capabilities and the precise Headscale compatibility surface were not
verified in this pass and are not asserted.
