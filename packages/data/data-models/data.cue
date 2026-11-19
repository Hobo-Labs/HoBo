package hobo

#ReactivityClass: "reactive" | "non-reactive"

#AggregateSnapshotRecord: {
	streamId:   string & !=""
	seq:        int & >=0
	fenceToken: =~"^[0-9]+$"
	stateJson:  string
	savedAt:    string & !=""
}

#ProjectionCheckpointRecord: {
	projection: string & !=""
	seq:        int & >=0
	rowsJson:   string
	savedAt:    string & !=""
}

#QuarantineRecord: {
	offendingSeq:  int & >0
	quarantineSeq: int & >0
	type:          =~"\\.Quarantined$"
	reason:        string & !=""
}

#AggregateQuarantinedEventData: {
	offendingSeq:     int & >0 & <=9007199254740991
	offendingType:    =~"^[a-z][a-z0-9]*\\.[A-Z][A-Za-z0-9]*$"
	offendingEventId: string & !=""
	fold:             string & !=""
	foldKind:         "aggregate"
	reason:           string
}

#UpcasterRegistration: {
	type:        =~"^[a-z][a-z0-9]*\\.[A-Z][A-Za-z0-9]*$"
	fromVersion: int & >=1
	toVersion:   int & >=2
}

#ActorActivatedData: {
	streamId:   string & !=""
	holderId:   string & !=""
	fenceToken: =~"^[0-9]+$"
}

#ActorStateAppendedData: {
	streamId:   string & !=""
	seq:        int & >0
	fenceToken: =~"^[0-9]+$"
}

#ActorPassivatedData: {
	streamId: string & !=""
	seq:      int & >=0
}

#ProjectionDeclaredData: {
	projection: string & !=""
	readSet: [...string] & !=[]
	reactivityClass: #ReactivityClass
}

#ProjectionLaggedData: {
	projection: string & !=""
	lagSeq:     int & >=0
	bound:      int & >=0
}

#ProjectionSinkReboundData: {
	projection:      string & !=""
	matchDecidedRef: string & !=""
}

#ProjectionReplicatedEventData: {
	eventJson:      string & !=""
	sourcePosition: =~"^[0-9]+$"
}

#ProjectionReplicationCheckedData: {
	sourceStreamId: string
	sourcePosition: =~"^[0-9]+$"
	checkedAtMs:    =~"^[0-9]+$"
	caughtUp:       bool
}

#CrossCampProjectionLaggedData: {
	projection:     string & !=""
	ownerCampId:    string & !=""
	replicaCampId:  string & !=""
	sourcePosition: =~"^[0-9]+$"
	boundMs:        =~"^[0-9]+$"
	observedLagMs:  =~"^[0-9]+$"
}
