# Customer Assurance Evidence Packet Contract

Executable M0 proof for HOBO-493, defining the customer assurance evidence packet outline before
customer-facing assurance claims or follow-up implementation work can fan out.

## Focused Gate

```powershell
pnpm --filter @hobo/customer-assurance-evidence-packet-contract test
pnpm exec oxlint src/draft/exp-proofs/cx/customer-assurance-evidence-packet-contract --deny-warnings
```

## Proof Surface

- `CUSTOMER_ASSURANCE_EVIDENCE_PACKET` records the packet goal, sections, legal artifact
  dispositions, readiness states, dependencies, M1 evidence, and follow-up gate.
- `validateCustomerAssuranceEvidencePacket` fails closed when M0 scope drifts into final legal
  approval, subprocessor approval, or public claims without evidence.
- `canCreateCustomerAssuranceFollowUp` blocks M1-M4 follow-up work until M0 packet evidence is
  accepted.
- `classifyCustomerAssuranceWork` routes adjacent legal/privacy, security, backup/restore, support,
  or compliance work to the owning initiative.

## Architecture Guardrail Evidence

- PACT: `architecture/pacts/customer_assurance_evidence_packet_contract.pact.json` fixes the
  customer-assurance packet boundary between the Compliance Evidence Pack consumer and provider.
- Protobuf + CUE: `architecture/customer_assurance_evidence_packet_contract.proto` and
  `architecture/customer_assurance_evidence_packet_contract.cue` define the packet shapes and
  constraints.
- Parse, don't validate: downstream M1 code must parse these records into derived domain types for
  section id, readiness state, legal artifact disposition, owner route, and claim boundary before
  any workflow consumes them.
- Event architecture: the command `CustomerAssurancePacketCommand` is submitted by the compliance
  owner actor, accepted as `CustomerAssurancePacketAccepted` or denied as
  `CustomerAssurancePacketDenied` events, appended to the compliance event store, projected into
  customer-assurance and support materialized views, captured as launch snapshots, and exposed
  through read stores for legal, security, support, and customer-success review.

## Acceptance Mapping

| Issue acceptance | Proof |
|---|---|
| Packet covers DPA needs, subprocessors/providers, data flows, controls, security evidence, backup/DR, support obligations, and known gaps. | Tests assert the required packet section ids. |
| Each section has owner, source evidence, beta readiness, and GA readiness. | Tests assert all readiness fields exist for every section. |
| Unavailable legal artifacts are blockers or explicit launch limitations. | Tests assert unavailable legal artifacts cannot be marked ready. |
| Scope out legal approval unless legal owner supplies text. | Tests reject final DPA approval, subprocessor approval, and proofless public claims. |

## Scope Guards

This proof deliberately does not draft or approve final legal terms, approve subprocessors, publish
compliance claims, implement a customer assurance portal, create a support workflow, or mutate live
customer data.
