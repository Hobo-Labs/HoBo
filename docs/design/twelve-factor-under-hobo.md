---
type: Reference
title: "12-factor under HoBo"
description: "How HoBo satisfies 12-factor intent without password-in-env or CF credential bags."
tags: [hobo, design, config, security]
---

# 12-factor under HoBo

Honest mapping of [12-factor](https://12factor.net/) principles under HoBo’s integrity membrane
([ADR-0141](./adr/02-identity-security.md#adr-0141), [ADR-0142](./adr/02-identity-security.md#adr-0142),
[ADR-0027](./adr/02-identity-security.md#adr-0027)).

## What we keep

| Factor | HoBo reading |
|---|---|
| **III. Config** | Schema in the Bindle; values outside the release artifact via ranked resolution and optional linked `wasi:config` |
| **IV. Backing services** | Attached as **linked capabilities** (`fromBinding`, WIT ports), swapped by rebinding providers |
| **V. Build/release/run** | Same component; Camp links + policy differ |
| **VI. Processes** | Stateless guests; no local secret files as truth |
| **X. Dev/prod parity** | Same WIT imports; different providers behind links |

## What we reject (non-goals)

- Password-in-env as “12-factor compliance”
- `VCAP_SERVICES` / Aspire `ConnectionStrings__*` credential bags as binding delivery
- OSBAPI as the core provider protocol
- CredHub product or always-on vault on every lattice
- Default OpenBao in `@hobo/identity` installs

## Binding delivery

**Only path:** WIT import → link → provider → `ctx.bindings.*`.

`hobo doctor` reports binding-delivery readiness: secret-shaped env is a failure.

## Config vs residual secrets

| Kind | Surface |
|---|---|
| Non-secret deploy variance | Linked `wasi:config/store` (import-optional; memory offline) |
| Sensitive config | Delegated refs + ADR-0027 ladder; host-mediated material only |
| Residual classical secrets | Optional SecretsPort / adapters; memory default local |

Agents see `schemaOnlyView` only. Events carry refs + sensitivity, never plaintext.
