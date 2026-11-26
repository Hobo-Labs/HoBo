package data_models

#StreamRunLifecycleStatus: "opened" | "closed" | "failed"

#StreamRunOpened: {
	run_id:    string & !=""
	opened_at: string & !=""
}

#StreamRunClosed: {
	run_id:    string & !=""
	status:    #StreamRunLifecycleStatus & != "opened"
	reason:    string
	closed_at: string & !=""
}
