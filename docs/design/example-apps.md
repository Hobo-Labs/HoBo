---
type: Reference
title: "Example Apps Scope and Acceptance"
description: "Source issue: HOBO-435."
tags: [hobo, design]
---

# Example Apps Scope and Acceptance

Source issue: HOBO-435.

Executable proof lives in
[`src/draft/exp-proofs/dx/example-apps-scope-acceptance`](../../src/draft/exp-proofs/dx/example-apps-scope-acceptance/README.md).
Branch evidence is summarized in
[`proofs/hobo-435-example-apps-scope`](./proofs/hobo-435-example-apps-scope/index.md).

## M0 Acceptance Record

Example Apps exists to make HoBo's product story inspectable without making example code a hidden
implementation lane. The examples must prove scaffold, local run, deploy, inspect, failure recovery,
and role handoff behavior through explicit proof modes: design records, contract tests, reference
fixtures, live recordings, or simulated references.

## User And Business Goal

HoBo needs a trusted example-app set that lets prospects, agents, demo owners, and platform teams
evaluate the platform story with reproducible evidence. The examples must show what is real today,
what is simulated as reference behavior, what needs a live recording, and what remains future scope.

## Primary Personas

| Persona | Need |
|---|---|
| App developer evaluator | See a minimal path from scaffold to local run to deploy evidence. |
| Platform engineer evaluator | See provider-agnostic app code plus Camp/provider mapping decisions. |
| Agent builder | Use examples as stable CLI/MCP fixtures without static keys or undocumented setup. |
| Demo maintainer | Refresh docs, recordings, transcripts, and expected outputs for launch demos. |

## Scope In

- Canonical example-app catalog with persona, template, command path, and proof owner per example.
- `snapshop` remains the anchor end-to-end example from [Plan 19](./worked-example.md#plan-19) and
  the role walkthrough.
- Proof requirements distinguish live behavior, contract-test behavior, recorded demo evidence, and
  simulated reference fixtures.
- M1-ready acceptance checklist for scaffold smoke tests, command transcripts, recordings, docs,
  and failure-mode contracts.

## Scope Out And Non-Goals

- Do not build or ship the actual example applications in this issue.
- Do not create launch marketing pages, screenshots, or final demo videos.
- Do not provision real cloud resources or store provider credentials.
- Do not define customer onboarding, support-desk, billing, or legal launch processes.
- Do not add lifecycle CLI verbs for examples; examples exercise existing HoBo verbs.
- Do not claim production readiness from reference fixtures alone.

## Service, UX, Security, And Support Boundaries

| Boundary | Rule |
|---|---|
| Service | Example apps are reference and contract-proof artifacts, not hosted production services with an SLA. |
| UX | Example UX covers scaffold, local run, deploy, inspect, and failure recovery evidence; marketing polish is separate launch-demo work. |
| Security | Examples never embed secrets, provider keys, customer data, or bypassed policy gates; claims name live versus simulated proof mode. |
| Support | Maintenance means fixtures, docs, tests, and recordings stay refreshable; customer support scripts live in Customer Onboarding. |

## Authoritative Dependencies

- [worked-example.md#plan-19](./worked-example.md#plan-19) keeps `snapshop` as the compressed
  end-to-end product story.
- [walkthrough.md](./walkthrough.md) defines the six-role example lifecycle and shared `snapshop`
  app.
- [developer-experience.md#plan-07](./developer-experience.md#plan-07) defines scaffold, dev, up,
  inspect, logs, and onboarding command behavior.
- [authoring-resources-wiring.md#plan-21](./authoring-resources-wiring.md#plan-21) defines resource
  collection, manifest IR, and inferred permissions used by examples.
- [ADR-0064](./adr/07-portability-extensibility.md#adr-0064) keeps product UI generation and
  business mechanics outside Example Apps.

## Owning Initiative Dependencies

| Owner | Consumes from Example Apps | Boundary |
|---|---|---|
| Example Apps | HOBO-488 launch demo golden path can consume the accepted catalog and proof-mode rules. | This issue defines scope; it does not author the launch demo path. |
| V1 Launch Site, Messaging & Demo Assets | Claim register and demo assets need Example Apps proof modes before making public claims. | Marketing copy, launch pages, and final assets remain outside Example Apps M0. |
| Workspace & Onboarding UX | First-run telemetry and workspace activation can use example command paths as fixtures. | Activation metrics and product UX instrumentation remain in the onboarding UX project. |
| Customer Onboarding | Pilot onboarding can reuse accepted example paths as comparable first-success scripts. | Customer-success scripts and support handoff remain in Customer Onboarding. |
| V1 Release Program & Cutline | Known-limitations and readiness dashboards can classify example claims by proof mode. | Go/no-go, legal, support, and release-note decisions remain in release-readiness projects. |

## Launch Demo Consumption

HOBO-488 consumes this accepted scope in [`launch-demo-golden-path.md`](./launch-demo-golden-path.md).
That record turns the `snapshop` example-app proof modes into a launch demo checklist with command
path, screens, expected outputs, failure recovery, and required assets. It does not build the demo
app or marketing surface.

## Evidence Required For M1

| Evidence | Owner | Proof mode | Proves |
|---|---|---|---|
| Catalog | Demo maintainer | Design record | Every example has a persona, command path, boundary owner, and refresh obligation. |
| Scaffold smoke | App developer evaluator | Contract test | Each supported template can scaffold, run locally, and expose a manifest fixture. |
| Command transcript | Agent builder | Reference fixture | CLI and MCP command paths are reproducible without private local knowledge. |
| Proof assets | Demo maintainer | Live recording | Launch-facing demos have screenshots, recordings, and expected outputs tied to real or declared simulated behavior. |
| Failure-mode contracts | Platform engineer evaluator | Contract test | Examples include refusal, policy denial, missing secret, and unsupported provider recovery evidence. |

## Follow-Up Gate

M1/M2/M3/M4 design or implementation issues must wait until this M0 scope record is accepted. This
branch records the gate and its executable guard; it does not create follow-up implementation issues.
