# Examples console — operator stamps a real Cloudflare temporary Environment Station.
# Executable acceptance: `pnpm --filter hobo-site run examples:regression`
# (Playwright drives /HoBo/examples/ — mocked station-broker; navigates to workers.dev.)
Feature: Examples console Cloudflare temporary Environment Station
  As a visitor of the public HoBo Examples console
  I want Deploy stations to provision a real Cloudflare temporary Environment Station
  So that I get a navigable workers.dev URL and claim URL without local Docker or blob stubs

  Scenario: Yard surfaces stay station-only and Cloudflare stamps via temporary accounts
    Given yard deploy surfaces forbid waspApp cli and Bindle app packaging
    And the examples console is open on the static site
    When the operator selects the Cloudflare yard
    Then Stage Source shows the Cloudflare stationBootstrap surface
    When the operator deploys stations for Cloudflare
    Then an anonymous Cloudflare Environment Station is ready on workers.dev
    And Playwright can navigate to the station URL and read health
    And Ship is unlocked without requiring examples:bridge
