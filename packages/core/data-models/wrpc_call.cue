package wrpc_call

#WrpcCallEvent: {
	type:            "link.Called"
	componentId:     string & !=""
	importInterface: string & !=""
	providerId:      string & !=""
	exportInterface: string & !=""
	operation:       string & !=""
	boundaryMode:    "live"
	transport:       "in-process" | "lattice"
	codec:           string & !=""
	deadline?:       (string & !="") | null
} & (*{
	outcome?:      _|_
	failureKind?:  _|_
	cancellation?: _|_
} | {
	outcome:       "deadline-exceeded"
	failureKind:   "cancelled"
	cancellation?: "signaled" | "unavailable"
} | {
	outcome:       "error"
	failureKind:   "retryable" | "fatal" | "cancelled" | "version-incompatible" | "ambiguous-commit"
	cancellation?: "signaled" | "unavailable"
})
