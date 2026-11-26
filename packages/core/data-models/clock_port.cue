package data_models

#SleepTimer: {
	timer_id:         string & !=""
	run_id:           string & !=""
	idempotency_key:  string & !=""
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
	type:      string & !=""
	at_ms:     int & >=0
	delta_ms?: int & >=0
	every_ms?: int & >0
}

#ClockSnapshot: {
	seed:   string & !=""
	now_ms: int & >=0
}
