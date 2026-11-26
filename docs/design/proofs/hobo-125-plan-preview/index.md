# HOBO-125 Plan Preview Proof

This proof backs [PLAN-07](../../developer-experience.md#plan-07),
[PLAN-19](../../worked-example.md#plan-19), [PLAN-04](../../control-plane.md#plan-04),
and the DeploymentPlan IR from HOBO-41.

The executable POC in
[`src/draft/technical-proofs/hobo-plan-preview-contract`](../../../../src/draft/technical-proofs/hobo-plan-preview-contract)
proves the M2 `hobo plan [--camp]` preview contract:

- `hobo plan --camp prod` renders every sample resource with provider,
  match reason, and estimated monthly cost;
- `--json` returns a stable machine envelope suitable for CI posting;
- a re-plan against the same current `DeploymentSet` reports zero changes;
- unresolved required capabilities fail closed and name the offending port;
- plan execution emits no provisioning side-effect events;
- ambiguous provider matches, non-portable `raw()` usage, cross-cloud edges, and
  cost assumptions are visible as warnings;
- unknown Camps fail before planning with a clear error.

Scope boundary: this is a contract adapter over fake collection, matching, and
planner seams. Real provider resolution, real planner execution, CI comment
publication, `verify`, and `up` provisioning remain downstream work.
