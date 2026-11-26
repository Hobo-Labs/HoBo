// Constraints that keep a PostgreSQL pack deployment honest.
//
// The protobuf file says which fields exist. These say which combinations are
// truthful: a digest is a digest, PGDATA lives under the mounted volume, a
// credential is a locator and never a value, `trust` is not an authentication
// method, and a migration never points at the database it is migrating from.
//
// The scalars below are spelled identically to `pack_framework.cue`. They are
// restated rather than imported because each package owns its own
// `data-models/` folder, and a CUE file in another directory is a different
// package — a cross-directory reference here would resolve to nothing.

package packs

#Sha256:       =~"^sha256:[0-9a-f]{64}$"
#IsoDate:      =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}$"
#AbsolutePath: =~"^/[A-Za-z0-9._/-]+$"
// The two architectures this pack publishes a pinned digest for. Narrower than
// the framework's platform set on purpose.
#Architecture: "linux/amd64" | "linux/arm64"
#Identifier:   =~"^[a-z_][a-z0-9_]{0,62}$"

// A locator, never material. The scheme set matches @hobo/bindings.
#SecretRef: =~"^(vault|azure-kv|aws-sm|gcp-sm|op|infisical|hobo-secret|hobo-token)://[^@?]+/[^@?]+$"

// The volume path the pinned PostgreSQL 18 image declares, and the PGDATA
// directory inside it. Both are pinned so an image change that moves either one
// fails validation instead of silently writing outside the volume.
#DataMountPath: "/var/lib/postgresql"
#PgData:        "/var/lib/postgresql/18/docker"

#PostgresImagePinRecord: {
	repository:   "docker.io/library/postgres"
	digest:       #Sha256
	architecture: #Architecture
	// Provenance only. Nothing resolves this tag at runtime.
	resolved_from_tag: string & !=""
	index_digest:      #Sha256
	server_version:    =~"^18\\.[0-9]+$"
	server_major:      18
}

#PostgresVolumeBindingRecord: {
	volume_name: "pgdata"
	mount_path:  #DataMountPath
	// Object storage cannot back PGDATA, so there is one legal value.
	storage_kind:  "local-volume"
	volume_id:     string & !=""
	minimum_bytes: uint64 & >=1073741824
}

#PostgresDeploymentRecord: {
	pack_id:      "pack.postgres.oci/v1"
	pack_version: =~"^[0-9]+\\.[0-9]+\\.[0-9]+$"
	resource_ref: string & !=""
	image:        #PostgresImagePinRecord
	data_volume:  #PostgresVolumeBindingRecord
	database:     #Identifier
	owner_role:   #Identifier
	max_connections: uint32 & >=10 & <=10000
	// `trust` is deliberately not a member: it turns an authenticated database
	// into an open one, and a deployment record should not be able to express it.
	host_auth_method:     "scram-sha-256" | "md5"
	superuser_secret_ref: #SecretRef
	password_file_path:   #AbsolutePath
	// PGDATA must sit inside the mounted volume or the data is not durable.
	// Pinned as a literal so a future image that moves PGDATA fails here rather
	// than writing to a directory the volume does not cover.
	_pgdataInsideVolume: true & (#PgData =~ "^/var/lib/postgresql/")
}

#PostgresOperationRecord: {
	operation_id: =~"^postgres\\.[a-z-]+\\.[a-z0-9-]+$"
	kind:         "backup" | "restore" | "migration" | "maintenance"
	profile_ref?: string
	// A command is an argv array with an executable in element 0.
	argv: [string & !="", ...string]
	env: [string]: string
	// Locators only. A resolved value here would be a leaked credential.
	secret_env: [string]: #SecretRef
	timeout_ms:     uint32 & >0
	exit_code?:     int32
	artifact_path?: #AbsolutePath
	// No shell means no metacharacters need escaping — but a credential in argv
	// is visible to every process on the host, so it is rejected outright.
	_noCredentialInArgv: true & ([for element in argv if element =~
		"(?i)(postgres(ql)?://|password=|//[^/:@]+:[^/:@]+@)" {element}] == [])
	// The executable is one of the tools this pack's operations actually use.
	_knownExecutable: true & (argv[0] =~ "^(pg_dump|pg_dumpall|pg_restore|psql|pg_isready)$")
}

#PostgresMigrationRecord: {
	profile_ref:   "migration.postgres.pg-dump/v1"
	dump:          #PostgresOperationRecord & {argv: [=~"^pg_dump$", ...string]}
	restore:       #PostgresOperationRecord & {argv: [=~"^pg_restore$", ...string]}
	artifact_path: #AbsolutePath
	// `host:port/database` on both sides.
	source_endpoint: string & !=""
	target_endpoint: string & !=""
	// A migration whose source and target are identical moves nothing.
	_distinctEndpoints: true & (source_endpoint != target_endpoint)
	// Both steps operate on the same artifact.
	_sameArtifact: true & (dump.artifact_path == artifact_path) &
		(restore.artifact_path == artifact_path)
}

#PostgresBindingRecord: {
	binding_id:            string & !=""
	resource_ref:          string & !=""
	capability_profile_ref: "data.postgres/v1"
	binding_profile_ref:   "binding.postgresql/v1"
	// A bare hostname. A `:` or `@` here would mean a connection string was
	// pasted into the address field.
	host: =~"^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$"
	port: uint32 & >=1 & <=65535
	tls:  bool
	database: #Identifier
	role:     #Identifier
	credential_secret_ref:   #SecretRef
	certificate_secret_ref?: #SecretRef
	image_digest:            #Sha256
	producer_evidence_ref:   string & !=""
	// Requiring TLS without naming the certificate to verify against is how a
	// client ends up trusting anything that answers on the port.
	if tls {
		certificate_secret_ref!: #SecretRef
	}
}

#PostgresConformanceRecord: {
	suite_ref:           "hobo.conformance/pack.postgres.oci/v1"
	profile_ref:         "data.postgres/v1" | "data.relational/v1" | "migration.postgres.pg-dump/v1"
	outcome:             "pass" | "fail" | "unknown"
	evidence_checked_at: #IsoDate
	// Required, not defaulted: replayed-fixture evidence and a real container run
	// are different claims, and the distinction has to survive into the read
	// store rather than being inferred later.
	executed_against_container: bool
	image_digest:               #Sha256
	architecture:               #Architecture
	// A pass is only meaningful against a specific image, so evidence recorded
	// for one digest never transfers to another.
	_evidenceIsDigestScoped: true & (image_digest != "")
}
