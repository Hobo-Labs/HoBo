---
type: Competitive Reference
title: "ServerKit — competitor reference"
description: "ServerKit is an open-source (MIT), self-hosted server control panel — apps (PHP/WordPress, Python, Node, Docker), databases, DNS, SSL, a full mail stack, firewall/WAF, backups, and monitoring for a VPS or dedicated box, plus a cross-platform Go agent fleet for multi-server management. Adjacent to HoBo: it operates the hosts you already own rather than abstracting app topology across providers, so it is head-on pressure on HoBo's self-host and developer-experience stories but a level below the meta-cloud abstraction."
tags: [hobo, competitors]
competitor:
  slug: serverkit
  name: "ServerKit"
  primary_category: self-hosted-paas
  categories: [self-hosted-paas, identity-networking-delivery]
  directness: adjacent
  role: "self-hosted open-source server control panel with a Go agent fleet — node-attach/Relay reference"
  posture: [benchmark, borrow]
  hobo_surface: [delivery, observability, identity-secrets]
  evidence: mixed
  status: active
  research_date: 2026-08-20
  contract: v1
  sources:
    - https://github.com/jhd3197/ServerKit
---

# ServerKit — competitor reference

> A faithful capture of **ServerKit** ([`jhd3197/ServerKit`](https://github.com/jhd3197/ServerKit)) for HoBo competitive analysis (researched 2026-07-03). ServerKit is a **self-hosted, open-source server control panel** — the modern-panel category (Coolify · CapRover · Dokku · Cloudron, and the old guard cPanel/Plesk). It is **adjacent, not head-on**: it runs *on* servers you already own or rent (VPS, dedicated, home lab) and manages the **host** directly — Nginx virtual hosts, Docker containers, databases, a full Postfix/Dovecot mail stack, DNS, Let's Encrypt SSL, firewall, backups, and monitoring — one abstraction level *below* HoBo's meta-cloud. It is captured because (a) it is the strongest **shipped** pressure on two specific HoBo stories — the **self-host / bootstrap-installer** story and the **developer-experience PaaS surface** (build packs, a template marketplace, PR preview environments, environment pipelines, status pages); (b) its **Go agent fleet** (pairing/enrollment, remote Docker, WireGuard service tunnels, drift-detecting server templates) is a concrete, real-world analog to HoBo's control-plane→node fabric (**Yard** → **Camp**/node and the **Relay**); and (c) it sharpens the honest contrast that HoBo is still design-phase while ServerKit ships weekly. Sources: [GitHub repo](https://github.com/jhd3197/ServerKit) · [README](https://github.com/jhd3197/ServerKit/blob/main/README.md) · [serverkit.ai](https://serverkit.ai) · sibling desktop client [Faro](https://github.com/jhd3197/Faro). **License: MIT** (free, no hosted/paid tier, no open-core gates). Repo state observed 2026-07-03: ~402 stars, latest release `v1.7.11`, 1,103 commits on `main`, single primary author (Juan Denis). API/CLI/config shapes quoted for analysis under fair use (see [`index.md`](index.md#sources--fair-use)). HoBo mapping lives in [primitive mapping](#primitive-mapping).

## What it is

ServerKit's tagline is *"Self-hosted infrastructure, made simple"* — *"a lightweight, modern server control panel for managing web apps, databases, Docker containers, and security without Kubernetes complexity or managed-platform costs."* In product terms it is a **batteries-included panel that owns a Linux host**: install it with one `curl … | bash` line and get a web dashboard that provisions apps, databases, domains, TLS, email, and security tooling on that box, then extends to more boxes through a lightweight agent.

It sits deliberately between two poles it names on its site: **traditional panels** (cPanel/Plesk — "classic hosting, but heavy and paid") and **container-only tools** (Portainer/CapRover — "Docker, but nothing else"). ServerKit's pitch is that it does *both* — classic LAMP/WordPress hosting *and* modern container workflows *and* a mail server *and* a security suite *and* a multi-server fleet — under one MIT-licensed roof with "no vendor lock-in, no recurring fees, no open-core tricks or feature gates."

| Dimension | ServerKit |
|---|---|
| Category | **Self-hosted server control panel** (Coolify/CapRover/Cloudron/cPanel category) — manages hosts you own, not a multi-cloud abstraction |
| Unit of management | A **server** (Linux host) and the apps/containers/services on it; multiple servers via a Go agent fleet |
| App types | PHP/WordPress (PHP-FPM 8.x), Python (Flask/Django on Gunicorn), Node.js (PM2), Docker & Docker Compose |
| Deploy sources | Git (with webhooks/CD), manual path, zip upload, Docker image; **Build Packs** for zero-Dockerfile detection |
| DX surface | 60+ one-click marketplace templates, PR preview environments, prod/staging/dev pipelines with code+DB promotion, visual workflow builder, config snapshots |
| Infra it manages | Nginx vhosts, MySQL/MariaDB/PostgreSQL, DNS zones (+ Cloudflare/Route53/DO), Let's Encrypt SSL, UFW/firewalld, cron, file manager/FTP, S3/B2/local backups, Postfix/Dovecot mail |
| Security | 2FA/TOTP, WebAuthn/passkeys, per-app ModSecurity v3 + OWASP CRS WAF, ClamAV, Fail2ban, Lynis audits, grype CVE + syft SBOM, Fernet-encrypted secrets |
| Multi-server | Cross-platform **Go agent** (Linux/Windows/macOS), pairing/enrollment, fleet rollouts, LAN discovery, remote Docker, WireGuard remote-service tunnels, drift-detecting server templates |
| Monitoring | Real-time CPU/RAM/disk/net over WebSocket, NVIDIA GPU (per-process/per-container), uptime, public status pages, Discord/Slack/Telegram/email/webhook alerts |
| Team/access | Admin/developer/viewer RBAC, multi-tenant workspaces + quotas, SSO (Google/GitHub/OIDC/SAML 2.0), audit log, tiered/scoped API keys |
| Backend stack | Python 3.11 · Flask · SQLAlchemy · Flask-SocketIO · Gunicorn (gevent-websocket); SQLite or PostgreSQL |
| Frontend stack | React 18 · Vite · SCSS · Recharts |
| Deploy of the panel | `curl -fsSL https://serverkit.ai/install.sh \| bash`, or Docker Compose; atomic blue/green self-update via `sudo serverkit update` |
| Supported OS | Ubuntu 22.04+, Debian 12+, Fedora, RHEL/Rocky/AlmaLinux 9+ |
| License / price | **MIT**, fully free, no hosted tier; ~402★, `v1.7.11`, 1.1k commits, single author |
| AI story | Not in the core panel; the **sibling Faro desktop client** ships an **"Agent Bridge"** for MCP/Claude-Code command execution without credential sharing |

ServerKit is **not** an infrastructure-from-code planner (Nitric/Encore) or a meta-cloud (HoBo). It does not infer app resources and map them onto managed cloud services across providers; even its "cloud provisioning" (DigitalOcean/Hetzner/Vultr/Linode) creates a bare VM and then installs *itself* on it. Its portability model is "run the same panel on any Linux box," not "map one app onto any provider mix."

## Core primitives and mental model

| Primitive | What it is |
| --------- | ---------- |
| **Server / node** | A machine the panel manages, paired with an agent |
| **Application** | A hosted app — PHP/WordPress, Python, Node, or Docker |
| **Agent** | The cross-platform Go binary on each node: pairing, remote Docker, WireGuard tunnels, drift-detecting templates |
| **Template** | A declarative configuration the agent enforces, detecting and correcting drift |
| **Service modules** | DNS, SSL, the full mail stack, WAF and security suite, backups, monitoring |

The mental model is **a control panel with a real agent fleet**. The panel is the familiar
cPanel-lineage surface; the agent is what makes it interesting here — pairing, tunnelling and drift
detection are node-attach mechanics rather than panel features.

## How it competes with HoBo

| Contested HoBo surface | The contest |
| ---------------------- | ----------- |
| `delivery` | Application deployment across managed nodes |
| `observability` | Monitoring and drift detection per node |
| `identity-secrets` | Pairing, tunnels and certificate management |

ServerKit is captured for its **node-attach and Relay reference value**, not as a rival for HoBo's
application model — a framing [`lineage.md`](../design/lineage.md) already records.

## Feature surface

### Apps & deployment

Every app is realized on the host through a language-appropriate runtime — PHP-FPM for PHP/WordPress, Gunicorn for Flask/Django, PM2 for Node, or Docker/Compose for containers — fronted by Nginx. The developer-experience surface is where ServerKit is most competitive with a PaaS:

- **Build Packs** — zero-Dockerfile detection that inspects a repo and *generates* a `Dockerfile` + compose from a build plan (a Nixpacks/Cloud-Native-Buildpacks analog).
- **Marketplace** — 60+ one-click templates (Immich, Ghost, Authelia, …).
- **Git CD** — deploy from Git with webhooks and zero-downtime updates; also manual path, zip upload, or a Docker image.
- **PR preview environments** — ephemeral environments auto-provisioned from pull-request webhooks and torn down on close.
- **Environment pipeline** — multi-environment (prod/staging/dev) management with **code *and* database promotion**, and WordPress-specific publishing (real subdomains, URL-swap previews, wildcard HTTPS, custom domains).
- **Container lifecycle** — image-update detection, auto-sleep for idle containers, and CPU-driven horizontal auto-scaling.
- **Config snapshots** — immutable, secret-masked, pre-deploy snapshots with diff and one-click restore.
- **Deterministic health** — one collapsed status per app (`healthy` / `degraded` / `restarting` / `unhealthy`).
- **Workflow builder** — node-based visual automation for deploys/CI-CD/server tasks.

### Infrastructure, domains & the Connections Hub

- **Domains** through Nginx virtual hosts; **DNS zone management** with full record editing (A/AAAA/CNAME/MX/TXT/CAA…) and providers Cloudflare / Route 53 / DigitalOcean; **Dynamic DNS** with token-authenticated A/AAAA updates for changing/home IPs.
- **SSL/TLS** — automatic Let's Encrypt with auto-renewal, hardened TLS 1.2+/AEAD ciphers, Cloudflare-aware configs, automatic CAA records.
- **Databases** — MySQL/MariaDB and PostgreSQL with user management and a browser SQL console.
- **Email server** — a genuinely full stack: Postfix + Dovecot, DKIM/SPF/DMARC, SpamAssassin, Roundcube webmail, forwarding rules.
- **Cloud provisioning** — create VMs on DigitalOcean / Hetzner / Vultr / Linode with cost tracking (then install ServerKit on them).
- **Connections Hub** — a single, credentials-encrypted-at-rest store for source (GitHub/GitLab), cloud infra, DNS providers, registrars, SMTP relays, and S3/B2. **This is the closest thing ServerKit has to HoBo's secretless/broker config surface** — one place where provider credentials live and are referenced.
- **Backups** — automated S3 / Backblaze B2 / local backups with scheduling, retention, optional encryption, one-click restore; plus cron (visual editor), a file manager, and a vsftpd FTP server.

### Security

Security is a headline pillar, and it is deep for a self-hosted panel:

- **Auth** — TOTP 2FA with backup codes; **WebAuthn/passkeys** for passwordless and second-factor sign-in.
- **Per-app WAF** — ModSecurity v3 + the OWASP Core Rule Set, per virtual host, detect/block modes, tunable paranoia, audit-log events.
- **Host hardening** — ClamAV malware scanning + quarantine, file-integrity monitoring, Fail2ban brute-force protection, SSH key management + IP allow/block lists, Lynis security audits, `unattended-upgrades`/`dnf-automatic` for OS patching.
- **Supply chain** — **grype** container CVE scanning and **syft** SBOM generation.
- **Secrets** — Fernet encryption at rest for provider credentials and system settings, plus an inbound webhook gateway for automation triggers.

Note how much of this is **host/OS-level** — mail-server DKIM, UFW rules, Lynis audits, ClamAV. That is exactly the layer HoBo abstracts *over* rather than manages, and it marks the clean scope boundary between the two products.

### Multi-server management — the agent fleet

The architecturally most interesting part, and the piece that most resembles a control plane:

- **Cross-platform Go agent** — Linux/Windows/macOS, `.deb`/`.rpm`/ARM64 builds, a Windows native service + MSI installer and optional WebView2 desktop console. Transport is a real-time WebSocket gateway with **HTTP-poll fallback**; authentication is **HMAC-SHA256**; stored host credentials are **AES-GCM** encrypted.
- **Enrollment** — secure short-code pairing *or* a pre-shared registration token; a guided onboarding state machine (validate → install prerequisites → install Docker → pair agent → ready).
- **Fleet management** — inventory, connection status, an approval queue, version rollouts, a command queue, and **UDP LAN auto-discovery**.
- **Remote Docker** — agent-backed Docker operations on remote hosts.
- **Remote service tunnels** — expose private/NAT'd services via **agent-managed WireGuard tunnels** (a direct analog to HoBo's **Relay** outbound-only proxy).
- **Server templates** — configuration templates with **compliance tracking, drift detection, and auto-remediation** (a shipped analog to HoBo Resource Packs + drift reconciliation).
- **Agent plugins** — an extensible per-server plugin system with declared capabilities and permissions.
- **Fleet monitor** — cross-server heatmaps, metric comparison, alert thresholds, anomaly detection, capacity forecasting; **API-key rotation** with an acknowledgment handshake; optional per-server Dockerized Traefik or Caddy proxy stack.

### Monitoring, alerts & status

- Real-time CPU / RAM / disk / network over WebSocket; **NVIDIA GPU** utilization/memory/temp/power, per-process and per-container.
- Uptime tracking with history; **public status pages** with HTTP/TCP/DNS/Ping health checks, component monitoring, and incident management.
- Notifications to Discord, Slack, Telegram, HTML email, and generic webhooks, with per-user channels, severity filters, and quiet hours.

### Team & access control

- **RBAC** with admin/developer/viewer roles and granular per-feature (read/write per module) permissions.
- **Multi-tenant workspaces** with isolation, quotas, member management, and invitations.
- **SSO/OAuth** — Google, GitHub, OpenID Connect, and **SAML 2.0** with account linking.
- **Audit logging** across all user actions; **tiered API keys** (standard/elevated/unlimited) with additive `X-API-Key` scopes, rate limiting, usage analytics, and OpenAPI docs; **event-driven webhook subscriptions** with HMAC signatures, retries, and custom headers.

### Architecture, stack & operations

The panel is a **monolith**: a Python 3.11 / Flask backend (SQLAlchemy ORM, Flask-Migrate migrations, Flask-SocketIO realtime), served by Gunicorn with gevent-websocket, backed by SQLite or PostgreSQL, with a React 18 / Vite / SCSS / Recharts frontend. Nginx is both the panel's reverse proxy and the front door for hosted apps; Docker/Compose runs the workloads. Multi-server capability is bolted on via the Go agent rather than a distributed control plane — the Flask panel remains the single brain.

Install is a one-liner (`curl -fsSL https://serverkit.ai/install.sh | bash`, with `PANEL_DOMAIN=` to trigger Let's Encrypt and `SERVERKIT_OFFLINE_TARBALL=` for air-gapped installs) or Docker Compose. Self-update is **atomic blue/green** — `sudo serverkit update` (flags `--dry-run`, `--branch dev`, `--release [version]`) runs pre-flight checks, backs up the DB, migrates, and **auto-rolls-back** on failure. Minimum footprint is 1 vCPU / 1 GB RAM / 10 GB disk on Ubuntu 22.04+.

### The AI angle lives in a sibling, not the core

ServerKit's core panel is not "AI-native." The AI story is **Faro**, the same author's desktop client for SFTP/FTP/SSH/S3, which ships an **"Agent Bridge"** — an MCP surface that lets Claude Code (and other MCP clients) execute commands *through* Faro **without sharing raw credentials**. It is a credential-brokering command bridge, not an agent-as-operator platform, and it is a separate product from the panel. Worth watching as a direction, but today ServerKit's own control surface is a human-first dashboard plus a REST/OpenAPI + `X-API-Key` API.

## Architecture

- **Panel** — the control surface, run by the operator.
- **Agent fleet** — a Go binary per node handling pairing, remote Docker operations, WireGuard
  tunnels between nodes, and template-driven drift correction. This is the part worth studying: it
  is a working node-attach implementation with outbound pairing and an overlay.
- **Execution** — application stacks, mail, DNS and security services configured on the nodes
  themselves.
- **State authority** — the panel's configuration, with templates as the desired state the agent
  enforces.
- **Portability boundary** — none claimed; this is server management, not application portability.

## Where ServerKit is stronger

> Shipped, evidenced capability only.


What ServerKit does well:

1. **It ships, and it is broad.** A single MIT install turns a $5 VPS into a multi-app host with TLS, a mail server, a WAF, backups, and monitoring — today. HoBo is design-phase; this is the honest gap-pressure.
2. **Real PaaS DX on your own box.** Build Packs (zero-Dockerfile), a 60+ template marketplace, ephemeral PR previews, and prod/staging/dev pipelines with *database* promotion are concrete developer ergonomics, not roadmap.
3. **A working control-plane→node fabric.** The Go agent's pairing, remote Docker, WireGuard tunnels, LAN discovery, and drift-detecting/auto-remediating server templates are a shipped multi-server story most panels lack.
4. **Security depth unusual for a panel.** Per-app ModSecurity+OWASP, ClamAV, Fail2ban, Lynis, grype/syft supply-chain scanning, passkeys, and encrypted-at-rest secrets are all in-box.
5. **Genuinely no lock-in.** MIT, no hosted tier, no feature gates, self-update with auto-rollback, offline-tarball install — the ownership story is clean.
6. **One credentials surface.** The Connections Hub centralizes source/cloud/DNS/registrar/SMTP/S3 credentials, encrypted at rest — a tidy UX pattern.

Gaps relative to HoBo's scope:

1. **Not a meta-cloud or IfC planner.** ServerKit manages hosts you already have; it does not map one app's resources onto AWS/GCP/Azure/Fly/edge/on-prem managed services through typed matching rules. "Cloud provisioning" is VM-create-then-install, not provider abstraction.
2. **Imperative, host-mutating config.** State is applied directly to the box and tracked in SQLAlchemy tables; there is no declarative desired-state manifest, no replayable event log, no Resource Definitions/Matching, and no plan/diff before apply beyond config snapshots.
3. **No contract-first boundaries.** The integration surface is REST/OpenAPI + `X-API-Key` and Socket.IO — not WIT/protobuf/CUE/PACT. Nothing enforces typed compatibility across an app's edges.
4. **Single-brain control plane.** The Flask panel is the orchestrator; agents are managed nodes. There is no cross-Yard federation, no event-sourced saga model, no HA control-plane story beyond blue/green self-update.
5. **AI is adjacent and command-shaped.** The MCP bridge lives in the Faro desktop client and brokers *commands*; agents are not principals with scoped, brokered credentials, capability manifests, or first-class audit inside the platform.
6. **Runtime is Docker/host processes.** No language-neutral component runtime; portability is "the panel runs on any Linux," not "the workload runs on any backend."
7. **Opinionated host ownership.** ServerKit wants to own Nginx, the mail stack, the firewall, and OS patching on the box. That is powerful for a VPS owner but is precisely the low-level surface HoBo intentionally abstracts rather than manages.

### Comparisons with adjacent tools

| Compared with | ServerKit edge | Their edge |
|---|---|---|
| Coolify / CapRover / Dokku | Broader scope: classic LAMP + WordPress pipelines + full mail stack + security suite + multi-server agent fleet, not just container PaaS | Larger communities; Coolify's polish and hosted option; narrower, more focused surfaces |
| cPanel / Plesk | Free/MIT, modern stack (Docker, Git CD, passkeys, SSO/SAML, WAF, agent fleet), no per-seat licensing | Decades of hosting-industry integration, reseller ecosystems, enterprise support |
| Cloudron | One-click app marketplace + email + backups overlap; also multi-server and cloud provisioning | Cloudron's managed app-update guarantees and mature per-app isolation model |
| Portainer | App/DB/mail/DNS/SSL/security breadth beyond containers | Deep, focused Docker/Kubernetes management and enterprise features |
| HoBo | Ships today; owns the host end-to-end; batteries-included on one VPS; real agent fleet | Meta-cloud abstraction (one app → any provider mix incl. managed services), WIT/wasm portable runtime, event-sourced control plane, Resource Definitions/Matching, agents-as-principals, contract gates |

## Primitive mapping

<a id="hobo-mapping"></a>

> Status vocabulary: `parity` = HoBo has an equivalent design target; `further` = HoBo intentionally goes beyond; `adjacent` = composes with or informs HoBo but is not the same product surface; `gap-pressure` = ServerKit raises the *execution* bar (it ships) even where HoBo's design has an answer; `out-of-scope` = deliberately below HoBo's app-topology line (host/OS management HoBo abstracts over rather than replaces).

### Apps, deployment & DX

| ServerKit surface | HoBo equivalent | Status | HoBo doc |
|---|---|---|---|
| App runtimes (PHP-FPM/Gunicorn/PM2/Docker) behind Nginx | Workload Profiles: wasm **Component host** with OCI-container fallback | further | [Plan 20](../design/wasm-runtime-wit.md#plan-20) |
| Build Packs (zero-Dockerfile → generated Dockerfile+compose) | Build/image providers under the control plane (Dagger/Packer-class adapters) | parity | [Plan 04](../design/control-plane.md#plan-04) |
| Marketplace (60+ one-click templates) | Registry catalogs + marketplace UX (trust tiers, installability) | parity/further | [platform-engineering](../design/platform-engineering.md#plan-25), [marketplace-ux](../design/marketplace-ux.md) |
| Git CD with webhooks | GitOps Operator Agent + Relay/pipeline authoring | parity | [Plan 25](../design/platform-engineering.md#plan-25), [Plan 40](../design/operators-sre.md#plan-40) |
| PR preview environments (ephemeral) | Preview **Camps** / ephemeral environment type | parity/further | [authoring-resources-wiring](../design/authoring-resources-wiring.md#plan-21), [environment-lifecycle](../design/environment-lifecycle.md) |
| Prod/staging/dev pipeline with code+DB promotion | Environment groups promoted/rolled back as a saga; **Deployment Set**/**Delta** | further | [platform-engineering](../design/platform-engineering.md#plan-25), [data-plane](../design/data-plane.md#plan-32) |
| Config snapshots (immutable, secret-masked, diff+restore) | Immutable **Deployment Set** + mutable **Delta** before promotion | parity | [platform-engineering](../design/platform-engineering.md#plan-25) |
| Deterministic single app health | Health/status projection folded from the event log | parity | [reliability-observability-cost](../design/reliability-observability-cost.md#plan-05) |
| Workflow builder (visual automation) | Durable `workflow`/`step` SDK ergonomics per Camp | further | [Plan 02](../design/sdk-api.md#plan-02) |

### Infrastructure, data & networking

| ServerKit surface | HoBo equivalent | Status | HoBo doc |
|---|---|---|---|
| Nginx vhosts + domains | `domain`/`gateway` ports + route-level security | parity | [route-level security](../design/authoring-resources-wiring.md#plan-21) |
| DNS zones + Cloudflare/Route53/DO providers | DNS/domain capability providers (ports & adapters) | parity | [Plan 04](../design/control-plane.md#plan-04) |
| Let's Encrypt SSL auto-renew | TLS/cert provisioning as a capability provider | parity | [Plan 04](../design/control-plane.md#plan-04) |
| MySQL/MariaDB/PostgreSQL + SQL console | `sql`/data-model/data-migration ports + data plane | parity/further | [authoring-resources-wiring](../design/authoring-resources-wiring.md#plan-21), [data-plane](../design/data-plane.md#plan-32) |
| S3/B2/local backups + restore | Backup/restore paths with RPO/RTO drill evidence | parity | [backup-restore](../design/backup-restore.md) |
| Connections Hub (encrypted credential store) | Secretless-first **Config and secrets** via `ctx.config` + Meta-cloud Broker | further | [authoring-resources-wiring](../design/authoring-resources-wiring.md#plan-21), [meta-cloud-broker](../design/meta-cloud-broker.md) |
| Cloud provisioning (DO/Hetzner/Vultr/Linode VMs) | Cloud provider adapters realizing Resource Definitions via Matching | further | [control-plane](../design/control-plane.md#plan-04), [Plan 25](../design/platform-engineering.md#plan-25) |
| Postfix/Dovecot mail, DKIM/SPF/DMARC, Roundcube | `notify` port covers transactional messaging; full mail *hosting* is not HoBo scope | adjacent/out-of-scope | [authoring-resources-wiring](../design/authoring-resources-wiring.md#plan-21) |
| Cron, file manager, FTP server | Scheduled triggers; host filesystem/FTP is host-level, not HoBo scope | parity/out-of-scope | [authoring-resources-wiring](../design/authoring-resources-wiring.md#plan-21) |

### Multi-server fabric & operations

| ServerKit surface | HoBo equivalent | Status | HoBo doc |
|---|---|---|---|
| Go agent per host (HMAC/AES-GCM, WS + poll) | Yard→Camp/node control fabric; **SVID** keyless workload identity | further | [control-plane](../design/control-plane.md#plan-04), [ai-native-agent-auth](../design/ai-native-agent-auth.md#plan-06) |
| Agent enrollment (short-code pairing / token) | Self-host bootstrap + node attach; signed-bundle trust | parity/gap-pressure | [bootstrap-installer](../design/bootstrap-installer.md), [control-plane](../design/control-plane.md#plan-04) |
| Remote service tunnels (WireGuard) | **Relay** — outbound-only proxy for a hosted Yard into a private network | parity | [control-plane](../design/control-plane.md#plan-04) |
| Remote Docker over the agent | Executor applying workloads with scoped short-lived credentials | parity/further | [wasm-runtime-wit](../design/wasm-runtime-wit.md#plan-20), [control-plane](../design/control-plane.md#plan-04) |
| Server templates + drift detection + auto-remediation | **Resource Packs** + drift reconciliation + ResourceActor reconcile loop | parity/further | [platform-engineering](../design/platform-engineering.md#plan-25), [drift-reconciliation](../design/drift-reconciliation.md) |
| Fleet monitor (heatmaps, anomaly, capacity forecast) | Observability + FinOps advisory (anomaly/forecast/rightsizing) + SRE Crew | parity/further | [reliability-observability-cost](../design/reliability-observability-cost.md#plan-05), [operators-sre](../design/operators-sre.md#plan-40) |
| API-key rotation w/ ack handshake | Brokered scoped tokens + credential lifecycle events | further | [ai-native-agent-auth](../design/ai-native-agent-auth.md#plan-06) |
| Atomic blue/green self-update + auto-rollback | Upgrade/migration engine with dry-run + rollback evidence | parity | [upgrade-migration-engine](../design/upgrade-migration-engine.md) |

### Security, monitoring, team & AI

| ServerKit surface | HoBo equivalent | Status | HoBo doc |
|---|---|---|---|
| Per-app ModSecurity/OWASP WAF, Fail2ban, SSH hardening | Route-level `security` + gateway authorizers; networking/isolation | parity/adjacent | [security-networking](../design/security-networking.md#plan-12) |
| ClamAV, Lynis, file-integrity, OS auto-patch | Host/OS hardening — below HoBo's app-topology line | out-of-scope | [security-networking](../design/security-networking.md#plan-12) |
| grype CVE scan + syft SBOM | SBOM/vulnerability/provenance evidence gates | parity/further | [sbom-vulnerability-notice-evidence](../design/sbom-vulnerability-notice-evidence.md) |
| Encrypted secrets at rest (Fernet) | Secretless-first config; secrets resolved to Camp refs, never plaintext | further | [authoring-resources-wiring](../design/authoring-resources-wiring.md#plan-21) |
| Real-time metrics, GPU, public status pages | Observability plane + public status page / incident comms | parity | [reliability-observability-cost](../design/reliability-observability-cost.md#plan-05), [public-status-page](../design/public-status-page-incident-communication.md) |
| RBAC + workspaces + quotas + SAML/OIDC SSO | Org/workspace/tenant model + member RBAC + tenant isolation/quotas | parity | [organization-workspace-model](../design/organization-workspace-model.md), [member-rbac-administration](../design/member-rbac-administration.md) |
| Audit logging | Event-sourced audit substrate (every decision a replayable event) | further | [data-plane](../design/data-plane.md#plan-11) |
| REST/OpenAPI + `X-API-Key` + webhook subscriptions | Contract-first WIT/protobuf/CUE boundaries + `notify` webhook-out | further | [contracts-policy-flags](../design/contracts-policy-flags.md#plan-29), [sdk-api](../design/sdk-api.md#plan-02) |
| Faro **Agent Bridge** (MCP command execution) | Agents-as-principals: MCP control surface + brokered tokens + capability manifests | further | [ai-native-agent-auth](../design/ai-native-agent-auth.md#plan-06), [generated-stack](../design/generated-stack.md#plan-23) |

### Where HoBo deliberately differs

- **HoBo is a meta-cloud; ServerKit is a host panel.** ServerKit manages the machines you own; HoBo chooses and governs how one app is realized across providers (including managed services), with auditable `match.Decided` records. ServerKit's "portability" is "the panel runs anywhere"; HoBo's is "the *workload* runs anywhere."
- **HoBo is contract-first at boundaries.** ServerKit integrates over REST/OpenAPI, `X-API-Key`, and Socket.IO. HoBo requires WIT/protobuf/CUE/PACT proof at integration edges so compatibility breaks are caught before deploy.
- **HoBo is event-sourced.** ServerKit mutates host state directly and logs actions. HoBo records platform decisions as replayable events and uses that log for audit, repair, policy, and cost — with plan/diff before apply, not just post-hoc snapshots.
- **HoBo treats agents as identities.** ServerKit's AI is a command bridge in a sibling desktop app. HoBo makes agents OIDC/SVID principals with brokered, scoped credentials, capability manifests, and first-class audit.
- **HoBo's runtime is language-neutral wasm/WIT.** ServerKit runs Docker containers and host processes. HoBo's portable unit is a Component with OCI fallback.
- **HoBo does not want to own your OS.** ServerKit's mail hosting, UFW rules, Lynis audits, and ClamAV are host/OS management *below* HoBo's app-topology line — a real place where ServerKit does things HoBo deliberately won't, and where the two could compose rather than compete.

### ServerKit-as-reference, and the borrowings HoBo could take

Because ServerKit lives one level below HoBo, the most useful relationship is **learning from a shipped implementation**, and in one framing, **composition**: a ServerKit-managed host (or its Go agent) is exactly the kind of self-hosted node a HoBo **Yard**/**Relay** could sit alongside or attach. Concrete borrowings:

1. **Node-attach UX.** ServerKit's **short-code pairing** + guided onboarding state machine (validate → prereqs → Docker → pair → ready) is a clean, shipped pattern for HoBo self-host node attach and Yard bootstrap ([bootstrap-installer](../design/bootstrap-installer.md)).
2. **WireGuard service tunnels validate the Relay.** ServerKit's agent-managed tunnels for private/NAT'd services are a real-world proof of HoBo's **Relay** (outbound-only proxy) design ([control-plane](../design/control-plane.md#plan-04)).
3. **Connections Hub → secretless surface.** A single encrypted store for source/cloud/DNS/registrar/SMTP/S3 credentials is a good UX analog for HoBo's secretless **Config and secrets** model; the lesson is a *one-surface* connections experience, while HoBo keeps the values as Camp references rather than encrypted-at-rest plaintext ([authoring-resources-wiring](../design/authoring-resources-wiring.md#plan-21)).
4. **Drift-detecting server templates.** ServerKit's compliance-tracking, drift-detecting, auto-remediating templates are a shipped analog to **Resource Packs + drift reconciliation** — validation that the direction is right, with HoBo adding provenance and conformance ([platform-engineering](../design/platform-engineering.md#plan-25), [drift-reconciliation](../design/drift-reconciliation.md)).
5. **Blue/green self-update with auto-rollback** is a good bar for HoBo's own upgrade/migration engine's operator ergonomics ([upgrade-migration-engine](../design/upgrade-migration-engine.md)).
6. **Deterministic single app-health** (healthy/degraded/restarting/unhealthy) is a tidy projection shape worth mirroring in HoBo's status surface ([reliability-observability-cost](../design/reliability-observability-cost.md#plan-05)).

### The one-line takeaway

**ServerKit is a shipped, batteries-included, MIT self-hosted server control panel — the strongest *live* pressure on HoBo's self-host and developer-experience stories — but it operates the hosts you already own instead of abstracting app topology across providers, mutates host state imperatively through a Flask panel rather than contract-first and event-sourced, and keeps its AI story in a sibling desktop client rather than treating agents as principals.** It is a candidate reference for HoBo's node-attach/**Relay** and connections UX and a useful "it ships today" benchmark — not a meta-cloud competitor.

## Adversarial critique

- **Enormous surface for one product.** Applications, databases, DNS, SSL, a full mail stack, WAF,
  backups and monitoring is a great deal to keep correct and secure, and the mail stack in
  particular is a domain with unforgiving failure modes.
- **Control panels are high-value targets.** A panel with root on every managed node is exactly the
  asset attackers seek, and this category has a long history of serious vulnerabilities.
- **Drift-detecting templates are only as good as their coverage** — what the template does not
  describe drifts silently.
- **Single-operator model.** There is no multi-tenancy or delegated administration worth the name.
- **Small project relative to its ambition**, which matters most for the security-sensitive parts.
- **No application abstraction.** Applications are stacks configured on machines, so nothing moves
  anywhere.

## Where HoBo is stronger or intentionally different

State labels follow the research contract.

- **Application-level intent and provider-abstract targets** (*implemented*); ServerKit manages
  servers, not applications-as-descriptions.
- **Scored placement and recorded decisions** (*implemented*, `match.Decided`).
- **Policy, residency and replay** (*implemented*, ADR-0135/0146).
- **Honest caveat.** On node-attach mechanics — pairing, tunnelling, drift correction — ServerKit has
  a working implementation and HoBo has a design.

## Better-together / integration posture

- **Borrow** — the reason this capture exists: **the agent's pairing, outbound tunnel and
  drift-detecting template mechanics** are a concrete reference for HoBo's Relay and node-attach
  path. This is now the fourth corpus occurrence of outbound-only agent connectivity (after Harness,
  Qovery and Rivet), and the pattern is unambiguous.
- **Benchmark** on node onboarding time.
- Not an adopt, provider, integrate or displace target.

## Threats and lessons

1. **Outbound-only agent connectivity is the settled pattern**, confirmed four times across this
   corpus in very different products. Any HoBo node-attach design that assumes ingress is wrong.
2. **Drift-detecting templates on the node** are a cheap, effective mechanism worth copying for
   attached nodes.
3. **Breadth is a security liability** in self-hosted software, and a reason for HoBo to keep its
   surface narrow and its escapes explicit.
4. **The panel category's users overlap HoBo's self-host audience**, which makes onboarding
   ergonomics — not features — the thing to learn from.

## Sources

- [jhd3197/ServerKit](https://github.com/jhd3197/ServerKit) — source, agent implementation, feature scope

This capture predates the research contract and was restructured to it on 2026-08-20 with its
original research preserved. Current project activity, security posture and agent capabilities were
not re-verified in this pass and are not asserted.
