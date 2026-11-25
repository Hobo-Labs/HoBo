---
type: Competitive Reference
title: "Infracost — Competitor Reference"
description: "Cost estimation at plan time, in the pull request — the only product in this category that puts a number in front of the decision instead of after it."
tags: [hobo, competitors]
competitor:
  slug: infracost
  name: "Infracost"
  aliases: []
  primary_category: finops-governance-placement
  categories: [finops-governance-placement, infrastructure-from-code]
  directness: overlapping
  role: "plan-time cost estimation — the strongest existing evidence for HoBo's claim that cost belongs at the decision, not in a monthly report"
  posture: [borrow, benchmark, integrate]
  hobo_surface: [finops, governance, delivery]
  evidence: mixed
  status: active
  research_date: 2026-08-20
  sources:
    - https://www.infracost.io/docs/
    - https://www.infracost.io/
---

# Infracost — Competitor Reference

> Captured for HoBo competitive analysis under the HoBo Competitive Research Contract.
> Research date **2026-08-20**. Supersedes the Infracost portion of the
> [FinOps tooling cohort capture](finops-tooling.md).

## What it is

Infracost estimates **what an infrastructure change will cost, before it is merged**. Its own
documentation frames this as shifting "cloud costs left—into your engineering workflow" to "catch
cost issues in pull requests before deployment"
([docs](https://www.infracost.io/docs/)).

- **Product boundary.** It parses IaC — Terraform, CloudFormation, AWS CDK, across AWS, Azure and
  Google Cloud — prices it, and comments on the pull request. It does not deploy, meter runtime
  usage, or optimize.
- **Operating model.** Open-source CLI plus a commercial cloud tier; a Cloud Pricing API supplies
  prices. Notably, "no cloud credentials or secrets are sent to the API," and "Infracost does not
  make any changes to your IaC state or cloud resources."
- **The differentiator is timing.** Every other product in this category tells you what you spent.
  This one tells you what you are about to spend, at the moment someone can still change their mind.

## Core primitives and mental model

| Primitive | What it is |
| --------- | ---------- |
| **Plan estimate** | A priced breakdown derived from an IaC plan, before apply |
| **Cost diff** | The delta introduced by a change — the unit that appears on a pull request |
| **Usage file** | Declared assumptions for usage-driven resources (requests, GB egress) that a plan cannot know |
| **FinOps policy** | A rule expressing an organizational cost standard, checkable against a project |
| **Tagging policy** | A rule requiring attribution tags so downstream showback works |
| **Cloud Pricing API** | The price source, queried without cloud credentials |

The mental model is **a change has a price, and the price is part of the review**. Making cost a
line in a diff rather than a line in a report is the whole idea, and it is the correct one.

## Feature surface

- Cost estimates for Terraform, OpenTofu-compatible plans, CloudFormation and AWS CDK.
- Pull-request comments where "every PR gets an automatic comment showing the cost diff, FinOps
  policy violations, and tagging issues introduced by the change."
- FinOps policies and tagging policies, with the ability to scan existing projects for violations and
  to "generate new IaC that is automatically compliant with any selected FinOps policies."
- Usage files for resources whose cost depends on traffic rather than shape.
- CI gating on thresholds (a change adding more than a set monthly figure).
- IDE inline estimates and a terminal CLI.
- Agent skills for coding assistants, so cost-aware infrastructure generation is available to an LLM.
- Credential-free pricing lookups.

## Architecture

- **Control plane** — none in the runtime sense. A CLI (or CI job) parses a plan, queries the pricing
  API, and emits a report; the commercial cloud tier stores history and policy.
- **Trust model** — the strongest constraint in this capture: it reads plan output, not cloud state,
  and sends no credentials. That is what makes it acceptable in CI on the first day.
- **Extension model** — usage files, custom price overrides, and policy definitions.
- **State authority** — the IaC plan for shape, the pricing API for price; runtime truth is out of
  scope entirely.
- **Portability boundary** — tied to the IaC ecosystems it parses. Its *idea* is fully portable, and
  HoBo can implement it without any of its machinery.

## How it competes with HoBo

This is the most directly instructive capture in the cohort, because HoBo's design already claims
this surface.

| Contested HoBo surface | The contest |
| ---------------------- | ----------- |
| `finops` | **Plan-time cost estimation** — designed in HoBo ([Plan 5](../design/reliability-observability-cost.md#plan-05)), shipped here |
| `governance` | Cost thresholds and tagging rules as merge gates against `@hobo/policy` admission |
| `delivery` | The gate lives in the pull request; HoBo's lives at `can-deploy` |

The honest comparison: Infracost estimates the cost of *the infrastructure someone already chose to
write*. HoBo's stronger claim is estimating the cost of *each candidate placement* and letting the
number influence the choice — but that is a design claim, and this is a shipped product.

## Primitive mapping

| Infracost | Nearest HoBo concept | Honest correspondence |
| --------- | -------------------- | --------------------- |
| Plan estimate | Planner cost estimate at bind/deploy (Plan 5) | **Close by design.** Infracost's is shipped; HoBo's is not. |
| Cost diff on a PR | Cost delta on a Deployment Set delta | Close in shape; HoBo's arrives at the gate rather than the review. |
| FinOps policy | `@hobo/policy` pack rule | Close, and Infracost's checks a plan while HoBo's decides an admission. |
| Tagging policy | Attribution requirements on showback | Close in role; the underlying problem — attribution discipline — is the same. |
| Usage file | Declared workload expectations in a Bindle | **The instructive mapping.** Both admit that shape alone does not determine cost and require the author to say what they expect. |
| Cloud Pricing API | Provider price data behind `match` scoring | Close; HoBo needs this data for cost-aware placement (ADR-0071) and does not have an equivalent public story. |
| Credential-free operation | — | HoBo's provider adapters need credentials by nature; the *estimation* path arguably should not. |
| — | `match.Decided` | **No equivalent.** Infracost prices one option; it never compares two. |

## Where Infracost is stronger

- **The timing is right and it is shipped.** A dollar figure in a pull-request comment changes
  behaviour in a way a monthly report does not, and this is the only product in the cohort operating
  before the money is spent.
- **Credential-free by design.** Nothing about it requires access to the cloud account, which removes
  the single largest adoption objection for a cost tool.
- **Usage files are an honest solution to a hard problem.** Rather than pretending traffic-dependent
  costs are knowable, it makes the author state an assumption — which is both accurate and a useful
  forcing function.
- **Policy plus generation.** Generating IaC that already complies with the selected FinOps policies
  closes the loop from "you violated a rule" to "here is code that does not".
- **Agent skills.** Exposing cost-awareness to coding assistants is a well-judged bet: the LLM
  writing the Terraform is now the thing that needs to know the price.
- **Low adoption cost.** A CI step and a comment; no cluster, no agent, no billing integration.

## Where HoBo is stronger or intentionally different

State labels follow the research contract.

- **Cost as a placement input** (*design-only*, ADR-0071). Infracost prices what you wrote; HoBo
  intends to compare candidates and record the choice in `match.Decided`.
- **Runtime metering in the same system** (*design-only*, ADR-0039). Estimation and actuals live in
  one event log, so estimate-versus-actual is derivable rather than a separate reconciliation
  project.
- **Enforcement at admission** (*design-only*). A merge gate can be overridden by merging; a
  `can-deploy` refusal cannot.
- **Provider-abstract description** (*implemented*). Infracost requires that a provider already be
  named in the IaC; HoBo prices before that commitment exists, which is the more useful moment.
- **Honest caveat.** HoBo's entire advantage here is designed and Infracost's is in production. On
  the specific surface both claim — plan-time cost — Infracost currently wins outright.

## Adversarial critique

- **Estimates are estimates.** List prices, ignored discounts, commitments and enterprise agreements
  mean the number is directionally right and frequently wrong in magnitude, and teams learn to
  discount it.
- **Usage assumptions dominate the answer for anything serverless.** A Lambda or an S3 bucket costs
  whatever traffic decides, so the usage file — a guess — determines the estimate.
- **It only sees what the IaC declares.** Data transfer, cross-AZ traffic, support plans and the
  managed services someone clicked into existence are invisible.
- **A PR comment is easy to ignore**, and a threshold gate is easy to override. The enforcement story
  is social, not technical.
- **No runtime feedback loop.** Because it never sees actuals, it cannot learn that its estimates are
  systematically wrong, which is the improvement everyone wants and nobody in this category ships.
- **Coverage is uneven across providers and resource types**, and an unpriced resource is silently
  absent from the total rather than flagged as unknown — a failure mode worth designing away from.
- **The IaC premise.** Teams whose infrastructure is not fully in Terraform get partial coverage,
  which is most teams.

## Better-together / integration posture

- **Borrow** — the primary posture, and the specific items:
  1. **Cost as part of the review artifact**, not a separate dashboard. HoBo's `can-deploy` output
     should carry a cost delta as a matter of course.
  2. **Usage files.** HoBo's Bindles should let an author declare expected load, because portability
     scoring and cost scoring both need it and neither can infer it.
  3. **Estimate-versus-actual as a first-class fact.** HoBo has both sides in one event log and
     should close the loop Infracost structurally cannot.
  4. **Credential-free estimation.** The estimation path should not require provider credentials even
     though the deployment path does.
- **Integrate** — for customers whose infrastructure remains Terraform-authored alongside HoBo.
- **Benchmark** on pull-request ergonomics.
- Not a displace target in the short term: HoBo has nothing shipped to displace it with.

## Threats and lessons

1. **Cost belongs at the decision.** Infracost proves the demand HoBo's Plan 5 asserts, and proves it
   in production. This strengthens the design and weakens any claim that HoBo is early to the idea.
2. **The unclosed loop is the opening.** No product in this category compares its own estimate to the
   actual bill for the same workload. HoBo's event log makes that trivial and it would be a genuinely
   novel, defensible feature.
3. **Pricing data is a dependency HoBo has not resourced.** Cost-aware placement (ADR-0071) requires
   accurate multi-provider prices, which is exactly the asset Infracost built a business around.
   Treating this as free is a planning error.
4. **Declare, don't infer, the unknowable.** Usage files are the right pattern for anything a
   description cannot determine — the same argument HoBo makes against StackGen's
   inference-without-declaration, arriving here from the cost side.
5. **Agent-facing cost awareness is a live surface.** Infracost shipping skills for coding assistants
   means the AI writing infrastructure is already a cost-tooling market, which is directly adjacent to
   HoBo's agent surface.

## Sources

- [Infracost documentation](https://www.infracost.io/docs/) — plan-time estimation, PR comments, FinOps and tagging policies, Cloud Pricing API credential handling, IDE and agent-skill surfaces (quoted above)
- [infracost.io](https://www.infracost.io/) — product positioning (vendor material)
- Related: [OpenCost](opencost.md) and [Kubecost](kubecost.md) for the runtime counterpart, [Vantage](vantage.md) for multi-cloud aggregation, [StackGen](stackgen.md) for the parallel declare-versus-infer argument

Pricing, current provider and resource coverage, and the precise contents of the agent skills were
not verified in this pass and are not asserted.
