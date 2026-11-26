# `@hobo/adapter-openbao`

**Optional** residual [OpenBao](https://openbao.org) secrets backend for HoBo.

This package is **not** a default dependency of `@hobo/identity` or the composed
`hobo` binary. Install it only when a Camp/Station needs residual OpenBao.

## Secretless-first ranking (unchanged)

1. bound-resource  
2. provider-federation ← OpenBao residual lives here  
3. camp-value  
4. static-escape  

Prefer identity federation. OpenBao is residual only (ADR-0027 / ADR-0113).

## Install

```bash
pnpm add @hobo/adapter-openbao
```

## Usage

```ts
import { createOpenBaoSecretsPort, createLocalStationOpenBaoSecretsPort } from "@hobo/adapter-openbao";
import { resolveConfigEntry, asHoboSecretsStore } from "@hobo/identity";

// Offline residual (hobo dev / tests — no network)
const offline = createOpenBaoSecretsPort({
  openbaoAddr: "http://127.0.0.1:8200",
  role: "hobo-workload",
  svidJwt: shortLivedSvidJwt, // never a long-lived OpenBao root token
  offline: true,
});

// Local Station residual helper (offline unless HOBO_OPENBAO_LIVE=1)
const station = createLocalStationOpenBaoSecretsPort({ stationId: "local" });

// Live residual OpenBao (JWT login + KV v2)
const live = createOpenBaoSecretsPort({
  openbaoAddr: process.env.HOBO_OPENBAO_ADDR!,
  role: process.env.HOBO_OPENBAO_ROLE ?? "hobo-workload",
  svidJwt: process.env.HOBO_SVID_JWT!,
  offline: false,
  fetch: globalThis.fetch,
});
```

### Env (live local)

| Env | Meaning |
|---|---|
| `HOBO_OPENBAO_LIVE=1` | Use live HTTP (requires OpenBao + JWT) |
| `HOBO_OPENBAO_ADDR` | e.g. `http://127.0.0.1:8200` |
| `HOBO_SVID_JWT` | Short-lived SVID JWT for auth/jwt |
| `HOBO_OPENBAO_ROLE` | JWT role (default `hobo-station-<id>`) |
| `HOBO_OPENBAO_NAMESPACE` | Free namespace → `X-Vault-Namespace` |
| `HOBO_OPENBAO_MOUNT` | KV v2 mount (default `secret`) |

## Default installation

`@hobo/identity` defaults residual secrets to **memory** (`createMemorySecretsPort` /
`createLocalStationSecretsPort`). OpenBao is never pulled into default installs.
