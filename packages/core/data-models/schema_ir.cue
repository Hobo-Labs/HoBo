
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
	columns: [#SqlIdentifier, ...#SqlIdentifier]
	unique: bool
}

#SchemaTableRecord: {
	name: #SqlIdentifier
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
	destructive: bool
}

#MigrationPlanRecord: {
	contract: "hobo.migration-plan/v1"
	steps: [...#MigrationStepRecord]
	engine_id:      string & !=""
	engine_version: string & !=""
	digest:         =~"^sha256:[a-f0-9]{64}$"
}
