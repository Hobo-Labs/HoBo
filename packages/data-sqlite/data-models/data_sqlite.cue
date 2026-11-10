package data_models

// Invariants for the SQLite data engine's own records.

#HexDigest: =~"^[0-9a-f]{64}$"

#SqliteEngineOptions: {
	path: string & !=""
}

#SqliteJournalRow: {
	seq:       int & >=1
	dataset:   =~"^[a-z][a-z0-9_]{0,62}$"
	tenant_id: string
	key:       string & !=""
	op:        "upsert" | "delete"
	record_json?: string
	// An upsert is journaled with its record; a delete with none.
	if op == "upsert" {
		record_json!: string & !=""
	}
	if op == "delete" {
		record_json?: _|_
	}
}

#SqliteFenceRow: {
	dataset:     =~"^[a-z][a-z0-9_]{0,62}$"
	tenant_id:   string
	fence_token: string & !=""
	fenced_at:   string & !=""
}

#SqliteWatermarkRow: {
	dataset:  =~"^[a-z][a-z0-9_]{0,62}$"
	source:   string & !=""
	position: string & !=""
}

#SqliteSubscriptionRow: {
	name:           string & !=""
	dataset:        =~"^[a-z][a-z0-9_]{0,62}$"
	start_position: int & >=0
	ack_position:   int & >=0
	// Progress never moves behind where the subscription started.
	ack_position: >=start_position
}

#SqliteDualSideEvidence: {
	count:  int & >=0
	digest: #HexDigest
}

#DataDualEvidence: {
	source:     #SqliteDualSideEvidence
	target:     #SqliteDualSideEvidence
	consistent: bool
	fidelity:   "live"
	// Consistent exactly when both sides digest the same.
	consistent: source.digest == target.digest
}

#CreateSqliteDataDualPortOptions: {
	sourcePath: string & !=""
	targetPath: string & !=""
	table?:     =~"^[A-Za-z_][A-Za-z0-9_]*$"
	tenant?:    string & !=""
}
