# HOBO-631 Allow Triple Effects Proof

This proof backs [PLAN-21](../../authoring-resources-wiring.md#plan-21),
[PLAN-06](../../ai-native-agent-auth.md#plan-06), and FR-002.

The executable POC in
[`src/draft/technical-proofs/s3-05-allow-triple-effects-poc`](../../../../src/draft/technical-proofs/s3-05-allow-triple-effects-poc)
proves the S3-05 `.allow()` triple-effect boundary:

- one `.allow()` declaration compiles to least-privilege IAM, deny-by-default wasm link-table entries, and broker token-scope ceiling;
- `fixtures/hello-bindle-golden.json` asserts the IAM+link+scope triple for `hello-bindle`;
- `request_token` within the ceiling emits `token.Granted`;
- `request_token` exceeding the ceiling is refused with auditable `token.Denied`; and
- unknown verbs fail closed at compile time.

Scope kept out: production promotion to `packages/identity/`, S2-06 IaC program emission, and S1-04 wasm host runtime enforcement.

Architecture-guard evidence (PACT, protobuf, CUE, parse-don't-validate, event vocabulary) lives in the package `ADR.md` and `architecture/` folder.
