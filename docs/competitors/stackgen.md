---
type: Competitive Reference
title: "StackGen — Competitor Reference"
description: "Generative infrastructure-from-code: analyze application source, infer its cloud dependencies, and emit compliant Terraform or Helm with no annotations."
tags: [hobo, competitors]
competitor:
  slug: stackgen
  name: "StackGen"
  aliases: ["appcd"]
  primary_category: agentic-infrastructure
  categories: [agentic-infrastructure, infrastructure-from-code]
  directness: overlapping
  role: "infrastructure inferred from unannotated source — the one product that removes the declaration step entirely, and the sharpest test of whether HoBo's authoring step is necessary"
  posture: [benchmark, borrow]
  hobo_surface: [authoring, app-graph, governance, typed-contracts]
  evidence: mixed
  status: renamed
  research_date: 2026-08-20
  contract: v1
  sources:
    - https://docs.stackgen.com/docs/concepts/whystackgen
    - https://docs.stackgen.com/reference/appcd-concepts
    - https://stackgen.com/
    - https://blog.stackgen.com/appcd-launches-generative-infrastructure-from-code
---

# StackGen — Competitor Reference

> Captured for HoBo competitive analysis under the HoBo Competitive Research Contract.
> Research date **2026-08-20**. The product launched as **appCD** and is now **StackGen**; the old
> name is recorded as an alias and `status: renamed` in front matter.

## What it is

StackGen generates infrastructure **from application source code that was never written for it**.
Its distinguishing claim: it "uses application code to generate Infrastructure from Code
automatically, **no code annotation or extensive configuration coding required**", reviewing "Python
and Java code to understand infrastructure and cloud dependencies and infer API, service
configuration, ingress/egress, environment variables"
([launch announcement](https://blog.stackgen.com/appcd-launches-generative-infrastructure-from-code)).

That is a materially different proposition from every other infrastructure-from-code product in this
corpus. Nitric, Encore, SST and Amplify all require the developer to *declare* — in decorators, in
typed functions, in a config file. StackGen requires nothing: it reads what is already there.

- **Product boundary.** Analysis of existing source, inference of dependencies, generation of
  compliant IaC.
- **Operating model.** Commercial, with a hosted product and integrations including HCP Terraform.
- **Compliance is part of the output.** It "automatically applies golden standards at creation,
  complying with HIPAA, NIST-CSF, PCI, GDPR regulations" — a vendor claim, recorded as such.

## Core primitives and mental model

| Primitive | What it is |
| --------- | ---------- |
| **Application source** | The input — unannotated Python or Java |
| **Inferred dependency** | A cloud service the analysis concludes the application needs |
| **Generated stack** | The emitted Terraform or Helm |
| **Golden standard** | The organizational or regulatory policy baked into generation |
| **StackBuilder** | The agent that builds infrastructure alongside the developer |

The mental model is **inference, not declaration**. The application is the specification; the tool's
job is to work out what it implies. Where HoBo asks a developer to describe capabilities, StackGen
asks nothing and derives them.

## Feature surface

- Static analysis of application source to infer cloud dependencies.
- Generation of Terraform or Helm from that inference.
- Policy and compliance standards applied at generation time.
- Visual review of the generated infrastructure design.
- HCP Terraform integration for state management.
- StackBuilder, an agent-shaped interface for infrastructure creation during development.

## Architecture

- **Analysis layer** — language-specific inference over application source; the quality of this layer
  is the entire product.
- **Generation layer** — inferred dependencies plus organizational standards produce IaC.
- **Execution** — delegated to Terraform (including HCP Terraform for state), which is the sensible
  choice.
- **State authority** — Terraform's, not StackGen's.
- **Portability boundary** — the output is ordinary Terraform, so **the generated artifact survives
  the product entirely**. That is an unusually good exit position, and worth crediting: the value is
  in the generation, not in holding the customer's configuration hostage.

## How it competes with HoBo

| Contested HoBo surface | The contest |
| ---------------------- | ----------- |
| `authoring` | **The sharpest challenge in the corpus** — StackGen removes the authoring step rather than improving it |
| `app-graph` | Inferred from source rather than declared |
| `governance` | Standards applied at generation |
| `typed-contracts` | Inferred dependencies, not declared contracts |

The question it poses to HoBo is uncomfortable and worth stating plainly: **if infrastructure can be
inferred from unannotated code, why should a developer write a Bindle at all?**

The honest answer has three parts. Inference tells you what an application *currently does*, not what
it *should be allowed to do* — least privilege cannot be inferred from behaviour. Inference cannot
express intent that is not in the code, such as residency, budget or availability requirements. And
inference produces a starting artifact, not a maintained description that survives refactoring. All
three are real, and none of them makes the challenge go away.

## Primitive mapping

| StackGen | Nearest HoBo concept | Honest correspondence |
| -------- | -------------------- | --------------------- |
| Inferred dependency | Bindle kind binding | **Same conclusion, opposite direction** — derived versus declared. |
| Generated stack | Provider realization | Partial; StackGen emits IaC, HoBo deploys through adapters. |
| Golden standard | `@hobo/policy` pack | **Close, and applied at a different moment** — generation time versus admission time. |
| StackBuilder | HoBo agent surface | Close in shape. |
| — | `match.Decided` / `PortabilityReport` | **No equivalent.** Generation targets a chosen stack; nothing is scored. |

## Where StackGen is stronger

- **Zero authoring burden.** No annotations, no config file, no new concepts — the shortest possible
  on-ramp, and the sixth and strongest instance of the import-what-exists finding in this corpus.
- **Works on existing applications**, which is where the actual industry problem is: brownfield
  estates nobody will rewrite.
- **Compliance at generation time** is a good moment to apply standards, before anything exists to
  remediate.
- **Output is ordinary Terraform**, so adoption is low-risk and exit is cheap.
- **Delegating state to HCP Terraform** rather than inventing another state store is disciplined.

## Where HoBo is stronger or intentionally different

State labels follow the research contract.

- **Intent that is not in the code** (*implemented*). Residency (ADR-0146), budget, availability and
  least-privilege are requirements an application's source cannot express, and inference cannot
  recover them.
- **Least privilege must be declared** (*implemented*, via the `.allow()`-style model HoBo takes from
  Nitric). Inferring permissions from observed behaviour grants what the code happens to do, not what
  it should be permitted to do — a security-relevant distinction.
- **A maintained description, not a one-time generation** (*implemented*). A Bindle is edited and
  reviewed as the application evolves; generated output must be regenerated and re-reviewed.
- **Scored placement across providers** (*implemented*, `match.Decided`); StackGen generates for a
  target you chose.
- **Portability is measured** (*implemented*, ADR-0144).
- **Honest caveat.** On time-to-first-artifact for an existing application, StackGen wins outright,
  and HoBo has no comparable on-ramp today.

## Adversarial critique

- **Inference is a heuristic, and the failure mode is confident wrongness.** Generated infrastructure
  that looks plausible and is subtly wrong is harder to catch than an obvious error, and the review
  burden lands on someone who did not write the input.
- **Two languages.** Python and Java analysis is a real scope limit, and each new language is a new
  analyzer.
- **Behaviour is not intent.** Anything the code does not express — data classification, region
  constraints, cost ceilings, disaster-recovery posture — cannot be inferred and must be added
  afterwards, which reintroduces the declaration step.
- **Least privilege from inference is a security concern**, not a convenience issue: permissions
  derived from what the code does grant everything the code does, including things it should not.
- **Generation is a starting point.** The relationship between the source and the generated stack
  after six months of divergence is the hard part, and the marketing is quiet about it.
- **Compliance claims need auditing.** Automatically satisfying HIPAA, PCI, NIST-CSF and GDPR is a
  vendor claim about a domain where claims are load-bearing; this capture records it and does not
  endorse it.
- **Renamed and repositioned** from appCD to StackGen, with an evolving agent story — early-stage
  volatility that adopters should weigh.

## Better-together / integration posture

- **Borrow** — **inference as an on-ramp, not as the model**. A `hobo import` that reads an existing
  application and *proposes* a Bindle — which the developer then reviews, corrects and maintains —
  would combine StackGen's on-ramp with HoBo's durable description. This is the sixth and most
  compelling occurrence of the import-what-exists finding, and it now has a clear design shape.
- **Benchmark** on time from existing repository to working deployment.
- Not an adopt, provider, integrate or displace target.

## Threats and lessons

1. **The authoring step is a cost, and someone has removed it.** HoBo must be able to say why a
   written description is worth it — intent, least privilege, and maintainability are the answer,
   and they need to be argued rather than assumed.
2. **Inference and declaration compose better than they compete.** Infer the draft, declare the
   intent, maintain the result. That is a concrete implementation issue for `hobo import`.
3. **Brownfield is where the market is.** Every product in this corpus that requires a rewrite is
   addressing the smaller half of the problem.
4. **Security cannot be inferred from behaviour** — the single most important limit on this approach,
   and one HoBo's declared-permission model handles correctly.

## Sources

- [Why StackGen](https://docs.stackgen.com/docs/concepts/whystackgen) and [concepts](https://docs.stackgen.com/reference/appcd-concepts) — product concepts and generation model
- [appCD launch announcement](https://blog.stackgen.com/appcd-launches-generative-infrastructure-from-code) — inference from unannotated Python and Java, Terraform/Helm output, compliance standards (vendor material)
- [StackBuilder](https://docs.stackgen.com/stackbuilder) and [HCP Terraform integration](https://stackgen.com/blog/stackgen-hcp-terraform-integration) — agent surface and state management
- [stackgen.com](https://stackgen.com/) — current positioning (vendor material)

Inference accuracy, language coverage beyond Python and Java, and the compliance claims were not
independently verified and are recorded as vendor claims rather than established facts.
