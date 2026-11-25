# HOBO-346 Generation Certify Stage Proof

This executable proof pins the certify step from
[Plan 23](../../generated-stack.md#plan-23),
[Plan 9](../../generated-stack.md#plan-09), and
[Plan 6](../../ai-native-agent-auth.md#plan-06): a generated plugin is trusted
only after green validation/conformance, policy certification, signed
provenance, and Registry verification.

## Acceptance Mapping

| Acceptance | Executable proof |
|---|---|
| Green run produces a signed, provenance-complete Registry record verifiable by the HOBO-312 predicate. | `green run publishes a signed provenance-complete Registry record` asserts pinned model, prompt, seed, validation ref, conformance ref, record signature verification, and `gen.Certified` / `gen.PluginCertified` events. |
| Unsigned or provenance-incomplete artifact is refused by Registry. | `Registry refuses unsigned and provenance-incomplete artifacts` asserts no certified catalog mutation. |
| Artifact claiming a port it did not pass cannot be certified. | `artifact claiming a port it did not pass cannot be certified` rejects the unvalidated Redis claim. |
| Re-signed artifact with a swapped report is detected by content-addressed provenance. | `re-signed record with swapped conformance report is detected` re-signs the Registry record after replacing the report and the Registry still refuses it. |
| Certification honors the promotion policy gate. | `certification waits for policy approval instead of silently publishing` blocks `require-approval` gate decisions. |

## Boundary

The proof lives in
[`src/draft/technical-proofs/generation-certify-stage-contract`](../../../../src/draft/technical-proofs/generation-certify-stage-contract/README.md).
It reuses the signed provenance predicate shape from HOBO-312 and consumes the
policy-gate result shape from HOBO-333, but remains an independent draft POC.

It intentionally does not implement Registry storage/crawl/discovery,
production signing-key infrastructure, live conformance execution, approval UI,
or provider runtime behavior.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\generation-certify-stage-contract test
npm.cmd test
npm.cmd run docs:cli-lint
npm.cmd run docs:design-lint
node scripts\validate-traceability.ts
git diff origin/main...HEAD --check
```
