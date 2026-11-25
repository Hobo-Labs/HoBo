# Role Journey CLI and MCP Transcripts

Independent experience proof for `HOBO-557`. It defines terminal-first CLI
transcripts and equivalent MCP tool-result shapes for six role journeys:
app developer, platform engineer, GitOps, SecOps, DevOps, and SRE.

This package is an artifact proof. It consumes accepted `HOBO-577` resource
lifecycle quickstart fixture ids and does not implement production CLI, API,
SDK, MCP runtime, live provider calls, customer data access, credentials, or
visual mockups.

## Audience

- App developer validating deploy and proof flow.
- Platform engineer reviewing readiness, stale evidence, and safe next action.
- GitOps release owner promoting and rolling back through `hobo up`.
- SecOps reviewer reading policy and contract refusal evidence.
- DevOps operator previewing import, migration, and restore evidence.
- SRE diagnosing incidents from projections, logs, rollback evidence, and
  support packets.

## Contract Surface

- `ROLE_JOURNEY_CLI_MCP_TRANSCRIPTS` is parsed into a branded
  `RoleJourneyCliMcpTranscripts` record.
- Every role journey starts from an accepted `HOBO-577` quickstart fixture id.
- Every step records a CLI command, terminal output, JSON result shape, MCP
  result shape, proof-mode label, support handoff, and accessibility note.
- The Pact fixture carries the complete parsed lower-camel contract body, and
  CUE constrains the same JSON boundary instead of a protobuf-only snake_case
  projection.
- Aggregate coverage proves deploy, manage, migrate, rollback, policy or
  contract denial, and support handoff.
- `classifyRoleJourneyScope` rejects production CLI, live provider or
  credential, customer-data, and dashboard-first requests.

## BDD Slices

```gherkin
Feature: role journey CLI and MCP transcripts

  Scenario: each role starts from accepted quickstart fixtures
    Given the accepted HOBO-577 resource lifecycle quickstart fixture set
    When a role journey transcript is parsed
    Then every CLI step and MCP result references one of those fixture ids

  Scenario: terminal output and MCP result stay equivalent
    Given a role journey CLI step
    When the transcript and MCP result are rendered
    Then both carry the same fixture id, proof mode, status, and support handoff

  Scenario: scope creep is refused
    Given a request for production CLI, live provider credentials, customer data, or dashboard tours
    When the scope classifier evaluates it
    Then the request is rejected with a specific reason
```

## Architecture Evidence

- Protobuf: `architecture/role_journey_cli_mcp_transcripts.proto`
- CUE constraints: `architecture/role_journey_cli_mcp_transcripts.cue`
- Pact-style fixture: `architecture/pacts/role_journey_cli_mcp_transcripts.pact.json`
- Package ADR: `ADR.md`

## Verification

```powershell
pnpm.cmd --prefix src\draft\exp-proofs\role-journey-cli-mcp-transcripts test
```

Branch-level validation also runs architecture guard, standards, docs freshness,
and the final PR-base agent check.
