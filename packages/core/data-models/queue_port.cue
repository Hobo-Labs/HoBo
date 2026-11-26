package data_models

#LeaseState: "pending" | "leased" | "completed" | "released"

#EnqueueRequest: {
	queue_name:      string & !=""
	idempotency_key: string & !=""
	body_json:       string
	available_at_ms: int & >=0
}

#QueueMessage: {
	message_id:          string & !=""
	queue_name:          string & !=""
	idempotency_key:     string & !=""
	body_json:           string
	state:               #LeaseState
	available_at_ms:     int & >=0
	delivery_attempt:    int & >=0
	lease_id:            string
	lease_expires_at_ms: int & >=0
	completed_at_ms:     int & >=0
}

#QueueEventRecord: {
	type:            string & !=""
	queue_name:      string & !=""
	message_id:      string & !=""
	idempotency_key: string & !=""
}
