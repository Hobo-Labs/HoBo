# Findings — 20260731-all-eq / iteration 002 (delight_maximize)

## Uplifts applied

### U-1: Doctor gbrain warn next-step (S)
- From backlog `fr-doctor-gbrain-next-step`
- Files: `scripts/doctor.ts`, `test/doctor-agent-tooling.test.ts`
- Effect: warn includes copy-paste `setup-agent-tools.sh --common-only --no-gbrain` + AUTH.md
- Harm: still 0; cognitive: no breach

### U-2: product-* persona schema v2 backfill (M)
- From backlog `fr-product-personas-schema-v2-backfill`
- All `product-*.md` personas now schemaVersion 2 with segment/demo/psycho/cognitive
- Validates via generate-persona --mode validate

### U-3: design:lint primary path (S)
- Already landed prior; marked done (no drift)

## Residual (L only — not auto-applied)

- fr-agent-check-multi-gate-wait (L)
- fr-public-site-optional-web-capture (L)

## implementableUpliftRemaining

**0** (S/M)
