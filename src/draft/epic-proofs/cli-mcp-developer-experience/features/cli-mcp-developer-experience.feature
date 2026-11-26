# Promoted from the README's prose gherkin blocks; every step drives
# services/cli-mcp-reference.ts (the epic's real mocked simulation).
Feature: CLI, MCP and developer experience
  The CLI and MCP expose one parity-checked control surface: app developers run
  a deterministic local-to-Camp loop, agents get SVID-scoped MCP tools, and
  operators keep auditable, fail-closed journeys — all against mocked
  identity, policy, runtime, gateway, and projection providers.

  Scenario: Build, inspect, and deploy a Snapshop app without cloud-specific code
    Given a generated HoBo project with the parity-checked CLI command surface
    When the app developer runs the deterministic local-to-Camp loop
    Then the mocked Camp deploy reaches deployed state with no cloud-specific code matches

  Scenario: Run MCP plan and deploy through an SVID-bound session
    Given the MCP server advertises CLI-parity tools over an SVID-bound session
    When an agent calls MCP plan with valid scope and MCP deploy without the required scope
    Then MCP plan succeeds while the unscoped deploy fails closed with a scope denial
    And static credential keys are rejected by the credential broker

  Scenario: Exercise policy denial, drift remediation, and canary rollout operator paths
    Given deterministic mocked identity, policy, runtime, gateway, and projection providers
    When GitOps, SecOps, SRE, and DevOps operators run their documented HoBo paths
    Then the operator simulation preserves read-only previews, denied policy decisions, drift replay evidence, and rollback state
