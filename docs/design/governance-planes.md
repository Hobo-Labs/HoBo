---
type: Reference
title: "Governance Planes: Compliance & AI Safety"
description: "This capability doc covers the HoBo governance plane: compliance/data governance and AI safety/model governance as one enforcement story."
tags: [hobo, design]
---

# Governance Planes: Compliance & AI Safety

This capability doc covers the HoBo governance plane: compliance/data governance and AI safety/model governance as one enforcement story.

## Plan 46

> **What this plane does.** This plane turns a **data classification into an *enforced* residency/retention decision** and delivers **right-to-erasure** on a forward-only log. It builds on residency context ([ADR-0040](./adr/01-architecture-core.md#adr-0040)/[ADR-0036](./adr/07-portability-extensibility.md#adr-0036)), the retention floor ([ADR-0023](./adr/02-identity-security.md#adr-0023)), and the OCSF audit export ([ADR-0046](./adr/02-identity-security.md#adr-0046)) — wiring them into one enforcement plane. Attestation evidence rides out as a signed OCSF export.

### Data classification — the input everything keys on
Resources and WIT-record fields carry a **classification label** (`public` / `internal` / `pii` / `phi` / `pci` / `secret`, extensible). Labels attach two ways:
- **On a resource** — `sql("patients").classify("phi")` — the coarse default for everything it holds.
- **On a WIT-record field** ([ADR-0051](./adr/03-data-plane.md#adr-0051)) — `email: pii`, `ssn: pii` — fine-grained, so a projection ([Plan 32](./data-plane.md#plan-32)) inherits classification per column and the schema *is* the data map.
Classification emits `data.Classified` ([Plan 11](./data-plane.md#plan-11)) and becomes the `context.dataClassifications` the policy plane already accepts ([Plan 29](./contracts-policy-flags.md#plan-29) decision request). **Discovery** (scan a projection/field for likely PII) is an optional engine behind a port that *proposes* labels; humans/policy confirm.

### Residency & retention — enforced, not hinted
Classification + jurisdiction → **policy obligations** ([Plan 29](./contracts-policy-flags.md#plan-29)). Both inputs are now **typed** ([ADR-0146](./adr/02-identity-security.md#adr-0146)): `@hobo/core`'s jurisdiction port carries the `JurisdictionId` catalog (with legal-basis citations), the region→jurisdiction mapping, typed `DataClassification`, per-tenant `ResidencyConstraint`, and the pure fail-closed `evaluateResidency` whose conflict codes feed `can-trail`/`can-migrate` and the Gatekeeper `residency` gate; the `@hobo/policy` residency pack (`eu-data-stays-in-eu` realized) turns verdicts into deny/warn/allow-with-evidence decisions. Enforcement lands at two points:
- **`can-deploy`** ([Plan 29](./contracts-policy-flags.md#plan-29)) — a plan that would place `phi` data in a Camp outside its allowed region is a **gate failure**, not a runtime surprise. This reuses the deterministic Matching context (`region`/`provider`, [ADR-0033](./adr/01-architecture-core.md#adr-0033)) and cross-Camp residency ([ADR-0040](./adr/01-architecture-core.md#adr-0040)); sovereign mode ([ADR-0036](./adr/07-portability-extensibility.md#adr-0036)) is the strict ceiling.
- **Runtime** — a `notify`/replication/export action that would move classified data across a residency boundary is denied or mutated (e.g. region-pinned channel, [Plan 21](./authoring-resources-wiring.md#plan-21)).

**Retention** is the dual: each classification declares a retention window; the compaction/archival rules ([Plan 11](./data-plane.md#plan-11)) honor it as a **floor and a ceiling** — audit streams are retained per policy, and data past its ceiling is a candidate for erasure. Retention rules ride the existing event-log compaction policy; no new store.

### Right-to-erasure on a forward-only log
The hard problem: HoBo's log is **append-only and never rewritten** ([Plan 11](./data-plane.md#plan-11)) — so how do you "delete" a user? **Crypto-shredding**, not history rewrite:
1. PII payloads are encrypted with a **per-subject key** via `hobo:crypto` ([Plan 21](./authoring-resources-wiring.md#plan-21)/[Plan 21](./authoring-resources-wiring.md#plan-21)) — keys the app never holds.
2. An `erasure.Requested` opens a saga; **destroying the subject's key** renders every historical event carrying their PII permanently unreadable (the ciphertext stays, the plaintext is gone) and a **tombstone** event records the erasure.
3. **Projections rebuild excluding erased subjects** ([Plan 32](./data-plane.md#plan-32)) — the read side no longer surfaces the data; an `erasure.Completed` fact closes the saga.
This **honors the forward-only invariant** (no event is rewritten or removed) while delivering GDPR/CCPA deletion semantics — and it's auditable: the erasure itself is a replayable fact.

```mermaid
flowchart TB
  CL["classify: resource + WIT-record fields → data.Classified"] --> CTX["policy context: dataClassifications + region (Plan 30)"]
  CTX --> GATE{"can-deploy gate (Plan 29): residency/retention obligations"}
  GATE -->|violation| REJ["deployment.PlanRejected (data in wrong region)"]
  GATE -->|ok| RUN["runtime: cross-boundary action re-checked"]
  ER["erasure.Requested (subject)"] --> SHRED["hobo:crypto: destroy per-subject key + tombstone"]
  SHRED --> PURGE["projections rebuild excluding subject (Plan 39)"]
  PURGE --> DONE["erasure.Completed"]
  RUN --> EV["audit log + OCSF export (ADR-0046)"]
  DONE --> EV
  EV --> ATT["OCSF attestation export (signed) → external GRC tools"]
```

### OCSF attestation export — evidence from the log
HoBo standardizes the **enforcement**, not a compliance program. The audit facts it already records — the OCSF audit export ([Plan 12](./security-networking.md#plan-12)/[ADR-0046](./adr/02-identity-security.md#adr-0046)), `policy.Decided` (every access/residency/retention decision), `data.Classified`/`erasure.*` (the data lifecycle) — are exportable as a signed, point-in-time **OCSF attestation export** that external GRC tools can consume to assemble whatever certification evidence (SOC2/GDPR/HIPAA) a buyer needs. HoBo produces the replayable facts; it does not run the attestation program itself.

### Events & ports
- **New:** `data.Classified`, `governance.*` (residency/retention obligation lifecycle), `erasure.Requested`/`erasure.Completed` ([Plan 11](./data-plane.md#plan-11)). **Reused:** `policy.Decided`/obligations ([Plan 29](./contracts-policy-flags.md#plan-29)), `compat.Gate*` ([Plan 29](./contracts-policy-flags.md#plan-29)), `match.Decided` region context ([ADR-0033](./adr/01-architecture-core.md#adr-0033)), `hobo:crypto` ([Plan 21](./authoring-resources-wiring.md#plan-21)), OCSF audit export ([ADR-0046](./adr/02-identity-security.md#adr-0046)), projection rebuild ([Plan 32](./data-plane.md#plan-32)).
- **Ports/engines behind ports:** a **classification/discovery** engine (built-in label rules; optional PII-discovery scanner) and a thin **OCSF attestation export** assembler (external GRC tools consume it). No new app-developer SDK surface beyond `.classify()` + `hobo attest`/`hobo erase`.

### Verification
- A plan placing a `phi`-classified `sql` in a non-permitted region is rejected at `can-deploy` with a precise residency violation; pinning to a permitted Camp passes.
- `hobo erase --subject <id>`: key destroyed, tombstone written, projections rebuilt excluding the subject, `erasure.Completed` — the subject's data is unreadable everywhere yet **no historical event was rewritten** (replay still works).
- `hobo attest` produces a signed OCSF attestation export whose every line traces to a source event (classification, residency/retention decision, access decision) for an external GRC tool to consume.
- A deploy routing `pii` to a Camp/provider outside its allowed region or classification fails the gate; pinning to a permitted target unblocks it (event-sourced) — the egress caveats for hosted embedders/models ([Plan 32](./data-plane.md#plan-32)) ride the same residency obligation.

### Scope
- **In scope:** classification labels (resource + WIT-field) → enforced residency/retention obligations at `can-deploy` + runtime; crypto-shred erasure + projection purge; PII-discovery that *proposes* labels (humans/policy confirm, never auto-classifies); a data-lineage view over classification + projection read-sets; an OCSF attestation export over the audit facts for external GRC tools.
- **Out of scope:** HoBo does not run a SOC2/GDPR/HIPAA attestation *program* and does not ship a DPA/subprocessor registry as a product surface ([ADR-0064](./adr/07-portability-extensibility.md#adr-0064)) — it exports the facts, GRC tools run the program.

### AI safety & model governance

The same enforcement spine — classification, the policy plane, signed facts, the OCSF attestation export — extends from data to the models that touch it. HoBo is AI-native to its core — `"use training"` ([Plan 23](./generated-stack.md#plan-23)), the generation pipeline ([Plan 23](./generated-stack.md#plan-23)), the Operator Crew ([Plan 40](./operators-sre.md#plan-40)), the generated stack ([Plan 23](./generated-stack.md#plan-23)) — so "AI everywhere" must be governed by default or it becomes the biggest liability. This half of the plane governs the models/prompts themselves, **enforces output guardrails**, runs **red-teaming**, and emits **model cards** — built on prompt-injection defenses ([ADR-0023](./adr/02-identity-security.md#adr-0023)), evals ([Plan 23](./generated-stack.md#plan-23)), and the PII-not-trained rule ([ADR-0025](./adr/03-data-plane.md#adr-0025)). **All AI work runs in sandboxed environments by default** ([ADR-0061](./adr/02-identity-security.md#adr-0061)). Data classification (above) is the input here too: a dataset's label decides whether it may train or only evaluate.

#### A model registry (the Registry pattern, applied to models)
Models, prompts, and eval-datasets are **versioned, signed, provenance-bearing artifacts** in the existing **Registry** ([Plan 6](./ai-native-agent-auth.md#plan-06)/[Plan 25](./platform-engineering.md#plan-25)) — the same machinery that holds providers and Resource Packs:
- A **model entry** pins `{ id, version, provider, weights-or-endpoint ref, model card, eval results, signature }`. Local/in-boundary models and hosted endpoints are both entries (the latter with an egress caveat, like a subprocessor, riding the same residency obligation as classified data above).
- A **prompt entry** is a versioned artifact too — because in HoBo a prompt *is* persisted code ([ADR-0048](./adr/03-data-plane.md#adr-0048)) when `"use training"` rewrites it. Promotion is gated.
- An **eval-dataset entry** carries its own provenance + the classification label above — so a PII-bearing dataset can't be used for training ([ADR-0025](./adr/03-data-plane.md#adr-0025)).
`model.Registered`/`model.Promoted` are events; promotion runs the four-lens gate below.

#### Output guardrails — an enforced default on every AI call ([ADR-0061](./adr/02-identity-security.md#adr-0061))
Guardrails are an **enforced default, not optional and not behind a swappable port.** The **`guardrail` capability** ([Plan 21](./authoring-resources-wiring.md#plan-21)/[Plan 20](./wasm-runtime-wit.md#plan-20)) runs **moderation / PII-leak / jailbreak / grounding** checks as a **policy-gated step** ([Plan 29](./contracts-policy-flags.md#plan-29)) wrapped around *every* AI output — `agent()` responses ([Plan 6](./ai-native-agent-auth.md#plan-06)), `"use training"` method outputs ([Plan 23](./generated-stack.md#plan-23)), and generated-stack artifacts ([Plan 23](./generated-stack.md#plan-23)). There is no off switch. **This holds for streaming, the common LLM mode:** the rail runs on a **buffered window with a commit watermark** — the model may not emit past the watermark until that span passes the checks — so a disallowed token is withheld **before** client delivery rather than retracted after ([ADR-0061](./adr/02-identity-security.md#adr-0061) §2). "Every output" therefore covers streamed outputs, not just batch ones.

The default governance layer is **NVIDIA NeMo Guardrails + the Microsoft AI governance / Responsible AI toolkit** — NeMo rails for moderation/jailbreak/grounding/topical control (streaming-aware), the Microsoft Responsible AI toolkit for moderation/PII/content-safety — applied to every call as the policy-gated step. Both run **local-first**, so the layer keeps working air-gapped with no egress. A failed check emits `guardrail.Blocked` and the policy decides: block, redact (mutate), or require-approval. Because it rides the policy plane, "why was this output blocked" is a replayable `policy.Decided`. **And because all AI work runs sandboxed by default** ([ADR-0061](./adr/02-identity-security.md#adr-0061)) — every `agent()` / `"use training"` / generation pipeline / generated-stack execution in a capability-scoped wasm sandbox with no ambient authority ([Plan 20](./wasm-runtime-wit.md#plan-20)) — the guardrail step governs the output while the sandbox bounds the blast radius of the call itself. A **hosted-model** call is consistent with grant-only egress, not an exception to it: the hosted-endpoint Registry entry carries an **explicit, residency-checked egress grant** ([ADR-0061](./adr/02-identity-security.md#adr-0061) §1), so the egress to the provider is the gated/audited boundary (an un-granted hosted-model call is denied by the sandbox) and the guardrail still governs the returned output.

```mermaid
flowchart TB
  IN["AI call: agent() / use-training method / generated output<br/>(runs in capability-scoped sandbox, ADR-0061)"] --> PRE["pre-guardrail: prompt-injection / input policy (ADR-0023)"]
  PRE --> MODEL["model invoked (registry-pinned version + provenance)"]
  MODEL --> POST{"output guardrail (enforced default): NeMo + MS Responsible AI<br/>moderation / PII / jailbreak / grounding"}
  POST -->|pass| OUT["response returned"]
  POST -->|fail| DEC{"policy.Decided (Plan 30)"}
  DEC -->|block| BLK["guardrail.Blocked"]
  DEC -->|redact| OUT
  DEC -->|require-approval| HUM["escalate to human"]
  RT["red-team tier (chaos sibling, ADR-0047)"] -.adversarial evals.-> MODEL
  RT -.finding → regression test.-> EVAL["eval-dataset (governed)"]
```

#### Red-teaming as a chaos-tier sibling
Adversarial evaluation reuses the **chaos verification tier** pattern ([ADR-0047](./adr/02-identity-security.md#adr-0047)): **hypothesis-driven, blast-radius-bounded, policy-gated** adversarial experiments against models/prompts/agents (jailbreak suites, prompt-injection corpora, harmful-content probes). A red-team run is event-sourced (`redteam.*`); a **discovered failure becomes a permanent regression test** in the governed eval-dataset — exactly as a chaos finding becomes a resilience regression test. Red-teaming runs in the same gated, replayable frame as every other HoBo verification tier.

#### Eval-dataset governance
Eval-datasets are first-class governed artifacts (registry entries above): **versioned, classified, provenance-tracked**. This **extends the PII-not-trained policy** ([ADR-0025](./adr/03-data-plane.md#adr-0025)) into a full lifecycle — the dataset's classification label gates whether it may train or only evaluate; contamination checks (eval data leaking into training) are a policy rule; the `training-engine`'s reward signal ([Plan 23](./generated-stack.md#plan-23) trajectories) is auditable against the dataset it was scored on.

#### Model cards as facts
Every registered model carries a **model card** (intended use, training-data provenance class, eval results, known limitations, guardrail coverage) — a signed, replayable artifact assembled from the registry + `guardrail.*` + `redteam.*` + eval facts. Just as with data compliance above, HoBo exports these facts via the OCSF attestation export for an external GRC/responsible-AI tool to consume; it does **not** run a responsible-AI attestation *program* itself ([ADR-0064](./adr/07-portability-extensibility.md#adr-0064)). Model cards are the AI analog of the conformance/provenance bridge that underpins portability.

#### Per-token inference budgets
Governance promises **per-token cost/safety budgets riding the spend breaker** ([ADR-0039](./adr/02-identity-security.md#adr-0039), [Plan 5](./reliability-observability-cost.md#plan-05)) — this section pins the object and gate seam. **LLM inference tokens are not auth `token.*` credential events**; they are counted from OpenInference LLM spans (`llm.token_count.prompt` / `llm.token_count.completion` on `gen.*` / `agent()` trajectories) and folded into `MeteringView` as **`inference-tokens-input`** and **`inference-tokens-output`** dimensions (total = sum).

A **`TokenBudget`** is a scoped, period-bound limit object:

```json
{
  "id": "budget:inference/tenant-a/monthly",
  "scope": { "kind": "tenant|camp|agent|model|run", "id": "tenant-a" },
  "period": "per-run|daily|monthly",
  "limits": {
    "inputTokens":  { "soft": 1000000, "hard": 1200000 },
    "outputTokens": { "soft": 200000,  "hard": 250000 },
    "totalTokens":  { "soft": 1100000, "hard": 1300000 }
  },
  "modelId": null
}
```

- **Authoring** — `agent({ policy: { tokenBudgetRef } })`, Camp/Bindle policy packs, and model-registry entries may bind a `TokenBudget` by ref; unset limits mean unbounded for that axis.
- **Gate seam** — **`evaluateInferenceTokenBudget`** runs as a **pre-inference policy step** (after input guardrails, **before** model invocation in the diagram above). It consumes a **seq-pinned `MeteringView`** snapshot plus the call's **estimated** input/output tokens (from the prompt + `max_tokens` ceiling) and returns `allow` · `allow`+warn obligation · `require-approval` · `deny` via `policy.Decided`, emitting **`inference.BudgetGateEvaluated`** with the pinned `meteringViewSeq`, scope, and counter deltas. Hard denies block the model call; they do not silently truncate mid-stream unless policy explicitly chooses degrade/truncate.
- **Post-call metering** — completed LLM spans append **`meter.UsageRecorded`** facts for the inference-token dimensions (owner = tenant → Camp → Bindle → run/agent/team), so showback and the spend circuit-breaker reuse the same projection as USD budgets ([Plan 5](./reliability-observability-cost.md#plan-05) budgets section).
- **Spend-breaker coupling** — inference-token **velocity** and **hard** breaches feed the same policy plane and durable **`spend.CircuitTripped`** / **`spend.CircuitReset`** saga as Camp/tenant USD quotas; a tripped breaker halts further inference until acknowledged.

Executable contract: [`proofs/hobo-695-token-budget-governance`](./proofs/hobo-695-token-budget-governance/index.md) → [`src/draft/technical-proofs/token-budget-governance-contract`](../../src/draft/technical-proofs/token-budget-governance-contract/README.md).

#### The four lenses, applied to model & prompt changes
A model/prompt promotion is governed by the same four-lens taxonomy as any change ([Plan 29](./contracts-policy-flags.md#plan-29)/[Plan 29](./contracts-policy-flags.md#plan-29)):
- **Contract** — the model's I/O schema + the guardrail floor *must never break* (a guardrail-coverage regression blocks promotion).
- **Eval** — the candidate *should improve* on the governed eval-dataset (champion/challenger + shadow, [Plan 23](./generated-stack.md#plan-23)).
- **Policy** — *may/may not* be promoted (residency of weights, dataset classification, red-team clearance).
- **Trace** — *what actually happened* — every invocation is an OpenInference trajectory ([Plan 23](./generated-stack.md#plan-23)) the registry links back to.

#### AI-side events, ports & verification
- **New events/ports:** `model.Registered`/`model.Promoted`, `guardrail.Blocked`, `redteam.*` ([Plan 11](./data-plane.md#plan-11)); a **`hobo:guardrail`** port + `guardrail` catalog row ([Plan 21](./authoring-resources-wiring.md#plan-21)/[Plan 20](./wasm-runtime-wit.md#plan-20)). **Reused:** the Registry + signing/provenance ([Plan 6](./ai-native-agent-auth.md#plan-06)/[Plan 25](./platform-engineering.md#plan-25)), `policy.Decided` ([Plan 29](./contracts-policy-flags.md#plan-29)), evals/trajectories/`training.*` ([Plan 23](./generated-stack.md#plan-23)/[ADR-0025](./adr/03-data-plane.md#adr-0025)), the chaos tier ([ADR-0047](./adr/02-identity-security.md#adr-0047)), persisted prompts ([ADR-0048](./adr/03-data-plane.md#adr-0048)), and the same OCSF attestation export defined above.
- **Guardrail layer (enforced default):** NVIDIA NeMo Guardrails + the Microsoft AI governance / Responsible AI toolkit, applied to every AI call as the policy-gated step — local-first, air-gap-safe, no off switch ([ADR-0061](./adr/02-identity-security.md#adr-0061)). The **red-team engine** (built-in adversarial suites) is certified by `@hobo/conformance` and air-gap-degradable.
- **Verification:** a `"use training"` candidate prompt that regresses guardrail coverage is **blocked at promotion** (Contract lens) even if it improves the eval score (Eval lens) — replayable `policy.Decided`; a jailbreak that elicits disallowed content emits a `redteam.*` finding, becomes a regression test in the governed dataset, and fails future promotions until mitigated; an agent output containing PII is caught by the guardrail step → `guardrail.Blocked` (or redacted by policy), local-first so air-gap catches it with no egress; `hobo attest` also produces a signed model-card export tracing to registry + guardrail + red-team + eval events.

#### AI-side scope
- **In scope:** model/prompt/eval-dataset registry entries (versioned, signed, provenance); the `guardrail` capability as an enforced default (NeMo Guardrails + Microsoft Responsible AI toolkit, local-first); red-teaming on the chaos-tier pattern, including automated continuous red-team campaigns; eval-dataset classification/contamination policy; model cards as exported facts; the four-lens model-promotion gate; per-token cost/safety budgets (riding the spend breaker); model distribution over Registry distribution ([ADR-0062](./adr/07-portability-extensibility.md#adr-0062)).
- **Out of scope:** as with data compliance above, HoBo does not run a responsible-AI attestation *program* itself ([ADR-0064](./adr/07-portability-extensibility.md#adr-0064)) — it exports the facts, a GRC tool runs the program; a watermarking/output-provenance scheme for generated media is a separate concern.

## HoBo.CD: posture and compliance

Governance at decision time (the gate) is joined by **continuous posture**
([ADR-0180](./adr/01-architecture-core.md#adr-0180) D24, D25; [continuous-delivery.md](./continuous-delivery.md)):

- **Rails are delivered like software.** An approved Rail version is Freight.
  It is promoted through a pipeline first in `INFORM` mode, where the enforced
  Rail still decides and the gate records shadow decisions
  (`policy.ShadowDecided`) with any divergence, and only then in `ENFORCE`
  mode, which requires a qualified `INFORM` node upstream. A Rail change no
  longer activates everywhere at once, and rollback restores the previous
  enforced digest.
- **Posture rules** are policy-IR rules in phase `observe`, bound by a Rail's
  `delivery.posture`. They match resources by kind and classification and
  assert `require` or `forbid` over declared attributes with a fixed operator
  set; there is no expression language.
- **Evaluation** runs Station-side with the pure `@hobo/policy/posture`
  evaluator over attributes reconcilers report (secret-free, at most 16 KiB
  per resource). Results are `compliance.Observed` and `compliance.Changed`,
  and the Camp's `POSTURE_COMPLIANT` condition. Agents report facts and never
  evaluate posture.
- **Remediation has one mutator.** `inform` records; `inform-only` cannot be
  raised by a parent; `enforce` acts only through a repair Delta applied by the
  Camp's reconciler. A rule that contradicts a value the Set owns is
  `ownership-conflict`: nothing is mutated, and the gate refuses promotions
  that keep the violation.
- **Evidence.** Compliance records map to **OSCAL assessment results**
  beside the existing OSCAL export.
- **Runbook:** [policy delivery and posture](../runbooks/cd/posture.md).
