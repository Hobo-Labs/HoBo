---
name: verify-yard-request-wire
description: Verify the complete, versioned Yard placement request codec and its request-digest checks when changing the broker wire contract.
---

# Yard request wire binding

**Property:** A decoded placement request is accepted only after its supported version, required inputs, amount, selection, identity, canonical representation and embedded digest agree; unknown fields retained by protobuf in ordinary messages are refused. The CUE contract and domain parser both refuse a missing exact Yard or Camp ID, a blank supplied ID, and a blank Camp environment type or requirement entry. A loss or alteration of resource, Camp or Yard requirements could otherwise make the request being authorized differ from the work the sender described.

**Review baseline:** commit `92c291c26b58af86b169c0fb51aa6211f7c0f775`. PASS for the models and executable checks below. Broker authorization for exact Camp selection is checked separately by `verify-yard-camp-binding`.

## Covered code

- `packages/broker/data-models/yard_placement.proto` defines versions 1 and 2 request snapshots, presence for the estimate and Yard ID, Bindle requirements, resources, Camp layout and the remaining Yard constraints. Version 2 carries labels as entries and properties as JSON object text to preserve special keys. `yard_placement.cue` requires the version marker and syntactic request fields; its Yard and Camp ID constraints use the ECMAScript trim whitespace set and require IDs for exact selection. It does not check the JSON text or digest against the request.
- `packages/broker/src/yard-placement/wire.ts` encodes version 2, decodes both complete versions, verifies that the encoded form can be decoded, and rejects unsupported, incomplete, unknown, ambiguous, invalid or internally inconsistent inputs. `parseBindleDeploymentRequest` independently rejects a negative estimate and malformed domain constraints. The protobuf JSON key `requestedShape` is retained for compatibility. Generated protobuf output is maintained by the schema generator.
- `packages/broker/test/yard-request-wire.test.ts` checks a full binary and CUE round trip, local placement and quoted-work digest, 100 generated combinations (seed 614578), malformed and missing fields, changed content, unknown ordinary-message fields, a recomputed digest with a negative amount, invalid residency, missing exact Yard or Camp ID or noncanonical fields, and the distinction between zero and missing. Camp and Yard parser/CUE agreement are checked on every ECMAScript trim whitespace character and 120 generated inputs each (seeds 614587, 614588, 614591 and 614592). It also demonstrates that changing a tenant and recomputing the embedded digest succeeds: separately authenticated authorization is still required.

## Run

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-yard-request-wire
```

The shared runner checks the pinned TLC 1.7.4 jar. Set `TLA2TOOLS` to an installed copy or let the runner obtain it. Java 11+, Node, Vitest, fast-check and workspace dependencies are required. The CUE checks need CUE 0.14.0 at the repository's `.tools/cue/v0.14.0/cue` path or in `HOBO_CUE_BIN`. Use `/statechart` on the model and view to inspect transitions and counterexamples.

## Scope and evidence

`YardRequestWire` explores 163 states for 20 request classes, including complete versions 1 and 2, unreadable bytes, unknown fields, unsupported and incomplete envelopes, invalid amount, mode, identity or residency, mixed or duplicate labels, invalid property text, a malformed or mismatched digest, noncanonical content, and a changed request with a recomputed matching digest. It checks that only suitable internally consistent inputs pass, and that valid or recomputed-digest inputs are not rejected merely for being those cases. The six-state projection has eight arrows and hides 96 same-label steps. `CampWirePresence` explores 108 states for three selection modes, absent/blank/nonblank IDs, valid/blank/slashed environment inputs and the two validation boundaries. Its four-state projection has four arrows and hides 54 same-label steps. `YardWirePresence` explores 36 states for those selection modes, Yard ID states and validation boundaries; its four-state projection hides 18 same-label steps. Four weakened Yard-boundary checks, four weakened Camp-boundary checks and ten earlier weakened model cases produce counterexamples; the amount case removes both the decoder and parser checks, and either check alone rejects a negative amount. Eighteen real-source mutants can be run with `python3 .agents/skills/verify-yard-request-wire/mutations/runtime.py`; each must pass its control first and then fail an actual assertion.

The finite models abstract parsing, Unicode classification and hashing as predicates, check one request at a time, and do not prove that TypeScript or CUE refines the models or that SHA-256 is collision-free. String tests sample generated inputs; they do not prove all Unicode strings or all other CUE constraints match the domain parser. CUE 0.14 rejects literal U+FEFF inside JSON strings, so the parity tests use its equivalent JSON escape. The checks do not prove authorization, transport authenticity, receipt transport, provider effects, or execution by a receiver. The version is a completeness assertion by the producer; a malicious producer can forge it and recompute the digest. The codec is public but is not wired to a deployed remote receiver. Unknown-field checking covers unknown fields retained in ordinary protobuf messages; special `google.protobuf.Struct` handling and protobuf map-entry internals are outside that check. Version 1 special-key maps that cannot be preserved are rejected by the digest check; version 2-only producers require upgraded receivers. Older messages lack the marker and must be reconstructed from their original inputs, with quotes and reservations reconciled where needed.

For the mandatory broken-code check, copy `packages/broker` to a scratch directory, link its `node_modules`, remove its copied `tsconfig.json`, set `BROKER_WIRE_VERIFY_PACKAGE_ROOT`, and replace the two-part `message.workBindingVersion !== 1 && message.workBindingVersion !== WORK_BINDING_VERSION` condition with `false`. Run this skill: the real-code test must fail on an assertion, not on loading. Also remove the exact-Camp and exact-Yard conditionals in separate scratch copies of `yard_placement.cue`, and remove the exact-Yard parser check in another copy; each must fail the corresponding real-code assertion. Restore the source and rerun the unmodified skill.

## Keep in sync

Review every change to covered code since the baseline. Update the model and tests from the code, preserve the property unless there is evidence of an intended policy change, replay counterexamples on the implementation, exercise a broken scratch implementation and rerun the unmodified skill before advancing the baseline. Use `/maintain-formal-verification-skill`.
