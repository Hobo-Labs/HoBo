package data_models

#PrincipalKind: "user" | "agent" | "service" | "system"

#PrincipalRef: {
	kind: #PrincipalKind
	id:   string & !=""
	delegated_by?: #PrincipalRef
}

#EventEnvelope: {
	id:       string & !=""
	type:     string & =~"^[a-z][a-z0-9]*\\.[A-Z][A-Za-z0-9]*$"
	v:        int & >=0
	stream_id: string & !=""
	seq:      int & >=0
	ts:       string & !=""
	actor:    #PrincipalRef
	tenant:   string & !=""
	project?: string & !=""
	causation_id?: string & !=""
	correlation_id?: string & !=""
	lane?: string & !=""
}
