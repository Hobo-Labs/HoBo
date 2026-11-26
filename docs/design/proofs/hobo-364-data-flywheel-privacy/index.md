# HOBO-364 data-flywheel privacy proof

This proof records the HOBO-364 spike recommendation for trajectory capture,
retention, tenant isolation, and optimizer-visible payloads. It is paired with
[ADR-0099](../../adr/03-data-plane.md#adr-0099) and the Plan 23 runtime-capture
notes in [generated-stack.md](../../generated-stack.md#plan-23).

## Recommendation

- Classify trajectory payload fields before persistence as `public`,
  `internal`, `pii`, or `secret`.
- Store PII as tokenized encrypted references, and store secrets as sealed
  encrypted references only.
- Deny external optimizer or judge providers raw access to PII or secrets; allow
  raw PII only through in-boundary, policy-approved decryption.
- Fail closed when trajectory stores or consumers cross tenant boundaries.
- Inherit trace sampling and retention; use the strictest positive retention
  limit across trace, request, tenant, and platform defaults.
- Honor tenant, method, user, and field opt-out before storage.
- Build optimizer payloads from transformed fields so raw PII in prompts cannot
  be re-emitted by a trained method.

## Executable proof

The dependency-free proof package lives at
`src/draft/exp-proofs/dx/data-flywheel-privacy-spike`.

```bash
npm.cmd --prefix src/draft/exp-proofs/dx/data-flywheel-privacy-spike test
```

It covers:

| Requirement | Proof vector |
|---|---|
| Capture boundaries | Mixed public/internal/PII/secret trajectory fields transform before storage. |
| PII redaction | PII becomes token and encrypted references; raw value is absent from serialized output. |
| Secret handling | Secrets become sealed encrypted references and are omitted from optimizer payloads. |
| Cross-tenant isolation | Store or optimizer tenant mismatch denies capture and emits a denial reason. |
| Retention and sampling | Trace sampling suppresses capture; effective retention chooses the strictest limit. |
| Opt-out | Method opt-out suppresses trajectory capture; field opt-out omits the field before storage. |
| PII re-emission defense | Optimizer payloads contain redacted fields and instructions, not raw prompt PII. |
