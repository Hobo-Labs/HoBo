---
type: Competitive Reference
title: "Flux Network / Orbit — Competitor Reference"
description: "Decentralized community-node container hosting with a Git-to-deploy UX — a compute provider target whose variable trust is exactly what a PortabilityReport and residency evaluation exist to score."
tags: [hobo, competitors]
competitor:
  slug: flux-network
  name: "Flux Network"
  aliases: ["flux", "orbit", "runonflux"]
  primary_category: cloud-application-platforms
  categories: [cloud-application-platforms, runtime-substrates]
  directness: adjacent
  role: "decentralized container host with a Git-to-Flux deploy UX (Orbit) — compute provider target, not an actor runtime"
  posture: [provider-target]
  hobo_surface: [provider-matching, runtime-portability]
  evidence: mixed
  status: active
  research_date: 2026-08-20
  contract: v1
  sources:
    - https://docs.runonflux.com/
    - https://orbit.runonflux.com/
---

# Flux Network / Orbit — Competitor Reference

> Captured for HoBo competitive analysis under the HoBo Competitive Research Contract.
> Research date **2026-08-20**; impedance findings first recorded 2026-08-14 and carried forward
> unchanged.
>
> **Name collision.** This is **Flux Network** (RunOnFlux), a decentralized compute network. It is
> unrelated to [Flux CD](flux-cd.md), the CNCF GitOps toolkit.

## What it is

Flux Network is a **decentralized container-hosting network run on community-operated nodes**, with
**Orbit** as its Git-to-deploy experience. For HoBo it is a compute provider target behind
`@hobo/provider-flux`; Orbit is a deployment *mode*, not a separate provider.

- **Product boundary.** Container hosting on third-party nodes, plus a deployment UX. It is not an
  actor runtime and provides no managed data services.
- **Operating model.** A decentralized network with a token-incentivized node operator population;
  Orbit is the hosted deploy surface over it.
- **The differentiator is the node population.** Capacity comes from independent operators, which
  makes it cheap and geographically diffuse and makes trust a variable rather than a constant.

## Core primitives and mental model

| Primitive | What it is |
| --------- | ---------- |
| **Node** | A community-operated machine contributing capacity, with variable and unguaranteed QoS |
| **Application / deployment** | A container specification scheduled onto some set of nodes |
| **Lease volume** | Attached storage for a deployment — **not** durable actor storage |
| **Orbit** | The Git-to-Flux deployment experience layered over the network |
| **ArcaneOS attestation** | A proprietary node-integrity signal |
| **Webhook / `/status` / `/health`** | The operational surface, whose default exposure is the operational hazard below |

The mental model is **capacity as a commodity from strangers**. That is a legitimate and interesting
supply model, and it means every trust property normally assumed of a cloud provider has to be
established explicitly instead.

## Feature surface

- Container deployment across a distributed node population.
- Git-to-deploy through Orbit.
- Lease volumes for deployment-scoped storage.
- Node attestation via ArcaneOS.
- Webhooks and status/health endpoints.
- Cost that is materially below hyperscaler pricing, which is the reason to look at it at all.

## Architecture

- **Scheduling** — deployments land on community nodes; the operator of any given node is not a party
  the customer has a contract with.
- **Storage** — lease volumes are directory-shaped and deployment-scoped. They are not a durable
  store, which is the single most important integration constraint below.
- **Trust** — attestation exists (ArcaneOS) and is proprietary, so it is an evidence class rather
  than a guarantee.
- **Exposure defaults** — webhook signatures are optional and `/status` and `/health` are public
  unless `API_KEY` is set. Any HoBo integration must therefore **fail closed** on apply rather than
  inherit the default.
- **State authority** — the network's own scheduling; HoBo records the placement decision and the
  impedance.
- **Portability boundary** — containers are portable; the storage semantics, attestation and
  operational surface are not. This is a provider whose escape hatch is "redeploy the container
  elsewhere", which is a good position.

## How it competes with HoBo

It does not compete. It is a provider target, and one whose properties make HoBo's scoring machinery
concrete rather than theoretical.

| Contested HoBo surface | The relationship |
| ---------------------- | ---------------- |
| `provider-matching` | A candidate with unusually strong cost and unusually weak trust — precisely the trade a scored decision exists to express |
| `runtime-portability` | Container-shaped workloads move here and back; stateful ones do not |

## Impedance

Carried forward unchanged from the original capture; these are the findings that govern the adapter.

| Fact | HoBo consequence |
|---|---|
| Community nodes, variable QoS | Policy: no secrets/control-plane/regulated data on community-free |
| Lease volumes ≠ actor storage | Never map `data`/`kv`/`actor` to a folder |
| n8n docs forbid live PG dir sync | No generic HA database from replica count |
| Webhook signature optional; `/status` and `/health` public unless `API_KEY` | Production apply fails closed. Do not claim a public HTTP `/logs` route. |
| ArcaneOS attestation proprietary | Evidence class, not a guarantee |
| Firebase/Stripe in Orbit UX | Hosting can be decentralized while gatekeepers remain |

Prices are ranking input (`COST_SOURCE` + date), never billing.

## Primitive mapping

| Primitive | Suitability |
|---|---|
| `web` / `api` / `service` | Yes |
| `actor` | Indirect: Rivet **runners** only |
| `data` / `kv` / `queue` / `bucket` | External providers |

Recipe `rivet-runners-on-flux`: trusted-yard control plane, outbound Flux runners.

| Flux Network | Nearest HoBo concept | Honest correspondence |
| ------------ | -------------------- | --------------------- |
| Node | Camp target | Partial: HoBo's Camps assume an accountable operator, which does not hold here. |
| Lease volume | — | **Deliberately unmapped.** Mapping `data`/`kv`/`actor` onto a lease volume would be a correctness bug, not a convenience. |
| ArcaneOS attestation | Evidence in a `PortabilityReport` | Close: a signal that is scored, never a guarantee that is trusted. |
| Orbit Git-to-deploy | Deployment mode over `@hobo/provider-flux` | Not a separate provider. |
| — | `evaluateResidency` | **No equivalent**, and the geographic diffuseness of the node population is exactly why fail-closed residency matters here. |

## Where Flux Network is stronger

- **Cost.** Community-supplied capacity is priced well below managed clouds, which is the entire
  reason it appears in a placement decision.
- **Geographic diffuseness** without a region list — capacity exists wherever operators do.
- **Censorship and single-vendor resistance**, at least in principle, since no one party can withdraw
  the network.
- **Git-to-deploy through Orbit** is a genuinely low-friction on-ramp for a stateless container.
- **Container-shaped portability.** Because it hosts containers and little else, the exit is
  redeploying elsewhere — a better position than platforms whose value is in the parts you cannot
  take.

## Where HoBo is stronger or intentionally different

State labels follow the research contract.

- **Trust is scored, not assumed** (*implemented*, `PortabilityReport`, ADR-0144). The impedance
  table above is what that looks like in practice.
- **Residency is fail-closed** (*implemented*, ADR-0146) — necessary rather than optional against a
  node population with no jurisdiction guarantees.
- **Policy refuses unsafe placements** (*implemented*, `@hobo/policy`): no secrets, control plane or
  regulated data on community-free capacity, enforced rather than advised.
- **Typed capability ports** (*implemented*). The reason `data`/`kv`/`actor` are not mapped here is
  that the port's contract cannot be met, which is the mechanism working as designed.
- **Honest caveat.** HoBo does not make this network more trustworthy. It makes the untrustworthiness
  legible and bounded, which is a smaller and more defensible claim.

## Adversarial critique

- **Variable QoS is the defining property.** There is no operator to escalate to and no SLA to
  enforce, so availability is statistical.
- **Insecure defaults.** Optional webhook signatures and public `/status` and `/health` endpoints
  unless a key is set are exactly the pattern the [Flux CD capture](flux-cd.md) criticises in a
  different context: a security model that is off until someone turns it on.
- **Proprietary attestation cannot be independently verified**, so it must be treated as an evidence
  class and never as a guarantee — as the impedance table already records.
- **Storage semantics invite a serious mistake.** A lease volume looks like a place to put a
  database, and is not. Any platform integrating this must refuse that mapping structurally rather
  than warn about it.
- **Decentralized hosting with centralized gatekeepers.** Orbit's own UX involves Firebase and
  Stripe, which is a fair illustration that decentralizing the compute layer does not decentralize
  the dependency graph.
- **Token-economy exposure.** Node supply depends on incentives denominated in a volatile asset,
  which is a capacity risk with no analogue in a managed cloud.
- **Regulated workloads are simply out of scope**, and any framing that suggests otherwise would be
  irresponsible.

## Better-together / integration posture

- **Provider-target** — the only posture. `@hobo/provider-flux` treats it as a cost-attractive,
  low-trust compute candidate, with policy refusing the placements that would be unsafe.
- **Recipe** — `rivet-runners-on-flux`: keep the control plane in a trusted Yard and run outbound
  Rivet runners on Flux, which is the shape that respects the trust boundary rather than arguing with
  it.
- Not a displace, adopt, borrow or benchmark target.

## Threats and lessons

1. **A low-trust provider is the best test of the scoring machinery.** ADR-0144's PortabilityReport
   and ADR-0146's residency evaluation are abstractions until a candidate arrives that is cheap and
   untrustworthy. This is that candidate, and the impedance table is the evidence the design works.
2. **Refuse structurally, do not warn.** The lease-volume trap should be impossible to fall into
   because the `data` port's contract cannot be satisfied — not because a document says so.
3. **Insecure defaults must be closed at apply time.** Inheriting a provider's permissive default is
   how a platform silently ships an exposure; failing closed on apply is the correct posture and is
   already recorded here.
4. **Decentralization is layered.** Decentralized compute with centralized auth and payments is the
   normal case, and a corpus that noted only the decentralized layer would be describing marketing
   rather than architecture.

## Sources

- [docs.runonflux.com](https://docs.runonflux.com/) — network, nodes, deployment and operational surface
- [orbit.runonflux.com](https://orbit.runonflux.com/) — the Git-to-deploy experience
- Related: [Flux CD](flux-cd.md) — unrelated product sharing the name; [Rivet](rivet.md) for the runner model referenced by the recipe

Pricing, current node-population size, ArcaneOS attestation internals and SLA terms were not verified
in this pass and are not asserted. Prices observed are ranking input only, recorded with
`COST_SOURCE` and a date, and are never used for billing.
