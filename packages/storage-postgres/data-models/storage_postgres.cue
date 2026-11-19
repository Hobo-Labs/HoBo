package storage_postgres


#Decimal64: =~"^(0|[1-9][0-9]*)$"
#PositiveDecimal64: =~"^[1-9][0-9]*$"

#SchemaName: =~"^[a-z_][a-z0-9_]{0,62}$"

#PostgresStoreConfigRecord: {
	connection_string:        string & !=""
	schema:                   #SchemaName | *"hobo_eventstore"
	partition_id:             string & !="" | *"default"
	pool_size:                int & >=1 & <=100 | *10
	statement_timeout_ms:     int & >=100 & <=60000 | *5000
	connection_timeout_ms:    int & >=100 & <=60000 | *5000
	min_server_major_version: int & >=16 | *16
	lease_ttl_ms:             int & >=1000 & <=600000 | *30000
	application_name:         string & =~"^[A-Za-z0-9._:-]{1,63}$" | *"hobo-storage-postgres"
}

#MigrationRecord: {
	version:    int & >=1
	name:       =~"^[a-z0-9_]+$"
	checksum:   =~"^[0-9a-f]{64}$"
	applied_at: string & !=""
}

#SubscriptionLeaseRecord: {
	subscription_id: string & !=""
	partition_id:    string & !=""
	holder_id:       string & !=""
	fence_token:     #PositiveDecimal64
	expires_at:      string & !=""
	released:        bool
}

#CheckpointLogRecord: {
	subscription_id: string & !=""
	partition_id:    string & !=""
	entry:           #PositiveDecimal64
	position:        #Decimal64
	fence_token:     #PositiveDecimal64
	holder_id:       string & !=""
	kind:            #CheckpointLogKind
	committed_at:    string & !=""
}

#CheckpointLogKind: "CHECKPOINT_LOG_KIND_ADVANCE" | "CHECKPOINT_LOG_KIND_RESET"

#StoragePostgresErrorCode: int & >=0 & <=10
