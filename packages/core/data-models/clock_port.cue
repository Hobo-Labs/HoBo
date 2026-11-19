package data_models

#SleepTimer: {
	timer_id:        string & !=""
	run_id:          string & !=""
	idempotency_key: string & !=""
	delay_ms:        int & >=0
	scheduled_at_ms: int & >=0
	fire_at_ms:      int & >=0
}

#CronSchedule: {
	schedule_id: string & !=""
	start_at_ms: int & >=0
} & ({every_ms: int & >0, jitter_ms: int & >=0 & <every_ms, expression?: _|_, timezone?: _|_} |
	{every_ms?: 0, jitter_ms?: _|_, expression: string & !="", timezone: string & !=""})

#ClockTraceEntry: {
	type:         string & !=""
	at_ms?:       int & >=0
	delta_ms?:    int & >=0
	every_ms?:    int & >0
	jitter_ms?:   int & >=0
	expression?:  string & !=""
	timezone?:    string & !=""
	schedule_id?: string & !=""
	start_at_ms?: int & >=0
} & ({
	type:        "cron.expression-scheduled"
	schedule_id: string & !=""
	expression:  string & !=""
	timezone:    string & !=""
	start_at_ms: int & >=0
} | {
	type:        "cron.scheduled"
	schedule_id: string & !=""
	every_ms:    int & >0
	start_at_ms: int & >=0
	jitter_ms:   int & >=0 & <every_ms
} | {
	type:  string & !="cron.expression-scheduled" & !="cron.scheduled"
	at_ms: int & >=0
})

#ClockSnapshot: {
	seed:   string & !=""
	now_ms: int & >=0
}
