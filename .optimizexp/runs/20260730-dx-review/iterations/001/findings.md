# DX review findings — iteration 001

Run: `20260730-dx-review` · experience: **dx** · report-only

Bus corrections applied: **3** (`correctedFrom` prior mismatch outcomes). All three scenario expectations **matched** after correction — environment still lacks `node_modules`; scores did **not** improve (no fix pass).

---

### F-1: Shared DX entrypoints require node_modules/tsx before any useful output
- Metrics (judged): friction=**4**, uncertainty=**3** (agent:check); doctor friction=**4**, uncertainty=**2**
- Personas: product-app-developer, junior-typescript-developer (+ platform-engineer shared failure mode)
- Evidence:
  - `.optimizexp/features/narrow-local-validation/evidence/.../primary.txt`
  - `.optimizexp/features/cli-help-and-doctor/evidence/.../primary.txt`
  - `.optimizexp/features/agent-check-staged/evidence/.../primary.txt`
  - outcomes `2026-07-30T18:01:05Z-0005`, `…0007`, `…0009`
- Smallest reduction:
  1. Preflight in `agent:check` / `doctor` scripts: if no `node_modules` or cannot resolve `tsx`, print **one-line install instruction** and exit non-zero **before** Node stack.
  2. Optionally: static offline doctor path (`node scripts/doctor-offline.mjs` or pure shell) listing engines + install steps.
  3. Document install-first at top of DX ladder in README / AGENTS performance policy.
- Effort: **S–M**
- Leverage: high — unblocks metric_max 4 → target ≤2 for cold clone

### F-2: Evidence harness exit codes can read 0 while body fails
- Metrics: uncertainty=**+1–2** contribution when agents/personas trust harness `exitCode`
- Personas: all CLI-evidence reviewers; junior especially
- Evidence: all three captures show `exitCode: 0` in primary header while stdout has `ELIFECYCLE … exit code 1`
- Cause: probe uses `cmd 2>&1 | head -N` without `set -o pipefail`; pipeline exit is from `head`
- Smallest reduction:
  1. Capture driver: `set -o pipefail` (bash) or avoid pipe; capture full stream with byte cap instead of `head`
  2. Parse body for `ELIFECYCLE` / non-zero and surface `effectiveExitCode` in meta.json
- Effort: **S**
- Leverage: medium — cleans agent/persona judgment; does not fix product DX alone

### F-3: Doctor is not a zero-setup preflight
- Metrics: friction=4 (same family as agent:check)
- Personas: product-app-developer
- Evidence: doctor primary + outcome `0007`
- Smallest reduction: doctor must not depend on workspace `tsx` for the “missing install” diagnosis; or ship a native/`node --experimental-strip-types` fallback for cold start
- Effort: **M**
- Leverage: high for onboarding narrative

### F-4 (platform): One bootstrap cliff for all `node --import tsx` scripts
- Metrics: product-platform-engineer estimated friction=3, uncertainty=2
- Personas: product-platform-engineer
- Smallest reduction: shared preflight helper used by package.json scripts; single place to improve messaging
- Effort: **M**
