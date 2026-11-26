package data_models

#EventInput: {
	type: string & =~"^[a-z][a-zA-Z0-9]*\\.[A-Z][A-Za-z0-9]*$"
	v:    int & >0
	data?: bytes
	meta?: {[string]: string}
}

#AppendRequest: {
	stream_id:       string & !=""
	events:          [...#EventInput] & [_, ...]
	expected_seq:    int & >=0
	actor:           #PrincipalRef
	tenant:          string & !=""
	project?:        string & !=""
	causation_id?:   string & !=""
	correlation_id?: string & !=""
	lane?:           string & !=""
}

#AppendResult: {
	stream_id: string & !=""
	appended:  [...#EventEnvelope]
	deduped:   [...#EventEnvelope]
}

#SnapshotRecord: {
	stream_id: string & !=""
	seq:       int & >0
	state:     bytes
	saved_at:  string & !="" & =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}T"
}

#QuarantineFact: {
	offending_seq:  int & >0
	offending_type: string & !=""
	reason:         string & !=""
}

#PositionedEvent: {
	global_position: =~"^(0|[1-9][0-9]*)$"
	event:           #EventEnvelope
}

#ReadAllRequest: {
	after_position?: =~"^(0|[1-9][0-9]*)$"
	limit?:          int & >0
	stream_id?:      string & !=""
	type?:           string & !=""
	tenant?:         string & !=""
	lane?:           string & !=""
}

#DurableCommitRequest: {
	stream_id: string & !=""
	events:    [...#EventInput]
	append:    #AppendRequest
	effects:   [...#DurableEffect]
}

#DurableEffect: {
	kind:            string & !=""
	idempotency_key: string & !=""
	payload:         bytes
}

#DurableCommitResult: {
	append:  #AppendResult
	effects: [...#DurableEffectReceipt]
}

#DurableEffectReceipt: {
	kind:            string & !=""
	id:              string & !=""
	idempotency_key: string & !=""
	deduped:         bool
}

#SubscriptionCheckpoint: {
	subscription_id: string & !=""
	partition_id:    string & !=""
	position:        =~"^(0|[1-9][0-9]*)$"
	fence_token:     =~"^[1-9][0-9]*$"
	updated_at:      string & !=""
}
