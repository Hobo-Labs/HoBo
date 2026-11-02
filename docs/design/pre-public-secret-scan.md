---
type: Reference
title: "Pre-public secret scan runbook (Target A)"
description: "Agent-executable and human-owned steps to scan git history for secrets before flipping the repository public. Required condition for full go on ADR-0140 Target A."
tags: [hobo, design, ship, security, target-a]
---

# Pre-public secret scan runbook (Target A)

> **Ship target:** A — OSS public ([ADR-0140](./adr/07-portability-extensibility.md#adr-0140)).  
> **Residual:** history secret scan remains a hard condition for full Target A go when the repo is still private.  
> **Parent:** [`instances/go-no-go-repo-public-2026-07-30.md`](./instances/go-no-go-repo-public-2026-07-30.md).

## Purpose

Before making the repository public, prove the full git history does not contain live credentials. CI `secret-scan` (gitleaks on the current tree/PR) is necessary but not sufficient for a private→public flip.

## Tooling

Prefer **gitleaks** CLI (HoBo CI `secret-scan` job on `runs-on: hobo` reads pin versions from `.github/action-pins.env` with `grep`/`cut` — keys are not shell-sourced — installs **linux x64 or arm64**, then runs `gitleaks git --redact`).

```sh
# Install once (or use the binary from CI setup)
# https://github.com/gitleaks/gitleaks

# Full history scan from repo root
gitleaks detect --source . --verbose --redact --report-path pre-public-gitleaks-report.json
```

Optional baseline (only after a human triage of known false positives):

```sh
gitleaks detect --source . --baseline-path .gitleaks-baseline.json --verbose --redact
```

Do **not** commit raw secret values. Reports that must leave the machine should be redacted.

## Pass criteria

| Check | Pass when |
|---|---|
| History scan | `gitleaks detect` exits 0, or every finding is triaged as false positive with baseline + justification |
| Working tree | CI secret-scan job green once Actions runners are restored (H-V1) |
| Remediation | Any true positive is rotated at the provider, purged from history (filter-repo/BFG with force-push policy), and re-scanned clean |

## Evidence to attach to the next go/no-go instance

1. Command + exit code + date  
2. Redacted report path or summary (finding counts, not secret material)  
3. Link to PR that updates `go-no-go-repo-public-*.md` condition 3 to **Met** only after clean scan  

## What this runbook does not do

- Flip repository visibility (human org setting)  
- Restore Actions runners (H-V1)  
- Approve customer ToS (H-O2)  
- Publish npm packages (H-E1b)  

## Related

- [`SECURITY.md`](../../SECURITY.md)  
- [`instances/residual-human-blockers-2026-07-30.md`](./instances/residual-human-blockers-2026-07-30.md)  
- CI secret-scan job in `.github/workflows/hobo-ci.yml`  
