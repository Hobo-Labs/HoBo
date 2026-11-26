package data_models

// Invariants for the provider-neutral PostgreSQL surface.
//
// These constrain the *shape and relationships* the TypeScript parsers enforce
// at runtime, so a product record that would be rejected by
// `postgres.database()` or by `parsePostgresTarget` is also rejected here.

#PostgresIsolationLevel: "read-uncommitted" | "read-committed" | "repeatable-read" | "serializable"

#PostgresConnectivityTransport: "tcp" | "tls-tcp" | "http" | "websocket"

#PostgresMigrationTool: "pg-dump" | "pg-restore" | "psql" | "prisma-migrate" |
	"drizzle-kit" | "knex" | "flyway" | "liquibase" | "atlas" | "sqlalchemy-alembic"

#PostgresCredentialRotationMode: "self-service-sql" | "provider-console" | "provider-api" | "none"

#PostgresMigrationProfileId: "migration.postgres.pg-dump/v1" | "migration.postgres.logical-copy/v1"

#PostgresSslMode: "require" | "verify-ca" | "verify-full" | "prefer"

// A parsed connection target. Every field is a value that has already been
// refused if it carried a shell metacharacter, whitespace, or traversal.
#PostgresTarget: {
	host:     string & =~"^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$"
	port:     int & >=1 & <=65535
	database: string & =~"^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,127}$"
	username: string & =~"^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,127}$"
	sslMode:  #PostgresSslMode
}

// What a Postgres product advertises. Every field is optional because an
// unset capability must fail a required gate rather than default to true.
#PostgresStructuredCapabilities: {
	// Guarantees. A conformant product asserts all of these.
	postgresWireProtocol?: bool
	tls?:                  bool
	transactions?:         bool
	constraints?:          bool
	connectionUriBinding?: bool
	ddl?:                  bool
	transactionRollback?:  bool

	// Features. Ranked and gated, frequently absent.
	serverVersion?:              string
	serverVersionMajor?:         int & >=1 & <=999
	isolationLevels?: [...#PostgresIsolationLevel]
	preparedStatements?:         bool
	jsonDocuments?:              bool
	jsonb?:                      bool
	migrationToolCompatibility?: [...#PostgresMigrationTool]
	maxConnections?:             int & >=1
	pooling?:                    bool
	connectivityTransports?: [...#PostgresConnectivityTransport]
	extensions?: [...(string & =~"^[a-z_][a-z0-9_-]{0,62}$")]
	credentialRotation?:  #PostgresCredentialRotationMode
	logicalReplication?:  bool
	exportSupported?:     bool
	importSupported?:     bool
	maxStorageBytes?:     int & >=1

	// Cross-field invariants the prose version of this vocabulary implies.
	//
	// jsonb is a refinement of json: a product cannot have the binary type
	// without the textual one.
	if jsonb != _|_ && jsonb {
		jsonDocuments: true
	}
	// Rollback is meaningless without transactions.
	if transactionRollback != _|_ && transactionRollback {
		transactions: true
	}
	// A product that says it cannot export cannot also claim pg_dump works.
	if exportSupported != _|_ && !exportSupported {
		migrationToolCompatibility?: [...(#PostgresMigrationTool & !="pg-dump")]
	}
}

#PostgresConformanceOutcome: "pass" | "fail" | "unknown"

#PostgresConformanceResultStatus: "pass" | "fail" | "not-run" | "blocked"

#PostgresConformanceResult: {
	caseId:        string & =~"^postgres\\.[a-z-]+\\.[a-z-]+$"
	capabilityKey: string & !=""
	status:        #PostgresConformanceResultStatus
	detail:        string
}

#PostgresConformanceReport: {
	suiteRef: "conformance.data.postgres/v1"
	outcome:  #PostgresConformanceOutcome
	results: [...#PostgresConformanceResult]
	ranAtMs: int & >=0

	// Fail closed. Any failure is a failing report; anything unproven leaves
	// the report unknown. `pass` is only reachable when every applicable case
	// actually ran and passed.
	if [for r in results if r.status == "fail" || r.status == "blocked" {r}] != [] {
		outcome: "fail"
	}
}
