// CUE constraints for every protobuf type in data_store_catalog.proto. The
// dependent rules are the evidence discipline itself: only an `unknown` claim
// may be unsourced, and then it must say what could not be confirmed.

package core

#DataStoreOfferingId: "sql.relational" | "sql.transactions" | "kv.point" |
	"blob.object" | "journal.event-stream" | "cdc.stream" | "replica.read" |
	"backup.pitr" | "migrate.dual-write" | "observe.lag" |
	"replica.multi-region" | "write.multi-writer" | "ha.failover" |
	"replicate.logical-publish" | "replicate.logical-subscribe" |
	"pool.transaction" | "auth.password" | "auth.identity-token" |
	"tls.public-ca"

#DataStoreProviderId: "sqlite-local" | "cloudflare-d1" | "supabase-postgres" |
	"aws-rds" | "gcp-cloudsql" | "azure-sql" | "neon-postgres" |
	"prisma-postgres" | "pgedge-cloud" | "planetscale-postgres" |
	"azure-postgres-flexible" | "azure-horizondb" | "aws-rds-postgres" |
	"aws-aurora-postgres" | "gcp-cloudsql-postgres" | "gcp-alloydb" |
	"self-hosted-postgres" | "other"

#DataStoreClaimSourceRecord: {
	url:        string & =~"^https://"
	checked_at: string & =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}$"
	note:       string & !=""
}

#DataStoreCatalogClaimRecord: {
	offering:    #DataStoreOfferingId
	realization: "native" | "fallback" | "operator" | "unsupported" | "unknown"
	stability:   "stable" | "preview" | "experimental"
	fidelity:    "real" | "simulated" | "mocked" | "camp-only"
	features: [...string & !=""]
	detail?: string
	sources: [...#DataStoreClaimSourceRecord]
	if realization == "unknown" {
		detail: string & !=""
	}
	if realization != "unknown" {
		sources: [#DataStoreClaimSourceRecord, ...#DataStoreClaimSourceRecord]
	}
}

#DataStoreCatalogEntryRecord: {
	provider:   #DataStoreProviderId
	vendor:     string & !=""
	product:    string & !=""
	management: "managed" | "self-hosted"
	stability:  "stable" | "preview" | "experimental"
	stability_basis: "vendor-stated" | "inferred"
	stability_sources: [#DataStoreClaimSourceRecord, ...#DataStoreClaimSourceRecord]
	yard_product_id?: string & !=""
	claims: [...#DataStoreCatalogClaimRecord]
}
