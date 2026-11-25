---
type: Competitive Reference
title: "Aspire — Competitor Reference"
description: "**Aspire** (`aspire.dev`, `github.com/dotnet/aspire`) is a code-first, opinionated framework for composing and orchestrating distributed applications. You describe a whole app's to"
tags: [hobo, competitors]
competitor:
  slug: aspire
  name: ".NET Aspire"
  aliases: ["dotnet aspire"]
  primary_category: infrastructure-from-code
  categories: [infrastructure-from-code, portable-application-models, runtime-substrates]
  directness: direct
  role: "code-first app composition, local orchestration and deploy — closest authoring analog outside TypeScript"
  posture: [borrow, benchmark]
  hobo_surface: [authoring, app-graph, wiring, environments]
  evidence: mixed
  status: active
  research_date: 2026-08-20
  contract: v1
  sources:
    - https://learn.microsoft.com/dotnet/aspire/
    - https://github.com/dotnet/aspire
---

# Aspire — Competitor Reference

> Captured for HoBo competitive analysis (research as of 2026) — the deepest capture in this folder. C# and CLI excerpts are quoted as illustrative competitive reference (see the [fair-use note](index.md#sources--fair-use)). The HoBo↔Aspire parity tracker lives at the end, under [primitive mapping](#primitive-mapping).

## What it is

**Aspire** (`aspire.dev`, `github.com/dotnet/aspire`) is a code-first, opinionated framework for composing and orchestrating distributed applications. You describe a whole app's topology — services, containers, databases, queues, and how they wire together — in a single **AppHost** program (C#, with a TypeScript AppHost emerging), then run the entire graph locally with one command. Aspire bundles an OpenTelemetry **dashboard** for that local run and can **publish/deploy** the same graph to real targets (Azure Container Apps, Docker Compose, Kubernetes).

Its positioning is "your stack, streamlined": infrastructure described in code, local-dev parity, observable by default. It is **MIT, fully open source**, and there is **no SaaS** — it is a tool you run locally and deploy from, not a hosted control plane, which keeps lock-in low (the deploy IR is plain JSON). C#/.NET is its native surface, but Python and Node/JS are first-class and Go/Java/Rust arrive via the Community Toolkit.

The mental model is **AppHost-centric** — a single source of truth that drives local run, the dashboard, and deployment alike:

```
AppHost program (C#/TS)            ── you write this
  builder.AddPostgres("db").AddDatabase("app")
  builder.AddProject<Projects.Api>("api").WithReference(db).WaitFor(db)
        │  builder.Build().Run()
        ▼
DCP (Developer Control Plane, Go)  ── local k8s-style orchestrator: containers + processes
        │  OTLP
        ▼
Aspire Dashboard                   ── logs · traces · metrics · resource graph
        │  aspire publish / deploy
        ▼
aspire-manifest.json → publishers  ── azd→ACA · Docker Compose · Kubernetes/Helm · custom
```

| Dimension | Aspire |
|---|---|
| Category | Code-first app composition + local orchestration + deploy |
| Author surface | **AppHost** (C#; TypeScript emerging) |
| Local orchestrator | **DCP** (Go, Kubernetes-style) |
| Observability | **OpenTelemetry** (logs/traces/metrics) + bundled **Dashboard** |
| Deploy IR | **`aspire-manifest.json`** → publishers |
| Deploy targets | Azure Container Apps (azd+Bicep), Docker Compose, Kubernetes/Helm, custom |
| CLI | standalone **`aspire`** (`new`/`run`/`add`/`publish`/`deploy`/…) |
| Languages | C#/.NET first; **Python, Node/JS** first-class; Go/Java/Rust via Community Toolkit |
| License / hosting | **MIT**, self-hosted; no SaaS |

Against the others in this folder: it is dev-to-deploy *tooling*, not a platform — unlike **Humanitec** ([humanitec.md](humanitec.md)), an enterprise Platform Orchestrator with matching, RBAC, policy, cost, and a hosted control plane. Like **Nitric** ([nitric.md](nitric.md)) it is infrastructure-from-code, but Nitric targets serverless with a Go plugin runtime, whereas Aspire is broader app composition plus local-dev parity and OTel.

## Core primitives and mental model

| Primitive | What it is |
| --------- | ---------- |
| **AppHost** | The composition program: a typed project that declares the whole distributed application |
| **Resource** | A project, container, executable or cloud service participating in the app graph |
| **`WithReference`** | The wiring primitive — connect one resource to another and let connection details flow |
| **`WaitFor`** | Ordering and readiness dependency between resources |
| **Annotation** | Metadata attached to a resource, which is how the model is extended |
| **Manifest** | The intermediate representation the AppHost emits for deployment tooling |
| **Integration** | A packaged component (database, cache, queue) with client and hosting halves |

The mental model is **the topology is a typed program**. The AppHost is compiled, refactorable and
IDE-navigable; `aspire run` stands the whole graph up locally, and the same program emits a manifest
for deployment. HoBo's wiring model and manifest IR both descend from this design.

## How it competes with HoBo

Aspire is recorded in [`lineage.md`](../design/lineage.md) as a **pillar**: `WithReference` wiring,
annotations and the manifest IR are taken from here.

| Contested HoBo surface | The contest |
| ---------------------- | ----------- |
| `authoring` | **Direct.** A typed composition program is exactly HoBo's authoring thesis |
| `app-graph` | The AppHost graph, with a shipped local dashboard over it |
| `wiring` | `WithReference` is the reference implementation of typed dependency wiring |
| `environments` | Local orchestration parity with the deployed shape |

The divergence: Aspire is .NET-first and stops at emitting a manifest. HoBo is language-neutral and
owns what happens after the manifest — matching, placement, policy, promotion.

## Feature surface

### AppHost & the resource model

The AppHost is a normal program whose job is to declare the app graph and run it:

```csharp
var builder = DistributedApplication.CreateBuilder(args);

var db  = builder.AddPostgres("postgres").AddDatabase("appdata");
var api = builder.AddProject<Projects.MyApi>("api")
                 .WithReference(db)
                 .WaitFor(db);
builder.AddNpmApp("web", "../web", "dev")
       .WithReference(api)
       .WithHttpEndpoint(env: "PORT");

builder.Build().Run();   // or await builder.Build().RunAsync();
```

`DistributedApplication.CreateBuilder(string[] args)` (also no-arg and `(DistributedApplicationOptions)` overloads) returns an `IDistributedApplicationBuilder` exposing `.Services` for DI and `.Eventing` for lifecycle; `builder.Build()` returns a `DistributedApplication` (`IHost`, `IAsyncDisposable`) with `.Run()`/`.RunAsync()`. The layout is a `*.AppHost` project (referencing `Aspire.AppHost.Sdk` plus project references to everything it orchestrates) alongside a shared **ServiceDefaults** project that wires OTel, service discovery, resilience, and health checks. A single-file `apphost.cs` direction — run via the `aspire` CLI without a full project — is emerging.

Everything in the graph implements **`IResource`**, accessed through a fluent **`IResourceBuilder<T>`**. Capabilities are expressed as marker/capability interfaces a resource type opts into:

| Interface | Grants |
|---|---|
| `IResourceWithEnvironment` | `WithEnvironment(...)` |
| `IResourceWithEndpoints` | `WithEndpoint`/`WithHttpEndpoint`/`GetEndpoint(name)` |
| `IResourceWithConnectionString` | exposes `ConnectionStringExpression` for `WithReference` |
| `IResourceWithServiceDiscovery` | injects discoverable endpoints into dependents |
| `IResourceWithArgs` | `WithArgs(...)` |
| `IResourceWithWaitSupport` | `WaitFor`/`WaitForStart`/`WaitForCompletion` |
| `IComputeResource` | a deployable compute unit (replicas, compute environment) |
| `IResourceWithContainerFiles` / `IResourceWithDockerfile` | contribute files / build from a Dockerfile |

The built-in resource types span compute and data:

- **`ProjectResource`** — a .NET project: `builder.AddProject<Projects.MyApi>("api")` (typed via generated `Projects.*`).
- **`ContainerResource`** — `builder.AddContainer("cache", "redis:7")`.
- **`ExecutableResource`** — `builder.AddExecutable("tool", "./tool", workingDir, args…)`.
- **`ParameterResource`** — `builder.AddParameter("api-key")` / `AddParameter("pw", secret: true)`.
- **`ConnectionStringResource`** — `builder.AddConnectionString("external-db")` (BYO connection string, no resource provisioned).
- **`ExternalServiceResource`** — references an external URL.
- **Dockerfile resource** — `builder.AddDockerfile("svc", "../svc")` (build instead of pull).
- **Database resources** — returned by `.AddDatabase("name")` on a server resource (`PostgresDatabaseResource`, `SqlServerDatabaseResource`, …).

Configuration is stored as **annotations**: each `With*` call attaches an `IResourceAnnotation` to `resource.Annotations`. Built-ins include `EndpointAnnotation`, `EnvironmentCallbackAnnotation` (lazy/deferred env), `ContainerMountAnnotation`, `ArgsAnnotation`, `HealthCheckAnnotation`, `WaitAnnotation`, `ReplicaAnnotation`, and `ManifestPublishingCallbackAnnotation` (controls what the manifest emits). They are queryable:

```csharp
var endpoints = api.Resource.Annotations.OfType<EndpointAnnotation>().ToList();
```

This annotation substrate is the extensibility seam. A custom integration is a resource subclass plus an `Add*` extension plus optional `With*` helpers:

```csharp
public sealed class LlmResource(string name) : Resource(name)
{ public string? Model { get; set; } }

public static class LlmResourceExtensions
{
    public static IResourceBuilder<LlmResource> AddLlm(this IDistributedApplicationBuilder b, string name)
        => b.AddResource(new LlmResource(name))
            .WithHttpEndpoint(targetPort: 8000, name: "http")
            .WithEnvironment("MODEL", "default");

    public static IResourceBuilder<LlmResource> WithModel(this IResourceBuilder<LlmResource> b, string m)
    { b.Resource.Model = m; return b.WithEnvironment("MODEL", m); }
}
// usage: builder.AddLlm("local").WithModel("mistral-7b");
```

Lifecycle is observable through eventing — `IDistributedApplicationLifecycleHook` for cross-cutting hooks, plus per-resource events that fire as resources transition (created → starting → running/ready):

```csharp
builder.Eventing.Subscribe<BeforeStartEvent>((evt, ct) => { /* mutate model */ return Task.CompletedTask; });
builder.Eventing.Subscribe<ResourceReadyEvent>((evt, ct) => { /* react when a resource is ready */ return Task.CompletedTask; });
```

Parameters and secrets bind through the standard config system (user-secrets/appsettings); non-secret params surface as text, secrets as masked password inputs, and values flow in as env vars or connection strings:

```csharp
var pw = builder.AddParameter("db-password", secret: true);   // prompted; masked
builder.AddSqlServer("sql").WithPassword(pw);
var ext = builder.AddConnectionString("legacy-db");           // BYO connection string
```

Persistence is configured with volumes, bind mounts, and container lifetime:

```csharp
builder.AddPostgres("pg").WithDataVolume();                          // named volume
builder.AddContainer("app", "img").WithBindMount("./cfg", "/cfg", isReadOnly: true);
builder.AddContainer("app", "img").WithVolume("data", "/data");
builder.AddPostgres("pg").WithLifetime(ContainerLifetime.Persistent); // survive restarts (vs Ephemeral default)
```

### Wiring, references & endpoints

`WithReference` is the core wiring verb — and the part HoBo borrowed most directly ([HoBo Plan 21](../design/authoring-resources-wiring.md#plan-21)):

```csharp
var db  = builder.AddPostgres("pg").AddDatabase("appdata");
var api = builder.AddProject<Projects.Api>("api")
                 .WithReference(db)                       // connection string + service discovery
                 .WithReference(cache.GetEndpoint("tcp")); // a specific endpoint
```

By convention it injects into the dependent's environment: connection strings as `ConnectionStrings__{name}` (e.g. `ConnectionStrings__appdata`), and service endpoints as `services__{name}__{endpointName}__{index}` (0-based; multiple endpoints/replicas yield multiple indices), resolved by .NET **service discovery** at runtime. The consuming service reads these through normal configuration / `HttpClient` + `AddServiceDiscovery()` (set up in ServiceDefaults). Direct env and args work the same way, with callback support for values computed at run/publish time (`EnvironmentCallbackAnnotation`):

```csharp
builder.AddContainer("svc", "img")
       .WithEnvironment("LOG_LEVEL", "debug")
       .WithEnvironment("DB", db)                 // resolves to its connection string
       .WithEnvironment("KEY", apiKeyParameter)   // ParameterResource
       .WithArgs("--port", "8080");
```

Two reference primitives stitch values together: **`ReferenceExpression`** (a deferred, interpolated string mixing literals and resource values, e.g. a custom connection string built from parts) and **`EndpointReference`** (`resource.GetEndpoint("https")` with `.Url`/`.UriExpression`/`.Host`/`.Port` members usable in `WithEnvironment`). The latter become `{resource.bindings.https.url}`-style tokens in the manifest.

Endpoints and networking are declared fluently:

```csharp
builder.AddProject<Projects.Api>("api")
       .WithHttpEndpoint(targetPort: 8080, port: 5000, name: "http")
       .WithHttpsEndpoint(name: "https")
       .WithExternalHttpEndpoints();              // expose beyond the dev host
builder.AddContainer("svc", "img")
       .WithEndpoint(targetPort: 9000, scheme: "tcp", name: "tcp", isProxied: true);
```

`targetPort` is the port the app listens on inside the container/process; `port` is the host-facing port (auto-assigned if omitted). `isProxied: true` (default) routes through Aspire's reverse proxy for stable URLs across restarts plus automatic service discovery, while `false` uses direct container DNS. `WithExternalHttpEndpoints()` marks endpoints external (it matters at deploy time as ingress), and `WithUrls(...)`/`WithUrlForEndpoint(...)` customize the URLs surfaced in the dashboard.

Ordering is expressed with the `WaitFor` family, gated by health checks:

```csharp
builder.AddProject<Projects.Api>("api")
       .WaitFor(db)              // wait until db is running AND healthy
       .WaitForStart(cache);    // wait until cache is merely running
builder.AddProject<Projects.Worker>("worker")
       .WaitForCompletion(migrations);  // wait until a one-shot task exits 0
```

Health checks gate those dependencies — `WaitFor(x)` blocks a dependent until `x` is running and all its health checks pass; `WaitForCompletion` handles run-to-completion jobs like migrations and seeders.

> **HoBo gap (GAP-027):** HoBo's orchestrator gates deploy DAG edges on `resource.Provisioned` only (IaC apply succeeded) — not on running+healthy or one-shot exit 0. Health-gated ordering is an explicit iteration hook in [Plan 4 §Health-gated dependency ordering](../design/control-plane.md#health-gated-dependency-ordering-iteration-hook); the parity tracker marks this row ◐ until that design lands.

```csharp
builder.AddProject<Projects.Api>("api").WithHttpHealthCheck("/health");      // GET /health → 200
builder.AddPostgres("pg").WithHealthCheck("custom-check");                    // DI-registered check
```

The payoff is uniform service discovery: `WithReference` plus ServiceDefaults' `AddServiceDiscovery()` let a service call a dependency by logical name (`http://api`), with resolution via configuration (`services__*` env), the platform (Container Apps/Kubernetes DNS), or DNS-SRV — the same code working locally and in production.

### Integration catalog

Integrations ship in **pairs**: a *hosting integration* used in the AppHost (`builder.AddRedis("cache")`, which declares/runs the resource and wires references) and a *client integration* used inside a service (`builder.AddRedisClient("cache")`, which registers a typed, health-checked, OTel-instrumented client bound to the injected connection string/endpoint). Nearly every data/messaging integration has a matching client package; the catalog below is the hosting side. Names are stable API surface; some live in core `Aspire.Hosting.*` packages, some in Azure/AWS packages, some in the Community Toolkit.

Compute & runtimes:

```csharp
builder.AddProject<Projects.Api>("api");           // .NET project
builder.AddContainer("nginx", "nginx:latest");     // any OCI image
builder.AddExecutable("tool", "./tool", ".", "--flag");
builder.AddDockerfile("svc", "../svc");            // build from Dockerfile
builder.AddNodeApp("api", "../api", "server.js");  // Node entrypoint
builder.AddNpmApp("web", "../web", "dev");         // npm/yarn/pnpm script
builder.AddPythonApp("worker", "../worker", "main.py");  // Python (uv/pip/venv)
builder.AddAzureFunctionsProject<Projects.Fn>("fn");
```

(MAUI, Orleans, IIS-Express/.NET-Framework projects, and SQL Server DB projects via `AddSqlProject` also exist.)

Relational databases, NoSQL / document / cache, and messaging / streaming:

```csharp
builder.AddPostgres("pg").AddDatabase("appdata");
builder.AddSqlServer("sql").AddDatabase("appdata");
builder.AddMySql("mysql").AddDatabase("appdata");
builder.AddAzurePostgresFlexibleServer("pg");   // .RunAsContainer() for local
builder.AddAzureSqlServer("sql").AddDatabase("appdata");

builder.AddMongoDB("mongo").AddDatabase("appdata");
builder.AddAzureCosmosDB("cosmos");
builder.AddRedis("cache").WithDataVolume();
builder.AddValkey("cache");      // Redis-compatible
builder.AddGarnet("cache");      // Microsoft's Redis-compatible store

builder.AddRabbitMQ("rmq").WithManagementPlugin();
builder.AddKafka("kafka");
builder.AddNats("nats");
builder.AddAzureServiceBus("sb");
builder.AddAzureEventHubs("eh");
```

Search & vector, identity / config / secrets, and observability:

```csharp
builder.AddElasticsearch("es");
builder.AddOpenSearch("os");
builder.AddQdrant("qdrant");     // vector DB
builder.AddMilvus("milvus");     // vector DB

builder.AddKeycloak("kc").WithRealmImport("./realm.json").WithDataVolume();
builder.AddAzureKeyVault("kv");
builder.AddAzureAppConfiguration("appcfg");

builder.AddSeq("seq");                 // structured-log server
builder.AddAzureApplicationInsights("ai");
```

AI / LLM integrations cover hosted and local models:

```csharp
builder.AddAzureOpenAI("openai").AddDeployment("gpt-4o", "gpt-4o", "2024-08-06");
builder.AddGitHubModel("ai", "openai/gpt-4o-mini");   // GitHub Models
builder.AddOllama("ollama").AddModel("llama3");        // local LLMs (Community Toolkit)
```

Beyond these, Azure adds `AddAzureStorage` (+ `AddBlobs`/`AddQueues`/`AddTables`), `AddAzureSignalR`, `AddAzureWebPubSub`, and `AddAzureContainerAppEnvironment` (a deploy target); AWS support comes via `Aspire.Hosting.AWS` (CloudFormation/CDK provisioning + resource references). Many Azure resources can `.RunAsContainer()`/emulate locally and provision the real service on deploy. The **Community Toolkit** (`github.com/CommunityToolkit/Aspire`) adds Go, Java (Spring Boot/Quarkus), Rust, Ollama, Dapr, and SQL/Mongo extensions — published to NuGet, community-maintained — which is how non-first-party languages and services become first-class AppHost resources.

### The `aspire` CLI

The standalone command-line tool (distinct from `dotnet`) drives Aspire's move toward a language-agnostic, single-file-AppHost experience. Install it as a global tool, then it covers the full project lifecycle:

```bash
dotnet tool install -g aspire.cli      # or the installer at aspire.dev
aspire --version

aspire new                 # scaffold a new Aspire solution (interactive; templates)
aspire init                # add Aspire to an existing repo (detects sln or file-based AppHost)
aspire add redis           # add a hosting integration package (e.g. Aspire.Hosting.Redis)
aspire add azure-cosmos-db
aspire update              # safely upgrade Aspire packages in the AppHost
```

Local run and inspection, then publish and deploy:

```bash
aspire run                 # find & run the AppHost; launches the dashboard
aspire run --no-dashboard
aspire run --project ./src/AppHost
aspire logs [resource] [--follow]   # stream resource logs
aspire exec <command>               # run a resource command (e.g. migrations)

aspire publish [--publisher docker-compose|kubernetes] [--output-path ./dist]
aspire deploy [--refresh]
```

Config and secrets round it out:

```bash
aspire config list
aspire config set <key> <value>     # CLI/feature settings
aspire secret set ConnectionStrings__Db "..."   # user-secret management
```

The CLI underpins the single-file `apphost.cs` experience (running an AppHost without a full project), the TypeScript AppHost, and MCP/agent entry points — repositioning Aspire from a .NET feature into a polyglot orchestration tool driven from the terminal. The exact command surface and flags evolve, but the groups above are the stable shape.

### Manifest, publishers & deployment

This is HoBo's closest structural analogue ([HoBo Plan 21](../design/authoring-resources-wiring.md#plan-21)). `aspire publish` emits **`aspire-manifest.json`** — a tool-agnostic description of the resolved graph that deployment tooling consumes. Entries carry resource type versions (`project.v1`, `container.v1`, `dockerfile.v0`, `parameter.v0`, `value.v0` for computed outputs, `azure.bicep.v0` for an Azure resource defined by a Bicep template), each with optional `connectionString`, `env`, `bindings`, `volumes`, and `params`/`outputs` for Bicep. Values reference other resources with `{...}` tokens resolved by the deploy tool — `{resource.connectionString}`, `{resource.bindings.<endpoint>.host|port|url}`, `{parameter.value}`:

```json
{
  "$schema": "https://json.schemastore.org/aspire-8.0.json",
  "resources": {
    "postgres": {
      "type": "container.v1",
      "image": "postgres:16",
      "env": { "POSTGRES_PASSWORD": "{pg-password.value}", "POSTGRES_DB": "appdata" },
      "bindings": { "tcp": { "scheme": "tcp", "protocol": "tcp", "transport": "tcp", "targetPort": 5432 } },
      "volumes": [ { "source": "pg-data", "target": "/var/lib/postgresql/data", "readOnly": false } ],
      "connectionString": "Host={postgres.bindings.tcp.host};Port={postgres.bindings.tcp.port};Username=postgres;Password={pg-password.value};Database=appdata"
    },
    "api": {
      "type": "project.v1",
      "path": "../MyApp.Api/MyApp.Api.csproj",
      "env": {
        "ConnectionStrings__appdata": "{postgres.connectionString}",
        "OTEL_EXPORTER_OTLP_ENDPOINT": "{otel.url}"
      },
      "bindings": { "http": { "scheme": "http", "protocol": "http", "transport": "http", "targetPort": 8080, "external": true } }
    },
    "pg-password": { "type": "parameter.v0", "value": "{pg-password.inputs.value}", "secret": true }
  }
}
```

A **publisher** (`IDistributedApplicationPublisher`) turns the model into deployment artifacts and, for `deploy`, applies them. You select a target by adding a **compute environment** resource in the AppHost, and resources can be pinned to one with `.WithComputeEnvironment(env)`, enabling mixed targets:

```csharp
builder.AddAzureContainerAppEnvironment("cae");    // Azure Container Apps
builder.AddDockerComposeEnvironment("compose");    // Docker Compose
builder.AddKubernetesEnvironment("k8s");           // Kubernetes/Helm
```

The deploy targets:

- **Azure Container Apps via `azd`** — the Azure Developer CLI consumes the manifest, generates Bicep, provisions ACA plus dependencies, builds/pushes images to ACR, and deploys. The most mature path.
- **Docker Compose** (`Aspire.Hosting.Docker`) — emits `docker-compose.yaml` + `.env` (services, networks, named volumes, `depends_on`) for `docker compose up`.
- **Kubernetes / Helm** (`Aspire.Hosting.Kubernetes`) — emits a Helm chart (`Chart.yaml`, `values.yaml`, `templates/`).
- **Custom** — implement `IDistributedApplicationPublisher` to emit Terraform/Pulumi/anything and register it in the AppHost.

```bash
aspire publish --output-path ./dist           # generate artifacts (manifest + target files)
aspire publish --publisher docker-compose
aspire deploy                                  # publish + apply to the configured target
aspire deploy --refresh                        # refresh credentials first
```

The deployment story is the framework's softest spot: the publishers and compute environments are newer than the run experience, and many teams still hand off to `azd` (Azure) or `kubectl`/`helm` (Kubernetes) for production.

### Dashboard, DCP & observability

This runtime/visibility layer is a major part of Aspire's appeal and a reference point for [HoBo Plan 7](../design/developer-experience.md#plan-07), [HoBo Plan 7 § Local dashboard (`hobo dev`)](../design/developer-experience.md#local-dashboard-hobo-dev), [ADR-0111](../design/adr/07-portability-extensibility.md#adr-0111), and [Plan 5](../design/reliability-observability-cost.md#plan-05). Note the scope gap HoBo closes: **Aspire's dashboard is a *local-dev* surface for one AppHost run**, whereas HoBo's **operations dashboard** ([HoBo Plan 49](../design/developer-experience.md#plan-49)) is the **multi-cloud / multi-environment** prod analog (project × environment fleet view), plus per-project **status pages** and an **architecture-availability** estimate (the "march of the 9s") Aspire has no equivalent of. HoBo's **`hobo dev` local dashboard** ([ADR-0111](../design/adr/07-portability-extensibility.md#adr-0111)) explicitly adopts Aspire's per-resource OTLP/logs/traces/metrics/resource-graph pattern via a co-launched local listener — not the Yard Gateway path used for hosted dashboards. **DCP** is Aspire's local orchestrator, written in Go, that the AppHost drives on `aspire run`:

- Manages the lifecycle of containers, .NET projects, and executables/processes as a unit.
- Provides a Kubernetes-style local API (pods/services/configmaps analogues) — but it is *not* Kubernetes and requires none.
- Handles a bridge network plus DNS so resources reach each other by name (`http://api`, `postgres:5432`) and containers can tunnel to host processes, plus health-probe execution and restarts.

```
AppHost (C#/TS)  ──►  DCP API (Go, localhost)  ──►  containers + processes
       └────────────────────────────────────────►  Dashboard (OTLP)
```

The **dashboard** is a web UI bundled with `aspire run`. It shows resources (a list plus a dependency graph, with status, endpoints, environment variables, and connection strings — sensitive values masked — and start/stop/restart controls), raw per-resource console logs, and structured logs, traces, and metrics over OpenTelemetry (OTLP): searchable structured logs, distributed traces with spans, and metrics with percentiles. It prompts interactively for missing parameters before start, and when launched from VS / VS Code, GitHub Copilot can summarize logs and help root-cause across logs/traces/metrics.

The dashboard also ships as a standalone container that works as a generic OTLP sink for *any* stack — no Aspire app required, which is a common reason non-.NET teams adopt it on its own:

```bash
docker run --rm -it -p 18888:18888 -p 4317:18889 \
  mcr.microsoft.com/dotnet/aspire-dashboard:latest
# point any OTEL_EXPORTER_OTLP_ENDPOINT at it (gRPC 4317 / HTTP 18889)
```

OpenTelemetry is on by default: the ServiceDefaults project wires OTel logging/metrics/tracing, service discovery, and standard resilience into every .NET service, while non-.NET services participate by exporting OTLP (Python/Node/Go SDKs). Telemetry is dev-time first — for production you still point OTel at Grafana/Datadog/etc., since the bundled dashboard is not a production monitoring system.

### Testing, polyglot & AI

`Aspire.Hosting.Testing` spins up the whole app graph in a test and exercises it end-to-end:

```csharp
using Aspire.Hosting.Testing;

var appHost = await DistributedApplicationTestingBuilder.CreateAsync<Projects.MyAppHost>();
await using var app = await appHost.BuildAsync();
await app.StartAsync();

var http = app.CreateHttpClient("api");
var res  = await http.GetAsync("/health");
Assert.Equal(HttpStatusCode.OK, res.StatusCode);
```

It launches the AppHost (real DCP, real containers/processes) in-process for the test run, with the dashboard disabled and ports randomized for parallel runs; resources are reached via `app.GetResource(name)`, `app.CreateHttpClient(name)`, and `WaitFor*` helpers. The limitation is that it is an *integration* harness with no built-in mocking/substitution — for pure unit tests you still reach for `WebApplicationFactory`/test doubles.

Polyglot support repositions Aspire as language-agnostic. Python arrives via `AddPythonApp(...)` with uv/pip/venv detection plus module/script execution (good for FastAPI/Flask/Celery); Node/JS via `AddNodeApp(...)` and `AddNpmApp(...)` (npm/yarn/pnpm, with Vite support) and an emerging TypeScript AppHost; Go/Java/Rust via the Community Toolkit (Spring Boot/Quarkus for Java, Cargo for Rust). Non-.NET apps participate as containers/executables/projects in the graph, wired with the same `WithReference`/endpoints and exporting OTLP to the dashboard — orchestration, wiring, and observability are uniform, though the deepest typed ergonomics remain strongest in .NET.

AI shows up two ways: as integrations (`AddAzureOpenAI`, `AddGitHubModel`, `AddOllama` — shown in the catalog above) and as GitHub Copilot in the dashboard for log summarization and root-cause when run from VS/VS Code.

## Architecture

- **Authoring plane** — the AppHost program, compiled and run.
- **Local orchestration** — `aspire run` starts containers and processes together, with a dashboard
  showing logs, traces and dependencies. The local experience is the product's strongest asset.
- **Deployment** — the AppHost emits a **manifest IR**, which downstream tooling turns into Azure,
  Kubernetes or other targets. Aspire deliberately does not own deployment.
- **Extension model** — annotations on resources, plus integrations packaged as libraries.
- **State authority** — none of its own; the program is the description and the deployment target
  holds the state.
- **Portability boundary** — the manifest is the seam. What the manifest can express travels; what a
  target adds beyond it does not. Aspire's honesty about stopping at the manifest is a design
  strength, not a gap.

## Where .NET Aspire is stronger

> Shipped, evidenced capability only.


What is genuinely strong:

1. **Code-first composition** — the topology (services, deps, wiring) is a typed program (`WithReference`/`WaitFor`/endpoints), not YAML/HCL; refactorable, with IDE support.
2. **Local-dev parity** — one command (`aspire run`) stands up the whole multi-service graph (containers + processes) locally, closely matching the deploy shape.
3. **Integrated observability** — OpenTelemetry (logs/traces/metrics) plus a bundled dashboard with a resource graph, out of the box; the dashboard also runs standalone for any language.
4. **Manifest IR + publishers** — a clean `aspire-manifest.json` fanning out to multiple targets (azd→ACA, Docker Compose, Kubernetes/Helm, custom).
5. **Polyglot reach** — first-class Python/Node alongside .NET, Go/Java/Rust via the toolkit, non-.NET apps wired uniformly and observed via OTLP.
6. **Extensible** — custom resources/integrations/publishers via NuGet; a rich first-party + Azure/AWS + Community Toolkit catalog.
7. **MIT / no lock-in** — open source, self-hosted, plain-JSON IR, Microsoft-backed with a fast release cadence.

The gaps — HoBo's openings:

1. **Deployment maturity** lags local dev — production often still leans on `azd`/`kubectl`/`helm`; publishers are newer than the run experience.
2. **Not a platform/IDP** — no platform-rules layer (no Resource-Definition/matching per environment), no RBAC/policy/approvals/cost/multi-tenant; one AppHost per repo.
3. **.NET heritage** — ergonomics and ecosystem skew .NET, and AppHost authoring is C#-first.
4. **Container-/process-centric** — no wasm/component runtime; non-containerized/legacy workloads need `ExecutableResource` glue.
5. **Dev-time dashboard** — not a production monitoring system; no event-sourced replay/time-travel/audit.
6. **No agent-native generation** — no generation pipeline-style AI generation of integrations/definitions; AI appears as *integrations* plus Copilot-in-dashboard, not as a generation pipeline.

Head-to-head:

| vs | Aspire's edge | Their edge |
|---|---|---|
| **Docker Compose** | code-first, OTel, projects-not-just-containers, deploy publishers | dead-simple `up`, ubiquitous |
| **Skaffold / Tilt / Garden** | polyglot code-first, local-dev parity beyond K8s | K8s-native inner loop, mature |
| **Pulumi / Crossplane** | local-dev + observability + app composition | mature, broad IaC / control-plane provisioning |
| **Nitric** ([nitric.md](nitric.md)) | broader app composition + OTel + local parity | serverless-first IfC + policy-from-code |
| **Humanitec** ([humanitec.md](humanitec.md)) | superb local dev, code-first | enterprise Platform Orchestrator: matching, RBAC, governance, hosted |

The net for HoBo: Aspire nails the developer inner loop — code-first wiring, local parity, a manifest IR, and observability — which is why HoBo adopts its wiring + manifest model ([Plan 21](../design/authoring-resources-wiring.md#plan-21)). HoBo then adds what Aspire lacks: a platform-rules/matching layer ([Plan 25](../design/platform-engineering.md#plan-25)), a wasm-first polyglot runtime ([Plan 20](../design/wasm-runtime-wit.md#plan-20)), event-sourced replay/audit ([Plan 11](../design/data-plane.md#plan-11)), agent-native AI generation ([Plan 6](../design/ai-native-agent-auth.md#plan-06)), and a hosted, multi-tenant, governed control plane.

## Primitive mapping

<a id="hobo-mapping"></a>

For every Aspire feature, the HoBo equivalent and the design doc that owns it. ✅ = designed at parity · ➕ = HoBo goes further · ◐ = designed but shallow/deferred · 🔜 = planned. HoBo design lives in [`../design/`](../design/index.md). Aspire directly inspired HoBo's wiring/manifest layer, so parity here is high by design. Rows marked ◐ must anchor to an explicit design gap or iteration hook — never a bare status; health/readiness-gate gaps anchor to the [Plan 4 iteration hook](../design/control-plane.md#health-gated-dependency-ordering-iteration-hook).

### Composition & wiring

| Aspire | HoBo equivalent | Status | HoBo doc |
|---|---|---|---|
| AppHost (`DistributedApplication.CreateBuilder`) | `bindle()` topology + **IfC** resource collection | ✅ | [02](../design/sdk-api.md#plan-02), [21](../design/authoring-resources-wiring.md#plan-21) |
| `IResource` + capability interfaces | Resources behind **WIT-interface ports** + capability negotiation | ➕ | [20](../design/wasm-runtime-wit.md#plan-20), [24](../design/wasm-runtime-wit.md#plan-20) |
| `Add*` integration catalog | Resource catalog + capability providers | ✅ | [21](../design/authoring-resources-wiring.md#plan-21), [03](../design/control-plane.md#plan-04) |
| Hosting vs **client** integrations | Provider `realize` (deploy) vs generated typed clients (`code`) | ✅ | [03](../design/control-plane.md#plan-04), [02](../design/sdk-api.md#plan-02) |
| `WithReference` / `services__*` / `ConnectionStrings__*` | Aspire-style references + the same env conventions | ✅ | [22](../design/authoring-resources-wiring.md#plan-21) |
| `ReferenceExpression` / `EndpointReference` / placeholders | Lazy refs + `${resources..outputs}` placeholders | ✅ | [22](../design/authoring-resources-wiring.md#plan-21), [27](../design/platform-engineering.md#plan-25) |
| `WaitFor` / `WaitForCompletion` (health-gated) | Choreography on `resource.Provisioned` only today; health/readiness-gated DAG edges not yet designed | ◐ | [04](../design/control-plane.md#plan-04), [iteration hook](../design/control-plane.md#health-gated-dependency-ordering-iteration-hook) |
| Endpoints / proxy / `WithExternalHttpEndpoints` | Endpoint model + ingress in the manifest | ✅ | [22](../design/authoring-resources-wiring.md#plan-21), [13](../design/security-networking.md#plan-12) |
| Annotations (`IResourceAnnotation`) | Manifest annotations / extensibility metadata | ✅ | [22](../design/authoring-resources-wiring.md#plan-21) |
| Custom resources/integrations | Custom providers (any wasm language) + AI-generated | ➕ | [03](../design/control-plane.md#plan-04), [23](../design/generated-stack.md#plan-23) |
| Parameters & secrets | Parameters + brokered secrets (`secrets` port) | ✅ | [02](../design/sdk-api.md#plan-02), [12](../design/security-networking.md#plan-12) |
| `AddContainer` local run / `ExternalServiceResource` / `AddConnectionString` (BYO) | `addContainer` runs under `hobo dev` (local engine, same env convention); `external` resource = contract-backed stub or `--connect` | ✅ | [ADR-0042](../design/adr/07-portability-extensibility.md#adr-0042), [ADR-0041](../design/adr/07-portability-extensibility.md#adr-0041) |

### Runtime, deploy & ops

| Aspire | HoBo equivalent | Status | HoBo doc |
|---|---|---|---|
| `aspire-manifest.json` (deploy IR) | **manifest IR = Deployment Set** | ✅➕ | [22](../design/authoring-resources-wiring.md#plan-21), [26](../design/platform-engineering.md#plan-25) |
| Publishers (azd/Compose/K8s/custom) | Publisher targets incl. **GitOps publisher** | ✅ | [22](../design/authoring-resources-wiring.md#plan-21), [28](../design/platform-engineering.md#plan-25) |
| Compute environments | Camps + **environment types** | ✅ | [26](../design/platform-engineering.md#plan-25) |
| DCP (local Go orchestrator) | local `runtime-local` host / dev loop; the Yard for hosted | ✅ | [20](../design/wasm-runtime-wit.md#plan-20), [04](../design/control-plane.md#plan-04), [07](../design/developer-experience.md#plan-07) |
| Aspire Dashboard (resource graph, OTel) | Dashboard: resource graph + run inspector + replay | ➕ | [07](../design/developer-experience.md#plan-07), [14](../design/reliability-observability-cost.md#plan-05) |
| OpenTelemetry-by-default | OTel + event-sourced traces/replay | ➕ | [14](../design/reliability-observability-cost.md#plan-05), [11](../design/data-plane.md#plan-11) |
| `Aspire.Hosting.Testing` | Conformance suites + per-port replay; whole-graph in-process harness not yet specified | ◐ | [09](../design/generated-stack.md#plan-09), [whole-graph hook](../design/generated-stack.md#whole-graph-in-process-test-harness-iteration-hook) |
| `aspire` CLI | `hobo` CLI | ✅ | [15](../design/developer-experience.md#plan-07) |
| Polyglot (Python/Node/Go/Java/Rust) | **WASM/WASI components** (any language) + OCI fallback | ➕ | [20](../design/wasm-runtime-wit.md#plan-20), [07](../design/developer-experience.md#plan-07) |
| AI integrations + Copilot-in-dashboard | Agents as principals + MCP + AI generation | ➕ | [06](../design/ai-native-agent-auth.md#plan-06), [23](../design/generated-stack.md#plan-23) |

### Where HoBo deliberately exceeds Aspire

| Capability | HoBo doc |
|---|---|
| **Platform-rules / Matching** (per-environment Resource Definitions — Aspire has no equivalent) | [25](../design/platform-engineering.md#plan-25) |
| **Hosted, multi-tenant, governed control plane** (RBAC/policy/approvals/cost) | [04](../design/control-plane.md#plan-04), [12](../design/security-networking.md#plan-12), [16](../design/reliability-observability-cost.md#plan-05) |
| **Event-sourced replay / time-travel / DR-as-replay** | [11](../design/data-plane.md#plan-11), [05](../design/reliability-observability-cost.md#plan-05) |
| **WASM-first polyglot runtime** (vs container/process) | [20](../design/wasm-runtime-wit.md#plan-20) |
| **Agent-native generation pipeline** generation of providers/implementations/definitions | [06](../design/ai-native-agent-auth.md#plan-06), [23](../design/generated-stack.md#plan-23) |
| **Stubbable ports** (run before implementations exist) | [23](../design/generated-stack.md#plan-23) |

### What HoBo borrows wholesale (credit Aspire)

`WithReference`-style wiring, uniform config for any component/container, annotations as extensibility, and the **manifest as deploy IR** — adopted in [Plan 21](../design/authoring-resources-wiring.md#plan-21). HoBo's contribution is wrapping that ergonomic core in a wasm runtime, a matching/platform layer, event-sourcing, and a governed hosted plane.

## Adversarial critique

- **.NET-first is the defining constraint.** Polyglot support exists and the authoring language is
  C#; a team with no .NET presence pays a large entry cost to describe a Python and Go system.
- **The manifest is an intermediate representation, not a contract.** It varies with tooling versions
  and target support, so "the same AppHost deploys anywhere" holds only where a publisher exists.
- **Deployment is somebody else's problem, by design.** That keeps Aspire clean and means the hard
  parts — placement, policy, promotion, drift — are outside its scope, so it cannot be evaluated as a
  platform.
- **Local parity is approximate.** Containers and processes locally are not the managed services
  used in production; the dashboard's fidelity is to the composition, not to production behaviour.
- **Microsoft ecosystem gravity.** Azure targets are the best-supported path, and the further from
  that the more assembly is required.
- **Rapid evolution.** The model has moved quickly across versions, which is healthy for the product
  and a real cost for teams standardizing on it.

## Where HoBo is stronger or intentionally different

State labels follow the research contract: **implemented** = shipped in `packages/`; **proof** =
draft/proof material; **design-only** = design intent.

- **Language-neutral by construction** (*implemented*). WIT ports and wasm components mean the
  authoring language is not the runtime language, and the polyglot story is structural rather than
  additive.
- **HoBo owns what happens after the manifest** (*implemented*): scored matching, recorded decisions,
  policy gates, promotion. Aspire stops where HoBo starts.
- **Portability is measured** (*implemented*, ADR-0144).
- **Event-sourced control plane with replay** (*implemented*, ADR-0135).
- **Fail-closed residency** (*implemented*, ADR-0146).
- **Honest caveat.** Aspire's local development experience — one command for the whole graph, with a
  dashboard — is better than HoBo's today, and it is the surface developers judge first.

## Better-together / integration posture

- **Borrow** — already recorded in [`lineage.md`](../design/lineage.md): `WithReference` wiring,
  annotations as the extension mechanism, and the manifest IR. This capture reaffirms all three.
- **Benchmark** — the local orchestration experience and dashboard set the bar for `hobo dev`.
- **Integrate** — an Aspire manifest is a plausible *input* to HoBo: the AppHost describes the graph,
  HoBo decides where it lands. That composition is coherent and worth prototyping.
- Not a displace target: different scopes.

## Threats and lessons

1. **Composition-as-a-typed-program is validated** by a major vendor with real adoption. HoBo's
   argument is what it does with the graph, not that it has one.
2. **Local-first is the strongest adoption vector in this cohort.** `aspire run` gives value before
   any cloud account exists — the same property HoBo's local runtime has and does not market.
3. **Stopping at the manifest is a legitimate strategy** and leaves the whole placement problem
   unclaimed, which is precisely HoBo's territory.
4. **Annotations as an extension mechanism** are simpler than a plugin API and map directly onto
   HoBo's trait model (ADR-0145).

## Sources

- [Aspire documentation](https://learn.microsoft.com/dotnet/aspire/) — AppHost, resources, `WithReference`, `WaitFor`, integrations, manifest
- [dotnet/aspire](https://github.com/dotnet/aspire) — source and MIT licence
- HoBo-side: [`design/lineage.md`](../design/lineage.md) records Aspire as a pillar influence

This capture predates the research contract and was restructured to it on 2026-08-20 with its
original research preserved. Current publisher coverage and version-to-version manifest changes were
not re-verified in this pass and are not asserted.
