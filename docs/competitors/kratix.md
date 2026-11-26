---
type: Competitive Reference
title: "Kratix — Competitor Reference"
description: "Platform-as-a-product framework: a Promise bundles an API, its dependencies, the workflows that fulfil it, and the destination rules that place the result."
tags: [hobo, competitors]
competitor:
  slug: kratix
  name: "Kratix"
  aliases: ["syntasso kratix", "ske"]
  primary_category: portable-application-models
  categories: [portable-application-models, platform-orchestrators, delivery-release-gitops]
  directness: overlapping
  role: "framework for building platform APIs — Promises bundle contract, fulfilment and placement, which is the packaging idea HoBo's Bindle kinds most resemble"
  posture: [borrow, benchmark, integrate]
  hobo_surface: [typed-contracts, extensibility, provider-matching, delivery, app-graph]
  evidence: mixed
  status: active
  research_date: 2026-08-19
  contract: v1
  sources:
    - https://docs.kratix.io/main/reference/promises/intro
    - https://docs.kratix.io/main/reference/workflows
    - https://docs.kratix.io/main/reference/destinations/intro
    - https://docs.kratix.io/main/guides/writing-a-promise
---

# Kratix — Competitor Reference

> Captured for HoBo competitive analysis under the HoBo Competitive Research Contract.
> Research date **2026-08-19**. HoBo's side of each comparison is labelled **implemented**,
> **proof**, or **design-only**.

## What it is

Kratix is an **open-source framework for building platform APIs**, from Syntasso, organized around
the idea of *platform as a product*. Its unit is the **Promise**: "a set of instructions written in
YAML that will produce a resource whenever the Promise is invoked, consisting of the dependencies it
must setup before the Promise can be requested, an API description of how a user can request that
Promise, the workflows that define how the provisioning takes place, and destination rules that
allow the Promise Author to determine where resources should go"
([Promise reference](https://docs.kratix.io/main/reference/promises/intro)).

- **Product boundary.** Not a platform — a framework for *making* one. Kratix ships no golden path;
  it ships the machinery for a platform team to publish theirs as an API.
- **Operating model.** Open source, installed into a platform Kubernetes cluster. A commercial
  edition (**Syntasso Kratix Enterprise**) exists above it.
- **The distinguishing idea.** A Promise packages four things that are usually scattered: the
  contract, the prerequisites, the fulfilment procedure, and the placement rules. Bundling them is
  what makes a platform capability a *product* with a version and an owner.

## Core primitives and mental model

| Primitive | What it is |
| --------- | ---------- |
| **Promise** | The packaged platform capability: dependencies, API, workflows, destination selectors |
| **Promise API** | The user-facing contract — "Promise APIs are Kubernetes Custom Resource Definitions (CRDs) under the hood" |
| **Resource request** | A user's instance of a Promise's API; "the Promise uses the API options to create the resources as described in the Promise" |
| **Workflow** | "The actions that must run in order to fulfil a Promise", a "chain of containers that execute in sequence" — covering "responses to API specifications, notifications, business rules, and custom specifications" |
| **Destination** | Where fulfilled resources are written; "platform teams can control which Destinations receive which Promises by using a combination of Destination labels and Promise Destination selectors" |
| **State Store** | The write target: "Kratix writes to two top-level directories within the State Store: one for dependencies and one for resources", where "dependencies/ holds files scheduled at the Promise level, and resources/ holds files generated for individual Resource requests" |
| **Compound Promise** | A Promise composed of other Promises |

The mental model is **the platform team ships products, and each product is a Promise**. A user
requests a Promise's API; containers run to fulfil it; the output lands in destinations chosen by
label matching, from where GitOps agents apply it.

Two properties are worth naming because they are unusual and good:

- **Fulfilment is arbitrary containers.** A workflow is any sequence of containers, so a Promise can
  be fulfilled by Terraform, Helm, a script, or a call to a ticketing system. Kratix does not care.
- **Placement is label-based selection**, not hard-coded targets — the closest mechanism in this
  cohort to HoBo's matching, though selection rather than scoring.

## Feature surface

- **Authoring (platform team)** — write a Promise: CRD schema, dependency manifests, workflow
  containers, destination selectors.
- **Authoring (developer)** — submit a resource request against the Promise's CRD.
- **Typed contracts** — CRD schemas are the API contract, with Kubernetes-native validation.
- **Workflows** — container chains at both Promise and resource scope.
- **Placement** — Destination labels × Promise selectors, with documented multi-destination
  management.
- **Delivery** — writes to a State Store (Git or S3-compatible); a GitOps agent applies from there.
  Kratix deliberately does not do the applying.
- **Composition** — Compound Promises let one capability depend on others.
- **Updates** — documented semantics for what happens to existing resources when a Promise changes.
- **Enterprise edition** — Syntasso Kratix Enterprise adds commercial features above the OSS core.

## Architecture

- **Control plane** — Kratix controllers in a platform cluster, reconciling Promises and resource
  requests.
- **Fulfilment** — containerized workflows, scheduled by Kratix.
- **Delivery seam** — the **State Store** is the boundary: Kratix produces files, GitOps agents
  consume them. This separation is architecturally clean — the thing that decides is not the thing
  that applies, so blast radius and audit boundaries are crisp.
- **State authority** — Kubernetes resources plus the State Store's Git history. Notably, Git *is* a
  log here, which gets closer to an auditable history than most competitors, though of outputs
  rather than decisions.
- **Portability boundary** — the platform cluster is Kubernetes; destinations are wherever a GitOps
  agent can apply. Since workflows are arbitrary containers, what a Promise can fulfil is
  effectively unbounded — a genuinely open extension model.

## How it competes with HoBo

Kratix overlaps HoBo on **how capabilities are packaged and placed**, not on application modelling.
There is no application graph in Kratix; there are independent capability requests.

| Contested HoBo surface | The contest |
| ---------------------- | ----------- |
| `typed-contracts` | Promise APIs as CRD schemas are a shipped contract mechanism |
| `extensibility` | The Promise is a packaging unit for a platform capability — HoBo's closest analog is a Bindle kind plus its adapter |
| `provider-matching` | Destination selectors are label-based placement; structurally the same job, decided by matching labels rather than scoring candidates |
| `delivery` | Workflow chains plus the GitOps handoff |
| `app-graph` | Only weakly: Compound Promises express dependency, but there is no application-level graph |

The honest read: Kratix is a **framework a platform team uses to build something HoBo aims to be a
product for**. Those are different businesses, which is why the posture here is borrow and integrate
rather than displace.

## Primitive mapping

| Kratix | Nearest HoBo concept | Honest correspondence |
| ------ | -------------------- | --------------------- |
| Promise | Bindle kind + adapter + Resource Pack | **The closest packaging analog in the corpus.** Both bundle a contract with its realization. Kratix additionally bundles placement rules into the same object, which HoBo splits between kind, adapter and Camp/Yard scoping. |
| Promise API (CRD) | BoundaryContract | **Partial.** Both are typed user-facing contracts. HoBo's carry effects and resilience metadata (ADR-0136); a CRD schema carries shape only. |
| Resource request | Bound port instance | Close. |
| Workflow (container chain) | Provider adapter execution | **Different and more open.** Arbitrary containers can fulfil anything; a HoBo adapter implements a typed port. Kratix trades type-safety for reach. |
| Destination + selectors | Camp / Yard + matching | **Genuinely close in role.** Label selection versus scored candidate selection is the same distinction that separates HoBo from every other product in this cohort. |
| State Store | — | **No direct HoBo equivalent.** The decide/apply separation via Git is a design HoBo does not have an exact counterpart for. |
| Compound Promise | Composed Bindle kinds | Close. |
| — | `match.Decided` / `PortabilityReport` | **No equivalent.** Selection is by label match; nothing is scored or explained, and nothing reports fidelity. |

## Where Kratix is stronger

- **Promise-as-product is the best packaging idea in this cohort.** Contract, prerequisites,
  fulfilment and placement in one versioned, ownable object is a genuinely clarifying decomposition.
- **Fulfilment is unbounded.** Arbitrary containers mean a Promise can wrap literally any process,
  including human-in-the-loop steps. No typed-port system can match that reach.
- **The State Store separation is architecturally clean.** Deciding and applying are different
  systems with a Git-shaped seam between them, which is excellent for audit and blast radius.
- **Open source with a real commercial backer**, and documented update semantics — which is more
  operational maturity than most projects at this stage show.
- **It does not pretend to be a platform.** Kratix's honesty about being a framework is itself a
  strength; teams know what they are buying.

## Where HoBo is stronger or intentionally different

- **There is an application model** (*implemented*). Kratix has capability requests; HoBo has a
  topology with dependencies and wiring. A platform built on Kratix must invent that layer itself.
- **Placement is scored, not selected by label** (*implemented*, `match.Decided`). Label selectors
  cannot express "cheapest compliant candidate", and cannot explain a choice.
- **Portability is measured** (*implemented*, ADR-0144). Arbitrary-container fulfilment makes
  portability unanalysable by construction — a real cost of Kratix's openness.
- **Typed contracts carry effects and resilience** (*implemented*, ADR-0136) beyond CRD shape.
- **Fail-closed residency** (*implemented*, ADR-0146); destination selectors have no jurisdiction
  semantics.
- **Event-sourced control plane with replay** (*implemented*, ADR-0135). Git history records
  outputs; HoBo's log records decisions.
- **Runs without Kubernetes** (*implemented*).
- **Honest caveat.** Kratix ships and is used to build real platforms today; HoBo is the more
  opinionated bet and the less proven one.

## Adversarial critique

- **You must build the platform yourself.** Kratix's honesty cuts both ways: adopting it means a
  platform team writes every Promise, every workflow container, and every selector. Time-to-value
  depends entirely on that team's capacity.
- **Arbitrary containers destroy analysability.** Because fulfilment is opaque, nothing can reason
  about what a Promise does — no dependency analysis, no impedance assessment, no cost estimation
  ahead of execution. Reach is bought with blindness.
- **Kubernetes CRDs as the API surface** constrain the contract language to what CRD schemas
  express, and put the platform cluster on the critical path.
- **Label-based placement is coarse.** It cannot express conditional placement, budget-aware
  placement, or residency rules without encoding them into label taxonomies by hand.
- **Two-system operations.** Kratix plus a GitOps agent plus a State Store is more moving parts than
  a single reconciler, and failures can land in the seam between them.
- **The OSS/commercial boundary** with Syntasso Kratix Enterprise is a thing adopters must evaluate;
  this capture does not assert where the line currently falls.
- **No application-level semantics** means cross-capability concerns — a service and its database
  and its queue as one unit — must be reinvented per platform, usually as Compound Promises with
  hand-rolled conventions.

## Better-together / integration posture

- **Borrow** — the Promise's *bundling*: contract + dependencies + fulfilment + placement rules as
  one versioned, ownable artifact. HoBo splits these across kinds, adapters, packs and scopes; there
  is a real question whether a single publishable object would make HoBo's extension story more
  legible. Also worth borrowing: **documented update semantics** for what happens to existing
  resources when a capability definition changes, which HoBo's Bindle-kind versioning story needs.
- **Integrate** — a HoBo provider adapter fulfilled by a Kratix Promise is coherent, and so is the
  reverse: HoBo could emit into a State Store rather than applying directly.
- **Benchmark** on how quickly a platform team can publish a new capability end to end.
- Not a displace target: different businesses.

## Threats and lessons

1. **Packaging is a first-class product decision, not an implementation detail.** Kratix makes the
   capability the unit of ownership and versioning. HoBo's equivalent is spread across several
   concepts, and that diffusion is a comprehension cost.
2. **Decide/apply separation is worth considering explicitly.** Emitting to a Git-shaped seam rather
   than applying directly gives auditability and blast-radius properties HoBo currently achieves by
   different means. Worth an explicit ADR-level comparison rather than an implicit choice.
3. **Openness and analysability trade against each other.** Kratix chose unbounded fulfilment and
   gave up reasoning about it; HoBo chose typed ports and gave up reach. Stating this trade
   explicitly in HoBo's docs is more honest and more persuasive than claiming both.
4. **Update semantics for capability definitions are a real gap.** What happens to already-deployed
   resources when a Bindle kind changes is a question Kratix documents and HoBo should.

Per the research contract, these belong in their own implementation issues rather than being
changed from this capture.

## Sources

- [Promise Custom Resource](https://docs.kratix.io/main/reference/promises/intro) — Promise structure: dependencies, API, workflows, destination rules
- [Workflows](https://docs.kratix.io/main/reference/workflows) — container chains as fulfilment
- [Destination](https://docs.kratix.io/main/reference/destinations/intro) and [multi-destination management](https://docs.kratix.io/main/reference/destinations/multidestination-management) — State Store layout, label/selector placement
- [Writing a Promise](https://docs.kratix.io/main/guides/writing-a-promise) and [Compound Promises](https://docs.kratix.io/main/guides/compound-promises) — authoring model
- [Promise updates](https://docs.kratix.io/main/reference/promises/updates) — update semantics
- [Syntasso Kratix Enterprise](https://docs.kratix.io/ske/releases/ske) — commercial edition

The precise OSS/enterprise feature boundary, and current adoption evidence, were not verified in
this pass and are not asserted.
