---
name: verify-yard-request-wire
description: Verify the complete, versioned Yard placement request codec and its request-digest checks when changing the broker wire contract.
---

# Yard request wire binding

**Property:** A decoded placement request is accepted only after its supported version, required inputs, amount, selection, identity, canonical representation and embedded digest agree; unknown fields retained by protobuf in ordinary messages are refused. A loss or alteration of resource, Camp or Yard requirements could otherwise make the request being authorized differ from the work the sender described.

**Review baseline:** commit `cf01e385ca64526401ee57f35e04ce8f190ef2e1`. PASS for the model and executable checks below.

## Covered code

- `packages/broker/data-models/yard_placement.proto` defines versions 1 and 2 request snapshots, presence for the estimate and Yard ID, Bindle requirements, resources, Camp layout and the remaining Yard constraints. Version 2 carries labels as entries and properties as JSON object text to preserve special keys. `yard_placement.cue` requires the version marker and syntactic request fields; it does not check the JSON text or digest against the request.
- `packages/broker/src/yard-placement/wire.ts` encodes version 2, decodes both complete versions, verifies that the encoded form can be decoded, and rejects unsupported, incomplete, unknown, ambiguous, invalid or internally inconsistent inputs. `parseBindleDeploymentRequest` independently rejects a negative estimate and malformed domain constraints. The protobuf JSON key `requestedShape` is retained for compatibility. Generated protobuf output is maintained by the schema generator.
- `packages/broker/test/yard-request-wire.test.ts` checks a full binary and CUE round trip, local placement and quoted-work digest, 100 generated combinations (seed 614578), malformed and missing fields, changed content, unknown ordinary-message fields, a recomputed digest with a negative amount, invalid residency or noncanonical fields, and the distinction between zero and missing. It also demonstrates that changing a tenant and recomputing the embedded digest succeeds: separately authenticated authorization is still required.

## Run

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-yard-request-wire
```

The shared runner checks the pinned TLC 1.7.4 jar. Set `TLA2TOOLS` to an installed copy or let the runner obtain it. Java 11+, Node, Vitest, fast-check and workspace dependencies are required. The CUE checks need CUE 0.14.0 at the repository's `.tools/cue/v0.14.0/cue` path or in `HOBO_CUE_BIN`. Use `/statechart` on the model and view to inspect transitions and counterexamples.

## Scope and evidence

`YardRequestWire` explores 163 states for 20 request classes, including complete versions 1 and 2, unreadable bytes, unknown fields, unsupported and incomplete envelopes, invalid amount, mode, identity or residency, mixed or duplicate labels, invalid property text, a malformed or mismatched digest, noncanonical content, and a changed request with a recomputed matching digest. It checks that only suitable internally consistent inputs pass, and that valid or recomputed-digest inputs are not rejected merely for being those cases. The six-state projection has eight arrows and hides 96 same-label steps. Ten weakened model cases produce the expected counterexamples; the amount case removes both the decoder and parser checks, and either check alone rejects a negative amount. Eleven corresponding real-source mutants can be run with `python3 .agents/skills/verify-yard-request-wire/mutations/runtime.py`; each must pass its control first and then fail an actual assertion.

The finite model abstracts parsing and hashing as predicates, checks one request at a time, and does not prove that TypeScript refines the model or that SHA-256 is collision-free. It does not prove authorization, transport authenticity, receipt transport, provider effects, or execution by a receiver. The version is a completeness assertion by the producer; a malicious producer can forge it and recompute the digest. The codec is public but is not wired to a deployed remote receiver. Unknown-field checking covers unknown fields retained in ordinary protobuf messages; special `google.protobuf.Struct` handling and protobuf map-entry internals are outside that check. Version 1 special-key maps that cannot be preserved are rejected by the digest check; version 2-only producers require upgraded receivers. Older messages lack the marker and must be reconstructed from their original inputs, with quotes and reservations reconciled where needed.

For the mandatory broken-code check, copy `packages/broker` to a scratch directory, link its `node_modules`, remove its copied `tsconfig.json`, set `BROKER_WIRE_VERIFY_PACKAGE_ROOT`, and replace the two-part `message.workBindingVersion !== 1 && message.workBindingVersion !== WORK_BINDING_VERSION` condition with `false`. Run this skill: the real-code test must fail on an assertion, not on loading. Restore the source and rerun the unmodified skill.

## Keep in sync

Review every change to covered code since the baseline. Update the model and tests from the code, preserve the property unless there is evidence of an intended policy change, replay counterexamples on the implementation, exercise a broken scratch implementation and rerun the unmodified skill before advancing the baseline. Use `/maintain-formal-verification-skill`.
