---
type: Reference
title: "Meta-cloud Broker Design"
description: "Source issue: HOBO-521."
tags: [hobo, design]
---

# Meta-cloud Broker Design

## Problem

HoBo's current control-plane design conflates three concerns that should evolve
independently:

- UX admin controls: the human and agent-facing surface for approving providers,
  mappings, policy ceilings, exceptions, and visibility.
- Meta-cloud resolution: validating an app's contract manifest against an
  environment's approved provider and IaC mapping facts.
- Yard execution: planning the deployment DAG from an accepted resolution,
  reconciling resources, dispatching IaC/build work, and observing drift.

Today the design describes the Yard Planner as the place where app manifests,
Resource Definitions, provider Capability Manifests, contract checks, and deploy
execution all meet. That makes the "self-hosted meta-cloud" idea too broad: the
same conceptual component appears to configure the platform, decide what the
environment can resolve, and execute the resolved deployment.

## Decision

Introduce a distinct **Meta-cloud Broker**. The broker is the authoritative,
mirrorable service that validates app contract manifests against a configured
**Broker Environment** and returns either:

- a signed **Resolution Receipt**, which the Yard can consume; or
- a structured **Resolution Rejection**, which explains why the manifest cannot
  be resolved in that environment and what could fix it.

The broker is analogous to a Pact broker in the sense that it validates contract
manifests between two sides before promotion. The analogy stops there. Pact-style
producer/consumer compatibility remains HoBo Contract IR behavior. The
Meta-cloud Broker validates **environment deployability**: whether HoBo-native
resources and capabilities can be mapped to approved provider, IaC, build, and
runtime configurations in a specific broker environment.

## Boundary

### UX Admin Controls

UX admin controls are the configuration and review surface. They allow humans or
authorized agents to propose and approve:

- provider registration and deprecation;
- Resource Definition and Resource Pack changes;
- broker environment versions;
- mapping exceptions and non-portable surfaces;
- policy ceilings that constrain placement; and
- receipt or rejection review workflows.

The UX admin surface does not resolve deployments itself. It writes proposed
configuration changes, approval records, and audit facts consumed by the broker.

### Meta-cloud Broker

The broker owns environment-resolution authority. It accepts a contract manifest
and a named broker environment, then runs deterministic resolution over the
environment's pinned catalog snapshot.

The broker owns:

- contract manifest intake;
- broker environment catalog snapshots;
- mapping contract validation;
- Resource Definition selection for production deploys;
- conformance and provenance evidence checks needed for resolution;
- structured rejection reasons and remediation candidates;
- Resolution Receipt signing; and
- mirror bundle production for self-hosted and air-gapped environments.

The broker does not:

- run IaC or build jobs;
- own ResourceActor state;
- broker runtime or cloud credentials;
- replace the token broker;
- replace the policy engine or Gatekeeper;
- own drift detection or rollback;
- own rollout state; or
- serve as the user-facing admin console.

### Yard Control Plane

The Yard remains the provider-specific execution control plane. It consumes a
valid Resolution Receipt, turns it into a DeploymentPlan DAG, and drives
ResourceActors and Executors to converge resources.

For production apply, the Yard must not silently fall back to local Matching when
a receipt is missing, stale, forged, or for a different manifest or broker
environment. Local/dev may run advisory unsigned resolution only when it carries
an explicit fidelity label and cannot be promoted as production evidence.

### Gatekeeper

The broker answers "can this manifest resolve in this broker environment?" The
Gatekeeper still answers "may this deployment apply now?"

Placement-relevant policy ceilings may be broker inputs, but final policy,
contract compatibility, evals, cost budget, signing, golden-suite, and apply
authorization still compose in Gatekeeper. The broker produces deployability
evidence; it does not grant permission to deploy.

## Core Artifacts

### Contract Manifest

The manifest produced from app code and authoring surfaces. It includes:

- HoBo-native resources such as database, queue, service, bucket, auth, config,
  and projection sinks;
- imported WIT ports and required verbs;
- inferred and explicitly narrowed `.allow()` scope;
- `require` and `prefer` capability constraints;
- provider-specific `.with(...)` and `.raw(...)` non-portable surfaces;
- contract compatibility inputs needed by the existing HoBo Contract IR; and
- the manifest schema version and digest.

### Broker Environment

A named, versioned resolution environment. It includes:

- approved providers and provider package digests;
- provider Capability Manifests;
- Resource Definitions and Resource Packs;
- mapping contracts from HoBo-native services to provider/IaC/build/runtime
  realizations;
- conformance report ids and validity windows;
- policy ceilings that constrain placement;
- supported IaC drivers and build providers;
- region, residency, cost, stability, and trust-tier constraints; and
- signing trust roots.

Broker environments are hosted by default but must be mirrorable into
self-hosted and air-gapped Yards as signed bundles.

### Mapping Contract

A mapping contract states how a HoBo-native service or WIT port can be realized
in a broker environment. It contains:

- the abstract resource or port it satisfies;
- hard and soft capability support;
- provider, driver, build, runtime, and co-provisioned resource options;
- matching criteria and specificity data;
- conformance evidence references;
- portability and degradation notes; and
- remediation text for unsupported requests.

Provider-owned default Resource Definitions become one kind of mapping contract.
Platform-authored Resource Definitions and Resource Packs are also mapping
contracts once approved into a broker environment.

### Broker Catalog Snapshot

An immutable content hash over the broker environment's resolution inputs:
providers, mappings, Capability Manifests, conformance evidence, policy ceilings,
resolver version, and signing trust. A Resolution Receipt pins this snapshot so a
later catalog change cannot alter the meaning of an already accepted resolution.

### Resolution Receipt

A signed resolution result. It includes:

- manifest digest and schema version;
- broker environment id and version;
- broker catalog snapshot hash;
- resolver version;
- selected mappings for every resolved resource;
- rejected candidates and warning candidates where relevant;
- provider package digests;
- conformance report ids;
- policy ceiling versions consumed by resolution;
- non-portable surfaces accepted for this environment;
- deterministic `match.Decided` payloads or enough data for the Yard to emit
  receipt-derived `match.Decided` events; and
- signature metadata.

The Yard Planner consumes the receipt to build a DeploymentPlan DAG. It may
verify and replay the receipt, but production apply must not mutate the selected
mapping without a new receipt.

### Resolution Rejection

A structured failure result. It includes:

- failed resource or manifest path;
- reject code;
- human-readable and machine-readable reason;
- missing hard requirement, failed conformance evidence, unsupported
  non-portable surface, stale catalog, or ambiguous mapping detail;
- candidate remediations such as installing a provider, changing a mapping,
  relaxing a `prefer`, adding a conformance report, or using a different broker
  environment; and
- broker catalog snapshot hash used for the rejection.

Rejections are first-class UX admin objects. They should guide platform teams to
repair environment mappings rather than forcing app developers to guess provider
configuration.

## Lifecycle

1. App code and authoring surfaces produce `hobo.manifest/v1`.
2. The CLI, MCP, or UX admin surface submits the manifest digest and target
   Broker Environment to the Meta-cloud Broker.
3. The broker resolves HoBo-native resources against approved mapping contracts.
4. The broker rejects if any hard requirement cannot be satisfied, if required
   evidence is missing, if a non-portable surface is unsupported, if the catalog
   is stale or untrusted, or if deterministic resolution cannot prove intent.
5. The broker signs a Resolution Receipt when the manifest is deployable in that
   broker environment.
6. The Yard verifies the receipt and builds a DeploymentPlan DAG from it.
7. Gatekeeper evaluates apply-time policy, app compatibility, evals, conformance,
   cost, signatures, golden suites, and other deploy gates.
8. The Orchestrator drives ResourceActors and Executors only after receipt
   verification and Gatekeeper approval pass.

## Existing Design Changes

### `docs/design/architecture.md`

Add the Meta-cloud Broker as a third control surface between authoring/admin and
Yard execution. Replace the current single-step statement that the Yard Planner
turns Bindle plus mapping into a DeploymentPlan with:

```text
Bindle/app code -> Contract Manifest
Contract Manifest + Broker Environment -> Resolution Receipt | Rejection
Resolution Receipt -> Yard DeploymentPlan
DeploymentPlan -> ResourceActors/Executors
```

Registry/catalog ownership should move conceptually from "inside the Yard" to
the broker environment authority, while Yards may host or mirror broker services
for self-hosted and air-gapped profiles.

### `docs/design/control-plane.md`

Narrow the Yard Planner. It consumes Resolution Receipts for production deploys
and builds DAGs from receipt-selected mappings. It records receipt-derived
`match.Decided` evidence but does not own production Resource Definition
selection when a broker receipt is required.

### `docs/design/platform-engineering.md`

Reframe Resource Definitions, Resource Packs, provider-owned defaults, and inline
Camp mapping as inputs to Broker Environments. Matching remains deterministic,
but the authoritative production resolution is broker-mediated and pinned to a
catalog snapshot.

### `docs/design/contracts-policy-flags.md`

Clarify two contract concerns:

- HoBo Contract IR validates producer/consumer compatibility and still powers
  `can-deploy`.
- Meta-cloud Broker validates environment deployability of the manifest against
  approved mappings and capabilities.

Avoid saying this is "not an external broker" without qualifying which contract
axis is being discussed.

### `docs/design/glossary.md`

Add terms:

- Meta-cloud Broker;
- Resolution Broker;
- Broker Environment;
- Mapping Contract;
- Broker Catalog Snapshot;
- Resolution Receipt;
- Resolution Rejection.

### `docs/design/traceability.md`

Map the first proof to Plan 04, Plan 25, Plan 29, ADR-0033, and ADR-0090.

## First Proof Scope

Create `src/draft/technical-proofs/meta-cloud-broker-resolution-contract`.

The proof should be intentionally narrow. It should not edit the production
control plane. It should prove the contract boundary with fixtures.

### In Scope

- Fixture `hobo.manifest/v1` with database, queue, service, bucket, and one
  provider-native non-portable surface.
- Fixture Broker Environment with approved providers, mapping contracts,
  Capability Manifests, conformance reports, and policy ceiling ids.
- Deterministic resolution to a Resolution Receipt.
- Deterministic rejection for:
  - unsupported hard `require`;
  - missing or expired conformance evidence;
  - unsupported `.raw()` or provider-native option;
  - stale broker catalog snapshot;
  - ambiguous mapping that cannot prove intent through specificity, priority,
    or stable tiebreak.
- Receipt verification fixture for the Yard Planner.
- Yard Planner refusal for missing, stale, forged, or manifest-mismatched
  receipt.
- Proof README documenting scope-in, scope-out, fixtures, and verification.

### Out of Scope

- Live provider calls.
- Real IaC emission or apply.
- Production Yard code changes.
- UX admin screens.
- Token broker implementation.
- Full Gatekeeper implementation.
- Real cryptographic signing beyond deterministic fixture signatures, unless a
  local repo helper already exists.
- Linear issue creation unless requested separately.

### Acceptance Evidence

- Unit tests for resolve and reject paths.
- Fixture receipt snapshot with stable catalog hash.
- Fixture rejection snapshot with remediation.
- Yard planner receipt enforcement test.
- Docs update to the nearest design or proof README.

## Adversarial Requirements

- A receipt signed against catalog A must not authorize apply against catalog B.
- A provider claim without current conformance evidence is unavailable, even if
  the provider package is signed.
- Admin UI changes are proposed environment changes, not in-place mutation of a
  receipt.
- Hosted broker downtime does not create a production local-resolution fallback.
- Air-gapped mirrors verify signed broker bundles and monotonic versioning before
  accepting new broker environments.
- A `.raw()` or provider-native option is deployable only when the broker
  environment explicitly supports it.
- Token broker and Meta-cloud Broker terms remain distinct in docs and APIs.

## Review Notes

### Standards Axis

This design keeps the existing HoBo preference for deterministic, replayable,
catalog-hashed decisions. It changes the authority boundary: production mapping
resolution is broker-mediated rather than Yard-local. Existing docs must be
updated where they imply the Yard Planner owns all resolution authority.

### Spec Axis

The design satisfies the requested split because each concern has one job:

- UX admin controls configure and approve broker environments.
- Meta-cloud Broker resolves or rejects contract manifests against those
  environments.
- Yard control plane executes an accepted resolution.

It also preserves the Pact analogy without overfitting it. The broker validates a
contract relationship before promotion, but the relationship is between app
manifest needs and broker-environment mapping promises, not only API
producer/consumer compatibility.

## Defaults For The First Proof

- Model `Resolution Receipt` as a signed artifact referenced by Yard events. The
  event records the receipt digest, broker environment id, broker catalog
  snapshot hash, and verification result.
- Use `meta-cloud-broker-resolution-contract` as the proof package name. Defer
  the production package name until the proof validates the boundary.
- Require receipts for production applies and for any apply targeting a
  non-local Camp. Local/dev resolution can be advisory only when the fidelity
  label is explicit and cannot be promoted as production evidence.
- The first proof should add the draft package, its proof README, and traceability
  linkage. The broader edits to `architecture.md`, `control-plane.md`,
  `platform-engineering.md`, `contracts-policy-flags.md`, and `glossary.md`
  should be a follow-up design-alignment slice unless the implementing issue
  explicitly asks to update the whole design suite in one branch.

## Follow-up Decisions

- Production package naming: `@hobo/meta-cloud-broker`,
  `@hobo/resolution-broker`, or an internal module under a broader broker
  package.
- Whether hosted broker receipt enforcement eventually expands from production
  and non-local Camp applies to every deploy, including local preview lanes.
