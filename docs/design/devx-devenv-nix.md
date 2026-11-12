---
type: Architecture Note
title: "DevX: devenv-first local environments; Nix as optional IaC"
description: "Recommend devenv for local/dev shells; treat Nix as an optional IacProvider adapter — never the default multi-cloud IaC path. Risks, hobo dev integration, NixOS Stations, dendritic follow-on."
tags: [hobo, design, dx, iac, nix, devenv]
---

# DevX: devenv-first; Nix optional (not default IaC)

Maintenance note for local developer environments and where **Nix** sits relative to HoBo's pluggable IaC surface. Topology language matches [yard-first-placement](./adr/yard-first-placement.md): **Yard owns provider**; Camp is provider-neutral until attached; **Trails** re-home Camps across Yards.

## Decisions

1. **Local / contributor DevX is devenv-first.** Prefer [devenv](https://devenv.sh/) (or equivalent declarative shell tooling) for reproducible local toolchains, services, and agent sandboxes. Contributors should not need a full NixOS install or flake-driven cloud apply to develop HoBo.
2. **Cloud / multi-cloud IaC stays pluggable** via the `IacProvider` port ([ADR-0006](./adr/01-architecture-core.md#adr-0006)): **Pulumi · Crossplane · Terraform · OpenTofu** are the first-party adapters. **None is sole primary.** Continuous placement/reconciliation stays on Planner + ResourceActors + **Trails** — Nix does not invent a parallel control plane.
3. **Nix is optional IaC, never default.** A future `@hobo/iac-nix` (or git-registry module) may realize *system/image* resources through Nix flakes / NixOS modules for operators who already run that estate. It is **not** the recommended multi-cloud managed-resource path, not required for `hobo up`, and not implied by yard-first placement.
4. **IaC / cloud selection is Yard-scoped** (or Matching under the selected Yard). Camps remain **provider-neutral until attached**; they do not pin cloud or IaC engines. Matching may select a Nix-backed realization **only under a Yard whose provider/substrate admits it** (e.g. self-host / NixOS Station) — never "Camp chooses Nix as cloud provider."
5. **Highest-ROI path now: optional/auto-detected devenv in `hobo dev`.** See [Integration: hobo dev](#integration-hobo-dev).

## Why not Nix-default

| Pressure | Stance |
|---|---|
| Multi-cloud portability | Pulumi/Crossplane/TF/OpenTofu map cleanly to managed cloud APIs; NixOS modules are OS/system-centric. Community almost always pairs Nix with TF/Pulumi for cloud resources. |
| Agent / CI blast radius | Default paths must work with ordinary Node/TS toolchains and short-lived sandboxes without a system Nix daemon. |
| Operator choice | Self-hosted Yards **configure** their IaC adapter; forcing Nix breaks ADR-0006's "no single primary." |
| Local DX | devenv gives hermetic shells without making every deploy path a flake evaluation. |

## Integration: hobo dev

**Recommended (not yet fully shipped — design intent):**

| Trigger | Behavior |
|---|---|
| `devenv.nix` / `devenv.yaml` present, or user opts in | `hobo dev` may **auto-detect** and activate a devenv shell (languages, processes, services) that mirrors local Camp/Station dual fixtures |
| No devenv files / opt-out | Existing Node/TS toolchain + `runtime-local` paths remain the default; **Nix is never required** |
| Fidelity honesty | devenv-managed local services stay labeled `simulated` vs live the same way dual fixtures do today |
| Profiles | Optional devenv profiles for station occupancy modes, agent harnesses, training loops |

This is **DevX only** — local devenv never substitutes for a registered cloud `IacProvider` under a Yard. Windows contributors use **WSL** for devenv/Nix; native Windows without WSL keeps the non-Nix path.

## Hermetic / NixOS / Station uses (optional)

Nix shines **outside** default multi-cloud managed resources:

1. **Hermetic packaging & builds** — Bindle components, wasm → OCI, station images, agent sandboxes. Complements dagger-adjacent `BuildProvider`; may appear as an optional Build adapter, not as cloud provider selection on a Camp.
2. **NixOS-based Stations / self-hosted Yards** — Immutable system config, atomic upgrades/rollbacks ([ADR-0131](./adr/01-architecture-core.md#adr-0131) Station occupancy). Deploy via Colmena / deploy-rs / nixos-anywhere patterns behind the existing continuous layer — still one Yard provider for that self-host estate.
3. **Continuous Trails** — Express system-package or image duals (expand-contract) as Trail steps; purity helps dual-consistency oracles. **Trails also own Camp re-home across Yards/clouds** — not Camp-local Nix pins.
4. **Bridge patterns** — Terranix-style generation of TF/Pulumi configs from Nix modules if operators want one declarative surface that still drives existing adapters.
5. **CI / agent environments** — Reproducible shells for coding agents and Golden Suite runners via devenv.

## Dendritic module structure (follow-on)

If/when the Nix module surface becomes non-trivial (multiple hosts, home-manager, station Rails profiles, policy packs):

- Prefer a **dendritic** (feature-oriented) flake-parts / import-tree layout: every `.nix` file is a top-level module of the same kind; organize by *feature* (trails, junctions, harness, FinOps), not by host class first.
- Keep `flake.nix` a thin root.
- Dendritic structure is a **structuring** pattern for Nix configs — **not** an IaC engine and **not** a second control plane. HoBo still reconciles via Planner/Trails under the Yard.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| **Learning curve / skill distribution** | Keep Nix optional and behind Yard/Matching; make **devenv** the easy entry; never require flakes for `hobo doctor` or offline proofs. |
| **Windows** | Document **WSL** for devenv/Nix; **do not** make Nix the only local path — Node/TS + `runtime-local` remain first-class. |
| **Binary caches / eval time** | Cachix or private caches; pin flakes; lean on devenv's activation caching; time-box agent sandboxes. |
| **Secrets / secretless-first** | Never put long-lived secrets in Nix expressions; use SVIDs + short-lived brokered credentials ([ADR-0027](./adr/02-identity-security.md#adr-0027)); pure evaluation + ref-only audit events. |
| **Drift from ADR-0006 / yard-first** | Treat `@hobo/iac-nix` as one more engine under the same Trails/Planner continuous layer and **Yard-owned provider** selection — not Camp-authored cloud choice and not a parallel control plane. |

## Recommended local shape

```text
# contributor / agent sandbox (illustrative)
devenv.nix          # languages, packages, processes for hobo dev
.envrc / direnv     # optional activation
# NOT required:
# flake.nix that applies production cloud resources as the only IaC path
```

Cloud apply still goes through **Yard → Planner → `IacProvider.preview|apply`** (or Matching under that Yard). Local devenv never substitutes for a registered cloud IaC adapter.

## Package map (aspirational)

| Surface | Role |
|---|---|
| devenv / direnv (repo tooling) | Local shells, services, agent preflight — **DevX only**; auto-detect in `hobo dev` |
| `@hobo/iac-pulumi` / `-crossplane` / `-terraform` / `-opentofu` | First-party multi-cloud managed-resource IaC adapters |
| `@hobo/iac-nix` (optional, later) | Optional adapter for Nix-centric / NixOS operators; never core default |
| Optional Build / Station Nix adapters | Hermetic images + NixOS Station system config under existing ports |

## Design ↔ code residual (`@hobo/camps`)

Production `camp()` **rejects** Camp-owned cloud selection at parse:

- `defaultProvider` / `tiers` / `bindings` → error: *Provider selection belongs on a Yard* (`packages/camps/src/camp.ts`).
- `providerSelection(...)` remains exported as a **descriptor helper** for within-provider mapping / legacy tests; it is **not** a Yard substitute.
- Type fields marked `@deprecated` on Camp config document the migration surface only.

**Decision:** no Camp API rewrite in this goal beyond docs — reject path already enforces yard-first. Track any remaining sugar-compiler proofs that still name `defaultProvider` as historical under Yard-owned defaults.

## Permanent non-goals

- Replacing Pulumi/TF/Crossplane/OpenTofu with Nix as the only production IaC.
- Requiring flakes to run `hobo dev`, `hobo doctor`, or offline draft proofs.
- Camp-level authoring of `iac: nix()` or `defaultProvider` as a substitute for Yard provider selection.
- Implementing full `@hobo/iac-nix`, Colmena, or nixos-anywhere automation in this design note alone.

## Related

- [ADR-0006](./adr/01-architecture-core.md#adr-0006) — pluggable IaC; no single primary
- [yard-first-placement ADR](./adr/yard-first-placement.md) — Yard owns provider; Camp neutral until attached; Trails for moves
- [ADR-0131](./adr/01-architecture-core.md#adr-0131) — Station occupancy
- [ADR-0134](./adr/02-identity-security.md#adr-0134) — Trails
- [developer-experience.md](./developer-experience.md#plan-07) — CLI / local DX
- [control-plane.md](./control-plane.md#plan-04) — `IacProvider` drivers
- [architecture.md](./architecture.md#plan-10) — monorepo package layout (`iac/`)
