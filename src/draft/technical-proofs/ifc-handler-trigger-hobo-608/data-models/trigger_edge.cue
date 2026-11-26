package trigger_edge

#ResourceId: string & =~"^[A-Za-z][A-Za-z0-9_-]*$"

#TriggerKind:
	"http.route" |
	"topic.subscribe" |
	"bucket.on" |
	"schedule.cron" |
	"schedule.every" |
	"queue.worker"

#ExportInterface:
	"wasi:http/incoming-handler" |
	"hobo:trigger/topic-subscriber" |
	"hobo:trigger/scheduled-run" |
	"hobo:trigger/blob-event" |
	"hobo:trigger/queue-worker"

#DurableRuntimeLink: {
	primitive: "workflow"
	interface: "hobo:runtime/workflow@0.1.0"
	handler:   string & !=""
}

#TriggerEdge: {
	id:               string & !=""
	kind:             #TriggerKind
	resource:         #ResourceId
	method?:          string
	path?:            string
	event?:           string
	cron?:            string
	every?:           string
	exportInterface:  #ExportInterface
	handler:          string & !=""
	inferredPermissions?: [...string]
	durableRuntime?:  #DurableRuntimeLink
}

#TriggerFiredEvent: {
	type:       string & "trigger.Fired"
	triggerId:  string & !=""
	kind:       #TriggerKind
	resource:   #ResourceId
	handler:    string & !=""
	success:    bool
}
