---
type: Competitive Reference
title: "Modal — competitor reference"
description: "Modal is a **serverless compute platform for AI, ML, and data** — positioned as *\"The production cloud for AI\"* and *\"AI infrastructure that developers love.\"* You write ordinary **P"
tags: [hobo, competitors]
competitor:
  slug: modal
  name: "Modal"
  primary_category: cloud-application-platforms
  categories: [cloud-application-platforms, runtime-substrates]
  directness: adjacent
  role: "Python-first serverless compute for AI/ML with agent Sandboxes — AI-native compute competitor"
  posture: [provider-target, benchmark]
  hobo_surface: [runtime-portability, provider-matching]
  evidence: mixed
  status: active
  research_date: 2026-08-19
  contract: v1
  sources:
    - https://modal.com/docs/guide
    - https://modal.com/
---

# Modal — competitor reference

> A faithful capture of **Modal** (Modal Labs) for HoBo competitive analysis. Modal is a **serverless compute platform for AI/ML and data** — you write ordinary **Python**, decorate functions with **`@app.function`** / classes with **`@app.cls`**, define the **container image, GPU, and schedule in the same Python** (no Dockerfile, no YAML), and Modal runs it on **its own managed fleet** with **serverless GPUs**, **sub-second cold starts**, and **autoscaling from zero to 1000+ containers**. Captured because it is the **serverless-GPU / AI-compute benchmark** HoBo's AI-native positioning must answer to — and a plausible HoBo **compute/GPU/sandbox provider**. Sources: [modal.com](https://modal.com/) · [modal.com/docs/guide](https://modal.com/docs/guide) · [modal.com/pricing](https://modal.com/pricing) · [modal.com/docs/guide/images](https://modal.com/docs/guide/images) · [modal.com/docs/guide/gpu](https://modal.com/docs/guide/gpu) · [modal.com/docs/guide/sandbox](https://modal.com/docs/guide/sandbox) · [modal.com/docs/guide/lifecycle-functions](https://modal.com/docs/guide/lifecycle-functions) · [modal.com/docs/guide/memory-snapshots](https://modal.com/docs/guide/memory-snapshots). **Proprietary hosted SaaS** (the `modal` Python client is open source; the runtime/platform is closed and Modal-hosted); **per-second usage billing**. Researched July 2026; API/CLI/pricing shapes quoted for analysis under fair use (see [`index.md`](index.md#sources--fair-use)).

## What it is

Modal is a **serverless compute platform for AI, ML, and data** — positioned as *"The production cloud for AI"* and *"AI infrastructure that developers love."* Its hero promise: *"Run inference, training, batch processing, and sandboxes with sub-second cold starts, instant autoscaling, and a developer experience that feels local."* You write ordinary **Python**, decorate functions with **`@app.function`** and classes with **`@app.cls`**, and define the **container image, GPU type, secrets, volumes, and schedule inline in the same Python** — Modal's slogan is *"Your cloud environment, in code."* There is **no Dockerfile and no YAML**: the container image is a builder expression, the GPU is a string (`gpu="H100"`), the schedule is `modal.Cron(...)`. Modal then *"takes your code, puts it in a container, and executes it in the cloud,"* abstracting away Kubernetes, Docker, and cloud accounts.

The crucial architectural difference from Encore/Nitric: **Modal runs your code on *its own* managed multi-cloud fleet — you do NOT bring your own AWS/GCP/Azure account.** Modal *is* the cloud (an "AI-native runtime"), elastic from **0 to 1000+ GPUs**, billed **per second of active compute** with idle time free. Where Encore/Nitric are *infrastructure-from-code that provisions into your cloud*, Modal is a *serverless-compute product that hosts your code on Modal's platform*. That makes Modal **complementary to HoBo as much as competitive**: it is a natural **GPU/compute/sandbox provider** HoBo could broker to — while being a competitor for the "AI-native" mindshare HoBo claims.

Modal's real edge is **execution performance and DX**: containers *"boot in about one second,"* **memory snapshots** (checkpoint/restore) push cold starts sub-second, `.map()` fans a function out across thousands of containers, and **Sandboxes** give agents a **gVisor-isolated** box to run untrusted / LLM-generated code. These are **shipping, production-grade capabilities** that HoBo (design-phase) has **not** proven — Modal is genuinely **ahead on GPU/ML serverless, Python ergonomics, and agent-sandbox code execution**.

| Dimension | Modal |
|---|---|
| Authoring | **Python-only**; infra-in-code via decorators (`@app.function`, `@app.cls`); image/GPU/schedule/volumes all defined in Python |
| Compute | **Serverless containers + serverless GPUs** (T4·L4·A10·L40S·A100·H100·H200·B200·RTX-PRO-6000); autoscale **0 → 1000+**; `.map()` fan-out |
| Primitives | `App` · `Function` · `Cls` (lifecycle) · `Image` · **Volume** · **Dict** · **Queue** · **Secret** · **Sandbox** · web endpoints · scheduled/cron |
| Image model | **Code-defined** container images: `modal.Image.debian_slim().uv_pip_install(...).apt_install(...).run_commands(...)`; also `from_registry` / `from_dockerfile` |
| Web | `@modal.fastapi_endpoint` (fka `web_endpoint`) · `@modal.asgi_app` · `@modal.wsgi_app` · `@modal.web_server` → auto `*.modal.run` URL |
| State/storage | **Volume** (distributed FS, `.commit()`/`.reload()`) · **Dict** (KV) · **Queue** · **Secret** (env vars); Modal's *own* managed primitives (not your cloud's) |
| Sandboxes | **gVisor-isolated** ephemeral containers for **untrusted / agent / LLM-generated code**; `modal.Sandbox.create()` + `.exec()` |
| Cold start / scale | *"Boot in ~1s"*; **memory snapshots** (`enable_memory_snapshot`, `@modal.enter(snap=True)`); `min_containers`/`max_containers`/`buffer_containers`/`scaledown_window` |
| CLI | `modal run` · `modal deploy` · `modal serve` (live-reload) · `modal shell` · `modal setup` · `modal volume`/`secret`/`app` |
| Clouds | **Modal-managed fleet** — you do **not** bring your own cloud account; no pluggable IaC, no on-prem/self-host |
| AI focus | Purpose-built: LLM/image/audio/video **inference**, **fine-tuning** (multi-node), **batch/embeddings**, GPU **notebooks**, agent **sandboxes** |
| License / price | **Proprietary hosted SaaS** (client OSS); **per-second usage billing** — Starter $0 (+$30/mo credits) · Team $250/mo (+$100/mo credits) · Enterprise custom |

## Core primitives and mental model

| Primitive | What it is |
| --------- | ---------- |
| **App** | A Python program whose functions are decorated for remote execution |
| **Function** | A decorated Python function that runs in the cloud, with resources declared in the decorator |
| **Image** | The container environment, defined in Python rather than in a Dockerfile |
| **Volume / Dict / Queue** | Persistent and coordination primitives available to functions |
| **Sandbox** | Isolated execution for untrusted or agent-generated code |
| **GPU attachment** | Declared per function, with fast cold starts as the headline capability |

The mental model is **infrastructure as Python decorators**. The distinguishing choice is that the
container image itself is *defined in Python* — a single language describes the code, its
environment, its resources and its scaling — which is a genuinely different authoring ergonomic from
everything else in this corpus.

## How it competes with HoBo

| Contested HoBo surface | The contest |
| ---------------------- | ----------- |
| `authoring` | Decorator-based declaration is infrastructure-from-code in its purest shipped form |
| `runtime-portability` | Fast-starting GPU and CPU containers on demand |
| `provider-matching` | Resource requirements declared per function, satisfied by Modal's scheduler |
| `agent-surface` | **Sandboxes for agent-generated code** are a shipped, well-shaped primitive |

Modal contests HoBo's authoring thesis directly within one language, and its Sandboxes contest the
agent-execution surface HoBo cares about.

## Feature surface

### The core model — `App`, `@app.function`, `@app.cls`

You create an `App`, decorate a Python function, and call it with `.remote()` to run in the cloud (or `.map()` to fan out, `.local()` to run locally):

```python
import modal

image = modal.Image.debian_slim().uv_pip_install("transformers[torch]")
app = modal.App("example-inference")

@app.function(gpu="h100", image=image)
def chat(prompt: str | None = None) -> list[dict]:
    ...

@app.local_entrypoint()
def main():
    chat.remote("hello")          # runs in the cloud
```

`modal run path/to/file.py` executes it. Calls are `fn.remote(...)` (single remote call), `fn.map(inputs)` (parallel fan-out), `fn.spawn(...)` (background), and `fn.local(...)` (in-process). The philosophy is *"everything, including container environments and GPU specification, is code"* — **no YAML required**.

**Classes with lifecycle (`@app.cls`)** keep expensive state (a loaded model) warm across calls — the pattern behind Modal's inference story:

```python
@app.cls(cpu=8)
class Model:
    @modal.enter()                      # runs once on container startup
    def load(self):
        import pickle
        self.model = pickle.load(open("model.pickle"))

    @modal.method()                     # remote method
    def predict(self, x):
        return self.model.predict(x)

    @modal.exit()                       # cleanup on container shutdown
    def teardown(self): ...
```

`@modal.enter()` loads the model once per container; `@modal.method()` marks callable methods; `@modal.exit()` cleans up; `modal.parameter()` makes **parameterized** class instances. This is a genuinely elegant serverless-inference ergonomics — state loaded once, reused across warm invocations.

### Code-defined container images

Images are **Python builder expressions**, not Dockerfiles — chained methods produce a reproducible image:

```python
image = (
    modal.Image.debian_slim(python_version="3.13")
    .apt_install("git")
    .uv_pip_install("torch<3")
    .env({"HALT_AND_CATCH_FIRE": "0"})
    .run_commands("git clone https://github.com/modal-labs/agi && echo 'ready to go!'")
)
```

Builder surface: `debian_slim()` · `from_registry()` · `from_dockerfile()` (escape hatch) · `pip_install()` / `uv_pip_install()` · `apt_install()` · `run_commands()` · `env()` · `add_local_dir()` / `add_local_file()` · `run_function()` (run Python as a build step). This "container-image-as-code" DX is a real strength — and it is exactly the class of **container workload HoBo maps onto its OCI-container fallback path**, not something HoBo has a first-class *builder* for.

### Serverless GPUs

GPU is a string on the decorator; `:n` requests multiple; a **list** is an ordered fallback:

```python
@app.function(gpu="A100")            # single GPU
def qwen_7b(): ...

@app.function(gpu="H100:8")          # 8× H100 in one container
def run_llama_405b_fp8(): ...

@app.function(gpu=["H100", "A100-40GB:2"])   # prefer H100, fall back
def run_on_80gb(): ...
```

Supported types: **T4, L4, A10, L40S, A100-40GB, A100-80GB, H100, H200, B200, RTX-PRO-6000** (up to 8 GPUs/container; A10 up to 4). Modal *"respects the ordering of this list and will try to allocate the most preferred GPU type before falling back."* **This is the surface HoBo does not have** — there is no shipped HoBo serverless-GPU runtime; the closest design hook is provider adapters + Resource Definitions targeting GPU node tiers, which is **not a proven Modal equivalent**.

### Autoscaling & cold starts

By default Functions **scale to zero**; the autoscaler *"will spin up new containers when there is no capacity available."* Knobs on `@app.function`/`@app.cls`:

```python
@app.function(min_containers=3, buffer_containers=3, scaledown_window=300)
def my_function(): ...
```

`min_containers` (warm baseline), `max_containers` (ceiling), `buffer_containers` (headroom during bursts), `scaledown_window` (idle grace, default 60s). Containers *"boot in about one second."* **Memory snapshots** — `@app.function(enable_memory_snapshot=True)` plus init code under `@modal.enter(snap=True)` — checkpoint a warmed container's memory (CPU and, in preview, GPU) and restore it on future boots for **sub-second cold starts**. `.map()` runs *"up to 1,000 concurrent invocations per call"* (limits: 2,000 pending / 25,000 total inputs per function). This cold-start/scale engineering is **Modal's strongest moat** and something HoBo has not demonstrated.

### State & storage primitives (Modal's own, not your cloud's)

- **Volume** — a *"high-performance distributed file system"* mounted by path; requires explicit sync:
  ```python
  vol = modal.Volume.from_name("my-volume", create_if_missing=True)
  @app.function(volumes={"/data": vol})
  def run():
      open("/data/xyz.txt", "w").write("hello")
      vol.commit()                    # persist; .reload() to see others' writes
  ```
- **Dict** — a *"distributed key-value store"*: `d["stop"] = True`, `"stop" in d`; `modal.Dict.from_name(...)` (persistent) or `modal.Dict.ephemeral()`.
- **Queue** — a *"distributed queue"*: `q.put(x)` / `q.put_many(xs)` / `q.get_many(2000, timeout=5)`; `from_name`/`ephemeral`.
- **Secret** — injected as env vars: `@app.function(secrets=[modal.Secret.from_name("secret-keys")])`; also `Secret.from_dict(...)` / `from_dotenv()`.

These are **Modal-managed** primitives — not a mapping onto S3/DynamoDB/etc. in *your* account. That is the inverse of HoBo/Encore/Nitric, which map an abstract resource onto a cloud-native managed service.

### Web endpoints (FastAPI / ASGI / WSGI)

```python
image = modal.Image.debian_slim().pip_install("fastapi[standard]")
app = modal.App(image=image)

@app.function()
@modal.fastapi_endpoint()             # fka @modal.web_endpoint
def square(x: int):
    return {"square": x**2}
# → https://username--app-function.modal.run?x=42
```

Also `@modal.asgi_app()` (FastAPI/Starlette/FastHTML, with `@modal.concurrent(max_inputs=100)`), `@modal.wsgi_app()` (Flask/Django), and `@modal.web_server()` (raw port for aiohttp/Tornado/subprocess servers). `modal serve script.py` gives a **live-reloading** dev loop; `modal deploy` yields a **persistent `*.modal.run` URL**. Endpoints autoscale — containers boot on demand.

### Scheduled functions / cron

```python
@app.function(schedule=modal.Period(days=1))
def daily(): ...

@app.function(schedule=modal.Cron("0 8 * * 1", timezone="America/New_York"))
def weekly_report(): ...
```

`modal.Period` is interval-based (`Period(hours=5)`) and *"resets upon redeployment"*; `modal.Cron` is standard cron with timezone support and holds timing across deploys.

### Sandboxes — secure agent / untrusted code execution

Modal **Sandboxes** are *"secure containers for executing untrusted user or agent code"* — the shipping surface for **LLM-generated code**, running a repo's test suite, or arbitrary-dependency scripts:

```python
sb_app = modal.App.lookup("my-app", create_if_missing=True)
sb = modal.Sandbox.create(app=sb_app)
p = sb.exec("python", "-c", "print('hello')", timeout=3)
print(p.stdout.read())
sb.terminate()
```

Sandboxes are **built on gVisor** (Google's `runsc` application kernel) with *"custom logic to prevent Sandboxes from making malicious system calls,"* and by default are *"not authorized to access other resources in your Modal workspace"* — the blast radius is the sandbox container. Default lifetime 5 minutes (configurable to 24h) with idle-timeout cleanup; they accept custom images, volumes, and secrets. This is a **concrete, production agent-code-exec product** — precisely the niche HoBo addresses (differently) with **wasm capability isolation + sandbox lanes** ([ADR-0076](../design/adr/02-identity-security.md#adr-0076)), which is **design-phase, not a shipped untrusted-code-execution offering**.

### CLI

- **`modal run`** — run a Function / local entrypoint (`file.py::fn`), with `--detach`, interactive mode, etc.
- **`modal deploy`** — deploy an App for persistent Functions / endpoints / schedules.
- **`modal serve`** — live-reload dev loop: re-deploys on file change (great for web endpoints).
- **`modal shell`** — interactive shell inside a Modal container (matching a Function's image).
- **`modal setup`** — authenticate the client; plus `modal volume`, `modal secret`, `modal dict`, `modal queue`, `modal app list/stop/logs`, `modal launch`, `modal container`, `modal token`, `modal profile`, `modal environment`.

### Pricing (per-second usage billing)

*"You always pay for what you use and nothing more. You never pay for idle resources — just actual compute time, by the CPU cycle."*

| Resource | Price |
|---|---|
| **GPU — Nvidia B200** | $0.001736 / sec |
| **GPU — Nvidia H200** | $0.001261 / sec |
| **GPU — Nvidia H100** | $0.001097 / sec |
| **GPU — Nvidia A100 80 GB** | $0.000694 / sec |
| **GPU — Nvidia A100 40 GB** | $0.000583 / sec |
| **GPU — Nvidia L40S** | $0.000542 / sec |
| **GPU — Nvidia A10** | $0.000306 / sec |
| **GPU — Nvidia L4** | $0.000222 / sec |
| **GPU — Nvidia T4** | $0.000164 / sec |
| **CPU** | $0.0000131 / core / sec (min 0.125 cores/container) |
| **Memory** | $0.00000222 / GiB / sec |
| **Volumes** | $0.09 / GiB / month (1 TiB/month free) |

Plans: **Starter** $0 ($30/mo free credits, 100 containers, 10 GPU concurrency) · **Team** $250/mo ($100/mo free credits, 1,000 containers, 50 GPU concurrency) · **Enterprise** custom. Regional multipliers apply. This **per-second usage-metering-and-billing business model is `✗`-by-design for HoBo**, whose stance is **no billing/monetization** ([ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064)) with metering as OSS **showback/FinOps** only ([ADR-0039](../design/adr/02-identity-security.md#adr-0039)).

## Architecture

- **Control plane** — Modal's hosted scheduler and image builder.
- **Data plane** — Modal's own capacity, including GPUs, with container start times engineered as a
  primary product characteristic rather than an implementation detail.
- **Execution model** — the Python program is introspected, images are built from the declared
  environment, and decorated functions are dispatched to remote containers on call.
- **Cold start is the architecture.** Much of Modal's engineering is in making container start fast
  enough that per-call dispatch is viable, which is what makes the decorator model feel local.
- **State authority** — Modal's platform; the program is the description and the platform holds
  everything else.
- **Portability boundary** — the Python code is portable, the decorators are not. The program does
  not run anywhere else without removing the thing that made it work.

## Where Modal is stronger

> Shipped, evidenced capability only.

### what Modal does well

- **Serverless GPUs, done well** — T4→B200 as a decorator string, `:n` for multi-GPU, ordered fallback lists, autoscale **0→1000+**, per-second billing with idle free. HoBo (design-phase) has **no shipped equivalent**; Modal is clearly ahead.
- **Sub-second cold starts** — ~1s container boots plus **memory snapshots** (checkpoint/restore, incl. preview GPU snapshots). This performance engineering is Modal's headline moat.
- **Infra-in-Python DX** — container images, GPU, secrets, volumes, schedules all defined in Python; *"a developer experience that feels local."* No Dockerfile/YAML.
- **Sandboxes for agent code-exec** — gVisor-isolated ephemeral containers for untrusted / LLM-generated code, **shipping today**, with syscall filtering and workspace isolation.
- **Warm-state class model** (`@app.cls` + `@modal.enter`) — load a model once, serve inference across warm calls; `.map()` fan-out to thousands.
- **Batteries-included serverless state** — Volumes, Dicts, Queues, Secrets, web endpoints (FastAPI/ASGI/WSGI), cron — all managed, all serverless.
- **Purpose-built for AI** — inference, multi-node fine-tuning, batch/embeddings, GPU notebooks; the AI-compute workflow is first-class, not bolted on.

## Where HoBo is stronger or intentionally different

State labels follow the research contract: **implemented** = shipped in `packages/`;
**proof** = draft/proof material; **design-only** = design intent. This capture predates the
contract; where it says "design-phase", read **design-only** unless labelled otherwise, and see
the [live provider matrix](../design/live-provider-matrix.md) for HoBo's honest coverage caveats.

### Modal's limits — HoBo's opening

- **Python-only.** One language, no polyglot. HoBo's runtime contract is **language-neutral WIT** — any wasm-compiling language, with OCI-container fallback for non-wasm (Modal-style) workloads ([Plan 20](../design/wasm-runtime-wit.md#plan-20)/[ADR-0031](../design/adr/01-architecture-core.md#adr-0031)).
- **Runs only on Modal's own fleet — no bring-your-own-cloud, no pluggable IaC, no self-host.** You cannot deploy into *your* AWS/GCP/Azure account, pin resources to providers, or run on-prem; the platform/runtime is proprietary and Modal-hosted. This is the **opposite stance** to HoBo's **cloud-agnostic control plane** onto your clouds via pluggable IaC ([Plan 4](../design/control-plane.md#plan-04)/[ADR-0006](../design/adr/01-architecture-core.md#adr-0006)), and to **self-host = hosted parity** (Yard-is-a-Bindle, [ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064)).
- **Compute product, not an app control plane.** Modal gives you *its own* Volumes/Dicts/Queues — it does **not** map abstract resources onto cloud-native managed services (RDS/S3/DynamoDB) in your account, has no **Resource Definitions + Matching** for per-env infra realization, and no **cost-routing Dispatcher** across clouds ([Plan 25](../design/platform-engineering.md#plan-25)/[ADR-0033](../design/adr/01-architecture-core.md#adr-0033)/[ADR-0071](../design/adr/01-architecture-core.md#adr-0071)).
- **No event-sourced control plane / audit-replay**, no **contracts/`can-deploy`/policy** planes, no governance/RBAC over the platform beyond Enterprise ([Plan 11](../design/data-plane.md#plan-11), [Plan 29](../design/contracts-policy-flags.md#plan-29), [Plan 46](../design/governance-planes.md#plan-46)).
- **Usage billing *is* the model.** Modal meters and charges per second; there is no showback-only / OSS-FinOps posture. HoBo deliberately has **no billing** ([ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064)); it does metering as **showback + budgets/breakers** ([ADR-0039](../design/adr/02-identity-security.md#adr-0039)).
- **Agent story is code-execution, not agent-identity.** Sandboxes give an agent a secure *box to run code*; Modal does not model the agent as a **principal** with brokered tokens, capability manifests, and audit. HoBo makes **agents first-class principals** + MCP control surface + sandbox lanes ([Plan 6](../design/ai-native-agent-auth.md#plan-06)/[ADR-0076](../design/adr/02-identity-security.md#adr-0076)).
- **No IfC least-privilege `.allow()`** across heterogeneous cloud resources; permissions live inside Modal's own resource model. HoBo's `.allow()` is **one declaration → IAM + wasm capability link + agent token scope** ([Plan 21](../design/authoring-resources-wiring.md#plan-21)).
- **No multi-tenant-app primitives, no cross-cloud data/migration, no `hobo import`** adopt-in-place ([ADR-0032](../design/adr/03-data-plane.md#adr-0032), [ADR-0041](../design/adr/07-portability-extensibility.md#adr-0041)).
- **No AI-generated providers/impls or trainable functions.** Modal is where you *run* AI; it does not *generate* its own adapters or self-optimize. HoBo's generation pipeline generates providers/impls ([Plan 23](../design/generated-stack.md#plan-23)/[ADR-0010](../design/adr/03-data-plane.md#adr-0010)) and `"use training"` methods self-tune.

## Adversarial critique

- **Python only.** The entire authoring model depends on decorating Python functions; there is no
  path for other languages, which is a deliberate and total scope decision.
- **The decorators are the lock-in.** Infrastructure declared inside application code is delightful
  and means the application and the platform cannot be separated — the same critique that applies to
  every infrastructure-from-code product, at its sharpest here.
- **GPU capacity is a supply problem** that no scheduler solves; availability and price are upstream
  of the product.
- **Cost is opaque until it is not.** Per-second GPU billing with fast scaling is efficient and hard
  to forecast, particularly for agent workloads with unpredictable fan-out.
- **Not a general application platform**, and does not claim to be: request/response web serving,
  stateful services and long-lived processes are not the target.
- **No self-host or BYOC**, so regulated workloads with data-residency constraints are largely out of
  scope.
- **Sandbox security is a strong claim** in an area where the threat model matters enormously;
  isolation quality should be evaluated directly rather than assumed.

### Comparisons with adjacent tools

- **vs HoBo:** Modal is **Python-only serverless compute on its own managed fleet, GPU-first, closed, usage-billed**; HoBo is a **multi-cloud, polyglot-wasm control plane** mapping one app onto *your* clouds, event-sourced + agent-native + governed with **no billing**. They are as **complementary as competitive**: HoBo needs heavy/GPU compute and agent code-exec, and **Modal is a natural HoBo compute/GPU/sandbox provider** — HoBo could broker inference behind its `model`/`embed` ports ([Plan 23](../design/generated-stack.md#plan-23)) and route agent code-exec to Modal Sandboxes behind its **sandbox lanes** ([ADR-0076](../design/adr/02-identity-security.md#adr-0076)), while owning **identity, governance, cost, multi-cloud placement, and no-lock-in**. Modal is ahead on **GPU serverless, cold-starts, Python DX, and shipping Sandboxes**; HoBo's edge is **breadth + control-plane + agent-as-principal + portability**.
- **vs Encore / Nitric:** Encore/Nitric are **IfC → *your* AWS/GCP(/Azure)** provisioning managed cloud services; Modal does **not** deploy into your account — it *is* the cloud, and is **compute/GPU-serverless-first** rather than app-backend/resource-first. HoBo spans both stances (control-plane onto your clouds **plus** hosting/brokering compute).
- **vs serverless-GPU peers (Replicate · Runpod · Baseten · Beam · Cloud Run GPU · Lambda):** Modal differentiates on **infra-in-Python DX + fast cold-starts + Sandboxes + integrated state primitives**. HoBo does **not** compete as a GPU host — it would **place / route / broker** such compute via provider adapters and the Dispatcher.
- **vs agent-sandbox peers (E2B · Daytona · gVisor/Firecracker DIY):** Modal Sandboxes occupy the agent-code-exec niche on **gVisor**; HoBo's analog is **wasm capability isolation + sandbox lanes** — a **different, design-phase** substrate, not a shipped equivalent.

**Net:** Modal is the **serverless-GPU / AI-compute benchmark HoBo does not yet match** — genuinely ahead on GPU serverless, sub-second cold-starts, Python DX, and a **shipping** agent-code-exec Sandbox product. But Modal is **single-language, single-platform (its own fleet), closed, usage-billed, and compute-centric**. HoBo's opening is **orthogonal**: a **cloud-agnostic, polyglot-wasm control plane** that runs on *your* clouds, models **agents as principals** (not just code boxes), governs cost as **OSS showback with no billing**, and can fold **Modal itself in as a GPU/compute/sandbox provider** rather than matching it head-on.

## Primitive mapping

<a id="hobo-mapping"></a>

> HoBo's equivalent for each Modal concept (✅ has · ➕ goes further · ◐ partial/thin/design-phase · 🔜 planned). **Modal ships genuinely strong tech (serverless GPU, ~1s cold starts, code-defined images, gVisor Sandboxes) that HoBo has NOT proven** — those rows are ◐/🔜 on purpose.

| Modal concept | HoBo equivalent | Notes |
|---|---|---|
| `@app.function` / `@app.cls` decorators (**infra-in-code**) | **IfC authoring** — inline resource decls + `.allow()` collected to manifest IR ([Plan 21](../design/authoring-resources-wiring.md#plan-21)) | ✅ same "infra defined in app code" thesis — but HoBo is **language-neutral (WIT/wasm)**, not Python-only |
| **Code-defined container images** (`modal.Image....`) | wasm-default components + **OCI-container fallback** for non-wasm workloads ([Plan 20](../design/wasm-runtime-wit.md#plan-20)/[ADR-0031](../design/adr/01-architecture-core.md#adr-0031)) | ◐ HoBo runs containers via the component-host/OCI path, but has **no code-defined image-builder DX** and it is design-phase — not a shipped `modal.Image` equivalent |
| **Serverless GPUs** (`gpu="H100:8"`, T4→B200, per-second) | provider adapters + component-host could target GPU node tiers; placement via **Matching/Dispatcher** ([Plan 25](../design/platform-engineering.md#plan-25)/[ADR-0033](../design/adr/01-architecture-core.md#adr-0033)/[ADR-0071](../design/adr/01-architecture-core.md#adr-0071)) | ◐/🔜 **HoBo has NO shipped GPU-serverless runtime** — GPU placement is a design hook (Resource Definitions → GPU tiers, cost-routed), **not a proven Modal-equivalent. Modal is clearly ahead.** |
| **Sub-second cold starts + memory snapshots + autoscale-to-zero** | durable event-sourced runtime + Camp autoscaling ([Plan 11](../design/data-plane.md#plan-11), [Plan 5](../design/reliability-observability-cost.md#plan-05)) | 🔜 HoBo's runtime is durable/replayable but has **not demonstrated Modal's cold-start/snapshot performance** — Modal's strongest moat |
| **Sandboxes** (gVisor; untrusted / agent / LLM code) | **sandbox lanes** for agent code-exec ([ADR-0076](../design/adr/02-identity-security.md#adr-0076)) + wasm capability isolation ([Plan 20](../design/wasm-runtime-wit.md#plan-20)) | ◐ HoBo's isolation is wasm deny-by-default + request-level sandbox lanes — a **different, design-phase** substrate; Modal **ships** gVisor sandboxes for arbitrary-language code **today**. Map honestly, don't overclaim. |
| `Volume` (distributed FS) | `wasi:blobstore` **bucket** port + object-storage adapters ([Plan 21](../design/authoring-resources-wiring.md#plan-21)) | ◐ maps to bucket/object semantics, not a POSIX distributed-FS; design-phase |
| `Dict` (distributed KV) | `wasi:keyvalue` **kv** port + the new `cache` port (ADR-0118, in progress) ([Plan 21](../design/authoring-resources-wiring.md#plan-21)) | ✅ port exists at parity; ◐ managed serverless-state DX unproven |
| `Queue` | `hobo:queue` / `wasi:messaging` **topic/queue** ports ([Plan 21](../design/authoring-resources-wiring.md#plan-21)) | ✅ port parity |
| `Secret` (`modal.Secret`, env vars) | `hobo:secrets` + `wasi:config/store` **secret** port ([ADR-0113](../design/adr/02-identity-security.md#adr-0113)) | ✅ port parity |
| Scheduled / cron (`modal.Period` / `modal.Cron`) | `hobo:scheduler` **schedule** port ([Plan 21](../design/authoring-resources-wiring.md#plan-21)) | ✅ port parity |
| Web endpoints (`fastapi_endpoint`/`asgi_app`/`wsgi_app`) → `*.modal.run` | `hobo:http` / `wasi:http` **service/api** + `web()` ([Plan 21](../design/authoring-resources-wiring.md#plan-21)) | ✅ HTTP/service port parity; ◐ no auto-managed `*.run` URL / instant serverless-deploy loop proven |
| `modal run` / `deploy` / `serve` / `shell` CLI | `hobo run/up/dev/...` CLI ([Plan 7](../design/developer-experience.md#plan-07)) + dashboard/status ([Plan 49](../design/developer-experience.md#plan-49)) | ✅ CLI surface designed; ◐ `modal serve` live-reload-to-cloud loop not yet proven |
| Python-native inference (LLM/embeddings on GPU) | **model / embed ports** + generation pipeline ([Plan 23](../design/generated-stack.md#plan-23)/[ADR-0010](../design/adr/03-data-plane.md#adr-0010)); GPU/inference **budgets + spend breakers** ([ADR-0039](../design/adr/02-identity-security.md#adr-0039)) | ➕/◐ HoBo abstracts inference behind multi-provider ports **but has no first-party GPU execution** — it would *broker* to Modal/clouds, not host GPUs |
| **Modal-managed fleet** (you don't bring your account) | **cloud-agnostic control plane** — deploy into *your* clouds via pluggable IaC ([Plan 4](../design/control-plane.md#plan-04)/[ADR-0006](../design/adr/01-architecture-core.md#adr-0006)) | ➕ opposite stance — HoBo maps onto your providers, no platform lock-in |
| **Per-second usage billing** | ✗ by design — **no billing/monetization** ([ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064)); metering is OSS **showback/FinOps** ([ADR-0039](../design/adr/02-identity-security.md#adr-0039)) | ✗ HoBo deliberately has no billing; Modal's business model is out of HoBo's scope |
| Agents run *code* in Sandboxes | agents as **first-class principals** + MCP + brokered tokens ([Plan 6](../design/ai-native-agent-auth.md#plan-06)) | ➕ HoBo models the agent's **identity/authz**, not just a code box — complementary (Modal Sandboxes could be a HoBo code-exec provider) |
| *(none — Python serverless compute only)* | **event-sourced control plane + audit/replay** ([Plan 11](../design/data-plane.md#plan-11)); **contracts/policy** ([Plan 29](../design/contracts-policy-flags.md#plan-29)); **governance planes** ([Plan 46](../design/governance-planes.md#plan-46)); org/RBAC/SSO/SCIM ([ADR-0074](../design/adr/02-identity-security.md#adr-0074)) | ➕ HoBo's control-plane breadth |
| *(none)* | **Operator Crew** (SRE) ([Plan 40](../design/operators-sre.md#plan-40)) + **`hobo import`** adopt-in-place ([ADR-0041](../design/adr/07-portability-extensibility.md#adr-0041)) | ➕ operations + brownfield onboarding |
| *(none)* | **AI-generated providers AND implementations** ([Plan 23](../design/generated-stack.md#plan-23)) + trainable semantic functions | ➕ |

### The one-line takeaway

**Modal proves the serverless-GPU + infra-in-Python + agent-sandbox surface HoBo has *not* built — and is genuinely ahead there** — but it is **Python-only, locked to Modal's own fleet, closed, usage-billed, and compute-centric**. HoBo's differentiation is the surrounding system: **any-cloud + pluggable-IaC breadth, a language-neutral wasm runtime, Resource Definitions/Matching + the Dispatcher, event-sourced governance (cost/policy/contracts), agents-as-principals (not just code boxes), and OSS showback with no billing** — and the cleanest synthesis is to **fold Modal in as a GPU/compute/sandbox provider** rather than to match its serverless-GPU engine head-on.

## Better-together / integration posture

- **Borrow** — **Sandboxes as a first-class primitive for running untrusted or agent-generated
  code**. HoBo's agent story needs an execution surface with exactly these properties, and Modal has
  the clearest shipped version. Also worth borrowing: **defining the image in the same language as
  the code**, which removes an entire artifact from the authoring loop.
- **Provider-target** — a strong fit for GPU and batch-shaped Bindle workloads.
- **Benchmark** — cold-start times and the decorator ergonomic.
- Not a displace or adopt target.

## Threats and lessons

1. **Agent execution needs a sandbox primitive, and HoBo does not have one** (*not-present*). This
   is a concrete gap in HoBo's AI-native claim and belongs in its own implementation issue.
2. **Infrastructure-from-code is proven in production**, in the language its users already use, with
   no separate manifest at all. That is the ergonomic bar for HoBo's authoring.
3. **Defining the environment in code removes an artifact.** Dockerfiles are a separate language, a
   separate file and a separate mental model; Modal deletes them.
4. **Specialization is a viable strategy.** Modal does one workload class extremely well rather than
   competing on breadth — a useful counterexample to the suite-building instinct visible elsewhere
   in this corpus.

## Sources

- [modal.com/docs/guide](https://modal.com/docs/guide) — apps, functions, images, volumes, sandboxes, GPU attachment
- [modal.com](https://modal.com/) — positioning and pricing (vendor material)

This capture predates the research contract and was restructured to it on 2026-08-19 with its
original research preserved. Current GPU inventory, pricing and sandbox isolation details were not
re-verified in this pass and are not asserted.
