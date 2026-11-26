package data_models

#CodegenStatus: "CLEAN" | "DRIFT" | "ERROR"

#DriftEntry: {
	path: string & !=""
	kind: string & !=""
}

#CueViolation: {
	package: string & !=""
	constraint: string & !=""
	message: string & !=""
}

#CodegenReport: {
	status: #CodegenStatus
	drift: [...#DriftEntry]
	cueViolations: [...#CueViolation]
	durationMs: int & >=0
}
