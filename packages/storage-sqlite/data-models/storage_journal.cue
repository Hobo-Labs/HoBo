package storage_sqlite

// CUE constraints for storage journal boundary records.

#PositionedEventWire: {
	global_position: =~"^(0|[1-9][0-9]*)$"
	event_envelope:  bytes
}

#StreamHeadWire: {
	stream_id:   string & !=""
	revision:    int & >=0
	owner_epoch: =~"^(0|[1-9][0-9]*)$"
	created_at:  string & !=""
	updated_at:  string & !=""
}

#SubscriptionCheckpointWire: {
	subscription_id: string & !=""
	partition_id:    string & !=""
	position:        =~"^(0|[1-9][0-9]*)$"
	fence_token:     =~"^[1-9][0-9]*$"
	updated_at:      string & !=""
}

#DurableEffectWire: {
	kind:            string & !=""
	id:              string & !=""
	idempotency_key: string & !=""
	deduped:         bool
}

#DurableCommitResultWire: {
	stream_id:      string & !=""
	appended:       [...bytes]
	deduped:        [...bytes]
	first_position: =~"^(0|[1-9][0-9]*)$"
	last_position:  =~"^(0|[1-9][0-9]*)$"
	effects:        [...#DurableEffectWire]
}

#SubscriptionLeaseWire: {
	subscription_id: string & !=""
	partition_id:    string & !=""
	holder_id:       string & !=""
	fence_token:     =~"^[1-9][0-9]*$"
	expires_at:      string & !=""
}

// StorageErrorCode enum: optimistic-concurrency, fencing, checkpoint,
// schema/codec, and persistence failure classes (storage_journal.proto).
#StorageErrorCode: int & >=0 & <=11
