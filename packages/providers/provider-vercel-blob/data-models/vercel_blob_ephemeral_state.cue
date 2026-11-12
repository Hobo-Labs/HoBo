package data_models

// CUE constraints for every protobuf type in vercel_blob_ephemeral_state.proto.
// They mirror the parse boundary in src/record.ts and src/env.ts: the record
// format is fixed, incarnations carry no ':' (the version separator),
// revisions start at 1, write ids are opaque printable tokens, and the
// documented per-call cost of an uncontended call stays within two reads,
// two uploads and one delete per key.

#RecordFormat: "hobo.vercel-blob.ephemeral/v1"
#Incarnation:  =~"^[!-9;-~]{1,64}$"
#WriteId:      =~"^[!-~]{1,64}$"

#VercelBlobEphemeralRecord: {
	format:        #RecordFormat
	value:         string
	incarnation:   #Incarnation
	revision:      int & >=1
	expires_at_ms: int & >0
	write_id:      #WriteId
}

#VercelBlobOperationCost: {
	operation:           string & !=""
	simple_operations:   int & >=0 & <=2
	advanced_operations: int & >=0 & <=2
	deletes:             int & >=0 & <=1
	per_key:             bool
}

#VercelBlobUsage: {
	simple_operations:   int & >=0
	advanced_operations: int & >=0
	deletes:             int & >=0
	calls_by_method: [string]: int & >=0
}

#VercelBlobPurgeReport: {
	listed:  int & >=0
	read:    int & >=0 & <=listed
	deleted: int & >=0 & <=listed
	cursor:  string
}

#EnvName: =~"^[A-Z_][A-Z0-9_]*$"

#VercelBlobEnvSource: {
	store_id_variable:        #EnvName & =~"BLOB_STORE_ID$"
	oidc_token_in_env:        bool
	read_write_token_present: bool
}
