package ci

// A retry row names the failed job's repository, run and attempt; the re-run's
// state says whether GitHub has been asked and what it answered.
#JobRetriedRecord: {
	type:             "job.retried"
	accountId:        string & !=""
	repository:       string & =~"^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$"
	runId:            int & >0
	attempt:          int & >=1 & <=1000
	relayJobId:       int & >0
	relayJob:         string & =~"^[A-Za-z_][A-Za-z0-9_-]{0,99}$"
	jobId:            int & >0
	jobName:          string & !=""
	kind:             "runner_start" | "machine_lost" | "runner_lost"
	target:           "any" | "same" | "other"
	failedStep?:      string
	failedMachineId?: string
	atMs:             int & >0
	{
		rerun: "pending"
	} | {
		rerun:       "started"
		rerunStatus: 201
	} | {
		rerun:        "failed"
		rerunStatus?: int & >=500 & <=599
	} | {
		rerun:       "refused"
		rerunStatus: int & >=200 & <=499 & !=201
	}
}

// Fixtures under fixtures/job_retried are retry rows; the package-wide
// fixtures are #Ci records and are vetted against this definition too.
#JobRetried: *#JobRetriedRecord | #Ci
