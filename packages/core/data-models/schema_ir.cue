// CUE constraints for every protobuf type in schema_ir.proto. These are
// load-bearing for ADR-0160: identifiers stay inside the unquoted-SQL grammar
// bounded by postgres' NAMEDATALEN so an emitter never has to guess quoting,
// type tokens carry no statement separator, the step vocabulary is closed and
// forward-only (no down/inverse kind exists to name), destructive work is
// confined to the contract phase, and a plan digest is a sha256 over the
// canonical JSON of the steps plus the engine identity.

package core

import "strings"

#SqlIdentifier: =~"^[A-Za-z_][A-Za-z0-9_$]*$" & strings.MaxRunes(63)

#SqlTypeToken: =~"^[A-Za-z][A-Za-z0-9_ ,.()'\\[\\]]*$" & strings.MaxRunes(128)

#SchemaColumnRecord: {
	name:                #SqlIdentifier
	type:                #SqlTypeToken
	nullable:            bool
	primary_key:         bool
	unique:              bool
	default_expression?: string & !=""
}

#SchemaIndexRecord: {
	name: #SqlIdentifier
	// Ordered and non-empty: position is semantic for composite indexes.
	columns: [#SqlIdentifier, ...#SqlIdentifier]
	unique: bool
}

#SchemaTableRecord: {
	name: #SqlIdentifier
	// A table with no columns is not a table.
	columns: [#SchemaColumnRecord, ...#SchemaColumnRecord]
	indexes: [...#SchemaIndexRecord]
}

#SchemaIrRecord: {
	contract: "hobo.schema-ir/v1"
	dialect:  "postgres"
	tables: [...#SchemaTableRecord]
}

#MigrationPhaseName: "expand" | "backfill" | "contract"

#MigrationStepKind: "create-table" | "add-column" | "add-index" | "widen-column" |
	"backfill-column" | "drop-column" | "drop-index" | "drop-table" | "narrow-column"

#MigrationStepRecord: {
	phase:   #MigrationPhaseName
	kind:    #MigrationStepKind
	table:   #SqlIdentifier
	column?: #SqlIdentifier
	index?:  #SqlIdentifier
	// Destructive work is confined to the contract phase; expand and backfill
	// are always safe to run ahead of the new code.
	destructive: bool
}

#MigrationPlanRecord: {
	contract: "hobo.migration-plan/v1"
	steps: [...#MigrationStepRecord]
	engine_id:      string & !=""
	engine_version: string & !=""
	digest:         =~"^sha256:[a-f0-9]{64}$"
}
