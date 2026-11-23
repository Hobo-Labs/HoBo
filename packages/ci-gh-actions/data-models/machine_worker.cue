package ghactions

// The machine worker's records (machine_worker.proto, ADR-0183).

#MachineId:   string & =~"^[a-z0-9][a-z0-9-]{0,62}$"
#MachineTime: number & >=0

// machine.json: the id and name only. A key, a token or anything else is not
// a stored machine.
#StoredMachine: {
	id:   #MachineId
	name: string & =~"^.{1,100}$"
}

#WorkerRepository: string & =~"^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$"
#WorkerJobId:      int & >0
#WorkerDetail:     string & !=""

#WorkerEvent: {
	type:      "worker.advertised"
	machineId: #MachineId
	atMs:      #MachineTime
	busy:      int & >=0 & <=1000
	slots:     int & >=1 & <=1000
	paused:    bool
} | {
	type:      "worker.refused"
	machineId: #MachineId
	atMs:      #MachineTime
	reason:    "malformed" | "invalid_signature" | "wrong_account" | "wrong_owner" | "stale" | "taken_over"
	detail:    #WorkerDetail
} | {
	type:       "worker.job_started" | "worker.job_finished" | "worker.job_failed"
	machineId:  #MachineId
	atMs:       #MachineTime
	jobId:      #WorkerJobId
	repository: #WorkerRepository
	runner?:    string & =~"^hobo-machine-[a-z0-9-]+-[0-9]+$"
	detail:     #WorkerDetail
} | {
	type:       "worker.job_refused"
	machineId:  #MachineId
	atMs:       #MachineTime
	jobId:      #WorkerJobId
	repository: #WorkerRepository
	detail:     #WorkerDetail
} | {
	type:      "worker.draining" | "worker.handing_off"
	machineId: #MachineId
	atMs:      #MachineTime
	running:   int & >=0 & <=1000
	detail:    #WorkerDetail
}

#MachineWorkerRecord: #StoredMachine | #WorkerEvent
// Fixtures under fixtures/machine_worker are machine worker records; the
// package-wide fixtures are #Onboarding records and are vetted against this
// definition too.
#MachineWorker: *#MachineWorkerRecord | #Onboarding
