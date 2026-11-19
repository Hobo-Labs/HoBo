package data_models


#EphemeralKey: =~"^[!-~]{1,512}$"
#Incarnation:  =~"^[!-9;-~]{1,64}$"

#LibsqlEphemeralRow: {
	key:           #EphemeralKey
	value:         string
	incarnation:   #Incarnation
	revision:      int & >=1
	expires_at_ms: int & >0
}

#LibsqlOperationCost: {
	operation:         string & !=""
	requests:          int & >=0 & <=1
	rows_read_max:     int & >=0 & <=2
	rows_written_max:  int & >=0 & <=1
	rows_read_per_key: bool
}

#LibsqlUsage: {
	requests:     int & >=0
	rows_read:    int & >=0
	rows_written: int & >=0
	requests_by_kind: [string]: int & >=0
}

#EnvName: =~"^[A-Z_][A-Z0-9_]*$"

#TursoEnvSource: {
	url_variable:   #EnvName & =~"TURSO_DATABASE_URL$"
	token_variable: #EnvName & =~"TURSO_AUTH_TOKEN$"
}
