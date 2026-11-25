---
type: Reference Standard
title: "OCSF — Open Cybersecurity Schema Framework"
description: "OCSF is \"an open, vendor-agnostic data model for standardizing cybersecurity telemetry.\" It defines a common **JSON schema, taxonomy, and semantic definitions** so that security ev"
tags: [hobo, standards]
---

# OCSF — Open Cybersecurity Schema Framework

> **Standard** · Open, vendor-agnostic schema + taxonomy for normalizing security events. Source: [ocsf.io](https://ocsf.io/) · [schema.ocsf.io](https://schema.ocsf.io/) · [ocsf/ocsf-schema (GitHub)](https://github.com/ocsf/ocsf-schema). Excerpts quoted for analysis (fair use).

## What it is
OCSF is "an open, vendor-agnostic data model for standardizing cybersecurity telemetry." It defines a common **JSON schema, taxonomy, and semantic definitions** so that security events from diverse products — endpoint, network, IAM, cloud, SIEM — can be **normalized into one shape** and analyzed at scale without per-source translation. It is **storage- and transport-agnostic** (no opinion on collection, ETL, or where data lands).

OCSF originated from work led by AWS and Splunk and is now an open community project. The current stable line is **v1.x** (v1.7.0 / v1.8.0 stable, with development continuing toward v1.9.0). It is the native normalized schema for, e.g., **Amazon Security Lake**, and is widely adopted as a SIEM ingestion/normalization target.

## Key features
- **Categories** (top-level domains, each with a UID):
  1. **System Activity** `[1]` — file/process/kernel/module operations
  2. **Findings** `[2]` — security, vulnerability, compliance, detection findings
  3. **Identity & Access Management** `[3]` — authentication, authorization, account management
  4. **Network Activity** `[4]` — HTTP, DNS, SSH, RDP, and other protocols
  5. **Discovery** `[5]` — device/user inventory
  6. **Application Activity** `[6]` — web resources, APIs, datastore operations
  7. **Remediation** `[7]` — corrective actions on files/processes/networks
  8. **Unmanned Systems** `[8]` — drone/airborne activity
- **Event classes** — a *class* is a specific event type inside a category (e.g. *Authentication*, *Process Activity*, *File Activity*, *API Activity*, *Network Flow*, *Detection Finding*). Each class has required + optional attributes.
- **`class_uid` composition** — `category_uid × 1000 + class` (e.g. File Activity = `1001`, in System Activity); `type_uid` further encodes the activity (`class_uid × 100 + activity_id`).
- **Base event attributes** — every class inherits a common base: `activity_id`, `category_uid`, `class_uid`, `type_uid`, `severity_id`, `time`, `metadata` (incl. schema version + product), `observables`, plus `status`, `message`, etc. This common core is what makes cross-class querying possible.
- **Attribute dictionary + objects** — a central **dictionary** defines every attribute once (name, type, description); reusable **objects** (e.g. `actor`, `user`, `device`, `process`, `http_request`, `api`, `cloud`) compose into classes so the same concept (a "user") has one consistent shape everywhere.
- **Profiles** — cross-cutting attribute bundles overlaid on classes for a context (e.g. **Cloud**, **Container**, **Host**, **Security Control**, **Incident**, **Data Classification**). A profile adds the same set of attributes to every class it applies to.
- **Extensions** — additive, namespaced schema add-ons for vendor- or platform-specific attributes/classes (e.g. **Windows**, **Linux** extensions), without forking the core.
- **Normalization value** — by reducing translation overhead, OCSF lets enterprises consolidate security data, improve detection fidelity, and accelerate investigation across multi-cloud/hybrid estates with one schema instead of N proprietary formats.

## Relevance to HoBo
HoBo's design makes a strong claim: **"the event log *is* the audit log"** ([Plan 12 §Audit & compliance](../design/security-networking.md#plan-12)). The append-only log records *who* (principal/SVID), *what* (event), *when* (Clock), and *why* (causation/correlation) for every infra change and every credential grant/use/revoke. That is precisely the raw material a SIEM wants — but HoBo's internal event types (`token.Granted`, `identity.Issued`, `policy.Decided`, `user.Authenticated`, …, [Plan 11](../design/data-plane.md#plan-11)) are HoBo-shaped, not SIEM-shaped. **OCSF is the export schema** that bridges that gap: the log is the source of truth; OCSF is the normalized form HoBo emits for security tooling.

**Mapping HoBo security-relevant events → OCSF classes:**

| HoBo event family ([Plan 11](../design/data-plane.md#plan-11)) | OCSF category → class |
|---|---|
| `user.Authenticated`, `session.Started`/`Refreshed`/`Revoked` ([Plan 6](../design/ai-native-agent-auth.md#plan-06)) | IAM `[3]` → **Authentication** |
| `identity.Issued`/`Rotated` | IAM `[3]` → **Account Change** / **Authentication** |
| `token.Granted`/`Used`/`Revoked`/`Denied` (the credential audit trail) | IAM `[3]` → **Authorization** / **Authentication** |
| `policy.Decided` (effect + evidence + obligations), `policy.ViolationDetected` ([Plan 29](../design/contracts-policy-flags.md#plan-29)) | Findings `[2]` → **Detection Finding** / **Compliance Finding** |
| `resource.*`, `deployment.*`, `domain.*` (infra changes) | Application Activity `[6]` → **API Activity**; Cloud profile |
| `spend.CircuitTripped` ([ADR-0039](../design/adr/02-identity-security.md#adr-0039)) | Findings `[2]` (anomaly/policy) |

**Why this fits HoBo's posture.** Per [`README`](./index.md), HoBo's bet is to *speak existing standards at its boundaries* rather than invent proprietary ones — OCSF is exactly the security-schema boundary. Concretely:
- **The `CredentialAudit` projection** ([Plan 11](../design/data-plane.md#plan-11)/[Plan 5](../design/reliability-observability-cost.md#plan-05)) already answers "what did this agent access, with which token, when?" — fold it to OCSF **Authorization/Authentication** events and a tenant gets SIEM-ready export with zero new instrumentation, the same "projection over the log" pattern used for metering ([ADR-0039](../design/adr/02-identity-security.md#adr-0039)).
- **Envelope vs payload.** OCSF defines the *security payload schema*; it is **complementary to CloudEvents** (see [`cloudevents.md`](./cloudevents.md)), which defines the *transport envelope*. The clean design: emit **CloudEvents-wrapped OCSF events** — CloudEvents `type` carries the OCSF class, `data` carries the OCSF object — to a tenant's security lake / SIEM.
- **Compliance leverage.** [Plan 12 §Iteration hooks](../design/security-networking.md#plan-12) asks which compliance targets to design toward (SOC2/ISO/FedRAMP) and what each implies for the log. Emitting OCSF (and aligning audit-stream retention to it) directly serves those audits because OCSF is the format auditors' tools already ingest. The per-tenant isolation of streams ([Plan 12](../design/security-networking.md#plan-12)) means OCSF export inherits tenant scoping — no cross-tenant leakage in the SIEM feed.

**Recommendation.** Treat OCSF as an **emit-at-the-boundary export schema**, realized as a projection/adapter over the audit streams (`token.*`, `identity.*`, `policy.*`, `user.*`/`session.*`, security-relevant `resource.*`). Use OCSF **profiles** (Cloud, Container, Incident) to enrich, and the **extension** mechanism for HoBo-specific attributes (Bindle/Camp/Yard scope) so the SIEM keeps HoBo's context without forking the core schema. Keep the internal envelope ([Plan 11](../design/data-plane.md#plan-11)) authoritative; OCSF is the normalized view security teams consume.

## Sources
- [OCSF — ocsf.io](https://ocsf.io/)
- [OCSF Schema Browser — schema.ocsf.io](https://schema.ocsf.io/)
- [ocsf/ocsf-schema — GitHub](https://github.com/ocsf/ocsf-schema)
- [OCSF in Amazon Security Lake — AWS docs](https://docs.aws.amazon.com/security-lake/latest/userguide/open-cybersecurity-schema-framework.html)
- [The OCSF — Splunk](https://www.splunk.com/en_us/blog/learn/open-cybersecurity-schema-framework-ocsf.html)
- HoBo: [Plan 12 — Security & multi-tenancy](../design/security-networking.md#plan-12) · [Plan 11 — Event model](../design/data-plane.md#plan-11) · [Plan 30 — Policy plane](../design/contracts-policy-flags.md#plan-29) · [Plan 36 — End-user auth](../design/ai-native-agent-auth.md#plan-06) · [ADR-0039 — Billing/quota/cost](../design/adr/02-identity-security.md#adr-0039)
