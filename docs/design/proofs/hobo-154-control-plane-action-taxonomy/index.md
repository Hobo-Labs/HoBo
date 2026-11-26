# HOBO-154 Control-Plane Action Taxonomy Proof

This proof makes the Plan 29 `hobo:<resource>:<verb>` taxonomy executable in
[`src/draft/technical-proofs/control-plane-action-taxonomy-contract`](../../../../src/draft/technical-proofs/control-plane-action-taxonomy-contract/README.md).

## Acceptance Mapping

| Acceptance | Executable proof |
|---|---|
| Every listed resource/verb has an action id | `pins every Plan 29 resource/verb row to a stable hobo:* action id` |
| A new control-plane CLI/MCP verb without an action id fails the build gate | `fails the completeness gate for a CLI or MCP verb without an action id` |
| Secret values are not a grantable read | `keeps secret-broker value reads ungrantable while allowing metadata and rotation` |
| Derivative, registry bundle-import, and relay high-privilege actions are present | `includes the high-privilege derivative, registry bundle import, and relay actions` |
| Operations lower to `(resource=hobo:<resource>, action=<verb>)` | `lowers a control-plane operation into the policy DecisionRequest shape` |

## Boundary

This is only the action taxonomy and completeness-gate contract. Role bindings, the policy engine,
and secret value resolution remain out of scope for this slice.

## Verification

```sh
npm.cmd --prefix src/draft/technical-proofs/control-plane-action-taxonomy-contract test
```
