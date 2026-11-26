# Mock Terraform provider schema for forge ingestion fixture.
# Maps mock:postgres-flexible to hobo:database/postgres@0.1.0 equivalence class.

terraform {
  required_providers {
    mockpostgres = {
      source  = "registry.example/mock-postgres"
      version = "0.1.0"
    }
  }
}

resource "mockpostgres_database" "example" {
  name     = "orders"
  sku      = "flexible"
  # Provider hints only — authoritative contract is the WIT port + manifest.
}
