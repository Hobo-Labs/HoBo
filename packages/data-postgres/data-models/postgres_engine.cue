package data_models

// Invariants for the PostgreSQL engine binding (src/engine).
//
// These constrain what the TypeScript parsers enforce at runtime —
// `parseNamespace`, `parseTableName`, `parseLsn`, `captureObjectNames` — so a
// record the binding would refuse is refused here too.

// A portable lowercase identifier: what a dataset, a field, a namespace and a
// schema-port table all are.
#PostgresIdentifier: string & =~"^[a-z][a-z0-9_]{0,62}$"

// A write-ahead-log location, as the server prints it.
#PostgresLogPosition: string & =~"^[0-9A-Fa-f]{1,8}/[0-9A-Fa-f]{1,8}$"

#PostgresMetadataTable: "hobo_data_datasets" | "hobo_data_fences" | "hobo_data_watermarks" |
	"hobo_data_subscriptions" | "hobo_data_schema_snapshots"

#PostgresEngineOptions: {
	// A namespace is never a system schema.
	namespace?: #PostgresIdentifier & !~"^pg_"
	capture?:   bool
	// The binding's own metadata tables are not the schema port's to snapshot.
	schemaTables?: [...(#PostgresIdentifier & !~"^hobo_data_(datasets|fences|watermarks|subscriptions|schema_snapshots)$")]
	pageSize?:  int & >=1 & <=100000
	nativePollIntervalMs?: int & >=0 & <=60000

	// An ephemeral binding drops its namespace on close, so it needs one of
	// its own: never the default, and never an unnamed (defaulted) one.
	// Written as two alternatives rather than a guard on the field: a guard
	// that reads an optional field fails for a record that omits it.
	*{ephemeral?: false} | {ephemeral!: true, namespace!: !="public"}
}

#PostgresImpedanceCode: "POSTGRES_RESERVED_COLUMN_NAMES" |
	"POSTGRES_TEXT_REFUSES_NUL_AND_LONE_SURROGATES" |
	"POSTGRES_JSONB_NUMBERS_READ_AS_FLOAT64" |
	"POSTGRES_NATIVE_VALUES_BEYOND_CANONICAL_RANGE" |
	"POSTGRES_SNAPSHOT_IS_FUZZY" |
	"POSTGRES_FENCE_TRIGGER_OWNER_CAN_DISABLE" |
	"POSTGRES_TRUNCATE_REFUSED_ON_DATASETS" |
	"POSTGRES_CAPTURE_NEEDS_LOGICAL_DECODING" |
	"POSTGRES_CAPTURE_SLOT_PINS_LOG" |
	"POSTGRES_CAPTURE_WHOLE_TRANSACTIONS" |
	"POSTGRES_CAPTURE_UNCHANGED_TOAST_REREAD" |
	"POSTGRES_CAPTURE_SLOT_NOT_FAILOVER_SAFE" |
	"POSTGRES_SCHEMA_SNAPSHOT_IS_A_COPY" |
	"POSTGRES_SCHEMA_SNAPSHOT_REFUSES_DEPENDENT_OBJECTS" |
	"POSTGRES_SCHEMA_RESTORE_RECREATES_TABLE" |
	"POSTGRES_RETIRE_IS_LOGGED_AS_DELETES" |
	"POSTGRES_NATIVE_COPY_WHOLE_DATASET_SAME_NAME" |
	"POSTGRES_NATIVE_COPY_NO_REVERSE_TAIL" |
	"POSTGRES_NATIVE_COPY_TARGET_HOLDS_SOURCE_CONNECTION" |
	"POSTGRES_NATIVE_COPY_NEEDS_REPLICATION_CAPACITY" |
	"POSTGRES_NATIVE_COPY_REFUSED_WHERE_CONNECTION_WOULD_BE_LOGGED"

// ── the executor boundary ───────────────────────────────────────────────────

// An absent `text` is SQL NULL. Text never contains U+0000: the server
// cannot hold it, and the binding refuses it before it is sent.
//
// A credential — the connection string a native transfer hands the target
// server — is recorded as the flag alone, never with its text.
#PostgresExecutorParameter: *{text?: string & !~"\u0000"} | {secret!: true}

#PostgresExecutorRequest: {
	sql:           string & !=""
	parameters:    [...#PostgresExecutorParameter]
	inTransaction: bool
}

#PostgresExecutorCell: {
	column: string & !=""
	text?:  string
}

#PostgresExecutorRow: {
	cells: [...#PostgresExecutorCell]
}

#PostgresExecutorResponse: {
	rows:     [...#PostgresExecutorRow]
	rowCount: int & >=0
}

// Five characters, digits and capitals: a SQLSTATE and nothing else.
#PostgresExecutorFailure: {
	sqlState: string & =~"^[0-9A-Z]{5}$"
}

// ── capture ─────────────────────────────────────────────────────────────────

// A replication slot name allows lowercase letters, digits and underscore,
// at most 63 bytes. Derived names always carry the binding's prefix.
#PostgresCaptureObjects: {
	slot:        string & =~"^hobo_s_[0-9a-f]{12}_[0-9a-f]{24}$"
	publication: string & =~"^hobo_p_[0-9a-f]{12}_[0-9a-f]{24}$"
}

// A native transfer's source half is recorded here too, under a key that
// starts with "native:": it is the same two objects, read by a PostgreSQL
// subscription instead of by the capture port.
#PostgresSubscription: {
	subscription:  string
	dataset:       #PostgresIdentifier
	tenant:        string
	objects:       #PostgresCaptureObjects
	startPosition: #PostgresLogPosition
}

// ── native transfer (logical-copy) ──────────────────────────────────────────

// The ticket is journaled, and its names are placed in statement text, so
// every name is exactly a name the binding derives.
#PostgresNativeTicket: {
	profile:     "migration.postgres.logical-copy/v1"
	publication: string & =~"^hobo_p_[0-9a-f]{12}_[0-9a-f]{24}$"
	slot:        string & =~"^hobo_s_[0-9a-f]{12}_[0-9a-f]{24}$"
	namespace:   #PostgresIdentifier & !~"^pg_"
	dataset:     #PostgresIdentifier
	// One tenant of a pooled table is refused, not approximated.
	tenant: ""
	origin: string & =~"^[0-9a-f]{32}$"
}

// The server-side subscription behind a native transfer, on the target.
#PostgresNativeSubscriptionName: string & =~"^hobo_n_[0-9a-f]{12}_[0-9a-f]{24}$"

// ── metadata rows ───────────────────────────────────────────────────────────

#PostgresDatasetRegistration: {
	// A dataset may not take the name of one of the binding's own tables.
	dataset:      #PostgresIdentifier & !~"^hobo_data_(datasets|fences|watermarks|subscriptions|schema_snapshots)$"
	schemaJson:   string & !=""
	schemaDigest: string & =~"^sha256:[0-9a-f]{64}$"
	fenceEpoch:   int & >=0
}

#PostgresFence: {
	dataset: #PostgresIdentifier
	tenant:  string
	// Never empty: an empty session setting means "no token presented".
	token:  string & !=""
	reason: string
}

#PostgresWatermark: {
	dataset:     #PostgresIdentifier
	source:      string & !=""
	logPosition: string & !=""
}

#PostgresSnapshotTable: {
	name:    #PostgresIdentifier
	present: bool
}

#PostgresSchemaSnapshot: {
	snapshotRef: string & =~"^hobo_snap_[0-9a-f]{12}_[0-9a-f]{16}$"
	takenAt:     string & !=""
	// A snapshot that covers nothing could restore nothing; the port refuses
	// to take one.
	tables: [#PostgresSnapshotTable, ...#PostgresSnapshotTable]
}
