---
type: Reference
title: "Role Journey CLI and MCP Transcripts Proof"
description: "Source issue: HOBO-557."
tags: [hobo, design]
---

# Role Journey CLI and MCP Transcripts Proof

`HOBO-557` creates CLI transcript and MCP tool pseudocode examples for six
role journeys: app developer, platform engineer, GitOps, SecOps, DevOps, and
SRE. The executable proof lives in
`src/draft/exp-proofs/ax/role-journey-cli-mcp-transcripts`.

## Acceptance Evidence

| Acceptance requirement | Branch evidence |
| --- | --- |
| Each role journey starts from accepted resource-lifecycle quickstart examples and links back to the same fixture ids. | `parseRoleJourneyCliMcpTranscripts` checks every role and step against `HOBO-577` fixture ids from `RESOURCE_LIFECYCLE_QUICKSTART_EXAMPLES`. |
| Each journey includes command/tool sequence, expected terminal output, JSON/MCP result shape, proof-mode label, support handoff, accessibility notes, and blocked/stale/unknown path. | `role-journey-cli-mcp-transcripts.test.ts` asserts terminal output, JSON schema, MCP result, proof mode, support wording, accessibility wording, and negative paths for every step. |
| Journeys cover deploy, manage, migrate, rollback, policy/contract denial, and support handoff from the CLI first. | `REQUIRED_ROLE_JOURNEY_COVERAGE` is aggregated across all six journeys and every step command must start with `hobo `. |
| Examples avoid enterprise dashboard walkthroughs unless secondary to terminal/API/SDK shape. | `classifyRoleJourneyScope` rejects dashboard-first, production CLI, live provider/credential, and customer-data requests. |

The Pact response body serializes the complete parsed proof record for all six
journeys, while CUE constrains the same lower-camel JSON surface used by the
TypeScript parser and Pact fixture.

Reviewer maintenance note: final merge validation also refreshes workspace
lockfile importer rows for already-merged proof packages, including adjacent
vibe proof packages that land while this branch is being reviewed, so
`pnpm.cmd run install:check` leaves the branch clean.

## Design References

- [`developer-experience.md#plan-07`](../../developer-experience.md#plan-07)
- [`cli-spec.md`](../../cli-spec.md)
- [`walkthrough.md`](../../walkthrough.md)
- [`dx-resource-lifecycle-scenario-matrix`](../dx-resource-lifecycle-scenario-matrix/README.md)
- [`cli-mcp-parity-resource-lifecycle-contracts`](../cli-mcp-parity-resource-lifecycle-contracts/README.md)
- [`resource-lifecycle-quickstart-examples`](../resource-lifecycle-quickstart-examples/README.md)

## Verification

```powershell
pnpm.cmd --prefix src\draft\exp-proofs\role-journey-cli-mcp-transcripts test
```

Architecture and boundary artifacts:

- Protobuf: `src/draft/exp-proofs/ax/role-journey-cli-mcp-transcripts/architecture/role_journey_cli_mcp_transcripts.proto`
- CUE: `src/draft/exp-proofs/ax/role-journey-cli-mcp-transcripts/architecture/role_journey_cli_mcp_transcripts.cue`
- Pact-style fixture: `src/draft/exp-proofs/ax/role-journey-cli-mcp-transcripts/architecture/pacts/role_journey_cli_mcp_transcripts.pact.json`
