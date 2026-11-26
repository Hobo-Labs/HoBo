package data_models

#QueueClockSnapshotRecord: {
	version: string & !=""
	seed:    string & !=""
	now_ms:  int & >=0
}
