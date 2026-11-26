# CLI Deploy Transcript Prototype

Independent experience proof for HOBO-573. It defines a terminal-first deploy transcript and a
matching MCP tool-result shape over deterministic resource lifecycle fixtures. The proof is an
artifact slice, not production CLI/API/SDK implementation.

## Audience

- App developer validating the smallest meaningful deploy path.
- Platform engineer reading Gatekeeper decisions before provider work starts.
- Agent/MCP caller needing machine-readable parity with human CLI output.
- Support operator needing customer-safe, redacted evidence wording.

## Contract Surface

- `CLI_DEPLOY_TRANSCRIPT_PROTOTYPE` is versioned as
  `hobo.cli-deploy-transcript-prototype/v1`.
- The transcript covers one successful preview deploy and three blocked deploys: policy denied,
  contract incompatible, and stale or unknown evidence.
- Every scenario carries DeploymentPlan, Deployment Set, Delta, Gatekeeper decision and
  explanation, ResourceActor event, projection, log fixture references, and value proof.
- `renderCliTranscript` creates the human terminal transcript.
- `renderMcpToolResult` creates the semantically equivalent MCP `hobo.up` result.
- `evaluateCliDeployTranscriptPrototype` fails closed on missing blocked paths, missing fixtures,
  missing MCP parity, live proof-mode creep, or missing support/accessibility notes.

## BDD Slices

```gherkin
Feature: CLI deploy transcript prototype

  Scenario: preview deploy succeeds from reference fixtures
    Given a DeploymentPlan, Delta, Gatekeeper allow decision, ResourceActor event, projection, and log fixture
    When the user runs collect, plan, up, inspect, and logs commands
    Then the transcript records the Deployment Set, Gatekeeper approval explanation, value proof,
      and the MCP tool result carries the same ids

  Scenario: deploy is blocked by policy
    Given a Gatekeeper deny decision from reference fixtures
    When the user runs hobo up
    Then the transcript says "blocked: policy denied" with refusal wording and no provider apply

  Scenario: deploy is blocked by contract incompatibility
    Given an incompatible producer/consumer contract fixture
    When the user runs hobo up
    Then the transcript says "blocked: contract incompatible" and shows Gatekeeper refusal plus
      customer-safe remediation

  Scenario: deploy is held on stale or unknown evidence
    Given a stale projection or unknown evidence fixture
    When the user runs hobo up
    Then the transcript says "blocked: stale or unknown evidence" and requests fixture refresh
      instead of claiming value from stale proof
```

## Scope Boundaries

Included:

- Deterministic transcript cases for `hobo collect`, `hobo plan`, `hobo up`, `hobo inspect`, and
  `hobo logs`.
- Equivalent MCP tool-result records for the same deploy cases.
- Support/customer-safe wording, accessibility notes, and proof-mode labels.
- Protobuf, CUE, and Pact-style boundary evidence for the fixture and transcript contract.

Excluded:

- Production `hobo up`, live provider apply, real account login, real credentials, launch demo
  claims, or visual dashboard substitutes for the terminal flow.
- Importing unmerged blocker PR code. Blocker outputs are represented only as reference fixture ids.

## Verification

```powershell
pnpm.cmd --dir src\draft\exp-proofs\cli-deploy-transcript-prototype test
```

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` - protobuf data shapes and CUE constraints for the transcript prototype.
- `architecture/pacts/` - Pact contract for the mocked fixture boundary.
- `ADR.md` - parse-don't-validate and event-architecture evidence.
