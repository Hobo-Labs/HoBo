package architecture_evidence

#FailureClass:
	"unspecified" |
	"transient" |
	"durable-recoverable" |
	"partial-failure" |
	"poison" |
	"drift" |
	"split-brain"

#Deadline: {
	source:                    "caller" | "inherited"
	started_at_ms:             int & >=0
	expires_at_ms:             int & >=started_at_ms
	remaining_at_dispatch_ms:  int & >=0
}

#FailureClassification: {
	class:                          #FailureClass & !="unspecified"
	reason:                         string & !=""
	requires_idempotency_decision:  bool
}

#FailureClassified: {
	source_event_id:   string & !=""
	classification:    #FailureClassification
}

#LinkCalled: {
	component_id:     string & !=""
	import_interface: string & !=""
	provider_id:      string & !=""
	operation:        string & !=""
	deadline:         #Deadline
	outcome:          "ok" | "deadline-exceeded" | "error"
	failure_class:    #FailureClass
	cancellation:     "not-needed" | "signaled"
}

#LinkRejected: {
	provider_id:    string & !=""
	operation:      string & !=""
	in_flight:      int & >=0 & <=max_in_flight
	max_in_flight:  int & >=0
	failure_class:  #FailureClass
}

#LinkFailed: {
	provider_id:      string & !=""
	operation:        string & !=""
	membrane:         "overloaded" | "severed" | "ambiguous-return"
	failure_class:    #FailureClass
	idempotency_key:  string & !=""
}

#MembraneDeadlineBackpressureContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
