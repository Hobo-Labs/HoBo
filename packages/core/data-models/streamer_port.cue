package data_models

#StreamerRunStatus: "completed" | "closed" | "failed"

#StreamerFrame: {
	runId:  string & !=""
	seq:    int & >=1 & <=9007199254740991
	stream: string & !=""
	chunk:  _
}

#StreamerRunResult: {
	runId:  string & !=""
	status: #StreamerRunStatus
	reason: string & !=""
}
