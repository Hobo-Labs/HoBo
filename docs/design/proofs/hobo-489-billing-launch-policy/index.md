# HOBO-489 Billing Launch Policy Proof

HOBO-489 is proven by the focused M0 contract at
[`src/draft/exp-proofs/cx/billing-launch-policy-contract`](../../../../src/draft/exp-proofs/cx/billing-launch-policy-contract/README.md)
and the durable policy record at [billing-launch-policy.md](../../billing-launch-policy.md).

## Acceptance Evidence

- Supported plans, prepaid credits, invoice timing, payment failure states, refund/credit
  correction, and v1 scope-out are represented in a versioned record.
- Every billing lifecycle state maps customer messaging, support action, audit evidence, and
  entitlement impact.
- Payment-provider boundaries name checkout, webhook, invoice-sync, and money-movement assumptions
  plus mocked-provider behavior.
- Legal/privacy inputs are linked as blockers or launch limitations.

## Negative Coverage

- Validation rejects missing entitlement impact.
- Validation rejects live-provider integration work in HOBO-489.
- Validation requires tax-engine and live-payment-provider scope-out entries.
- Validation rejects legal/privacy inputs that are neither blockers nor limitations.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\billing-launch-policy-contract test
```
