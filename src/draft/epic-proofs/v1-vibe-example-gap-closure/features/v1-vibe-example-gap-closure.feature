Feature: V1 vibe example backlog closure
  HOBO-539 coordinates the corrected DX-first vibe example backlog: HOBO-566
  owns the API/SDK/CLI/MCP backbone slices, HOBO-540 through HOBO-565 carry
  branch-sized artifact children, and production scope creep is rejected at
  the boundary.

  Scenario: The DX-first backbone graph is enforced
    Given the corrected HOBO-539 vibe backlog prioritizing API, SDK, CLI, and MCP examples
    When the vibe DX backbone graph is evaluated
    Then HOBO-566 owns HOBO-567 through HOBO-577 with M1 foundations before M2 transcript work

  Scenario: Every vibe child targets an isolated exp proof
    Given the HOBO-539 vibe child issue matrix
    When the vibe child matrix is evaluated
    Then all 26 vibe children pass with isolated exp-proof packages and proof notes
    And the vibe quickstart consumers match the child matrix

  Scenario: Production scope creep is rejected
    Given vibe change requests that reach for production behavior
    When the vibe scope guard evaluates the requests
    Then every production-reaching vibe request is rejected as outside HOBO-539
