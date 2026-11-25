# Generation Safety Gate Contract POC

Independent POC for HOBO-355. It proves the post-conformance safety gate that
runs after `gen.Validated` and before promotion/certification. Conformance can
prove the WIT port contract while a candidate still phones home, reads outside
its scoped capabilities, hides a trigger, or asks for broader capabilities than
its declared `.allow()` grants. This gate rejects those candidates and emits
`gen.SafetyRejected`.

## Contract

- `runGenerationSafetyGate()` requires a green
  `hobo.gen.validation-report/v1` for the same candidate digest before it runs.
- Requested capabilities must be covered by the candidate's declared
  `.allow()` grants, including verbs and scope.
- Static checks flag direct network sinks, secret-like environment reads,
  filesystem reads outside scoped paths, time bombs, and literal input-trigger
  branches.
- Dependency checks flag package names that are near approved dependencies but
  not exact matches.
- Sandbox `sandbox.EscapeAttemptBlocked` evidence is authoritative: denied
  network, filesystem, or capability escape attempts reject even if static
  checks miss the behavior. Escape evidence must match the validated no-egress
  sandbox profile digest.
- Safety reports are digest-addressed as `hobo.gen.safety-report/v1`.
  Rejected reports emit a `gen.SafetyRejected` generation event carrying the
  safety report ref and failing assertion ids.

## Acceptance Mapping

| Acceptance / adversarial case | Executable proof |
|---|---|
| Clean conformance-green candidate passes. | `clean conformance-green candidate passes the post-conformance safety gate` asserts no findings and no rejection event. |
| Network egress rejects before certification. | `network egress attempt rejects before certification and emits gen.SafetyRejected` asserts static and sandbox findings plus a valid event. |
| Read outside scoped capabilities rejects. | `filesystem read outside scoped paths rejects a contract-green candidate` flags `/etc/passwd` outside allowed read paths. |
| Trigger-gated payload rejects. | `input-triggered backdoor is rejected even when normal conformance paths pass` flags the literal input trigger and secret read. |
| Time bomb rejects. | `time-bomb payload is rejected even when conformance stays green` flags wall-clock gated behavior. |
| Typosquatted dependency rejects. | `typosquatted dependency is rejected as a generated-code safety finding` flags `@hobo/provder-sdk`. |
| Over-broad capability request rejects. | `over-broad capability request is rejected against declared allow grants` compares requested capabilities to `.allow()`. |
| Sandbox no-egress remains the floor even when static misses. | `sandbox no-egress evidence is the floor even when static scan misses` rejects late-bound `fetch` through sandbox evidence only. |

## Scope Boundaries

This POC does not choose or wrap a general SAST vendor, implement a sandbox
runner, execute candidate code, publish to the Registry, or change the
certification stage. It only pins the safety-gate contract and event shape that
the production runner and certification path must honor.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\generation-safety-gate-contract test
npm.cmd --prefix src\draft\technical-proofs\generation-pipeline-io-contract test
npm.cmd test
npm.cmd run docs:cli-lint
npm.cmd run docs:design-lint
node scripts\validate-traceability.ts
git diff origin/main...HEAD --check
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Generation Safety Gate Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
