package adapter_drizzle


#DrizzleImpedanceCode: "DRIZZLE_COLUMN_UNRECOGNIZED" |
	"DRIZZLE_COLUMN_TYPE_UNREADABLE" |
	"DRIZZLE_DEFAULT_UNREPRESENTABLE" |
	"DRIZZLE_EXPORT_UNRECOGNIZED" |
	"DRIZZLE_EXTRA_CONFIG_UNREAD" |
	"DRIZZLE_FOREIGN_KEY_UNREAD" |
	"DRIZZLE_INDEX_EXPRESSION_UNREPRESENTABLE" |
	"DRIZZLE_INDEX_KEY_ORDER_UNREPRESENTABLE" |
	"DRIZZLE_INDEX_PREDICATE_UNREPRESENTABLE" |
	"DRIZZLE_NON_POSTGRES_TABLE" |
	"DRIZZLE_TABLE_COLUMNS_EMPTY" |
	"DRIZZLE_TABLE_NAME_DUPLICATE" |
	"DRIZZLE_TABLE_SCHEMA_UNREPRESENTABLE" |
	"DRIZZLE_VIEW_UNREAD"

#DrizzleErrorCode: "DRIZZLE_INGEST_INPUT_INVALID" |
	"DRIZZLE_DIALECT_UNSUPPORTED" |
	"TOOLCHAIN_UNAVAILABLE" |
	"SQL_EMISSION_INCOMPLETE"

#EngineVersion: =~"^[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.-]+)?$"

#TableName: =~"^[a-z_][a-z0-9_]*$"

#DrizzleImpedanceFindingRecord: {
	code:   #DrizzleImpedanceCode
	detail: string & !=""
}

#DrizzleSchemaIngestionRecord: {
	contract: "hobo.schema-ir/v1"
	dialect:  "postgres"
	table_names: [...#TableName]
	impedance: [...#DrizzleImpedanceFindingRecord]
}

#DrizzleDiffEngineRecord: {
	engine_id:      "drizzle-kit"
	engine_version: #EngineVersion
	toolchain_present:     bool
	sql_emission_available: bool
	_emissionRequiresToolchain: true & (!sql_emission_available | toolchain_present)
}

#DrizzleRefusalRecord: {
	code:        #DrizzleErrorCode
	message:     string & !=""
	remediation: string & !=""
}
