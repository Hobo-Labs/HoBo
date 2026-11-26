---
type: Competitive Reference
title: "Anon / temporary container hosts — Competitor Reference"
description: "OpenPouch-class anonymous temporary hosting competitors for Examples Temporary (zero project API keys): Clawdship, APPISH, ZeroDeploy, SSHGrid, ttl.sh, Dockup, and blacklisted Instanode."
tags: [hobo, competitors]
competitor:
  slug: anon-container-hosts
  name: "Anonymous container hosts"
  aliases: ["openpouch", "clawdship", "ttl.sh", "zerodeploy", "dockup"]
  primary_category: cloud-application-platforms
  categories: [cloud-application-platforms, self-hosted-paas]
  directness: adjacent
  role: "cohort capture of zero-key temporary container hosts used as the Examples Temporary host matrix"
  posture: [benchmark, provider-target]
  hobo_surface: [provider-matching, delivery]
  evidence: mixed
  status: active
  research_date: 2026-08-20
  contract: v1
  sources:
    - https://clawdship.dev/
    - https://ttl.sh/
---

# Anon / temporary container hosts — Competitor Reference

> Captured 2026-08 for HoBo Examples Temporary: browser → same-origin API → remote HTTPS, **zero project API keys**, no user CLI. Fair-use factual surface only ([index](index.md#sources--fair-use)).

HoBo needs **anonymous temporary hosts** that can run Node/Docker (OpenSaaS server) and ideally Convex OCI (≥~512MiB). OpenPouch Instant Lane is the proven Node baseline; competitors below are implemented or fail-closed with evidence.

## What it is

This is a **cohort capture, not a product capture**: the set of anonymous, zero-key temporary
container hosts evaluated as backends for HoBo's Examples Temporary lane, where the constraint is
browser → same-origin API → remote HTTPS with **no project API keys and no visitor CLI**.

- **Cohort boundary.** Hosts that accept a deployment without an account or key. Credentialed
  runners (E2B, Dockup, Workers Paid Containers) are operator unlocks and out of scope by rule.
- **Why it is one capture.** These are interchangeable candidates evaluated against one requirement,
  and the useful artifact is the comparison matrix with probe evidence. Should any single host become
  strategically important, it earns its own capture under
  [`metadata-contract.md`](metadata-contract.md).
- **Status of the evidence.** Every row below records an observed probe result and a date. Vendor
  documentation claiming a capability is recorded as a claim; a probe is what promotes it.

## Core primitives and mental model

| Primitive | What it is |
| --------- | ---------- |
| **Instant lane / drop** | A single unauthenticated HTTP POST carrying a tarball, returning a URL |
| **Claim token / claim URL** | The mechanism that converts an anonymous deployment into an owned one |
| **Ephemeral TTL** | The deployment's lifetime — typically hours, after which it disappears |
| **Anon memory cap** | The cgroup limit applied to keyless deployments, and the binding constraint here |
| **Adapter + chain** | HoBo's side: per-host adapters tried in order with one-shot probes and cooldowns |

The mental model is **a URL in one call, owned by nobody**. It is an excellent fit for a
try-it-now demo and a categorically wrong fit for anything holding state or secrets.

## Architecture

- **HoBo's side** — per-host adapters under `site/scripts/anon-container-hosts/`, composed by
  `chain.mts` with one-shot attempts and per-host cooldown files, so a dead host costs one request
  rather than a retry storm.
- **Transport** — the browser talks only to a same-origin API, which talks to the remote host. No
  credentials ever reach the visitor and no CLI is required of them.
- **Failure posture** — fail closed. Where no host can satisfy a requirement (Convex OCI RAM), the
  path refuses rather than degrading silently, with an explicit opt-in env knob for operators.
- **State authority** — none. These deployments are disposable by design.
- **Portability boundary** — near-total. Each host takes a tarball or an OCI image and returns a URL,
  so switching hosts is an adapter, which is exactly why a chain works.

## How it competes with HoBo

Not at all. This cohort exists as a provider-target matrix for one HoBo feature.

| Contested HoBo surface | The relationship |
| ---------------------- | ---------------- |
| `provider-matching` | Candidate hosts selected by capability and evidence, with a documented fallback chain |
| `delivery` | The Examples Temporary lane's deployment path |

## Feature surface

### Matrix (runtime-oriented)

| Host | Anon? | Runs containers? | HoBo adapter | Proven status |
|---|---|---|---|---|
| **OpenPouch** (`openpouch.sh`) | Yes (no key) | Yes (Node dynamic; anon `memory.max=256MiB`) | `site/scripts/anon-container-hosts/openpouch-http.mts` | **Works** (2026-08 probe: `*.openpouch.sh`); **OOM** for Convex binary |
| **Clawdship** (`clawdship.dev`) | Yes (first deploy auto-account) | Yes (static + Docker tar.gz) | `clawdship.mts` | Adapter shipped; DNS resolves, **TCP:443 timeout** from this env (one-shot, no retry) |
| **APPISH** (`appi.sh`) | Claims push→URL | Yes (OCI push) | `appish-crane.mts` | Login/push-id gated; anon crane → `BLOB_UPLOAD_INVALID` |
| **ZeroDeploy** Drop | Yes | **No** (static / tar.gz site) | `zerodeploy.mts` | **Works** for static (2026-08: `*.zerodeploy.app`, nested `{data.url}`) — not Docker/OCI |
| **SSHGrid** Deploy API | Yes | **No** (tiny static/PHP JSON) | — | Static only; size-capped |
| **ttl.sh** | Yes | **No** (registry only) | — | Not a runner |
| **Dockup** (`dockup.cc`) | No (`dkp_` key) | Yes | — | Credentialed — forbidden for Examples Temporary |
| **Instanode** | Docs claim anon stacks | Docs claim deploy | **Blacklisted** | Live `api.instanode.dev` → nginx **404**; do not re-probe |
| **Lakebed** | Yes (`lakebed deploy`) | Capsule IR (not OCI) | Existing lakebed path | Works for capsules; not Convex OCI |
| **E2B / Offly / SnapDeploy** | No | Yes | — | API key / signup — forbidden |

Sources checked 2026-08: [clawdship.dev](https://clawdship.dev/), [appi.sh](https://appi.sh/), [zerodeploy.dev/agents](https://zerodeploy.dev/agents), [sshgrid.com/api](https://sshgrid.com/api), [ttl.sh](https://ttl.sh/), [dockup.cc/llms.txt](https://dockup.cc/llms.txt), OpenPouch Instant Lane docs.

### Per-host surface

### Clawdship

```bash
curl -X POST https://api.clawdship.dev/v1/sites \
  -F name=my-api -F type=docker -F slug=my-api -F port=3000 \
  -F archive=@/tmp/archive.tar.gz
```

- Zero signup; first response may include `cship_` API key + billing URL.
- Static or Docker (`Dockerfile` in archive).
- Agent skill: `https://clawdship.dev/skill.md`.

### OpenPouch Instant Lane

```http
POST https://openpouch.sh/api/deployments
Content-Type: application/gzip
X-Openpouch-Project: <slug>
x-openpouch-env: <base64 JSON>
```

Body = gzip tarball of Node project. Anon cgroup **256MiB**.

### ZeroDeploy Drop

```http
POST https://api.zerodeploy.dev/drop
Content-Type: application/gzip
```

Returns `{ url, claim_token, expires_at }`. Ephemeral ~72h. **Not Docker.**

### APPISH

```bash
crane copy --platform linux/amd64 <image> push.to.appi.sh/<slot>/app:port_<port>
# → https://<slot>.appi.sh
```

Free slots documented as dashboard push-id / login.

## Primitive mapping

### Integration paths

| Need | Path |
|---|---|
| OpenSaaS anon server | `provisionAnonOpenSaasServer` — OpenPouch HTTP → **Clawdship** → CF Neon shim |
| Generic host chain | `site/scripts/anon-container-hosts/chain.mts` (one-shot + per-host cooldown) |
| Convex OCI | Default fail-closed (`ephemeral-anon.ts`); opt-in `HOBO_CONVEX_OCI_HOST=clawdship` |
| Static anon drop | ZeroDeploy adapter (not wired into OpenSaaS server) |
| Examples Temporary rule | Browser-only; no visitor CLI (`docker`/`wrangler`/`openpouch`/`crane`) |

Env knobs:

- `HOBO_OPENSAAS_SERVER_HOST=auto|openpouch|clawdship|cloudflare`
- `HOBO_OPENPOUCH_TRANSPORT=http|cli` (default `http`)
- `HOBO_CONVEX_OCI_HOST=clawdship|cloudflare|…`
- `HOBO_ANON_HOST_COOLDOWN_DIR` — per-host 6h cooldown files
- `HOBO_ANON_PROBE=openpouch|clawdship|zerodeploy|all` — one-shot probe script

## Adversarial critique

- **Anonymous hosting is unaccountable hosting.** No contract, no support, no SLA, and no recourse
  when a host disappears — several already have.
- **Documentation frequently overstates the free tier.** APPISH's anonymous push returns
  `BLOB_UPLOAD_INVALID`; Instanode's docs describe anonymous stacks against an endpoint that returns
  nginx 404. This is precisely why the matrix records probes rather than claims.
- **"Zero signup" often means deferred signup.** Clawdship's first response may carry an API key and
  a billing URL, which is a claim flow and is not the same as being free.
- **Memory caps are the real constraint**, not the API. The anonymous 256MiB tier is what makes
  Convex OCI impossible, and no amount of adapter work changes it.
- **Ephemeral means ephemeral.** A ~72-hour TTL is fine for a demo and disqualifying for anything a
  reader might bookmark.
- **Running arbitrary containers for anonymous users is an abuse magnet**, so these services are
  under continuous pressure to tighten limits — the tier this cohort depends on is the first thing
  that gets restricted.
- **Probing has an etiquette cost.** Repeatedly testing free tiers from CI is impolite and is why the
  cooldown and one-shot rules exist; they are correct and should stay.

## Where these hosts are stronger

- **Genuinely zero-key deployment.** OpenPouch's Instant Lane and ZeroDeploy's Drop take a tarball over plain HTTP and return a working URL with no account, which nothing in the managed-cloud corpus does.
- **Agent-shaped surfaces.** A single HTTP POST with a gzip body is trivially callable by an agent, and Clawdship publishes an agent skill at a well-known URL — this cohort is ahead of the mainstream on machine-callable deployment.
- **Claim flows** turn an anonymous deployment into an owned one after the fact, which is the right order of operations for a demo.
- **Speed to first URL** is the category's whole proposition and it is real.

## Where HoBo is stronger or intentionally different

State labels follow the research contract.

- **Fail-closed by default** (*implemented*). Convex OCI is refused rather than attempted on a host that cannot hold it; opting in is explicit.
- **Evidence-backed host selection** (*implemented*). Each row above records a probe result and a date, not a vendor claim — the discipline the research contract asks for, applied operationally.
- **Cooldowns and one-shot probing** (*implemented*) so a failing host degrades the chain rather than the run.
- **Blacklisting with a reason** (*implemented*). Instanode is recorded as documented-but-404 with an instruction not to re-probe.

## Gaps

- **No zero-key host proven for Convex OCI RAM** yet; OpenPouch too small; CF Temporary Containers 403; Clawdship is the best implemented competitor bet.
- Static Drop APIs (ZeroDeploy/SSHGrid) help demos, not Bindle `container` / Convex self-host.
- Credentialed runners (E2B, Dockup, Workers Paid Containers) stay operator unlocks — not Examples Temporary.

### Capability mapping

| Competitor capability | HoBo equivalent |
|---|---|
| Anon Instant Lane deploy | Temporary Station + anon host adapters |
| Agent-native one HTTP call | Same-origin `/api/cf-temp/*` → remote host APIs |
| Claim / billing link | Surface `claimUrl` on Temporary ship results |
| Docker from tarball | Clawdship adapter + staged Dockerfile |
| OCI push→URL | APPISH adapter (fail-closed when login-gated) |
| Capsule IR | Lakebed provider (separate path) |

## Better-together / integration posture

- **Provider-target** — the only posture: adapters behind the Examples Temporary chain, selected by
  evidence and refused where capability is absent.
- **Benchmark** — on the agent-callable deployment surface. A single HTTP call with a tarball and no
  credentials is a better machine interface than most of the corpus offers, and it is a fair bar for
  HoBo's own agent-facing deploy path.
- Not a displace, adopt or borrow target beyond that interface shape.

## Threats and lessons

1. **Probe, then claim.** This capture is the operational form of the research contract's evidence
   rule: documentation says a thing, a probe establishes it, and the difference is written down with
   a date. That discipline is worth generalizing to HoBo's provider matrix.
2. **A one-call, credential-free deploy is the right agent interface.** These hosts are ahead of the
   mainstream cloud on machine-callability precisely because they had to be simple, and HoBo's agent
   surface should aim at that shape.
3. **Fail closed on capability, opt in explicitly.** Refusing Convex OCI rather than attempting it on
   a 256MiB host is the correct behaviour and a small worked example of ADR-0144's impedance
   reasoning.
4. **Free tiers are not infrastructure.** The Examples Temporary lane is a demo path and should never
   become load-bearing for anything else; this capture should say so every time it is refreshed.

## Sources

Probed 2026-08 with results recorded in the matrix above:
[clawdship.dev](https://clawdship.dev/), [appi.sh](https://appi.sh/),
[zerodeploy.dev/agents](https://zerodeploy.dev/agents), [sshgrid.com/api](https://sshgrid.com/api),
[ttl.sh](https://ttl.sh/), [dockup.cc/llms.txt](https://dockup.cc/llms.txt), and the OpenPouch
Instant Lane documentation.

Related: [Lakebed](lakebed.md) for the capsule path referenced in the matrix, and
[Flux Network](flux-network.md) for the other low-trust compute target in this corpus.

Pricing, current free-tier limits and TTLs change frequently and are asserted only as of the probe
date recorded above.
