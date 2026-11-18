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
}
