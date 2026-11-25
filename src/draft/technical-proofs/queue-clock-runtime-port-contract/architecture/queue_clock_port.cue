// CUE constraints for queue + clock runtime port records (HOBO-596).

package queue_clock

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

#SleepTimer: {
	timer_id:         string & !=""
	run_id:           string & !=""
	idempotency_key: string & !=""
	delay_ms:         int & >=0
	scheduled_at_ms:  int & >=0
	fire_at_ms:       int & >=0
}

#CronSchedule: {
	schedule_id: string & !=""
	every_ms:    int & >0
	start_at_ms: int & >=0
}

#ClockTraceEntry: {
	type:       string & !=""
	at_ms:      int & >=0
	delta_ms?:  int & >=0
	every_ms?:  int & >0
}

#ClockSnapshot: {
	seed:    string & !=""
	now_ms:  int & >=0
}

#QueueClockSnapshotRecord: {
	version: string & !=""
	seed:    string & !=""
	now_ms:  int & >=0
}

#QueueEventRecord: {
	type:            string & !=""
	queue_name:      string & !=""
	message_id:      string & !=""
	idempotency_key: string & !=""
}
