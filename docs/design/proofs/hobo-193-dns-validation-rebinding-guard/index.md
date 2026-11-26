# HOBO-193 DNS Validation Rebinding Guard Proof

This executable proof covers the M3 adversarial hardening required by
[Plan 12](../../security-networking.md#plan-12),
[ADR-0035](../../adr/07-portability-extensibility.md#adr-0035), and
[ADR-0101](../../adr/07-portability-extensibility.md#adr-0101). It builds on the
HOBO-189 threat model and HOBO-142 validation resource boundary while keeping the
production DNS/ACME/gateway implementations out of scope.

## Acceptance Mapping

| Acceptance | Executable proof |
|---|---|
| DNS rebinding after validation is detected and blocks promotion. | `DNS rebinding after domain.Validated is caught before live-zone mutation` changes resolver evidence before promotion and asserts `domain.ValidationFailed`, `promote-recheck`, and no live-zone write. |
| A single spoofed resolver cannot validate a bad target. | `one spoofed resolver cannot satisfy the multi-vantage validation gate` asserts one attacker answer among three fails `multi-vantage-resolve`. |
| Sibling-name ACME evidence does not satisfy the gate. | `sibling-name ACME challenge evidence cannot satisfy the exact FQDN gate` rejects `_acme-challenge.shop.com` for `api.shop.com`. |
| Validate-to-promote TOCTOU is bounded and rechecked. | `validate-to-promote window is bounded and rechecked before write` rejects a promotion outside the pinned window. |
| Live zone is never mutated to the attacker target by the guard. | The rebinding test asserts the recording live zone has no writes and no attacker target after the failed promotion. |

## Adversarial Mapping

| Adversarial case | Guard |
|---|---|
| Attacker controls one of N vantage resolvers. | Any answer not matching the expected target fails closed instead of quorum-picking. |
| Attacker flips record exactly at propagation-confirm boundary. | Promotion recomputes the canonical evidence digest and rejects drift before write. |
| Attacker races the promote write. | Promotion checks the validate-to-promote window and live-zone baseline immediately before the live write. |

## Commands

```powershell
npm.cmd --prefix src\draft\technical-proofs\dns-validation-rebinding-guard-contract test
npm.cmd test
npm.cmd run docs:cli-lint
npm.cmd run docs:design-lint
node scripts\validate-traceability.ts
node scripts\validate-sdk-contracts.ts
node scripts\validate-deployment-set-delta.ts
git diff origin/main...HEAD --check
```
