# HOBO-191 CDKTF Import-Only Backend Proof

This proof backs [PLAN-04](../../control-plane.md#plan-04) and
[ADR-0041](../../adr/07-portability-extensibility.md#adr-0041).

Executable artifact:

- [`src/draft/technical-proofs/iac-cdktf-import-only-contract`](../../../../src/draft/technical-proofs/iac-cdktf-import-only-contract)

Acceptance evidence:

- A CDKTF/Terraform state fixture is parsed into HoBo resource records.
- Mapped resources are surfaced as `adopted` candidates with source provenance.
- `apply`, `preview`, and `destroy` reject with a precise import-only error.
- The import -> plan -> no-op diff conformance path emits no create/delete work.

Adversarial evidence:

- Unknown Terraform resource types are retained as `external` records.
- Delete/create proposals against adopted resources are blocked as destructive
  import plans.
- Malformed or partial state files fail closed before a drift report is emitted.

Scope boundary:

- No `hobo import` CLI or production importer orchestration.
- No production `external`/`adopted` resource-kind implementation.
- No authoring of new CDKTF/Terraform infra; the backend is read-only.
- No Pulumi/OpenTofu/Crossplane behavior.
