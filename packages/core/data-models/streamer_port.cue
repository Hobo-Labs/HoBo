package data_models

#StreamerRunStatus: "completed" | "closed" | "failed"

#StreamerFrame: {
	run_id: string & !=""
	seq:    int & >=1
	stream: string & !=""
}

#StreamerRunResult: {
	run_id: string & !=""
	status: #StreamerRunStatus
	reason: string
}
