---
type: Reference Standard
title: "CNCF Serverless Workflow"
description: "Serverless Workflow is a **CNCF (Sandbox, accepted July 2020) vendor-neutral DSL for defining and executing workflows** — \"a vendor-neutral, open-source, and entirely community-dri"
tags: [hobo, standards]
---

# CNCF Serverless Workflow

> **Standard** · vendor-neutral workflow DSL · Source: [serverlessworkflow.io](https://serverlessworkflow.io/) · [specification (GitHub)](https://github.com/serverlessworkflow/specification) · [DSL reference](https://github.com/serverlessworkflow/specification/blob/main/dsl-reference.md). Excerpts quoted for analysis (fair use).

## What it is
Serverless Workflow is a **CNCF (Sandbox, accepted July 2020) vendor-neutral DSL for defining and executing workflows** — "a vendor-neutral, open-source, and entirely community-driven ecosystem tailored for defining and executing DSL-based workflows." A workflow is authored declaratively in **YAML or JSON**, and any conforming **runtime** can execute it; the spec separates *what* the workflow does from *how/where* it runs (FaaS, containers, HTTP services, event brokers).

The DSL reached **v1.0.0 (released 27 January 2025)**, a substantial redesign over the 0.8.x line (which was organized around named `functions`/`events`/`states`). v1.0 reorganizes the language around **tasks** sequenced inside a `do` block, native HTTP/gRPC/OpenAPI/AsyncAPI calls, and CloudEvents-based eventing. It sits in the CNCF "App Definition and Development" space, alongside other declarative-app standards.

## Key features
- **Document shape** — a workflow has a `document` (DSL version, namespace, name, version), optional `input`/`output`/`schedule`, reusable definitions under `use` (functions, authentications, retries, errors), and a `do` list of named tasks.
- **Tasks (the unit of work), v1.0:**
  - `call` — invoke a function/service: **HTTP, gRPC, OpenAPI, AsyncAPI**, or a custom/named function.
  - `run` — run a **container, script, shell command, or sub-workflow**.
  - `do` — a nested sequence of tasks (composition/grouping).
  - `set` — set/transform workflow data (expressions, e.g. via `jq`/runtime expr).
  - `switch` — conditional branching on `when` cases.
  - `for` — iterate over a collection (looping).
  - `fork` — run branches **concurrently** (optionally compete/`compete: true`).
  - `try` / `catch` — structured error handling (see below).
  - `raise` — raise a (typed) error.
  - `emit` — publish a **CloudEvent**.
  - `listen` — wait for / correlate one or more incoming events.
  - `wait` — pause for a duration.
- **Control flow** — tasks run in order within a `do`; each task may carry a **`then`** directive to redirect flow (`continue`, `exit`, `end`, or a named task), making the sequence an explicit, deterministic graph.
- **Events** — first-class, **CloudEvents-native**. `emit` publishes; `listen` consumes with **correlation** (match by event attributes/payload) and timeouts. The spec also defines **lifecycle events** for workflows (Started/Completed/Faulted/Cancelled…) and tasks (Created/Started/Completed/Retried…).
- **Functions / calls** — protocol-typed (`http`, `grpc`, `openapi`, `asyncapi`) plus reusable, parameterized **custom functions** declared under `use.functions` and invoked by name; authentication policies declared once under `use.authentications` and referenced.
- **Error handling & retries** — `try` wraps tasks; `catch` filters by error type (`when`/`errors`), optionally **retries** with a declared policy (delay, **backoff** — constant/linear/exponential — `limit` on attempts and/or duration, jitter) and a recovery `do`. Errors follow a **Problem Details (RFC 7807)-style** model (`type`, `status`, `title`, `detail`).
- **Timeouts & scheduling** — per-task and per-workflow `timeout`; workflows can be `schedule`d (on `cron`, `after`, `every`, or on an event).
- **Runtimes & SDKs** — known runtimes include **Apache KIE SonataFlow** (the main reference runtime, ex-Kogito), **Synapse**, **Lemline**, plus a Java reference implementation. Official **SDKs** exist for **Go, Java, .NET, Python, TypeScript, Rust, and PHP**, used to parse/validate/build workflow definitions.

## Relevance to HoBo
HoBo already has a **workflow/step durable-execution primitive** as a core SDK surface — `workflow(fn)` / `"use workflow"` and `step(fn, opts)` ([Plan 2 §Layer 4](../design/sdk-api.md#plan-02)), exposed to wasm guests via the **`hobo:runtime/workflow`** WIT interface (`run-step`, `sleep`, `emit`) ([Plan 20](../design/wasm-runtime-wit.md#plan-20)) and backed by the durable runtime a Camp supplies ([Plan 2 §Layer 1](../design/sdk-api.md#plan-02), durable runtime [Plan 11](../design/data-plane.md#plan-11)). So HoBo and Serverless Workflow are **the same problem solved from opposite ends**: HoBo's is a **code-first, replayable, event-sourced TS runtime**; Serverless Workflow is a **declarative, portable, multi-runtime DSL**.

**TS workflow/step vs. a declarative DSL.** HoBo's surface is *imperative TypeScript that compiles to a deterministic event log* — steps are memoized, `sleep`/`cron` are durable timers, retries are per-step (`3×` capped exp-backoff + jitter by default, `FatalError`/`RetryableError` overrides), and replay is the recovery mechanism ([Plan 2](../design/sdk-api.md#plan-02)). Serverless Workflow's equivalents map closely: `step ≈ call`/`run`, `sleep ≈ wait`, `emit ≈ emit`, `listen` for event correlation, `switch`/`for`/`fork` for control flow, and HoBo's retry budget ≈ the DSL's `try`/`catch` + `retry` policy. The semantics line up well enough that one could be **expressed in terms of** the other.

**The opportunity: Serverless Workflow as an interchange / optional authoring format behind the workflow port.** Because HoBo's workflow capability is a **WIT port** with a built-in backend (the recurring HoBo stance — keep the standard *behind* a port, don't bake it into the model), HoBo could:
- **Import** a Serverless Workflow document as an *alternative authoring surface* — non-TS teams (or AI/Forge generation, [Plan 23](../design/generated-stack.md#plan-23)) author declaratively; HoBo compiles the DSL to its internal step graph and executes it on the durable runtime, gaining replay + the event log for free.
- **Export** a HoBo workflow's resolved shape to Serverless Workflow YAML/JSON as a **portable interchange artifact** — useful for portability/conformance claims ([ADR-0024](../design/adr/07-portability-extensibility.md#adr-0024)) and for handing a workflow to a non-HoBo runtime (SonataFlow/Synapse).
- Treat a **Serverless Workflow runtime** (SonataFlow) as one possible *provider* behind the workflow port, the way OPA/Pact sit behind the policy/contract ports.

**Caveats to analyze before adopting.** (1) Determinism: HoBo's replay model needs side effects confined to steps; a DSL `call`/`run` must map to a memoized step, and free-form `set` expressions must be deterministic. (2) The DSL's CloudEvents eventing aligns with HoBo's CloudEvents-at-the-boundary bet but must be reconciled with HoBo's internal event log semantics. (3) Versioning: the 0.8 → 1.0 redesign was breaking, so any import/export should pin **DSL v1.0.0** and version the mapping. Net: a strong candidate for an **optional declarative authoring + interchange surface**, not a replacement for the TS-native primitive.

## Sources
- Serverless Workflow — https://serverlessworkflow.io/
- Specification repo (CNCF) — https://github.com/serverlessworkflow/specification
- DSL reference (v1.0.0) — https://github.com/serverlessworkflow/specification/blob/main/dsl-reference.md
- "Understanding the Serverless Workflow 1.0 DSL" (Gilles Barbier) — https://gillesbarbier.medium.com/understanding-the-serverless-workflow-1-0-dsl-6e874a1fd511
- Apache KIE SonataFlow (runtime) — https://sonataflow.org/
